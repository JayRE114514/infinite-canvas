import { Type, type Static } from "typebox";

export const WorkspaceRoleSchema = Type.Union([
    Type.Literal("owner"),
    Type.Literal("admin"),
    Type.Literal("member"),
]);
export type WorkspaceRole = Static<typeof WorkspaceRoleSchema>;

export const WorkspaceTypeSchema = Type.Union([Type.Literal("personal"), Type.Literal("team")]);
export type WorkspaceType = Static<typeof WorkspaceTypeSchema>;

/** 空间状态是封闭枚举，响应里不允许出现任意字符串。 */
export const WorkspaceStatusSchema = Type.Union([
    Type.Literal("active"),
    Type.Literal("suspended"),
    Type.Literal("deactivated"),
]);
export type WorkspaceStatus = Static<typeof WorkspaceStatusSchema>;

/** 邀请只能是 admin 或 member，永远不会返回 owner。 */
export const WorkspaceInvitationRoleSchema = Type.Union([Type.Literal("admin"), Type.Literal("member")]);
export type WorkspaceInvitationRole = Static<typeof WorkspaceInvitationRoleSchema>;

/** Better Auth IDs are opaque strings; consumers must not assume UUID format. */
export const WorkspaceIdSchema = Type.String({ minLength: 1 });
export type WorkspaceId = Static<typeof WorkspaceIdSchema>;

export const WorkspaceSummarySchema = Type.Object({
    id: WorkspaceIdSchema,
    name: Type.String(),
    slug: Type.String(),
    type: WorkspaceTypeSchema,
    status: WorkspaceStatusSchema,
    ownerUserId: Type.String(),
    role: WorkspaceRoleSchema,
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
    deletedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
});
export type WorkspaceSummary = Static<typeof WorkspaceSummarySchema>;

/** 平台管理员读取空间时没有成员角色，不能伪造 WorkspaceSummary.role。 */
export const AdminWorkspaceSchema = Type.Object({
    id: WorkspaceIdSchema,
    name: Type.String(),
    slug: Type.String(),
    type: WorkspaceTypeSchema,
    status: WorkspaceStatusSchema,
    ownerUserId: Type.String(),
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
    deletedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
});
export type AdminWorkspace = Static<typeof AdminWorkspaceSchema>;

export const AdminWorkspaceResponseSchema = Type.Object({ workspace: AdminWorkspaceSchema });
export type AdminWorkspaceResponse = Static<typeof AdminWorkspaceResponseSchema>;

export const WorkspaceListResponseSchema = Type.Object({ workspaces: Type.Array(WorkspaceSummarySchema) });
export type WorkspaceListResponse = Static<typeof WorkspaceListResponseSchema>;

export const WorkspaceResponseSchema = Type.Object({ workspace: WorkspaceSummarySchema });
export type WorkspaceResponse = Static<typeof WorkspaceResponseSchema>;

export const PersonalWorkspaceRepairResponseSchema = Type.Object({ workspace: WorkspaceSummarySchema });
export type PersonalWorkspaceRepairResponse = Static<typeof PersonalWorkspaceRepairResponseSchema>;

