CREATE TABLE "artbox_video_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"normalized_input" jsonb NOT NULL,
	"status" text DEFAULT 'submitting' NOT NULL,
	"remote_task_id" text,
	"result_asset_id" uuid,
	"public_error" jsonb,
	"poll_lease_epoch" bigint DEFAULT 0 NOT NULL,
	"poll_lease_until" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artbox_video_generations_workspace_idempotency_unique" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "artbox_video_generations_idempotency_key_nonempty" CHECK (length(idempotency_key) > 0),
	CONSTRAINT "artbox_video_generations_request_hash_check" CHECK (request_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "artbox_video_generations_status_check" CHECK (status IN ('submitting', 'queued', 'processing', 'succeeded', 'failed', 'reconciling')),
	CONSTRAINT "artbox_video_generations_remote_state_check" CHECK (status NOT IN ('queued', 'processing', 'succeeded') OR remote_task_id IS NOT NULL),
	CONSTRAINT "artbox_video_generations_result_state_check" CHECK ((status = 'succeeded') = (result_asset_id IS NOT NULL)),
	CONSTRAINT "artbox_video_generations_lease_epoch_safe" CHECK (poll_lease_epoch >= 0 AND poll_lease_epoch <= 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "artbox_video_generations" ADD CONSTRAINT "artbox_video_generations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artbox_video_generations" ADD CONSTRAINT "artbox_video_generations_result_asset_id_assets_id_fk" FOREIGN KEY ("result_asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artbox_video_generations" ADD CONSTRAINT "artbox_video_generations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artbox_video_generations_workspace_status_idx" ON "artbox_video_generations" USING btree ("workspace_id","status");
--> statement-breakpoint
CREATE FUNCTION public.enforce_artbox_video_generation_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $artbox_generation_lifecycle$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'submitting'
           OR NEW.remote_task_id IS NOT NULL
           OR NEW.result_asset_id IS NOT NULL
           OR NEW.poll_lease_epoch <> 0
           OR NEW.poll_lease_until IS NOT NULL THEN
            RAISE EXCEPTION 'ArtBox generation must be created as a fresh local submission' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
       OR NEW.normalized_input IS DISTINCT FROM OLD.normalized_input
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'ArtBox generation identity and normalized request are immutable' USING ERRCODE = '23514';
    END IF;

    IF OLD.remote_task_id IS NOT NULL AND NEW.remote_task_id IS DISTINCT FROM OLD.remote_task_id THEN
        RAISE EXCEPTION 'ArtBox remote task identity is immutable once known' USING ERRCODE = '23514';
    END IF;
    IF NEW.poll_lease_epoch < OLD.poll_lease_epoch OR NEW.poll_lease_epoch > OLD.poll_lease_epoch + 1 THEN
        RAISE EXCEPTION 'ArtBox poll lease epoch must advance monotonically by one' USING ERRCODE = '23514';
    END IF;
    IF OLD.status IN ('succeeded', 'failed', 'reconciling') AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'terminal ArtBox generation status is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status = 'submitting' AND NEW.status IN ('queued', 'failed', 'reconciling'))
        OR (OLD.status IN ('queued', 'processing') AND NEW.status IN ('queued', 'processing', 'succeeded', 'failed', 'reconciling'))
    ) THEN
        RAISE EXCEPTION 'invalid ArtBox generation status transition % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
    IF NEW.result_asset_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.assets a
        WHERE a.id = NEW.result_asset_id
          AND a.workspace_id = NEW.workspace_id
          AND a.kind = 'video'
          AND a.status = 'ready'
    ) THEN
        RAISE EXCEPTION 'ArtBox result Asset must be a ready video in the same Workspace' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END
$artbox_generation_lifecycle$;
--> statement-breakpoint
ALTER FUNCTION public.enforce_artbox_video_generation_lifecycle() OWNER TO schema_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.enforce_artbox_video_generation_lifecycle() FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint
CREATE TRIGGER artbox_video_generations_enforce_lifecycle
BEFORE INSERT OR UPDATE ON public.artbox_video_generations
FOR EACH ROW EXECUTE FUNCTION public.enforce_artbox_video_generation_lifecycle();
--> statement-breakpoint
REVOKE ALL ON TABLE public.artbox_video_generations FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.artbox_video_generations TO app_api;
--> statement-breakpoint
GRANT UPDATE (status, remote_task_id, result_asset_id, public_error, poll_lease_epoch, poll_lease_until, updated_at)
ON TABLE public.artbox_video_generations TO app_api;
--> statement-breakpoint
ALTER TABLE public.artbox_video_generations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.artbox_video_generations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY artbox_video_generations_api_select_member ON public.artbox_video_generations
FOR SELECT TO app_api
USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')
    AND public.is_active_workspace_member(workspace_id, nullif(current_setting('app.user_id', true), ''))
);
--> statement-breakpoint
CREATE POLICY artbox_video_generations_api_insert_member ON public.artbox_video_generations
FOR INSERT TO app_api
WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')
    AND public.is_active_workspace_member(workspace_id, nullif(current_setting('app.user_id', true), ''))
);
--> statement-breakpoint
CREATE POLICY artbox_video_generations_api_update_member ON public.artbox_video_generations
FOR UPDATE TO app_api
USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')
    AND public.is_active_workspace_member(workspace_id, nullif(current_setting('app.user_id', true), ''))
)
WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')
    AND public.is_active_workspace_member(workspace_id, nullif(current_setting('app.user_id', true), ''))
);
