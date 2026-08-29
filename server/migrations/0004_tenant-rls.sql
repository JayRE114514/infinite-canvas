-- Task 4：默认拒绝的行级安全 + 封闭授权矩阵。
-- 先把业务权限从 PUBLIC 与全部运行期角色收回，再按矩阵逐项授予；矩阵之外一律拒绝。
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_api, app_worker, app_maintenance;
--> statement-breakpoint
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint
-- 三个运行期角色只有 USAGE，没有 CREATE；也都不能访问迁移器的 drizzle 模式。
GRANT USAGE ON SCHEMA public TO app_api, app_worker, app_maintenance;
--> statement-breakpoint
DO $revoke_drizzle$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') THEN
        EXECUTE 'REVOKE ALL ON SCHEMA drizzle FROM PUBLIC, app_api, app_worker, app_maintenance';
    END IF;
END
$revoke_drizzle$;
--> statement-breakpoint
-- 身份表：Better Auth 适配器需要完整生命周期，只有 app_api 拥有。
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users TO app_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sessions TO app_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounts TO app_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.verifications TO app_api;
--> statement-breakpoint
-- 业务表：命令与可更新列都显式列举，标识、归属和历史列不可改写。
GRANT SELECT, INSERT ON public.workspaces TO app_api;
--> statement-breakpoint
GRANT UPDATE (name, slug, status, deleted_at, updated_at) ON public.workspaces TO app_api;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.workspace_members TO app_api;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.workspace_invitations TO app_api;
--> statement-breakpoint
GRANT UPDATE (status) ON public.workspace_invitations TO app_api;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.canvases TO app_api;
--> statement-breakpoint
GRANT UPDATE (title, snapshot_json, revision, updated_by, updated_at, deleted_at) ON public.canvases TO app_api;
--> statement-breakpoint
GRANT INSERT ON public.workspace_audit_logs TO app_api;
--> statement-breakpoint
-- 运维只读：仅空间的 id 与 status 两列，且没有任何写权限。
GRANT SELECT (id, status) ON public.workspaces TO app_maintenance;
--> statement-breakpoint
-- 启用 RLS：授权根表 ENABLE（便于窄口 definer 函数无递归读取），叶子表 FORCE。
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.workspace_invitations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.canvases ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.workspace_audit_logs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.workspace_invitations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.canvases FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.workspace_audit_logs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- workspaces：读取是"用户维度"的，不要求空间上下文，因此只读列表路由可用。
CREATE POLICY workspaces_api_select_member ON public.workspaces
FOR SELECT TO app_api
USING (
    EXISTS (
        SELECT 1
        FROM public.workspace_members member
        WHERE member.workspace_id = workspaces.id
          AND member.user_id = nullif(current_setting('app.user_id', true), '')
          AND member.status = 'active'
    )
);
--> statement-breakpoint
-- 自建空间：新行的 owner 必须是当前用户。
CREATE POLICY workspaces_api_insert_self ON public.workspaces
FOR INSERT TO app_api
WITH CHECK (
    owner_user_id = nullif(current_setting('app.user_id', true), '')
    AND status = 'active'
    AND deleted_at IS NULL
);
--> statement-breakpoint
-- 租户改写必须同时命中精确空间上下文与管理角色。
CREATE POLICY workspaces_api_update_manager ON public.workspaces
FOR UPDATE TO app_api
USING (id = nullif(current_setting('app.workspace_id', true), '') AND public.is_workspace_manager(id, nullif(current_setting('app.user_id', true), '')))
WITH CHECK (
    id = nullif(current_setting('app.workspace_id', true), '')
    AND status = 'active'
    AND deleted_at IS NULL
    AND public.is_workspace_manager(id, nullif(current_setting('app.user_id', true), ''))
);
--> statement-breakpoint
-- owner 下线团队空间：只有当前上下文中的 owner_user_id 本人可以 active -> deactivated。
CREATE POLICY workspaces_api_update_owner_deactivate ON public.workspaces
FOR UPDATE TO app_api
USING (
    id = nullif(current_setting('app.workspace_id', true), '')
    AND owner_user_id = nullif(current_setting('app.user_id', true), '')
    AND type = 'team'
    AND status = 'active'
    AND deleted_at IS NULL
)
WITH CHECK (
    id = nullif(current_setting('app.workspace_id', true), '')
    AND owner_user_id = nullif(current_setting('app.user_id', true), '')
    AND type = 'team'
    AND status = 'deactivated'
    AND deleted_at IS NOT NULL
);
--> statement-breakpoint
-- 运维读取整个全局候选集，列级授权已把可见列限制为 id 与 status。
CREATE POLICY workspaces_maintenance_select ON public.workspaces
FOR SELECT TO app_maintenance
USING (true);
--> statement-breakpoint
-- workspace_members 自读直接比较 user_id，绝不递归查询本表。
CREATE POLICY workspace_members_api_select_self ON public.workspace_members
FOR SELECT TO app_api
USING (user_id = nullif(current_setting('app.user_id', true), ''));
--> statement-breakpoint
-- 同空间成员列表：成员判定走 definer 函数，不构成策略递归。
CREATE POLICY workspace_members_api_select_workspace ON public.workspace_members
FOR SELECT TO app_api
USING (workspace_id = nullif(current_setting('app.workspace_id', true), '') AND public.is_active_workspace_member(workspace_id, nullif(current_setting('app.user_id', true), '')));
--> statement-breakpoint
-- 建空间时写入自己的 owner 成员行。
CREATE POLICY workspace_members_api_insert_self_owner ON public.workspace_members
FOR INSERT TO app_api
WITH CHECK (
    user_id = nullif(current_setting('app.user_id', true), '')
    AND role = 'owner'
    AND status = 'active'
    AND public.is_workspace_manager(workspace_id, nullif(current_setting('app.user_id', true), ''))
);
--> statement-breakpoint
-- 邀请接受事务在成员建立前，可读取已认领邀请所指向空间的现有成员用于容量检查。
CREATE POLICY workspace_members_api_select_accepted_recipient ON public.workspace_members
FOR SELECT TO app_api
USING (
    EXISTS (
        SELECT 1 FROM public.workspace_invitations accepted_invitation
        WHERE accepted_invitation.workspace_id = workspace_members.workspace_id
          AND accepted_invitation.status = 'accepted'
          AND public.is_current_verified_email(accepted_invitation.email, nullif(current_setting('app.user_id', true), ''))
    )
);
--> statement-breakpoint
-- 接受邀请只能把"当前已验证邮箱的接收人本人"加入，且角色必须与邀请一致。
CREATE POLICY workspace_members_api_insert_invited ON public.workspace_members
FOR INSERT TO app_api
WITH CHECK (
    user_id = nullif(current_setting('app.user_id', true), '')
    AND role <> 'owner'
    AND EXISTS (
        SELECT 1 FROM public.workspace_invitations accepted_invitation
        WHERE accepted_invitation.workspace_id = workspace_members.workspace_id
          AND accepted_invitation.status = 'accepted'
          AND accepted_invitation.role = workspace_members.role
          AND public.is_current_verified_email(accepted_invitation.email, nullif(current_setting('app.user_id', true), ''))
    )
);
--> statement-breakpoint
-- 移除成员需要精确空间上下文与管理角色；owner 由服务层条件删除排除。
CREATE POLICY workspace_members_api_delete_manager ON public.workspace_members
FOR DELETE TO app_api
USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')
    AND role <> 'owner'
    AND public.is_workspace_manager(workspace_id, nullif(current_setting('app.user_id', true), ''))
);
--> statement-breakpoint
-- 邀请：读写都要求精确空间上下文与管理角色。
CREATE POLICY workspace_invitations_api_select_manager ON public.workspace_invitations
FOR SELECT TO app_api
USING (workspace_id = nullif(current_setting('app.workspace_id', true), '') AND public.is_workspace_manager(workspace_id, nullif(current_setting('app.user_id', true), '')));
--> statement-breakpoint
-- 接收人凭令牌认领时没有空间上下文，只允许读到发给自己已验证邮箱的邀请。
CREATE POLICY workspace_invitations_api_select_recipient ON public.workspace_invitations
FOR SELECT TO app_api
USING (public.is_current_verified_email(email, nullif(current_setting('app.user_id', true), '')));
--> statement-breakpoint
CREATE POLICY workspace_invitations_api_insert_manager ON public.workspace_invitations
FOR INSERT TO app_api
WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')
    AND public.is_workspace_manager(workspace_id, nullif(current_setting('app.user_id', true), ''))
    AND inviter_id = nullif(current_setting('app.user_id', true), '')
);
--> statement-breakpoint
-- 管理员只能 pending -> canceled；接收人只能在未过期时 pending -> accepted/rejected。
CREATE POLICY workspace_invitations_api_update_manager ON public.workspace_invitations
FOR UPDATE TO app_api
USING (
    status = 'pending'
    AND workspace_id = nullif(current_setting('app.workspace_id', true), '')
    AND public.is_workspace_manager(workspace_id, nullif(current_setting('app.user_id', true), ''))
)
WITH CHECK (
    status = 'canceled'
    AND workspace_id = nullif(current_setting('app.workspace_id', true), '')
    AND public.is_workspace_manager(workspace_id, nullif(current_setting('app.user_id', true), ''))
);
--> statement-breakpoint
CREATE POLICY workspace_invitations_api_update_recipient ON public.workspace_invitations
FOR UPDATE TO app_api
USING (
    status = 'pending'
    AND expires_at > now()
    AND public.is_current_verified_email(email, nullif(current_setting('app.user_id', true), ''))
)
WITH CHECK (
    status IN ('accepted', 'rejected')
    AND expires_at > now()
    AND public.is_current_verified_email(email, nullif(current_setting('app.user_id', true), ''))
);
--> statement-breakpoint
-- 邀请已被当前已验证邮箱认领后，允许同事务读取目标空间并加锁。
CREATE POLICY workspaces_api_select_accepted_recipient ON public.workspaces
FOR SELECT TO app_api
USING (
    EXISTS (
        SELECT 1 FROM public.workspace_invitations accepted_invitation
        WHERE accepted_invitation.workspace_id = workspaces.id
          AND accepted_invitation.status = 'accepted'
          AND public.is_current_verified_email(accepted_invitation.email, nullif(current_setting('app.user_id', true), ''))
    )
);
--> statement-breakpoint
-- 画布：必须同时命中精确空间上下文与活跃成员身份。
-- SELECT 不以 deleted_at 作为策略谓词：软删除由服务层过滤，
-- 以便后续 Gate 的授权删除仍能锁定已删除行并返回持久回执。
CREATE POLICY canvases_api_select_member ON public.canvases
FOR SELECT TO app_api
USING (workspace_id = nullif(current_setting('app.workspace_id', true), '') AND public.is_active_workspace_member(workspace_id, nullif(current_setting('app.user_id', true), '')));
--> statement-breakpoint
CREATE POLICY canvases_api_insert_member ON public.canvases
FOR INSERT TO app_api
WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '') AND public.is_active_workspace_member(workspace_id, nullif(current_setting('app.user_id', true), '')));
--> statement-breakpoint
CREATE POLICY canvases_api_update_member ON public.canvases
FOR UPDATE TO app_api
USING (workspace_id = nullif(current_setting('app.workspace_id', true), '') AND public.is_active_workspace_member(workspace_id, nullif(current_setting('app.user_id', true), '')))
WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '') AND public.is_active_workspace_member(workspace_id, nullif(current_setting('app.user_id', true), '')));
--> statement-breakpoint
-- 空间审计只追加：app_api 仅保留 owner 自助下线路径。
CREATE POLICY workspace_audit_logs_api_insert_owner ON public.workspace_audit_logs
FOR INSERT TO app_api
WITH CHECK (
    operation_id IS NULL
    AND actor_user_id = nullif(current_setting('app.user_id', true), '')
    AND workspace_id = nullif(current_setting('app.workspace_id', true), '')
    AND action = 'workspace_deactivate'
    AND from_status = 'active'
    AND to_status = 'deactivated'
    AND transaction_xid = pg_current_xact_id()
    AND EXISTS (
        SELECT 1 FROM public.workspace_members m
        WHERE m.workspace_id = workspace_audit_logs.workspace_id
          AND m.user_id = nullif(current_setting('app.user_id', true), '')
          AND m.role = 'owner'
          AND m.status = 'active'
    )
);
--> statement-breakpoint
-- FORCE RLS 下，schema_owner 也只能由 xid 绑定的管理员操作写入精确匹配的审计。
-- app_api 本身不命中此策略；管理员审计只能在 execute_workspace_admin_operation() 内产生。
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
    )
);
--> statement-breakpoint
-- 0004 先全量收回函数权限，再只恢复八个签名明确的 app_api 控制入口。
GRANT EXECUTE ON FUNCTION public.is_active_workspace_member(text, text) TO app_api;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_workspace_manager(text, text) TO app_api;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_current_verified_email(text, text) TO app_api;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.has_accepted_workspace_invitation(text, text, text) TO app_api;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.begin_admin_operation(text, text, text, text) TO app_api;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_current_admin_operation(text, text, text) TO app_api;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.execute_workspace_admin_operation() TO app_api;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_workspace_provisioning(text, text, text) TO app_api;
