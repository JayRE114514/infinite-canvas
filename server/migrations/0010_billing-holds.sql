CREATE TABLE "credit_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"billing_order_id" uuid NOT NULL,
	"original_amount" bigint NOT NULL,
	"captured_amount" bigint DEFAULT 0 NOT NULL,
	"released_amount" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"reserve_transaction_id" uuid NOT NULL,
	"close_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "credit_holds_workspace_order_unique" UNIQUE("workspace_id","billing_order_id"),
	CONSTRAINT "credit_holds_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "credit_holds_workspace_reserve_transaction_unique" UNIQUE("workspace_id","reserve_transaction_id"),
	CONSTRAINT "credit_holds_original_positive" CHECK (original_amount > 0),
	CONSTRAINT "credit_holds_amounts_conserved" CHECK (captured_amount >= 0 and released_amount >= 0 and captured_amount + released_amount <= original_amount),
	CONSTRAINT "credit_holds_status_allowed" CHECK (status in ('active', 'closed')),
	CONSTRAINT "credit_holds_status_coherent" CHECK ((status = 'active' and captured_amount + released_amount < original_amount and close_transaction_id is null and closed_at is null) or (status = 'closed' and captured_amount + released_amount = original_amount and close_transaction_id is not null and closed_at is not null))
);
--> statement-breakpoint
CREATE TABLE "billing_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"capability_id" text NOT NULL,
	"price_version" text NOT NULL,
	"price_snapshot" jsonb NOT NULL,
	"estimated_amount" bigint NOT NULL,
	"actual_amount" bigint,
	"status" text DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"review_after" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_orders_workspace_task_unique" UNIQUE("workspace_id","task_id"),
	CONSTRAINT "billing_orders_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "billing_orders_estimated_positive" CHECK (estimated_amount > 0),
	CONSTRAINT "billing_orders_actual_range" CHECK (actual_amount is null or (actual_amount >= 0 and actual_amount <= estimated_amount)),
	CONSTRAINT "billing_orders_status_allowed" CHECK (status in ('reserved', 'settled', 'released', 'review')),
	CONSTRAINT "billing_orders_status_amount_coherent" CHECK ((status in ('reserved', 'review') and actual_amount is null) or (status = 'settled' and actual_amount is not null) or (status = 'released' and actual_amount = 0)),
	CONSTRAINT "billing_orders_review_after_fixed" CHECK (review_after = created_at + interval '24 hours')
);
--> statement-breakpoint
ALTER TABLE "workspace_audit_logs" ADD COLUMN "replayed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD COLUMN "billing_order_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_workspace_billing_order_fk" FOREIGN KEY ("workspace_id","billing_order_id") REFERENCES "public"."billing_orders"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_workspace_reserve_transaction_fk" FOREIGN KEY ("workspace_id","reserve_transaction_id") REFERENCES "public"."credit_transactions"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_workspace_close_transaction_fk" FOREIGN KEY ("workspace_id","close_transaction_id") REFERENCES "public"."credit_transactions"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_orders" ADD CONSTRAINT "billing_orders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_holds_workspace_status_idx" ON "credit_holds" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "billing_orders_workspace_review_idx" ON "billing_orders" USING btree ("workspace_id","status","review_after");--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_workspace_billing_order_fk" FOREIGN KEY ("workspace_id","billing_order_id") REFERENCES "public"."billing_orders"("workspace_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- Billing/Hold 表保持 Workspace 直接作用域与 FORCE RLS；运行期角色只获得窄口函数权限。
REVOKE ALL ON public.billing_orders, public.credit_holds FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint
ALTER TABLE public.billing_orders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.billing_orders FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.credit_holds ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.credit_holds FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY billing_orders_schema_owner_all ON public.billing_orders
FOR ALL TO schema_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY credit_holds_schema_owner_all ON public.credit_holds
FOR ALL TO schema_owner USING (true) WITH CHECK (true);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.assert_credit_workspace_context(p_workspace_id text, p_require_user boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $assert_credit_workspace_context$
DECLARE
    v_workspace_id text := nullif(current_setting('app.workspace_id', true), '');
    v_user_id text := nullif(current_setting('app.user_id', true), '');
BEGIN
    IF v_workspace_id IS NULL OR v_workspace_id <> p_workspace_id THEN
        RAISE EXCEPTION 'credit command requires matching Workspace context' USING ERRCODE = '42501';
    END IF;
    IF p_require_user AND (v_user_id IS NULL OR NOT public.is_active_workspace_member(p_workspace_id, v_user_id)) THEN
        RAISE EXCEPTION 'credit command requires active Workspace membership' USING ERRCODE = '42501';
    END IF;
END
$assert_credit_workspace_context$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.assert_credit_workspace_context(text, boolean)
FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.create_billing_order(
    p_workspace_id text,
    p_task_id uuid,
    p_capability_id text,
    p_price_version text,
    p_price_snapshot jsonb,
    p_estimated_amount bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $create_billing_order$
DECLARE
    v_order_id uuid;
    v_created_at timestamp with time zone := now();
BEGIN
    PERFORM public.assert_credit_workspace_context(p_workspace_id, true);
    IF p_estimated_amount <= 0 OR btrim(p_capability_id) = '' OR btrim(p_price_version) = '' THEN
        RAISE EXCEPTION 'billing order input is invalid' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.billing_orders (
        workspace_id, task_id, capability_id, price_version, price_snapshot,
        estimated_amount, created_at, review_after, updated_at
    ) VALUES (
        p_workspace_id, p_task_id, p_capability_id, p_price_version, p_price_snapshot,
        p_estimated_amount, v_created_at, v_created_at + interval '24 hours', v_created_at
    ) RETURNING id INTO v_order_id;
    RETURN v_order_id;
END
$create_billing_order$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.create_billing_order(text, uuid, text, text, jsonb, bigint)
FROM PUBLIC, app_worker, app_maintenance;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.create_billing_order(text, uuid, text, text, jsonb, bigint) TO app_api;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.reserve_credit_hold(
    p_workspace_id text,
    p_billing_order_id uuid,
    p_amount bigint,
    p_operation_key text,
    p_request_hash text
)
RETURNS TABLE (hold_id uuid, replayed boolean, available_amount bigint, held_amount bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $reserve_credit_hold$
DECLARE
    v_order public.billing_orders%ROWTYPE;
    v_wallet public.credit_wallets%ROWTYPE;
    v_transaction_id uuid;
    v_existing_hash text;
    v_hold_id uuid;
    v_replayed boolean := false;
BEGIN
    PERFORM public.assert_credit_workspace_context(p_workspace_id, true);
    IF p_amount <= 0 OR p_operation_key = '' OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'credit reserve input is invalid' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_order FROM public.billing_orders
    WHERE workspace_id = p_workspace_id AND id = p_billing_order_id FOR UPDATE;
    IF NOT FOUND OR v_order.status <> 'reserved' OR v_order.estimated_amount <> p_amount THEN
        RAISE EXCEPTION 'billing order cannot be reserved' USING ERRCODE = 'P4091';
    END IF;

    SELECT * INTO v_wallet FROM public.credit_wallets
    WHERE workspace_id = p_workspace_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'credit wallet does not exist' USING ERRCODE = 'P4040'; END IF;

    SELECT id, request_hash INTO v_transaction_id, v_existing_hash
    FROM public.credit_transactions
    WHERE workspace_id = p_workspace_id AND operation_key = p_operation_key;
    IF FOUND THEN
        IF v_existing_hash <> p_request_hash THEN
            RAISE EXCEPTION 'credit reserve idempotency conflict' USING ERRCODE = 'P4090';
        END IF;
        SELECT id INTO v_hold_id FROM public.credit_holds
        WHERE workspace_id = p_workspace_id AND reserve_transaction_id = v_transaction_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'credit reserve replay is inconsistent' USING ERRCODE = '23514'; END IF;
        v_replayed := true;
    ELSE
        IF v_wallet.available_amount < p_amount THEN
            RAISE EXCEPTION 'insufficient available credits' USING ERRCODE = 'P4020';
        END IF;
        INSERT INTO public.credit_transactions (workspace_id, operation_key, request_hash, kind, billing_order_id)
        VALUES (p_workspace_id, p_operation_key, p_request_hash, 'reserve', p_billing_order_id)
        RETURNING id INTO v_transaction_id;
        INSERT INTO public.ledger_entries (workspace_id, transaction_id, wallet_id, bucket, amount)
        VALUES
            (p_workspace_id, v_transaction_id, v_wallet.id, 'available', -p_amount),
            (p_workspace_id, v_transaction_id, v_wallet.id, 'held', p_amount);
        UPDATE public.credit_wallets wallet
        SET available_amount = wallet.available_amount - p_amount,
            held_amount = wallet.held_amount + p_amount,
            updated_at = now()
        WHERE wallet.workspace_id = p_workspace_id AND wallet.id = v_wallet.id
        RETURNING wallet.* INTO v_wallet;
        INSERT INTO public.credit_holds (workspace_id, billing_order_id, original_amount, reserve_transaction_id)
        VALUES (p_workspace_id, p_billing_order_id, p_amount, v_transaction_id)
        RETURNING id INTO v_hold_id;
    END IF;

    RETURN QUERY SELECT v_hold_id, v_replayed, v_wallet.available_amount, v_wallet.held_amount;
END
$reserve_credit_hold$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reserve_credit_hold(text, uuid, bigint, text, text)
FROM PUBLIC, app_worker, app_maintenance;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.reserve_credit_hold(text, uuid, bigint, text, text) TO app_api;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.close_credit_hold(
    p_workspace_id text,
    p_hold_id uuid,
    p_kind text,
    p_actual_amount bigint,
    p_operation_key text,
    p_request_hash text
)
RETURNS TABLE (transaction_id uuid, replayed boolean, available_amount bigint, held_amount bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $close_credit_hold$
DECLARE
    v_hold public.credit_holds%ROWTYPE;
    v_wallet public.credit_wallets%ROWTYPE;
    v_transaction_id uuid;
    v_existing_hash text;
    v_replayed boolean := false;
    v_actual bigint;
    v_remaining bigint;
    v_release bigint;
BEGIN
    PERFORM public.assert_credit_workspace_context(p_workspace_id, false);
    IF p_kind NOT IN ('capture', 'release') OR p_operation_key = '' OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'credit Hold close input is invalid' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_hold FROM public.credit_holds
    WHERE workspace_id = p_workspace_id AND id = p_hold_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'credit Hold does not exist' USING ERRCODE = 'P4040'; END IF;
    SELECT * INTO v_wallet FROM public.credit_wallets
    WHERE workspace_id = p_workspace_id FOR UPDATE;

    SELECT id, request_hash INTO v_transaction_id, v_existing_hash
    FROM public.credit_transactions
    WHERE workspace_id = p_workspace_id AND operation_key = p_operation_key;
    IF FOUND THEN
        IF v_existing_hash <> p_request_hash OR v_hold.close_transaction_id IS DISTINCT FROM v_transaction_id THEN
            RAISE EXCEPTION 'credit Hold close idempotency conflict' USING ERRCODE = 'P4090';
        END IF;
        v_replayed := true;
        RETURN QUERY SELECT v_transaction_id, v_replayed, v_wallet.available_amount, v_wallet.held_amount;
        RETURN;
    END IF;
    IF v_hold.status <> 'active' THEN
        RAISE EXCEPTION 'credit Hold is already closed' USING ERRCODE = 'P4091';
    END IF;

    v_remaining := v_hold.original_amount - v_hold.captured_amount - v_hold.released_amount;
    v_actual := CASE WHEN p_kind = 'capture' THEN p_actual_amount ELSE 0 END;
    IF v_actual < 0 OR v_actual > v_remaining THEN
        RAISE EXCEPTION 'captured amount is outside the active Hold' USING ERRCODE = '22023';
    END IF;
    v_release := v_remaining - v_actual;

    INSERT INTO public.credit_transactions (workspace_id, operation_key, request_hash, kind, billing_order_id)
    VALUES (p_workspace_id, p_operation_key, p_request_hash, p_kind, v_hold.billing_order_id)
    RETURNING id INTO v_transaction_id;
    INSERT INTO public.ledger_entries (workspace_id, transaction_id, wallet_id, bucket, amount)
    VALUES
        (p_workspace_id, v_transaction_id, v_wallet.id, 'held', -v_remaining),
        (p_workspace_id, v_transaction_id, v_wallet.id, 'available', v_release),
        (p_workspace_id, v_transaction_id, NULL, 'platform_clearing', v_actual);
    UPDATE public.credit_wallets wallet
    SET available_amount = wallet.available_amount + v_release,
        held_amount = wallet.held_amount - v_remaining,
        updated_at = now()
    WHERE wallet.workspace_id = p_workspace_id AND wallet.id = v_wallet.id
    RETURNING wallet.* INTO v_wallet;
    UPDATE public.credit_holds
    SET captured_amount = captured_amount + v_actual,
        released_amount = released_amount + v_release,
        status = 'closed', close_transaction_id = v_transaction_id, closed_at = now()
    WHERE workspace_id = p_workspace_id AND id = p_hold_id;
    UPDATE public.billing_orders
    SET actual_amount = v_actual,
        status = CASE WHEN p_kind = 'capture' THEN 'settled' ELSE 'released' END,
        updated_at = now()
    WHERE workspace_id = p_workspace_id AND id = v_hold.billing_order_id;

    RETURN QUERY SELECT v_transaction_id, v_replayed, v_wallet.available_amount, v_wallet.held_amount;
END
$close_credit_hold$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.close_credit_hold(text, uuid, text, bigint, text, text)
FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.capture_credit_hold(text, uuid, bigint, text, text)
RETURNS TABLE (transaction_id uuid, replayed boolean, available_amount bigint, held_amount bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $capture_credit_hold$
    SELECT * FROM public.close_credit_hold($1, $2, 'capture', $3, $4, $5);
$capture_credit_hold$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.capture_credit_hold(text, uuid, bigint, text, text) FROM PUBLIC, app_api, app_maintenance;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.capture_credit_hold(text, uuid, bigint, text, text) TO app_worker;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.release_credit_hold(text, uuid, text, text)
RETURNS TABLE (transaction_id uuid, replayed boolean, available_amount bigint, held_amount bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $release_credit_hold$
    SELECT * FROM public.close_credit_hold($1, $2, 'release', 0, $3, $4);
$release_credit_hold$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.release_credit_hold(text, uuid, text, text) FROM PUBLIC, app_api, app_maintenance;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.release_credit_hold(text, uuid, text, text) TO app_worker;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.compensate_credit_capture(
    p_workspace_id text,
    p_capture_transaction_id uuid,
    p_amount bigint,
    p_operation_key text,
    p_request_hash text
)
RETURNS TABLE (transaction_id uuid, replayed boolean, available_amount bigint, held_amount bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $compensate_credit_capture$
DECLARE
    v_hold public.credit_holds%ROWTYPE;
    v_wallet public.credit_wallets%ROWTYPE;
    v_transaction_id uuid;
    v_existing_hash text;
    v_compensated numeric;
    v_replayed boolean := false;
BEGIN
    PERFORM public.assert_credit_workspace_context(p_workspace_id, false);
    IF p_amount <= 0 OR p_operation_key = '' OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'credit compensation input is invalid' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_hold FROM public.credit_holds
    WHERE workspace_id = p_workspace_id AND close_transaction_id = p_capture_transaction_id FOR UPDATE;
    IF NOT FOUND OR v_hold.captured_amount <= 0 THEN
        RAISE EXCEPTION 'captured transaction does not exist' USING ERRCODE = 'P4040';
    END IF;
    SELECT * INTO v_wallet FROM public.credit_wallets WHERE workspace_id = p_workspace_id FOR UPDATE;

    SELECT id, request_hash INTO v_transaction_id, v_existing_hash
    FROM public.credit_transactions WHERE workspace_id = p_workspace_id AND operation_key = p_operation_key;
    IF FOUND THEN
        IF v_existing_hash <> p_request_hash THEN
            RAISE EXCEPTION 'credit compensation idempotency conflict' USING ERRCODE = 'P4090';
        END IF;
        v_replayed := true;
    ELSE
        SELECT COALESCE(sum(entry.amount), 0) INTO v_compensated
        FROM public.credit_transactions tx
        JOIN public.ledger_entries entry
          ON entry.workspace_id = tx.workspace_id AND entry.transaction_id = tx.id
        WHERE tx.workspace_id = p_workspace_id
          AND tx.compensates_transaction_id = p_capture_transaction_id
          AND entry.wallet_id = v_wallet.id AND entry.bucket = 'available';
        IF v_compensated + p_amount > v_hold.captured_amount THEN
            RAISE EXCEPTION 'credit compensation exceeds captured amount' USING ERRCODE = '22023';
        END IF;
        INSERT INTO public.credit_transactions (
            workspace_id, operation_key, request_hash, kind, compensates_transaction_id, billing_order_id
        ) VALUES (
            p_workspace_id, p_operation_key, p_request_hash, 'compensation',
            p_capture_transaction_id, v_hold.billing_order_id
        ) RETURNING id INTO v_transaction_id;
        INSERT INTO public.ledger_entries (workspace_id, transaction_id, wallet_id, bucket, amount)
        VALUES
            (p_workspace_id, v_transaction_id, v_wallet.id, 'available', p_amount),
            (p_workspace_id, v_transaction_id, NULL, 'platform_clearing', -p_amount);
        UPDATE public.credit_wallets wallet
        SET available_amount = wallet.available_amount + p_amount, updated_at = now()
        WHERE wallet.workspace_id = p_workspace_id AND wallet.id = v_wallet.id
        RETURNING wallet.* INTO v_wallet;
    END IF;
    RETURN QUERY SELECT v_transaction_id, v_replayed, v_wallet.available_amount, v_wallet.held_amount;
END
$compensate_credit_capture$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.compensate_credit_capture(text, uuid, bigint, text, text)
FROM PUBLIC, app_api, app_maintenance;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.compensate_credit_capture(text, uuid, bigint, text, text) TO app_worker;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.mark_billing_order_review(p_workspace_id text, p_billing_order_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $mark_billing_order_review$
DECLARE
    v_changed boolean;
BEGIN
    PERFORM public.assert_credit_workspace_context(p_workspace_id, false);
    UPDATE public.billing_orders
    SET status = 'review', updated_at = now()
    WHERE workspace_id = p_workspace_id AND id = p_billing_order_id
      AND status = 'reserved' AND now() >= review_after;
    v_changed := FOUND;
    RETURN v_changed;
END
$mark_billing_order_review$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mark_billing_order_review(text, uuid) FROM PUBLIC, app_api, app_maintenance;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mark_billing_order_review(text, uuid) TO app_worker;
--> statement-breakpoint

-- 审计重放显式标记，避免把每次管理员尝试的 amount 误汇总为新增积分。
CREATE POLICY workspace_audit_logs_schema_owner_select_wallet_adjust ON public.workspace_audit_logs
FOR SELECT TO schema_owner
USING (
    action = 'wallet_adjust'
    AND public.is_current_admin_operation('workspace', 'wallet_adjust', workspace_id)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mark_wallet_adjust_audit_replay()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $mark_wallet_adjust_audit_replay$
BEGIN
    IF NEW.action = 'wallet_adjust' THEN
        NEW.replayed := EXISTS (
            SELECT 1 FROM public.workspace_audit_logs prior
            WHERE prior.workspace_id = NEW.workspace_id
              AND prior.action = 'wallet_adjust'
              AND prior.credit_transaction_id = NEW.credit_transaction_id
        );
    END IF;
    RETURN NEW;
END
$mark_wallet_adjust_audit_replay$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mark_wallet_adjust_audit_replay() FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint
CREATE TRIGGER workspace_audit_logs_mark_wallet_replay
BEFORE INSERT ON public.workspace_audit_logs
FOR EACH ROW EXECUTE FUNCTION public.mark_wallet_adjust_audit_replay();
--> statement-breakpoint

-- 投影检查必须 fail closed；缺少 Wallet 本身就是账务不变量损坏。
CREATE OR REPLACE FUNCTION public.assert_credit_wallet_projection(p_workspace_id text, p_wallet_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $assert_credit_wallet_projection$
DECLARE
    v_available bigint;
    v_held bigint;
    v_entry_available numeric;
    v_entry_held numeric;
BEGIN
    SELECT available_amount, held_amount INTO v_available, v_held
    FROM public.credit_wallets WHERE workspace_id = p_workspace_id AND id = p_wallet_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'credit wallet % is missing', p_wallet_id
            USING ERRCODE = '23514', CONSTRAINT = 'credit_wallets_projection_matches_ledger';
    END IF;
    SELECT
        COALESCE(sum(amount) FILTER (WHERE bucket = 'available'), 0),
        COALESCE(sum(amount) FILTER (WHERE bucket = 'held'), 0)
    INTO v_entry_available, v_entry_held
    FROM public.ledger_entries
    WHERE workspace_id = p_workspace_id AND wallet_id = p_wallet_id;
    IF v_available::numeric <> v_entry_available OR v_held::numeric <> v_entry_held THEN
        RAISE EXCEPTION 'credit wallet % projection does not match ledger', p_wallet_id
            USING ERRCODE = '23514', CONSTRAINT = 'credit_wallets_projection_matches_ledger';
    END IF;
END
$assert_credit_wallet_projection$;
