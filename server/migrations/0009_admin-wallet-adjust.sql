ALTER TABLE "workspace_audit_logs" DROP CONSTRAINT "workspace_audit_logs_action_allowed";--> statement-breakpoint
ALTER TABLE "workspace_audit_logs" ADD COLUMN "credit_amount" bigint;--> statement-breakpoint
ALTER TABLE "workspace_audit_logs" ADD COLUMN "credit_reason" text;--> statement-breakpoint
ALTER TABLE "workspace_audit_logs" ADD COLUMN "credit_transaction_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_audit_logs" ADD CONSTRAINT "workspace_audit_logs_workspace_credit_transaction_fk" FOREIGN KEY ("workspace_id","credit_transaction_id") REFERENCES "public"."credit_transactions"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_audit_logs_credit_transaction_idx" ON "workspace_audit_logs" USING btree ("workspace_id","credit_transaction_id");--> statement-breakpoint
ALTER TABLE "workspace_audit_logs" ADD CONSTRAINT "workspace_audit_logs_credit_fields_coherent" CHECK ((action = 'wallet_adjust' and from_status is null and to_status is null and credit_amount > 0 and btrim(credit_reason) <> '' and credit_transaction_id is not null) or (action <> 'wallet_adjust' and credit_amount is null and credit_reason is null and credit_transaction_id is null));--> statement-breakpoint
ALTER TABLE "workspace_audit_logs" ADD CONSTRAINT "workspace_audit_logs_action_allowed" CHECK (action in ('workspace_read', 'workspace_suspend', 'workspace_deactivate', 'workspace_restore', 'wallet_adjust'));
--> statement-breakpoint

