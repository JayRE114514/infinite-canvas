-- A Provider POST may be accepted after Workspace authorization changes. This one narrow finalizer
-- records only that already-issued create outcome; ordinary tenant table policies remain unchanged.
-- UPDATE ... RETURNING checks SELECT RLS against both old and new rows, so SELECT is bound to the
-- immutable row identity while the UPDATE policy and function WHERE clause enforce submitting CAS.
CREATE POLICY artbox_video_generations_finalizer_schema_owner_select ON public.artbox_video_generations
FOR SELECT TO schema_owner
USING (
    id::text = nullif(current_setting('app.artbox_finalize_generation_id', true), '')
    AND workspace_id = nullif(current_setting('app.artbox_finalize_workspace_id', true), '')
    AND request_hash = nullif(current_setting('app.artbox_finalize_request_hash', true), '')
    AND created_by = nullif(current_setting('app.user_id', true), '')
);
--> statement-breakpoint
CREATE POLICY artbox_video_generations_finalizer_schema_owner_update ON public.artbox_video_generations
FOR UPDATE TO schema_owner
USING (
    status = 'submitting'
    AND id::text = nullif(current_setting('app.artbox_finalize_generation_id', true), '')
    AND workspace_id = nullif(current_setting('app.artbox_finalize_workspace_id', true), '')
    AND request_hash = nullif(current_setting('app.artbox_finalize_request_hash', true), '')
    AND created_by = nullif(current_setting('app.user_id', true), '')
)
WITH CHECK (
    id::text = nullif(current_setting('app.artbox_finalize_generation_id', true), '')
    AND workspace_id = nullif(current_setting('app.artbox_finalize_workspace_id', true), '')
    AND request_hash = nullif(current_setting('app.artbox_finalize_request_hash', true), '')
    AND created_by = nullif(current_setting('app.user_id', true), '')
    AND (
        (status = 'queued' AND remote_task_id IS NOT NULL AND length(remote_task_id) > 0 AND public_error IS NULL)
        OR (
            status IN ('failed', 'reconciling')
            AND remote_task_id IS NULL
            AND public_error IS NOT NULL
        )
    )
);
--> statement-breakpoint
CREATE FUNCTION public.finalize_artbox_video_generation_create(
    p_generation_id uuid,
    p_workspace_id text,
    p_request_hash text,
    p_status text,
    p_remote_task_id text,
    p_public_error jsonb
)
RETURNS TABLE (
    generation_id uuid,
    workspace_id text,
    generation_status text,
    result_asset_id uuid,
    generation_error jsonb,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $artbox_create_finalizer$
DECLARE
    v_user_id text := nullif(current_setting('app.user_id', true), '');
    v_updated integer;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'ArtBox create finalization requires a user context' USING ERRCODE = '42501';
    END IF;
    IF p_generation_id IS NULL
       OR p_workspace_id IS NULL OR length(p_workspace_id) = 0
       OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
       OR p_status IS NULL OR p_status NOT IN ('queued', 'failed', 'reconciling') THEN
        RAISE EXCEPTION 'Invalid ArtBox create finalization input' USING ERRCODE = '22023';
    END IF;
    IF p_status = 'queued' THEN
        IF p_remote_task_id IS NULL OR length(p_remote_task_id) = 0 OR p_public_error IS NOT NULL THEN
            RAISE EXCEPTION 'Invalid queued ArtBox create outcome' USING ERRCODE = '22023';
        END IF;
    ELSE
        IF p_remote_task_id IS NOT NULL
           OR p_public_error IS NULL
           OR jsonb_typeof(p_public_error) <> 'object'
           OR NOT (p_public_error ?& ARRAY['code', 'message', 'retryable'])
           OR p_public_error - ARRAY['code', 'message', 'retryable'] <> '{}'::jsonb
           OR jsonb_typeof(p_public_error->'code') <> 'string'
           OR length(p_public_error->>'code') = 0
           OR jsonb_typeof(p_public_error->'message') <> 'string'
           OR length(p_public_error->>'message') = 0
           OR jsonb_typeof(p_public_error->'retryable') <> 'boolean' THEN
            RAISE EXCEPTION 'Invalid terminal ArtBox create outcome' USING ERRCODE = '22023';
        END IF;
    END IF;

    PERFORM set_config('app.artbox_finalize_generation_id', p_generation_id::text, true);
    PERFORM set_config('app.artbox_finalize_workspace_id', p_workspace_id, true);
    PERFORM set_config('app.artbox_finalize_request_hash', p_request_hash, true);

    RETURN QUERY
    UPDATE public.artbox_video_generations AS generation
    SET status = p_status,
        remote_task_id = CASE WHEN p_status = 'queued' THEN p_remote_task_id ELSE NULL END,
        public_error = p_public_error,
        updated_at = now()
    WHERE generation.id = p_generation_id
      AND generation.workspace_id = p_workspace_id
      AND generation.request_hash = p_request_hash
      AND generation.created_by = v_user_id
      AND generation.status = 'submitting'
    RETURNING generation.id,
              generation.workspace_id,
              generation.status,
              generation.result_asset_id,
              generation.public_error,
              generation.created_at,
              generation.updated_at;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
        RAISE EXCEPTION 'ArtBox create outcome finalization target is unavailable' USING ERRCODE = 'P0002';
    END IF;
END
$artbox_create_finalizer$;
--> statement-breakpoint
ALTER FUNCTION public.finalize_artbox_video_generation_create(uuid, text, text, text, text, jsonb) OWNER TO schema_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.finalize_artbox_video_generation_create(uuid, text, text, text, text, jsonb)
FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.finalize_artbox_video_generation_create(uuid, text, text, text, text, jsonb) TO app_api;
