CREATE OR REPLACE FUNCTION public.notify_ai_task_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $notify_ai_task_event$
BEGIN
    PERFORM pg_notify('ai_task_events', NEW.task_id::text);
    RETURN NEW;
END
$notify_ai_task_event$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.notify_ai_task_event() FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint
CREATE TRIGGER task_events_notify_after_insert
AFTER INSERT ON public.task_events
FOR EACH ROW EXECUTE FUNCTION public.notify_ai_task_event();
--> statement-breakpoint
GRANT SELECT ON public.billing_orders TO app_api;
--> statement-breakpoint
CREATE POLICY billing_orders_api_member ON public.billing_orders
FOR SELECT TO app_api
USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')
    AND public.is_active_workspace_member(workspace_id, nullif(current_setting('app.user_id', true), ''))
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.get_ready_asset_storage(p_workspace_id text, p_asset_id uuid)
RETURNS TABLE (
    object_key text, status text, display_name text, media_type text,
    byte_size bigint, sha256 text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $get_ready_asset_storage$
DECLARE
    v_require_user boolean := session_user = 'app_api';
BEGIN
    PERFORM public.assert_asset_workspace_context(p_workspace_id, v_require_user);
    RETURN QUERY SELECT asset.object_key, asset.status, asset.display_name, asset.media_type, asset.byte_size, asset.sha256
    FROM public.assets asset
    WHERE asset.workspace_id = p_workspace_id AND asset.id = p_asset_id;
END
$get_ready_asset_storage$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_ready_asset_storage(text, uuid) FROM PUBLIC, app_maintenance;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_ready_asset_storage(text, uuid) TO app_api, app_worker;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.resolve_visible_asset_workspace(p_asset_id uuid, p_user_id text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $resolve_visible_asset_workspace$
    SELECT asset.workspace_id
    FROM public.assets asset
    WHERE asset.id = p_asset_id
      AND asset.status <> 'deleted'
      AND public.is_active_workspace_member(asset.workspace_id, p_user_id);
$resolve_visible_asset_workspace$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.resolve_visible_asset_workspace(uuid, text) FROM PUBLIC, app_worker, app_maintenance;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.resolve_visible_asset_workspace(uuid, text) TO app_api;