export const CreateWorkspaceBodySchema = Type.Object(
    {
        name: Type.String({ minLength: 1, maxLength: 120 }),
        slug: Type.String({ minLength: 1, maxLength: 120, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
    },
    { additionalProperties: false },
);
export type CreateWorkspaceBody = Static<typeof CreateWorkspaceBodySchema>;

export const UpdateWorkspaceBodySchema = Type.Object(
    {
        name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
        slug: Type.Optional(
            Type.String({ minLength: 1, maxLength: 120, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
        ),
    },
    { additionalProperties: false, minProperties: 1 },
);
export type UpdateWorkspaceBody = Static<typeof UpdateWorkspaceBodySchema>;

export const WorkspacePathSchema = Type.Object(
    { workspaceId: WorkspaceIdSchema },
    { additionalProperties: false },
);
export type WorkspacePath = Static<typeof WorkspacePathSchema>;

export const WorkspaceMemberPathSchema = Type.Object(
    { workspaceId: WorkspaceIdSchema, memberId: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
);
export type WorkspaceMemberPath = Static<typeof WorkspaceMemberPathSchema>;

export const WorkspaceInvitationPathSchema = Type.Object(
    { workspaceId: WorkspaceIdSchema, invitationId: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
);
export type WorkspaceInvitationPath = Static<typeof WorkspaceInvitationPathSchema>;

export const WorkspaceMemberSchema = Type.Object({
    id: Type.String(),
    userId: Type.String(),
    role: WorkspaceRoleSchema,
    joinedAt: Type.String({ format: "date-time" }),
    user: Type.Object({
        id: Type.String(),
        name: Type.String(),
        email: Type.String(),
        image: Type.Union([Type.String(), Type.Null()]),
    }),
});
export type WorkspaceMember = Static<typeof WorkspaceMemberSchema>;

export const WorkspaceMembersResponseSchema = Type.Object({
    members: Type.Array(WorkspaceMemberSchema),
    total: Type.Integer({ minimum: 0 }),
});
export type WorkspaceMembersResponse = Static<typeof WorkspaceMembersResponseSchema>;

export const CreateWorkspaceInvitationBodySchema = Type.Object(
    {
        email: Type.String({ format: "email" }),
        role: WorkspaceInvitationRoleSchema,
    },
    { additionalProperties: false },
);
export type CreateWorkspaceInvitationBody = Static<typeof CreateWorkspaceInvitationBodySchema>;

export const WorkspaceInvitationSchema = Type.Object({
    id: Type.String(),
    workspaceId: WorkspaceIdSchema,
    email: Type.String(),
    role: WorkspaceInvitationRoleSchema,
    status: Type.Union([
        Type.Literal("pending"),
        Type.Literal("accepted"),
        Type.Literal("rejected"),
        Type.Literal("canceled"),
    ]),
    inviterId: Type.String(),
    expiresAt: Type.String({ format: "date-time" }),
    createdAt: Type.String({ format: "date-time" }),
});
export type WorkspaceInvitation = Static<typeof WorkspaceInvitationSchema>;

export const WorkspaceInvitationResponseSchema = Type.Object({ invitation: WorkspaceInvitationSchema });
export type WorkspaceInvitationResponse = Static<typeof WorkspaceInvitationResponseSchema>;

export const WorkspaceInvitationsResponseSchema = Type.Object({ invitations: Type.Array(WorkspaceInvitationSchema) });
export type WorkspaceInvitationsResponse = Static<typeof WorkspaceInvitationsResponseSchema>;

/**
 * 接受邀请只接受原始令牌：服务端用它算 SHA-256 摘要去认领邀请。
 * 邀请 ID 不能替代令牌，因此不再有基于路径 ID 的兑换契约。
 */
export const AcceptWorkspaceInvitationBodySchema = Type.Object(
    { token: Type.String({ minLength: 1, maxLength: 512 }) },
    { additionalProperties: false },
);
export type AcceptWorkspaceInvitationBody = Static<typeof AcceptWorkspaceInvitationBodySchema>;

export const AcceptWorkspaceInvitationResponseSchema = Type.Object({ workspaceId: WorkspaceIdSchema });
export type AcceptWorkspaceInvitationResponse = Static<typeof AcceptWorkspaceInvitationResponseSchema>;

export const SuccessResponseSchema = Type.Object({ success: Type.Literal(true) });
export type SuccessResponse = Static<typeof SuccessResponseSchema>;

export const AppErrorResponseSchema = Type.Object({
    error: Type.Object({
        code: Type.String(),
        message: Type.String(),
        retryable: Type.Boolean(),
        requestId: Type.String(),
    }),
});
export type AppErrorResponse = Static<typeof AppErrorResponseSchema>;
