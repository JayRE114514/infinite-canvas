ALTER TABLE "workspace_invitations" RENAME COLUMN "organizationId" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "workspace_invitations" RENAME COLUMN "inviterId" TO "inviter_id";--> statement-breakpoint
ALTER TABLE "workspace_invitations" RENAME COLUMN "expiresAt" TO "expires_at";--> statement-breakpoint
ALTER TABLE "workspace_invitations" RENAME COLUMN "createdAt" TO "created_at";--> statement-breakpoint
ALTER TABLE "workspace_members" RENAME COLUMN "organizationId" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "workspace_members" RENAME COLUMN "userId" TO "user_id";--> statement-breakpoint
ALTER TABLE "workspace_members" RENAME COLUMN "createdAt" TO "joined_at";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME COLUMN "workspace_type" TO "type";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME COLUMN "createdAt" TO "created_at";--> statement-breakpoint
ALTER TABLE "workspace_invitations" DROP CONSTRAINT "workspace_invitations_organizationId_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_invitations" DROP CONSTRAINT "workspace_invitations_inviterId_users_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_members" DROP CONSTRAINT "workspace_members_organizationId_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_members" DROP CONSTRAINT "workspace_members_userId_users_id_fk";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP CONSTRAINT "workspaces_owner_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "workspace_invitations_organizationId_idx";--> statement-breakpoint
DROP INDEX "workspace_members_organizationId_idx";--> statement-breakpoint
DROP INDEX "workspace_members_userId_idx";--> statement-breakpoint
DROP INDEX "workspace_invitations_pending_email_unique";--> statement-breakpoint
DROP INDEX "workspace_members_workspace_user_unique";--> statement-breakpoint
DROP INDEX "workspaces_owner_personal_unique";--> statement-breakpoint
-- 以下为生成后按计划补充的数据转换：生成器只改列名，没有转换遗留时间类型，
-- 也没有为 NOT NULL 列准备回填，直接执行会在既有数据上失败。
-- 遗留 timestamp 列按 UTC 显式解释后转成 timestamptz。
ALTER TABLE "workspaces" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "workspace_members" ALTER COLUMN "joined_at" TYPE timestamptz USING "joined_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "workspace_invitations" ALTER COLUMN "expires_at" TYPE timestamptz USING "expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "workspace_invitations" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- 邀请角色回填后才能收紧为 NOT NULL。
UPDATE "workspace_invitations" SET "role" = 'member' WHERE "role" IS NULL;--> statement-breakpoint
-- 邮箱归一化，并作废上线前所有待处理邀请：
-- 新流程只认应用计算的 SHA-256 摘要，不保留任何兼容兑换路径。
UPDATE "workspace_invitations"
SET "email" = lower(btrim("email")),
    "status" = CASE WHEN "status" = 'pending' THEN 'canceled' ELSE "status" END;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ALTER COLUMN "role" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_members" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
-- token_digest 先可空落地，给不可再兑换的遗留行回填 64 位占位摘要，然后再收紧。
ALTER TABLE "workspace_invitations" ADD COLUMN "token_digest" text;--> statement-breakpoint
UPDATE "workspace_invitations"
SET "token_digest" = md5("id" || ':legacy:1') || md5("id" || ':legacy:2')
WHERE "token_digest" IS NULL;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ALTER COLUMN "token_digest" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_invitations_token_digest_unique" ON "workspace_invitations" USING btree ("token_digest");--> statement-breakpoint
CREATE INDEX "workspace_invitations_workspace_id_idx" ON "workspace_invitations" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_one_active_owner_unique" ON "workspace_members" USING btree ("workspace_id") WHERE role = 'owner' and status = 'active';--> statement-breakpoint
CREATE INDEX "workspace_members_workspace_id_idx" ON "workspace_members" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_invitations_pending_email_unique" ON "workspace_invitations" USING btree ("workspace_id","email") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_workspace_user_unique" ON "workspace_members" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_owner_personal_unique" ON "workspaces" USING btree ("owner_user_id") WHERE type = 'personal';--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "activeOrganizationId";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "logo";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_role_allowed" CHECK (role in ('admin', 'member'));--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_status_allowed" CHECK (status in ('pending', 'accepted', 'rejected', 'canceled'));--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_email_normalized" CHECK (email = lower(btrim(email)));--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_token_digest_length" CHECK (char_length(token_digest) = 64);--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_role_allowed" CHECK (role in ('owner', 'admin', 'member'));--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_status_allowed" CHECK (status in ('active', 'removed'));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_type_allowed" CHECK (type in ('personal', 'team'));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_status_allowed" CHECK (status in ('active', 'suspended', 'deactivated'));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_deleted_at_status_coherent" CHECK ((status = 'deactivated') = (deleted_at is not null));--> statement-breakpoint
-- 以下为生成后按计划补充：延迟到 COMMIT 校验的 owner 不变量。
-- SECURITY DEFINER + 固定 search_path，只读 workspaces / workspace_members 两张授权根表，
-- 因此即使根表启用 RLS，非 owner 的邀请接受事务在提交时也能看到真实 owner。
CREATE OR REPLACE FUNCTION public.assert_workspace_owner_invariant(target_workspace_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $assert_owner$
DECLARE
    workspace_row record;
    matching_owner_count integer;
BEGIN
    SELECT w.id, w.owner_user_id, w.status
    INTO workspace_row
    FROM public.workspaces w
    WHERE w.id = target_workspace_id;

    -- 空间已在同事务内消失时无需校验。
    IF NOT FOUND THEN
        RETURN;
    END IF;

    -- 只有活跃空间必须恰好有一个活跃 owner 成员，且与 owner_user_id 一致。
    IF workspace_row.status <> 'active' THEN
        RETURN;
    END IF;

    SELECT count(*)
    INTO matching_owner_count
    FROM public.workspace_members m
    WHERE m.workspace_id = workspace_row.id
      AND m.role = 'owner'
      AND m.status = 'active'
      AND m.user_id = workspace_row.owner_user_id;

    IF matching_owner_count <> 1 THEN
        RAISE EXCEPTION 'active workspace % must have exactly one active owner member equal to owner_user_id', workspace_row.id
            USING ERRCODE = '23514';
    END IF;
END
$assert_owner$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.assert_workspace_owner_invariant(text) FROM PUBLIC;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.workspaces_owner_invariant_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $workspaces_owner_check$
BEGIN
    PERFORM public.assert_workspace_owner_invariant(NEW.id);
    RETURN NULL;
END
$workspaces_owner_check$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.workspaces_owner_invariant_check() FROM PUBLIC;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.workspace_members_owner_invariant_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $members_owner_check$
BEGIN
    PERFORM public.assert_workspace_owner_invariant(COALESCE(NEW.workspace_id, OLD.workspace_id));
    RETURN NULL;
END
$members_owner_check$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.workspace_members_owner_invariant_check() FROM PUBLIC;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER workspaces_owner_invariant_deferred
AFTER INSERT OR UPDATE ON public.workspaces
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.workspaces_owner_invariant_check();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER workspace_members_owner_invariant_deferred
AFTER INSERT OR UPDATE OR DELETE ON public.workspace_members
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.workspace_members_owner_invariant_check();--> statement-breakpoint
-- 收回 PUBLIC 的应用表权限。业务表授权由 Task 4 的 0004 单独负责，
-- 这里只授予 Better Auth 适配器真实需要的身份表 DML，让身份回归跑在真实 app_api 登录下。
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_api;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users TO app_api;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sessions TO app_api;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounts TO app_api;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.verifications TO app_api;
