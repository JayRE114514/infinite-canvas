CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"status" text DEFAULT 'staging' NOT NULL,
	"display_name" text NOT NULL,
	"object_key" text NOT NULL,
	"media_type" text,
	"byte_size" bigint,
	"sha256" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "assets_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "assets_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "assets_status_allowed" CHECK (status in ('staging', 'ready', 'failed', 'deleted')),
	CONSTRAINT "assets_byte_size_nonnegative" CHECK (byte_size is null or byte_size >= 0),
	CONSTRAINT "assets_sha256_format" CHECK (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assets_state_coherent" CHECK ((status = 'staging' and media_type is null and byte_size is null and sha256 is null and failure_reason is null and deleted_at is null) or (status = 'ready' and media_type is not null and byte_size is not null and sha256 is not null and failure_reason is null and deleted_at is null) or (status = 'failed' and failure_reason is not null and deleted_at is null) or (status = 'deleted' and deleted_at is not null))
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_workspace_status_idx" ON "assets" USING btree ("workspace_id","status");
--> statement-breakpoint
REVOKE ALL ON public.assets FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint
ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.assets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY assets_schema_owner_all ON public.assets
FOR ALL TO schema_owner USING (true) WITH CHECK (true);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.assert_asset_workspace_context(p_workspace_id text, p_require_user boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $assert_asset_workspace_context$
DECLARE
    v_workspace_id text := nullif(current_setting('app.workspace_id', true), '');
    v_user_id text := nullif(current_setting('app.user_id', true), '');
BEGIN
    IF v_workspace_id IS NULL OR v_workspace_id <> p_workspace_id THEN
        RAISE EXCEPTION 'Asset command requires matching Workspace context' USING ERRCODE = '42501';
    END IF;
    IF p_require_user AND (v_user_id IS NULL OR NOT public.is_active_workspace_member(p_workspace_id, v_user_id)) THEN
        RAISE EXCEPTION 'Asset command requires active Workspace membership' USING ERRCODE = '42501';
    END IF;
END
$assert_asset_workspace_context$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.assert_asset_workspace_context(text, boolean)
FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.create_staging_asset(p_workspace_id text, p_display_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $create_staging_asset$
DECLARE
    v_asset_id uuid := gen_random_uuid();
BEGIN
    PERFORM public.assert_asset_workspace_context(p_workspace_id, false);
    IF btrim(p_display_name) = '' THEN
        RAISE EXCEPTION 'Asset display name is required' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.assets (id, workspace_id, display_name, object_key)
    VALUES (v_asset_id, p_workspace_id, p_display_name, 'assets/' || v_asset_id::text || '/' || gen_random_uuid()::text);
    RETURN v_asset_id;
END
$create_staging_asset$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.create_staging_asset(text, text) FROM PUBLIC, app_api, app_maintenance;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.create_staging_asset(text, text) TO app_worker;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.get_staging_asset_storage(p_workspace_id text, p_asset_id uuid)
RETURNS TABLE (object_key text, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $get_staging_asset_storage$
BEGIN
    PERFORM public.assert_asset_workspace_context(p_workspace_id, false);
    RETURN QUERY SELECT asset.object_key, asset.status
    FROM public.assets asset
    WHERE asset.workspace_id = p_workspace_id AND asset.id = p_asset_id;
END
$get_staging_asset_storage$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_staging_asset_storage(text, uuid) FROM PUBLIC, app_api, app_maintenance;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_staging_asset_storage(text, uuid) TO app_worker;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.mark_asset_ready(
    p_workspace_id text,
    p_asset_id uuid,
    p_media_type text,
    p_byte_size bigint,
    p_sha256 text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $mark_asset_ready$
DECLARE
    v_asset public.assets%ROWTYPE;
BEGIN
    PERFORM public.assert_asset_workspace_context(p_workspace_id, false);
    SELECT * INTO v_asset FROM public.assets
    WHERE workspace_id = p_workspace_id AND id = p_asset_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Asset does not exist' USING ERRCODE = 'P4040'; END IF;
    IF v_asset.status = 'ready' THEN
        IF v_asset.media_type = p_media_type AND v_asset.byte_size = p_byte_size AND v_asset.sha256 = p_sha256 THEN
            RETURN;
        END IF;
        RAISE EXCEPTION 'ready Asset metadata conflict' USING ERRCODE = 'P4090';
    END IF;
    IF v_asset.status <> 'staging' THEN
        RAISE EXCEPTION 'Asset cannot become ready from current status' USING ERRCODE = 'P4091';
    END IF;
    UPDATE public.assets
    SET status = 'ready', media_type = p_media_type, byte_size = p_byte_size,
        sha256 = p_sha256, updated_at = now()
    WHERE workspace_id = p_workspace_id AND id = p_asset_id;
END
$mark_asset_ready$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mark_asset_ready(text, uuid, text, bigint, text) FROM PUBLIC, app_api, app_maintenance;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mark_asset_ready(text, uuid, text, bigint, text) TO app_worker;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.mark_asset_failed(p_workspace_id text, p_asset_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $mark_asset_failed$
BEGIN
    PERFORM public.assert_asset_workspace_context(p_workspace_id, false);
    UPDATE public.assets
    SET status = 'failed', failure_reason = p_reason, updated_at = now()
    WHERE workspace_id = p_workspace_id AND id = p_asset_id AND status = 'staging';
    IF NOT FOUND THEN RAISE EXCEPTION 'Asset cannot become failed from current status' USING ERRCODE = 'P4091'; END IF;
END
$mark_asset_failed$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mark_asset_failed(text, uuid, text) FROM PUBLIC, app_api, app_maintenance;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mark_asset_failed(text, uuid, text) TO app_worker;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.get_ready_asset(p_workspace_id text, p_asset_id uuid)
RETURNS TABLE (asset_id uuid, display_name text, media_type text, byte_size bigint, sha256 text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $get_ready_asset$
DECLARE
    v_require_user boolean := session_user = 'app_api';
BEGIN
    PERFORM public.assert_asset_workspace_context(p_workspace_id, v_require_user);
    RETURN QUERY SELECT asset.id, asset.display_name, asset.media_type, asset.byte_size, asset.sha256
    FROM public.assets asset
    WHERE asset.workspace_id = p_workspace_id AND asset.id = p_asset_id AND asset.status = 'ready';
END
$get_ready_asset$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_ready_asset(text, uuid) FROM PUBLIC, app_maintenance;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_ready_asset(text, uuid) TO app_api, app_worker;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.logical_delete_asset(p_workspace_id text, p_asset_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $logical_delete_asset$
DECLARE
    v_require_user boolean := session_user = 'app_api';
BEGIN
    PERFORM public.assert_asset_workspace_context(p_workspace_id, v_require_user);
    UPDATE public.assets SET status = 'deleted', deleted_at = now(), updated_at = now()
    WHERE workspace_id = p_workspace_id AND id = p_asset_id AND status IN ('ready', 'failed');
    IF NOT FOUND THEN RAISE EXCEPTION 'Asset cannot be deleted from current status' USING ERRCODE = 'P4091'; END IF;
END
$logical_delete_asset$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.logical_delete_asset(text, uuid) FROM PUBLIC, app_maintenance;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.logical_delete_asset(text, uuid) TO app_api, app_worker;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.protect_asset_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $protect_asset_identity$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.object_key IS DISTINCT FROM OLD.object_key OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Asset identity and object key are immutable' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END
$protect_asset_identity$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.protect_asset_identity() FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint
CREATE TRIGGER assets_identity_immutable
BEFORE UPDATE ON public.assets
FOR EACH ROW EXECUTE FUNCTION public.protect_asset_identity();