-- wallet_adjust 只有在 begin、独立窄口、审计 CHECK 与审计 RLS 四层同批齐备后才进入闭世界。
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
        RAISE EXCEPTION 'unsupported platform admin purpose %', v_purpose USING ERRCODE = '22023';
    ELSIF v_target_kind = 'workspace' THEN
        IF v_workspace_id IS NULL THEN
            RAISE EXCEPTION 'workspace admin operation requires a workspace target' USING ERRCODE = '22023';
        END IF;
        IF NOT (v_purpose = ANY (ARRAY[
            'workspace_read', 'workspace_suspend', 'workspace_deactivate', 'workspace_restore', 'wallet_adjust'
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
REVOKE ALL ON FUNCTION public.begin_admin_operation(text, text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.begin_admin_operation(text, text, text, text) TO app_api;
--> statement-breakpoint

-- 赠送积分的独立窄口：只接受业务值，actor/target/purpose/operation/xid 全部从绑定操作推导。
CREATE OR REPLACE FUNCTION public.execute_wallet_adjustment(
    p_amount bigint,
    p_reason text,
    p_operation_key text,
    p_request_hash text
)
RETURNS TABLE (
    transaction_id uuid,
    replayed boolean,
    available_amount bigint,
    held_amount bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $execute_wallet_adjustment$
DECLARE
    v_user_id text := nullif(current_setting('app.user_id', true), '');
    v_raw_operation_id text := nullif(current_setting('app.admin_operation_id', true), '');
    v_operation_id uuid;
    v_operation public.admin_operations%ROWTYPE;
    v_wallet public.credit_wallets%ROWTYPE;
    v_transaction_id uuid;
    v_existing_hash text;
    v_replayed boolean := false;
    v_row_count integer;
BEGIN
    IF v_user_id IS NULL OR v_raw_operation_id IS NULL THEN
        RAISE EXCEPTION 'wallet adjustment requires a bound admin operation' USING ERRCODE = '42501';
    END IF;
    IF p_amount <= 0 OR btrim(p_reason) = '' OR p_operation_key = '' OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'wallet adjustment input is invalid' USING ERRCODE = '22023';
    END IF;

    BEGIN
        v_operation_id := v_raw_operation_id::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'wallet adjustment has an invalid operation id' USING ERRCODE = '42501';
    END;

    SELECT operation.*
    INTO v_operation
    FROM public.admin_operations operation
    JOIN public.platform_admins admin
      ON admin.user_id = operation.admin_user_id
     AND admin.status = 'active'
    WHERE operation.id = v_operation_id
      AND operation.transaction_xid = pg_current_xact_id()
      AND operation.admin_user_id = v_user_id
      AND operation.target_kind = 'workspace'
      AND operation.target_workspace_id IS NOT NULL
      AND operation.purpose = 'wallet_adjust';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'wallet adjustment is not bound to this transaction/user/purpose' USING ERRCODE = '42501';
    END IF;

    SELECT wallet.*
    INTO v_wallet
    FROM public.credit_wallets wallet
    WHERE wallet.workspace_id = v_operation.target_workspace_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'credit wallet does not exist' USING ERRCODE = 'P4040';
    END IF;

    INSERT INTO public.credit_transactions (workspace_id, operation_key, request_hash, kind)
    VALUES (v_wallet.workspace_id, p_operation_key, p_request_hash, 'adjustment')
    ON CONFLICT (workspace_id, operation_key) DO NOTHING
    RETURNING id INTO v_transaction_id;

    IF v_transaction_id IS NULL THEN
        SELECT tx.id, tx.request_hash
        INTO v_transaction_id, v_existing_hash
        FROM public.credit_transactions tx
        WHERE tx.workspace_id = v_wallet.workspace_id
          AND tx.operation_key = p_operation_key;

        IF NOT FOUND OR v_existing_hash <> p_request_hash THEN
            RAISE EXCEPTION 'wallet adjustment idempotency conflict' USING ERRCODE = 'P4090';
        END IF;
        v_replayed := true;
    ELSE
        INSERT INTO public.ledger_entries (workspace_id, transaction_id, wallet_id, bucket, amount)
        VALUES
            (v_wallet.workspace_id, v_transaction_id, v_wallet.id, 'available', p_amount),
            (v_wallet.workspace_id, v_transaction_id, NULL, 'platform_clearing', -p_amount);

        UPDATE public.credit_wallets wallet
        SET available_amount = wallet.available_amount + p_amount,
            updated_at = now()
        WHERE wallet.workspace_id = v_wallet.workspace_id
          AND wallet.id = v_wallet.id
        RETURNING wallet.* INTO v_wallet;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        IF v_row_count <> 1 THEN
            RAISE EXCEPTION 'wallet adjustment requires exactly one Wallet update' USING ERRCODE = 'P0001';
        END IF;
    END IF;

    INSERT INTO public.workspace_audit_logs (
        workspace_id, actor_user_id, action, operation_id,
        credit_amount, credit_reason, credit_transaction_id, transaction_xid
    ) VALUES (
        v_wallet.workspace_id, v_operation.admin_user_id, 'wallet_adjust', v_operation.id,
        p_amount, p_reason, v_transaction_id, pg_current_xact_id()
    );
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    IF v_row_count <> 1 THEN
        RAISE EXCEPTION 'wallet adjustment requires exactly one audit row' USING ERRCODE = 'P0001';
    END IF;

    RETURN QUERY SELECT
        v_transaction_id,
        v_replayed,
        v_wallet.available_amount,
        v_wallet.held_amount;
END
$execute_wallet_adjustment$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.execute_wallet_adjustment(bigint, text, text, text)
FROM PUBLIC, app_worker, app_maintenance;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.execute_wallet_adjustment(bigint, text, text, text) TO app_api;
--> statement-breakpoint

-- 成员只能读取当前 Workspace 的 Wallet 投影；账务历史与写入仍只在深模块窄口内。
GRANT SELECT ON public.credit_wallets TO app_api;
--> statement-breakpoint
CREATE POLICY credit_wallets_api_select_member ON public.credit_wallets
FOR SELECT TO app_api
USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')
    AND public.is_active_workspace_member(workspace_id, nullif(current_setting('app.user_id', true), ''))
);
--> statement-breakpoint

-- 管理员审计策略增加 wallet_adjust 分支，其余 purpose 仍保持原 closed-world。
DROP POLICY workspace_audit_logs_schema_owner_insert_admin ON public.workspace_audit_logs;
--> statement-breakpoint
CREATE POLICY workspace_audit_logs_schema_owner_insert_admin ON public.workspace_audit_logs
FOR INSERT TO schema_owner
WITH CHECK (
    operation_id IS NOT NULL
    AND operation_id::text = nullif(current_setting('app.admin_operation_id', true), '')
    AND actor_user_id = nullif(current_setting('app.user_id', true), '')
    AND transaction_xid = pg_current_xact_id()
    AND (
        (action = 'workspace_read' AND public.is_current_admin_operation('workspace', 'workspace_read', workspace_id))
        OR (action = 'workspace_suspend' AND public.is_current_admin_operation('workspace', 'workspace_suspend', workspace_id))
        OR (action = 'workspace_deactivate' AND public.is_current_admin_operation('workspace', 'workspace_deactivate', workspace_id))
        OR (action = 'workspace_restore' AND public.is_current_admin_operation('workspace', 'workspace_restore', workspace_id))
        OR (action = 'wallet_adjust' AND public.is_current_admin_operation('workspace', 'wallet_adjust', workspace_id))
    )
);
