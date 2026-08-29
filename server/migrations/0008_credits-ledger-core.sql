CREATE TABLE "credit_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_accounts_workspace_unique" UNIQUE("workspace_id"),
	CONSTRAINT "credit_accounts_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "credit_accounts_status_allowed" CHECK (status = 'active')
);
--> statement-breakpoint
CREATE TABLE "credit_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"operation_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"kind" text NOT NULL,
	"compensates_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_transactions_workspace_operation_unique" UNIQUE("workspace_id","operation_key"),
	CONSTRAINT "credit_transactions_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "credit_transactions_operation_key_nonempty" CHECK (operation_key <> ''),
	CONSTRAINT "credit_transactions_request_hash_format" CHECK (request_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "credit_transactions_kind_allowed" CHECK (kind in ('adjustment', 'reserve', 'capture', 'release', 'compensation')),
	CONSTRAINT "credit_transactions_compensation_coherent" CHECK ((kind = 'compensation') = (compensates_transaction_id is not null))
);
--> statement-breakpoint
CREATE TABLE "credit_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"credit_account_id" uuid NOT NULL,
	"available_amount" bigint DEFAULT 0 NOT NULL,
	"held_amount" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_wallets_workspace_unique" UNIQUE("workspace_id"),
	CONSTRAINT "credit_wallets_account_unique" UNIQUE("credit_account_id"),
	CONSTRAINT "credit_wallets_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "credit_wallets_available_nonnegative" CHECK (available_amount >= 0),
	CONSTRAINT "credit_wallets_held_nonnegative" CHECK (held_amount >= 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"transaction_id" uuid NOT NULL,
	"wallet_id" uuid,
	"bucket" text NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_bucket_allowed" CHECK (bucket in ('available', 'held', 'platform_clearing')),
	CONSTRAINT "ledger_entries_wallet_coherent" CHECK ((bucket = 'platform_clearing' and wallet_id is null) or (bucket in ('available', 'held') and wallet_id is not null))
);
--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_workspace_compensation_fk" FOREIGN KEY ("workspace_id","compensates_transaction_id") REFERENCES "public"."credit_transactions"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_wallets" ADD CONSTRAINT "credit_wallets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_wallets" ADD CONSTRAINT "credit_wallets_workspace_account_fk" FOREIGN KEY ("workspace_id","credit_account_id") REFERENCES "public"."credit_accounts"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_workspace_transaction_fk" FOREIGN KEY ("workspace_id","transaction_id") REFERENCES "public"."credit_transactions"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_workspace_wallet_fk" FOREIGN KEY ("workspace_id","wallet_id") REFERENCES "public"."credit_wallets"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_transactions_workspace_created_idx" ON "credit_transactions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_workspace_transaction_idx" ON "ledger_entries" USING btree ("workspace_id","transaction_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_workspace_wallet_idx" ON "ledger_entries" USING btree ("workspace_id","wallet_id");
--> statement-breakpoint

-- 每个既有 Workspace 立即拥有一个 Credit Account 与 Wallet；后续 Workspace 由同一迁移拥有的触发器开通。
INSERT INTO public.credit_accounts (workspace_id)
SELECT id FROM public.workspaces;
--> statement-breakpoint
INSERT INTO public.credit_wallets (workspace_id, credit_account_id)
SELECT workspace_id, id FROM public.credit_accounts;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.provision_workspace_credit_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $provision_workspace_credit_account$
DECLARE
    v_account_id uuid;
BEGIN
    INSERT INTO public.credit_accounts (workspace_id)
    VALUES (NEW.id)
    RETURNING id INTO v_account_id;

    INSERT INTO public.credit_wallets (workspace_id, credit_account_id)
    VALUES (NEW.id, v_account_id);

    RETURN NEW;
END
$provision_workspace_credit_account$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.provision_workspace_credit_account() FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint
CREATE TRIGGER workspaces_provision_credit_account
AFTER INSERT ON public.workspaces
FOR EACH ROW EXECUTE FUNCTION public.provision_workspace_credit_account();
--> statement-breakpoint

-- 账务历史只追加；更正必须创建引用原交易的新 compensation transaction。
CREATE OR REPLACE FUNCTION public.reject_credit_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $reject_credit_history_mutation$
BEGIN
    RAISE EXCEPTION 'credit history table % is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END
$reject_credit_history_mutation$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reject_credit_history_mutation() FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint
CREATE TRIGGER credit_transactions_append_only
BEFORE UPDATE OR DELETE ON public.credit_transactions
FOR EACH ROW EXECUTE FUNCTION public.reject_credit_history_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only
BEFORE UPDATE OR DELETE ON public.ledger_entries
FOR EACH ROW EXECUTE FUNCTION public.reject_credit_history_mutation();
--> statement-breakpoint

