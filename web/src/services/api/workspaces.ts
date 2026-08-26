import type {
    CreateWorkspaceBody,
    CreateWorkspaceInvitationBody,
    SuccessResponse,
    WorkspaceInvitationResponse,
    WorkspaceListResponse,
    WorkspaceMembersResponse,
    WorkspaceResponse,
} from "@infinite-canvas/contracts";
import { queryOptions } from "@tanstack/react-query";

import { authClient, unwrapAuthResponse } from "@/lib/auth-client";
import { platformRequest } from "@/services/api/platform-client";

const workspaceRootKey = ["platform", "workspaces"] as const;

export const workspaceKeys = {
    all: workspaceRootKey,
    lists: [...workspaceRootKey, "list"] as const,
    list: (userId: string) => [...workspaceRootKey, "list", userId] as const,
    members: (userId: string, workspaceId: string) => [...workspaceRootKey, workspaceId, "members", userId] as const,
    invitations: (userId: string, workspaceId: string) => [...workspaceRootKey, workspaceId, "invitations", userId] as const,
};

export function workspacesQueryOptions(userId: string) {
    return queryOptions({
        queryKey: workspaceKeys.list(userId),
        queryFn: () => platformRequest<WorkspaceListResponse>("/workspaces"),
    });
}

export function workspaceMembersQueryOptions(userId: string, workspaceId: string) {
    return queryOptions({
        queryKey: workspaceKeys.members(userId, workspaceId),
        queryFn: () => platformRequest<WorkspaceMembersResponse>(`/workspaces/${encodeURIComponent(workspaceId)}/members`),
    });
}

export function workspaceInvitationsQueryOptions(userId: string, workspaceId: string) {
    return queryOptions({
        queryKey: workspaceKeys.invitations(userId, workspaceId),
        queryFn: async () => {
            const invitations = unwrapAuthResponse(
                await authClient.organization.listInvitations({
                    query: { organizationId: workspaceId },
                    fetchOptions: { credentials: "include" },
                }),
            );
            return invitations.filter((invitation) => invitation.status === "pending");
        },
    });
}

export function createWorkspace(body: CreateWorkspaceBody) {
    return platformRequest<WorkspaceResponse>("/workspaces", { method: "POST", body: JSON.stringify(body) });
}

export function inviteWorkspaceMember(workspaceId: string, body: CreateWorkspaceInvitationBody) {
    return platformRequest<WorkspaceInvitationResponse>(`/workspaces/${encodeURIComponent(workspaceId)}/invitations`, {
        method: "POST",
        body: JSON.stringify(body),
    });
}

export function cancelWorkspaceInvitation(workspaceId: string, invitationId: string) {
    return platformRequest<SuccessResponse>(`/workspaces/${encodeURIComponent(workspaceId)}/invitations/${encodeURIComponent(invitationId)}`, { method: "DELETE" });
}

export function removeWorkspaceMember(workspaceId: string, memberId: string) {
    return platformRequest<SuccessResponse>(`/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(memberId)}`, { method: "DELETE" });
}
