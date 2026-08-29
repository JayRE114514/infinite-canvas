-- 收紧管理员用途词表到"具备完整执行链"的闭世界集合。
-- 只有同时具备以下四层的 purpose 才允许开启操作：
--   1. begin_admin_operation 白名单；
--   2. 独立的窄口 SECURITY DEFINER 执行函数；
--   3. 对应审计表的 action CHECK；
--   4. 对应审计表的 INSERT RLS 策略。
-- 截至本迁移，只有四个 Workspace 生命周期 purpose 四层齐备：
-- execute_workspace_admin_operation() 只接受这四个用途，
-- workspace_audit_logs_action_allowed 只允许这四个 action，
-- workspace_audit_logs_schema_owner_insert_admin 也只放行这四个 action。
-- 平台级目标当前没有任何可执行 purpose：既无窄口执行函数，
-- global_audit_logs 也没有 action CHECK、没有启用 RLS、没有 INSERT 策略。
-- 其余用途（wallet_adjust、wallet_status_write、billing_confirm_charge、
-- billing_confirm_no_charge、ledger_compensate、workspace_export 以及全部平台级用途）
-- 只保留在 ADR/roadmap 中作为实现差距，不再表现为运行期可执行能力。
-- 只替换 begin_admin_operation 的用途判定，签名、权限与其余语义保持不变；
-- 不改写历史迁移，也不放宽 execute_workspace_admin_operation()。
CREATE OR REPLACE FUNCTION public.begin_admin_operation(target_kind text, target_workspace_id text, purpose text, request_id text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $begin_admin_op$
DECLARE
    v_target_kind text := target_kind;
    v_workspace_id text := target_workspace_id;
    v_purpose text := purpose;
    v_request_id text := request_id;
    v_user_id text := nullif(current_setting('app.user_id', true), '');
    v_operation_id uuid;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'admin operation requires transaction-local app.user_id' USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.platform_admins a WHERE a.user_id = v_user_id AND a.status = 'active'
    ) THEN
        RAISE EXCEPTION 'user % is not an active platform admin', v_user_id USING ERRCODE = '42501';
    END IF;

    IF v_target_kind = 'platform' THEN
        -- 平台级目标没有任何四层齐备的用途，因此一律拒绝，不区分具体用途。
        RAISE EXCEPTION 'unsupported platform admin purpose %', v_purpose USING ERRCODE = '22023';
    ELSIF v_target_kind = 'workspace' THEN
        IF v_workspace_id IS NULL THEN
            RAISE EXCEPTION 'workspace admin operation requires a workspace target' USING ERRCODE = '22023';
        END IF;
        IF NOT (v_purpose = ANY (ARRAY[
            'workspace_read', 'workspace_suspend', 'workspace_deactivate', 'workspace_restore'
        ])) THEN
            RAISE EXCEPTION 'unsupported workspace admin purpose %', v_purpose USING ERRCODE = '22023';
        END IF;
    ELSE
        RAISE EXCEPTION 'unsupported admin target kind %', v_target_kind USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.admin_operations
        (admin_user_id, target_kind, target_workspace_id, purpose, request_id, transaction_xid)
    VALUES (v_user_id, v_target_kind, v_workspace_id, v_purpose, v_request_id, pg_current_xact_id())
    RETURNING id INTO v_operation_id;

    PERFORM set_config('app.admin_operation_id', v_operation_id::text, true);
    RETURN v_operation_id;
END
$begin_admin_op$;
--> statement-breakpoint
-- CREATE OR REPLACE 保留既有 ACL；仍按 0003/0004 的封闭矩阵显式复述一次。
REVOKE ALL ON FUNCTION public.begin_admin_operation(text, text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.begin_admin_operation(text, text, text, text) TO app_api;
