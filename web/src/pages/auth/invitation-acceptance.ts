import type { WorkspaceSummary } from "@infinite-canvas/contracts";
import type { QueryClient } from "@tanstack/react-query";

import { authClient, unwrapAuthResponse } from "@/lib/auth-client";
import { workspaceKeys, workspacesQueryOptions } from "@/services/api/workspaces";

export type AcceptedInvitationRecord = {
    organizationId: string;
};

export class InvitationSynchronizationError extends Error {
    constructor() {
        super("Accepted Workspace is not available yet");
        this.name = "InvitationSynchronizationError";
    }
}

const acceptanceRequests = new Map<string, Promise<AcceptedInvitationRecord>>();
const synchronizationRequests = new Map<string, Promise<WorkspaceSummary>>();

function requestKey(...parts: string[]) {
    return JSON.stringify(parts);
}

function clearSettledRequest<T>(requests: Map<string, Promise<T>>, key: string, request: Promise<T>) {
    if (requests.get(key) === request) requests.delete(key);
}

export function getAcceptedInvitation(queryClient: QueryClient, userId: string, invitationId: string) {
    return queryClient.getQueryData<AcceptedInvitationRecord>(workspaceKeys.acceptedInvitation(userId, invitationId));
}

export function acceptInvitationOnce(queryClient: QueryClient, userId: string, invitationId: string) {
    const acceptedKey = workspaceKeys.acceptedInvitation(userId, invitationId);
    const accepted = queryClient.getQueryData<AcceptedInvitationRecord>(acceptedKey);
    if (accepted) return Promise.resolve(accepted);

    const key = requestKey(userId, invitationId);
    const activeRequest = acceptanceRequests.get(key);
    if (activeRequest) return activeRequest;

    const request = (async () => {
        const response = unwrapAuthResponse(
            await authClient.organization.acceptInvitation({
                invitationId,
                fetchOptions: { credentials: "include" },
            }),
        );
        const result = { organizationId: response.invitation.organizationId };
        queryClient.setQueryData(acceptedKey, result);
        return result;
    })();
    acceptanceRequests.set(key, request);
    void request.then(
        () => clearSettledRequest(acceptanceRequests, key, request),
        () => clearSettledRequest(acceptanceRequests, key, request),
    );
    return request;
}

export function synchronizeAcceptedWorkspace(queryClient: QueryClient, userId: string, organizationId: string) {
    const key = requestKey(userId, organizationId);
    const activeRequest = synchronizationRequests.get(key);
    if (activeRequest) return activeRequest;

    const listKey = workspaceKeys.list(userId);
    const request = (async () => {
        await queryClient.cancelQueries({ queryKey: listKey, exact: true });
        await queryClient.invalidateQueries({ queryKey: listKey, exact: true, refetchType: "none" });
        const result = await queryClient.fetchQuery(workspacesQueryOptions(userId));
        const workspace = result.workspaces.find((item) => item.id === organizationId);
        if (!workspace) throw new InvitationSynchronizationError();
        return workspace;
    })();
    synchronizationRequests.set(key, request);
    void request.then(
        () => clearSettledRequest(synchronizationRequests, key, request),
        () => clearSettledRequest(synchronizationRequests, key, request),
    );
    return request;
}
