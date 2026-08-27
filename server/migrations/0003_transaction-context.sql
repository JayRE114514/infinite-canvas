CREATE TABLE "workspace_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"operation_id" uuid,
	"transaction_xid" "xid8" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_workspace_id" text,
	"purpose" text NOT NULL,
	"request_id" text NOT NULL,
	"transaction_xid" "xid8" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "global_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"action" text NOT NULL,
	"transaction_xid" "xid8" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_admins" (
	"user_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_provisioning_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"source" text NOT NULL,
	"event_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"transaction_xid" "xid8" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_audit_logs" ADD CONSTRAINT "workspace_audit_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_audit_logs" ADD CONSTRAINT "workspace_audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_audit_logs" ADD CONSTRAINT "workspace_audit_logs_operation_id_admin_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."admin_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_operations" ADD CONSTRAINT "admin_operations_admin_user_id_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_audit_logs" ADD CONSTRAINT "global_audit_logs_operation_id_admin_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."admin_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_audit_logs" ADD CONSTRAINT "global_audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_provisioning_audits" ADD CONSTRAINT "workspace_provisioning_audits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_provisioning_audits" ADD CONSTRAINT "workspace_provisioning_audits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_audit_logs_workspace_id_idx" ON "workspace_audit_logs" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_audit_logs_operation_unique" ON "workspace_audit_logs" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "admin_operations_admin_user_id_idx" ON "admin_operations" USING btree ("admin_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_provisioning_audits_user_source_unique" ON "workspace_provisioning_audits" USING btree ("user_id","source");--> statement-breakpoint
ALTER TABLE "workspace_audit_logs" ADD CONSTRAINT "workspace_audit_logs_action_allowed" CHECK (action in ('workspace_read', 'workspace_suspend', 'workspace_deactivate', 'workspace_restore'));--> statement-breakpoint
ALTER TABLE "workspace_audit_logs" ADD CONSTRAINT "workspace_audit_logs_status_allowed" CHECK ((from_status is null or from_status in ('active', 'suspended', 'deactivated')) and (to_status is null or to_status in ('active', 'suspended', 'deactivated')));--> statement-breakpoint
ALTER TABLE "admin_operations" ADD CONSTRAINT "admin_operations_target_kind_allowed" CHECK (target_kind in ('platform', 'workspace'));--> statement-breakpoint
ALTER TABLE "admin_operations" ADD CONSTRAINT "admin_operations_target_coherent" CHECK ((target_kind = 'platform' and target_workspace_id is null) or (target_kind = 'workspace' and target_workspace_id is not null));--> statement-breakpoint
ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_status_allowed" CHECK (status in ('active', 'revoked'));--> statement-breakpoint
ALTER TABLE "workspace_provisioning_audits" ADD CONSTRAINT "workspace_provisioning_audits_source_allowed" CHECK (source in ('email_verification', 'explicit_repair'));--> statement-breakpoint

-- 以下为生成后按计划补充：审计不可变触发器 + 窄口 SECURITY DEFINER 控制函数。
-- 全部函数固定 search_path、使用全限定名、不使用动态 SQL。

-- 审计表只追加：任何 UPDATE / DELETE 一律拒绝，连表主人也不例外。
CREATE OR REPLACE FUNCTION public.reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $reject_audit$
BEGIN
    RAISE EXCEPTION 'audit table % is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END