-- 零和在提交时验证，使一笔业务交易可以在同一事务内分多条语句追加分录。
CREATE OR REPLACE FUNCTION public.assert_credit_transaction_balanced(p_workspace_id text, p_transaction_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $assert_credit_transaction_balanced$
DECLARE
    v_entry_count bigint;
    v_total numeric;
BEGIN
    SELECT count(*), COALESCE(sum(amount), 0)
    INTO v_entry_count, v_total
    FROM public.ledger_entries
    WHERE workspace_id = p_workspace_id
      AND transaction_id = p_transaction_id;

    IF v_entry_count < 2 OR v_total <> 0 THEN
        RAISE EXCEPTION 'credit transaction % is not balanced', p_transaction_id
            USING ERRCODE = '23514', CONSTRAINT = 'credit_transactions_balanced';
    END IF;
END
$assert_credit_transaction_balanced$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.assert_credit_transaction_balanced(text, uuid) FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.check_credit_transaction_balance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $check_credit_transaction_balance$
DECLARE
    v_workspace_id text;
    v_transaction_id uuid;
BEGIN
    IF TG_TABLE_NAME = 'credit_transactions' THEN
        v_workspace_id := NEW.workspace_id;
        v_transaction_id := NEW.id;
    ELSE
        v_workspace_id := COALESCE(NEW.workspace_id, OLD.workspace_id);
        v_transaction_id := COALESCE(NEW.transaction_id, OLD.transaction_id);
    END IF;

    PERFORM public.assert_credit_transaction_balanced(v_workspace_id, v_transaction_id);
    RETURN NULL;
END
$check_credit_transaction_balance$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.check_credit_transaction_balance() FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER credit_transactions_balance_deferred
AFTER INSERT ON public.credit_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.check_credit_transaction_balance();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_balance_deferred
AFTER INSERT OR UPDATE OR DELETE ON public.ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.check_credit_transaction_balance();
--> statement-breakpoint

-- Wallet 是账本投影：提交时 available/held 必须分别等于该 Wallet 的对应分录聚合。
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
    SELECT available_amount, held_amount
    INTO v_available, v_held
    FROM public.credit_wallets
    WHERE workspace_id = p_workspace_id
      AND id = p_wallet_id;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT
        COALESCE(sum(amount) FILTER (WHERE bucket = 'available'), 0),
        COALESCE(sum(amount) FILTER (WHERE bucket = 'held'), 0)
    INTO v_entry_available, v_entry_held
    FROM public.ledger_entries
    WHERE workspace_id = p_workspace_id
      AND wallet_id = p_wallet_id;

    IF v_available::numeric <> v_entry_available OR v_held::numeric <> v_entry_held THEN
        RAISE EXCEPTION 'credit wallet % projection does not match ledger', p_wallet_id
            USING ERRCODE = '23514', CONSTRAINT = 'credit_wallets_projection_matches_ledger';
    END IF;
END
$assert_credit_wallet_projection$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.assert_credit_wallet_projection(text, uuid) FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.check_credit_wallet_projection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $check_credit_wallet_projection$
DECLARE
    v_workspace_id text;
    v_wallet_id uuid;
BEGIN
    IF TG_TABLE_NAME = 'credit_wallets' THEN
        v_workspace_id := NEW.workspace_id;
        v_wallet_id := NEW.id;
    ELSE
        v_workspace_id := COALESCE(NEW.workspace_id, OLD.workspace_id);
        v_wallet_id := COALESCE(NEW.wallet_id, OLD.wallet_id);
    END IF;

    IF v_wallet_id IS NOT NULL THEN
        PERFORM public.assert_credit_wallet_projection(v_workspace_id, v_wallet_id);
    END IF;
    RETURN NULL;
END
$check_credit_wallet_projection$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.check_credit_wallet_projection() FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER credit_wallets_projection_deferred
AFTER INSERT OR UPDATE ON public.credit_wallets
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.check_credit_wallet_projection();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_projection_deferred
AFTER INSERT OR UPDATE OR DELETE ON public.ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.check_credit_wallet_projection();
--> statement-breakpoint

-- 全部积分表直接按 Workspace 默认拒绝；当前切片不向运行期角色授予业务 DML。
REVOKE ALL ON public.credit_accounts, public.credit_wallets, public.credit_transactions, public.ledger_entries
FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint
ALTER TABLE public.credit_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.credit_accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.credit_wallets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.credit_wallets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.credit_transactions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.ledger_entries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.ledger_entries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY credit_accounts_schema_owner_all ON public.credit_accounts
FOR ALL TO schema_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY credit_wallets_schema_owner_all ON public.credit_wallets
FOR ALL TO schema_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY credit_transactions_schema_owner_all ON public.credit_transactions
FOR ALL TO schema_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY ledger_entries_schema_owner_all ON public.ledger_entries
FOR ALL TO schema_owner USING (true) WITH CHECK (true);
