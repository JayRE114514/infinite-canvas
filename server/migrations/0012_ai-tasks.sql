CREATE TABLE "ai_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by" text NOT NULL,
	"capability_id" text NOT NULL,
	"adapter_id" text NOT NULL,
	"adapter_version" text NOT NULL,
	"exact_model_id" text NOT NULL,
	"input" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result_asset_id" uuid,
	"public_error_code" text,
	"lease_epoch" bigint DEFAULT 0 NOT NULL,
	"lease_worker_id" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_tasks_workspace_idempotency_unique" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "ai_tasks_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "ai_tasks_idempotency_nonempty" CHECK (idempotency_key <> ''),
	CONSTRAINT "ai_tasks_request_hash_format" CHECK (request_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ai_tasks_status_allowed" CHECK (status in ('queued', 'submitting', 'processing', 'storing', 'succeeded', 'failed', 'reconciling')),
	CONSTRAINT "ai_tasks_lease_epoch_nonnegative" CHECK (lease_epoch >= 0)
);
--> statement-breakpoint
CREATE TABLE "provider_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"adapter_id" text NOT NULL,
	"adapter_version" text NOT NULL,
	"exact_model_id" text NOT NULL,
	"provider_idempotency_key" text NOT NULL,
	"remote_task_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"failure_classification" text,
	"redacted_error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_attempts_workspace_task_sequence_unique" UNIQUE("workspace_id","task_id","sequence"),
	CONSTRAINT "provider_attempts_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "provider_attempts_sequence_positive" CHECK (sequence > 0),
	CONSTRAINT "provider_attempts_status_allowed" CHECK (status in ('pending', 'submitting', 'processing', 'succeeded', 'failed', 'ambiguous'))
);
--> statement-breakpoint
CREATE TABLE "task_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_events_workspace_task_sequence_unique" UNIQUE("workspace_id","task_id","sequence"),
	CONSTRAINT "task_events_sequence_positive" CHECK (sequence > 0)
);
--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_workspace_result_asset_fk" FOREIGN KEY ("workspace_id","result_asset_id") REFERENCES "public"."assets"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_attempts" ADD CONSTRAINT "provider_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_attempts" ADD CONSTRAINT "provider_attempts_workspace_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "public"."ai_tasks"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_workspace_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "public"."ai_tasks"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_tasks_workspace_created_idx" ON "ai_tasks" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "task_events_workspace_task_idx" ON "task_events" USING btree ("workspace_id","task_id","sequence");
--> statement-breakpoint
ALTER TABLE public.billing_orders ADD CONSTRAINT billing_orders_workspace_task_fk
FOREIGN KEY (workspace_id, task_id) REFERENCES public.ai_tasks(workspace_id, id) ON DELETE restrict;
--> statement-breakpoint

REVOKE ALL ON public.ai_tasks, public.provider_attempts, public.task_events
FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint
ALTER TABLE public.ai_tasks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.ai_tasks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.provider_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.provider_attempts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.task_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.task_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY ai_tasks_api_member ON public.ai_tasks
FOR ALL TO app_api
USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')
    AND public.is_active_workspace_member(workspace_id, nullif(current_setting('app.user_id', true), ''))
)
WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')
    AND created_by = nullif(current_setting('app.user_id', true), '')
    AND public.is_active_workspace_member(workspace_id, nullif(current_setting('app.user_id', true), ''))
);
--> statement-breakpoint
CREATE POLICY provider_attempts_api_member ON public.provider_attempts
FOR ALL TO app_api
USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')
    AND public.is_active_workspace_member(workspace_id, nullif(current_setting('app.user_id', true), ''))
)
WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')
    AND public.is_active_workspace_member(workspace_id, nullif(current_setting('app.user_id', true), ''))
);
--> statement-breakpoint
CREATE POLICY task_events_api_member ON public.task_events
FOR ALL TO app_api
USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')
    AND public.is_active_workspace_member(workspace_id, nullif(current_setting('app.user_id', true), ''))
)
WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')
    AND public.is_active_workspace_member(workspace_id, nullif(current_setting('app.user_id', true), ''))
);
--> statement-breakpoint
CREATE POLICY ai_tasks_worker_workspace ON public.ai_tasks
FOR ALL TO app_worker
USING (workspace_id = nullif(current_setting('app.workspace_id', true), ''))
WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY provider_attempts_worker_workspace ON public.provider_attempts
FOR ALL TO app_worker
USING (workspace_id = nullif(current_setting('app.workspace_id', true), ''))
WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY task_events_worker_workspace ON public.task_events
FOR ALL TO app_worker
USING (workspace_id = nullif(current_setting('app.workspace_id', true), ''))
WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint

GRANT SELECT, INSERT ON public.ai_tasks, public.provider_attempts, public.task_events TO app_api;
--> statement-breakpoint
GRANT SELECT ON public.ai_tasks, public.provider_attempts, public.task_events TO app_worker;
--> statement-breakpoint
GRANT UPDATE (status, result_asset_id, public_error_code, lease_epoch, lease_worker_id, lease_expires_at, updated_at)
ON public.ai_tasks TO app_worker;
--> statement-breakpoint
GRANT UPDATE (remote_task_id, status, failure_classification, redacted_error, updated_at)
ON public.provider_attempts TO app_worker;
--> statement-breakpoint
GRANT INSERT ON public.task_events TO app_worker;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.reject_task_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $reject_task_event_mutation$
BEGIN
    RAISE EXCEPTION 'Task Event is append-only' USING ERRCODE = '42501';
END
$reject_task_event_mutation$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reject_task_event_mutation() FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint
CREATE TRIGGER task_events_append_only
BEFORE UPDATE OR DELETE ON public.task_events
FOR EACH ROW EXECUTE FUNCTION public.reject_task_event_mutation();
