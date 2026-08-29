CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'staging' NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" bigint,
	"staging_object_key" text,
	"final_object_key" text NOT NULL,
	"etag" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_staging_object_key_unique" UNIQUE("staging_object_key"),
	CONSTRAINT "assets_final_object_key_unique" UNIQUE("final_object_key"),
	CONSTRAINT "assets_kind_check" CHECK (kind IN ('image', 'video', 'audio')),
	CONSTRAINT "assets_status_check" CHECK (status IN ('staging', 'ready', 'failed', 'deleted')),
	CONSTRAINT "assets_file_name_nonempty" CHECK (length(file_name) > 0),
	CONSTRAINT "assets_content_type_nonempty" CHECK (length(content_type) > 0),
	CONSTRAINT "assets_byte_size_safe" CHECK (byte_size IS NULL OR (byte_size >= 0 AND byte_size <= 9007199254740991)),
	CONSTRAINT "assets_object_keys_distinct" CHECK (staging_object_key IS NULL OR staging_object_key <> final_object_key),
	CONSTRAINT "assets_state_coherent" CHECK ((
                status = 'staging' AND staging_object_key IS NOT NULL AND byte_size IS NULL
            ) OR (
                status = 'ready' AND staging_object_key IS NULL AND byte_size IS NOT NULL
            ) OR status IN ('failed', 'deleted'))
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_workspace_status_idx" ON "assets" USING btree ("workspace_id","status");
--> statement-breakpoint
-- Final object identity and lifecycle transitions are database invariants, not TypeScript call-order conventions.
CREATE FUNCTION public.enforce_asset_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $asset_lifecycle$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status NOT IN ('staging', 'ready') THEN
            RAISE EXCEPTION 'asset must be created as staging or ready' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.file_name IS DISTINCT FROM OLD.file_name
       OR NEW.content_type IS DISTINCT FROM OLD.content_type
       OR NEW.final_object_key IS DISTINCT FROM OLD.final_object_key
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'asset identity and final object key are immutable' USING ERRCODE = '23514';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status = 'staging' AND NEW.status IN ('ready', 'failed'))
        OR (OLD.status IN ('ready', 'failed') AND NEW.status = 'deleted')
    ) THEN
        RAISE EXCEPTION 'invalid asset status transition % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END
$asset_lifecycle$;
--> statement-breakpoint
ALTER FUNCTION public.enforce_asset_lifecycle() OWNER TO schema_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.enforce_asset_lifecycle() FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint
CREATE TRIGGER assets_enforce_lifecycle
BEFORE INSERT OR UPDATE ON public.assets
FOR EACH ROW EXECUTE FUNCTION public.enforce_asset_lifecycle();
--> statement-breakpoint
REVOKE ALL ON TABLE public.assets FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.assets TO app_api;
--> statement-breakpoint
GRANT UPDATE (status, staging_object_key, byte_size, etag, updated_at) ON TABLE public.assets TO app_api;
--> statement-breakpoint
ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.assets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY assets_api_select_member ON public.assets
FOR SELECT TO app_api
USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')
    AND public.is_active_workspace_member(workspace_id, nullif(current_setting('app.user_id', true), ''))
);
--> statement-breakpoint
CREATE POLICY assets_api_insert_member ON public.assets
FOR INSERT TO app_api
WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')
    AND public.is_active_workspace_member(workspace_id, nullif(current_setting('app.user_id', true), ''))
);
--> statement-breakpoint
CREATE POLICY assets_api_update_member ON public.assets
FOR UPDATE TO app_api
USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')
    AND public.is_active_workspace_member(workspace_id, nullif(current_setting('app.user_id', true), ''))
)
WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')
    AND public.is_active_workspace_member(workspace_id, nullif(current_setting('app.user_id', true), ''))
);
