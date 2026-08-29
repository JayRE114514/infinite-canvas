-- PostgreSQL 将 ON CONFLICT 目标中的 source 同时识别为入参与列名。
-- 保持 Task 3 的签名、权限和重放协议不变，只明确该函数内列名优先。
CREATE OR REPLACE FUNCTION public.record_workspace_provisioning(source text, workspace_id text, event_id text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $record_provisioning$
#variable_conflict use_column
DECLARE
    v_source text := source;
    v_workspace_id text := workspace_id;
    v_event_id text := event_id;
    v_user_id text := nullif(current_setting('app.user_id', true), '');
    v_audit_id uuid;
    v_existing_workspace_id text;
    v_existing_event_id text;
    v_existing_id uuid;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'workspace provisioning requires transaction-local app.user_id' USING ERRCODE = '42501';
    END IF;

    IF NOT (v_source = ANY (ARRAY['email_verification', 'explicit_repair'])) THEN
        RAISE EXCEPTION 'unsupported provisioning source %', v_source USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.workspace_provisioning_audits
        (user_id, source, event_id, workspace_id, transaction_xid)
    VALUES (v_user_id, v_source, v_event_id, v_workspace_id, pg_current_xact_id())
    ON CONFLICT (user_id, source) DO NOTHING
    RETURNING id INTO v_audit_id;

    IF v_audit_id IS NOT NULL THEN
        RETURN v_audit_id;
    END IF;

    SELECT p.id, p.workspace_id, p.event_id
    INTO v_existing_id, v_existing_workspace_id, v_existing_event_id
    FROM public.workspace_provisioning_audits p
    WHERE p.user_id = v_user_id AND p.source = v_source;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'provisioning conflict without a committed row for user %', v_user_id USING ERRCODE = '23514';
    END IF;

    IF v_existing_workspace_id <> v_workspace_id OR v_existing_event_id <> v_event_id THEN
        RAISE EXCEPTION 'workspace provisioning history mismatch for user % source %', v_user_id, v_source
            USING ERRCODE = '23514';
    END IF;

    RETURN v_existing_id;
END
$record_provisioning$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_workspace_provisioning(text, text, text) FROM PUBLIC;