$reject_audit$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reject_audit_mutation() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER admin_operations_append_only
BEFORE UPDATE OR DELETE ON public.admin_operations
FOR EACH ROW EXECUTE FUNCTION public.reject_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER global_audit_logs_append_only
BEFORE UPDATE OR DELETE ON public.global_audit_logs
FOR EACH ROW EXECUTE FUNCTION public.reject_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER workspace_audit_logs_append_only
BEFORE UPDATE OR DELETE ON public.workspace_audit_logs
FOR EACH ROW EXECUTE FUNCTION public.reject_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER workspace_provisioning_audits_append_only
BEFORE UPDATE OR DELETE ON public.workspace_provisioning_audits
FOR EACH ROW EXECUTE FUNCTION public.reject_audit_mutation();
--> statement-breakpoint
-- 成员判定只读 workspaces / workspace_members 两张授权根表，绝不读叶子资源，
-- 因此可被叶子表策略安全调用而不产生递归。
-- 形参与列名同名时列名优先，这里统一用位置参数消除歧义。
CREATE OR REPLACE FUNCTION public.is_active_workspace_member(workspace_id text, user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $is_active_member$
    SELECT EXISTS (
        SELECT 1
        FROM public.workspaces w
        JOIN public.workspace_members m ON m.workspace_id = w.id
        WHERE w.id = $1
          AND w.status = 'active'
          AND w.deleted_at IS NULL
          AND m.user_id = $2
          AND m.status = 'active'
    );
$is_active_member$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.is_active_workspace_member(text, text) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.is_workspace_manager(workspace_id text, user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $is_manager$
    SELECT EXISTS (
        SELECT 1
        FROM public.workspaces w
        WHERE w.id = $1
          AND w.status = 'active'
          AND w.deleted_at IS NULL
          AND (
              EXISTS (
                  SELECT 1 FROM public.workspace_members m
                  WHERE m.workspace_id = w.id
                    AND m.user_id = $2
                    AND m.status = 'active'
                    AND m.role IN ('owner', 'admin')
              )
              OR (
                  w.owner_user_id = $2
                  AND NOT EXISTS (
                      SELECT 1 FROM public.workspace_members owner_member
                      WHERE owner_member.workspace_id = w.id
                        AND owner_member.role = 'owner'
                        AND owner_member.status = 'active'
                  )
              )
          )
    );
$is_manager$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.is_workspace_manager(text, text) FROM PUBLIC;
--> statement-breakpoint
-- 邀请相关判定只读 users / workspace_invitations。
CREATE OR REPLACE FUNCTION public.is_current_verified_email(candidate_email text, user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $is_verified_email$
    SELECT EXISTS (
        SELECT 1
        FROM public.users u
        WHERE u.id = $2
          AND u."emailVerified"
          AND lower(btrim(u.email)) = lower(btrim($1))
    );
$is_verified_email$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.is_current_verified_email(text, text) FROM PUBLIC;
--> statement-breakpoint
-- Gate 0 暂无调用方：保留此固定协议入口供后续邀请流程使用，但当前策略不依赖它。
CREATE OR REPLACE FUNCTION public.has_accepted_workspace_invitation(workspace_id text, user_id text, role text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $has_accepted_invitation$
    SELECT EXISTS (
        SELECT 1
        FROM public.workspace_invitations i
        JOIN public.users u ON u.id = $2
        WHERE i.workspace_id = $1
          AND i.status = 'accepted'
          AND i.role = $3
          AND u."emailVerified"
          AND i.email = lower(btrim(u.email))
    );
$has_accepted_invitation$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.has_accepted_workspace_invitation(text, text, text) FROM PUBLIC;
--> statement-breakpoint

-- 管理员操作：校验当前活跃管理员身份与用途词表，写入事务 ID，并设置事务局部操作 ID。
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
        IF v_workspace_id IS NOT NULL THEN
            RAISE EXCEPTION 'platform admin operation must not carry a workspace target' USING ERRCODE = '22023';
        END IF;
        IF NOT (v_purpose = ANY (ARRAY[
            'user_read', 'model_read', 'model_write', 'provider_route_read', 'provider_route_write'
        ])) THEN
            RAISE EXCEPTION 'unsupported platform admin purpose %', v_purpose USING ERRCODE = '22023';
        END IF;
    ELSIF v_target_kind = 'workspace' THEN
        IF v_workspace_id IS NULL THEN
            RAISE EXCEPTION 'workspace admin operation requires a workspace target' USING ERRCODE = '22023';
        END IF;
        IF NOT (v_purpose = ANY (ARRAY[
            'workspace_read', 'workspace_suspend', 'workspace_deactivate', 'workspace_restore',
            'wallet_adjust', 'wallet_status_write', 'billing_confirm_charge', 'billing_confirm_no_charge',
            'ledger_compensate', 'workspace_export'
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
-- 策略调用：操作 ID、当前事务、当前用户、目标、用途、行归属与管理员状态必须同时成立。
CREATE OR REPLACE FUNCTION public.is_current_admin_operation(required_target_kind text, required_purpose text, row_workspace_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $is_current_admin_op$
DECLARE
    v_kind text := required_target_kind;
    v_purpose text := required_purpose;
    v_row_workspace_id text := row_workspace_id;
    v_user_id text := nullif(current_setting('app.user_id', true), '');
    v_raw text := nullif(current_setting('app.admin_operation_id', true), '');
    v_operation_id uuid;
BEGIN
    IF v_raw IS NULL OR v_user_id IS NULL THEN
        RETURN false;
    END IF;

    BEGIN
        v_operation_id := v_raw::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
        RETURN false;
    END;

    RETURN EXISTS (
        SELECT 1
        FROM public.admin_operations o
        JOIN public.platform_admins a ON a.user_id = o.admin_user_id AND a.status = 'active'
        WHERE o.id = v_operation_id
          AND o.transaction_xid = pg_current_xact_id()
          AND o.admin_user_id = v_user_id
          AND o.target_kind = v_kind
          AND o.purpose = v_purpose
          AND o.target_workspace_id IS NOT DISTINCT FROM v_row_workspace_id
    );
END
$is_current_admin_op$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.is_current_admin_operation(text, text, text) FROM PUBLIC;
--> statement-breakpoint
-- Workspace 管理员操作的唯一数据边界：不接受目标、用途或 actor 参数，全部从当前 xid 绑定的操作推导。
-- 读取/状态流转、唯一审计和结果返回在同一事务内完成；生命周期只写 status/deleted_at/updated_at。
CREATE OR REPLACE FUNCTION public.execute_workspace_admin_operation()
RETURNS TABLE (
    workspace_id text,
    workspace_name text,
    workspace_slug text,
    workspace_type text,
    workspace_status text,
    owner_user_id text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $execute_workspace_admin_operation$
DECLARE
    v_user_id text := nullif(current_setting('app.user_id', true), '');
    v_raw_operation_id text := nullif(current_setting('app.admin_operation_id', true), '');
    v_operation_id uuid;
    v_operation public.admin_operations%ROWTYPE;
    v_workspace public.workspaces%ROWTYPE;
    v_target_status text;
    v_changed_at timestamp with time zone;
    v_audit_count integer;
    v_updated_count integer;
BEGIN
    IF v_user_id IS NULL OR v_raw_operation_id IS NULL THEN
        RAISE EXCEPTION 'workspace admin execution requires a bound operation' USING ERRCODE = '42501';
    END IF;

    BEGIN
        v_operation_id := v_raw_operation_id::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'workspace admin execution has an invalid operation id' USING ERRCODE = '42501';
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
      AND operation.purpose IN (
          'workspace_read', 'workspace_suspend', 'workspace_deactivate', 'workspace_restore'
      );
    IF NOT FOUND THEN
        RAISE EXCEPTION 'workspace admin execution is not bound to this transaction/user/purpose'
            USING ERRCODE = '42501';
    END IF;

    IF v_operation.purpose = 'workspace_read' THEN
        SELECT workspace.*
        INTO v_workspace
        FROM public.workspaces workspace
        WHERE workspace.id = v_operation.target_workspace_id;
    ELSE
        -- 与邀请容量/owned-context 协议共用 opaque Workspace key；行锁再与合法租户写入串行化。
        PERFORM pg_advisory_xact_lock(hashtextextended(v_operation.target_workspace_id, 0));
        SELECT workspace.*
        INTO v_workspace
        FROM public.workspaces workspace
        WHERE workspace.id = v_operation.target_workspace_id
        FOR UPDATE;
    END IF;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'workspace target does not exist' USING ERRCODE = 'P4040';
    END IF;

    v_target_status := CASE v_operation.purpose
        WHEN 'workspace_read' THEN v_workspace.status
        WHEN 'workspace_suspend' THEN 'suspended'
        WHEN 'workspace_deactivate' THEN 'deactivated'
        WHEN 'workspace_restore' THEN 'active'
    END;

    INSERT INTO public.workspace_audit_logs
        (workspace_id, actor_user_id, action, from_status, to_status, operation_id, transaction_xid)
    VALUES (
        v_workspace.id,
        v_operation.admin_user_id,
        v_operation.purpose,
        v_workspace.status,
        v_target_status,
        v_operation.id,
        pg_current_xact_id()
    );
    GET DIAGNOSTICS v_audit_count = ROW_COUNT;
    IF v_audit_count <> 1 THEN
        RAISE EXCEPTION 'workspace admin execution requires exactly one audit row' USING ERRCODE = 'P0001';
    END IF;

    IF v_operation.purpose = 'workspace_read' THEN
        RETURN QUERY SELECT
            v_workspace.id,
            v_workspace.name,
            v_workspace.slug,
            v_workspace.type,
            v_workspace.status,
            v_workspace.owner_user_id,
            v_workspace.created_at,
            v_workspace.updated_at,
            v_workspace.deleted_at;
        RETURN;
    END IF;

    IF NOT (
        (v_operation.purpose = 'workspace_suspend' AND v_workspace.status = 'active')
        OR (
            v_operation.purpose = 'workspace_deactivate'
            AND v_workspace.status IN ('active', 'suspended')
        )
        OR (
            v_operation.purpose = 'workspace_restore'
            AND v_workspace.status IN ('suspended', 'deactivated')
        )
    ) THEN
        RAISE EXCEPTION 'workspace status transition is invalid' USING ERRCODE = 'P4091';
    END IF;

    v_changed_at := now();
    UPDATE public.workspaces workspace
    SET status = v_target_status,
        deleted_at = CASE WHEN v_target_status = 'deactivated' THEN v_changed_at ELSE NULL END,
        updated_at = v_changed_at
    WHERE workspace.id = v_workspace.id
      AND workspace.status = v_workspace.status
    RETURNING workspace.* INTO v_workspace;
    GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    IF v_updated_count <> 1 THEN
        RAISE EXCEPTION 'workspace status changed concurrently' USING ERRCODE = 'P4092';
    END IF;

    RETURN QUERY SELECT
        v_workspace.id,
        v_workspace.name,
        v_workspace.slug,
        v_workspace.type,
        v_workspace.status,
        v_workspace.owner_user_id,
        v_workspace.created_at,
        v_workspace.updated_at,
        v_workspace.deleted_at;
END
$execute_workspace_admin_operation$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.execute_workspace_admin_operation() FROM PUBLIC;
--> statement-breakpoint
-- 个人空间开通审计的唯一写入口：重放时只在身份一致时返回既有审计 ID，
-- 不一致则抛不变量错误，绝不泄漏 23505，也不静默接受分叉历史。
CREATE OR REPLACE FUNCTION public.record_workspace_provisioning(source text, workspace_id text, event_id text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $record_provisioning$
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
--> statement-breakpoint
-- 逐个签名授予 app_api EXECUTE：控制函数是运行期角色唯一的写入通道，
-- 因此三个运行期角色都不需要 platform_admins / admin_operations / provisioning 的表权限。
GRANT EXECUTE ON FUNCTION public.is_active_workspace_member(text, text) TO app_api;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_workspace_manager(text, text) TO app_api;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_current_verified_email(text, text) TO app_api;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.has_accepted_workspace_invitation(text, text, text) TO app_api;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.begin_admin_operation(text, text, text, text) TO app_api;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_current_admin_operation(text, text, text) TO app_api;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.execute_workspace_admin_operation() TO app_api;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_workspace_provisioning(text, text, text) TO app_api;
