import { Type, type Static } from "typebox";

export const WorkspaceRoleSchema = Type.Union([
    Type.Literal("owner"),
    Type.Literal("admin"),
    Type.Literal("member"),
]);
export type WorkspaceRole = Static<typeof WorkspaceRoleSchema>;

export const WorkspaceTypeSchema = Type.Union([Type.Literal("personal"), Type.Literal("team")]);
export type WorkspaceType = Static<typeof WorkspaceTypeSchema>;

export const WorkspaceSummarySchema = Type.Object({
    id: Type.String(),
    name: Type.String(),
    slug: Type.String(),
    type: WorkspaceTypeSchema,
    status: Type.String(),
    ownerUserId: Type.String(),
    role: WorkspaceRoleSchema,
    createdAt: Type.String({ format: "date-time" }),
});
export type WorkspaceSummary = Static<typeof WorkspaceSummarySchema>;

export const WorkspaceListResponseSchema = Type.Object({ workspaces: Type.Array(WorkspaceSummarySchema) });
export type WorkspaceListResponse = Static<typeof WorkspaceListResponseSchema>;

export const WorkspaceResponseSchema = Type.Object({ workspace: WorkspaceSummarySchema });
export type WorkspaceResponse = Static<typeof WorkspaceResponseSchema>;

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
    { workspaceId: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
);
export type WorkspacePath = Static<typeof WorkspacePathSchema>;

export const WorkspaceMemberPathSchema = Type.Object(
    { workspaceId: Type.String({ minLength: 1 }), memberId: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
);
export type WorkspaceMemberPath = Static<typeof WorkspaceMemberPathSchema>;

export const WorkspaceInvitationPathSchema = Type.Object(
    { workspaceId: Type.String({ minLength: 1 }), invitationId: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
);
export type WorkspaceInvitationPath = Static<typeof WorkspaceInvitationPathSchema>;

export const WorkspaceMemberSchema = Type.Object({
    id: Type.String(),
    userId: Type.String(),
    role: WorkspaceRoleSchema,
    createdAt: Type.String({ format: "date-time" }),
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
        role: Type.Union([Type.Literal("admin"), Type.Literal("member")]),
    },
    { additionalProperties: false },
);
export type CreateWorkspaceInvitationBody = Static<typeof CreateWorkspaceInvitationBodySchema>;

export const WorkspaceInvitationSchema = Type.Object({
    id: Type.String(),
    workspaceId: Type.String(),
    email: Type.String(),
    role: WorkspaceRoleSchema,
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
