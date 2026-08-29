import type { AcceptWorkspaceInvitationResponse, WorkspaceSummary } from "@infinite-canvas/contracts";
import type { QueryClient } from "@tanstack/react-query";

import { platformRequest } from "@/services/api/platform-client";
import { workspaceKeys, workspacesQueryOptions } from "@/services/api/workspaces";

export type AcceptedInvitationRecord = {
    workspaceId: string;
    generation: number;
};

type SynchronizedWorkspace = {
    workspace: WorkspaceSummary;
    generation: number;
};

class InvitationLifecycleCancelledError extends Error {
    constructor() {
        super("Invitation lifecycle changed");
        this.name = "InvitationLifecycleCancelledError";
    }
}

export class InvitationSynchronizationError extends Error {
    constructor() {
        super("Accepted Workspace is not available yet");
        this.name = "InvitationSynchronizationError";
    }
}

const acceptanceRequests = new Map<string, Promise<AcceptedInvitationRecord>>();
const acceptedInvitations = new Map<string, AcceptedInvitationRecord>();
const synchronizationRequests = new Map<string, Promise<SynchronizedWorkspace>>();
let lifecycleGeneration = 0;

function requestKey(...parts: string[]) {
    return JSON.stringify(parts);
}

function clearSettledRequest<T>(requests: Map<string, Promise<T>>, key: string, request: Promise<T>) {
    if (requests.get(key) === request) requests.delete(key);
}

function assertActiveLifecycle(generation: number) {
    if (generation !== lifecycleGeneration) throw new InvitationLifecycleCancelledError();
}

export function isInvitationLifecycleActive(generation: number) {
    return generation === lifecycleGeneration;
}

export function resetInvitationAcceptanceLifecycle() {
    lifecycleGeneration += 1;
    acceptedInvitations.clear();
    acceptanceRequests.clear();
    synchronizationRequests.clear();
}

export async function clearWorkspaceSessionMemory(queryClient: QueryClient) {
    resetInvitationAcceptanceLifecycle();
    await queryClient.cancelQueries({ queryKey: workspaceKeys.all }).catch(() => undefined);
    queryClient.removeQueries({ queryKey: workspaceKeys.all });
}

export function getAcceptedInvitation(userId: string, token: string) {
    return acceptedInvitations.get(requestKey(userId, token));
}

export function acceptInvitationOnce(queryClient: QueryClient, userId: string, token: string) {
    const acceptedKey = workspaceKeys.acceptedInvitation(userId, token);
    const key = requestKey(userId, token);
    const accepted = acceptedInvitations.get(key);
    if (accepted) return Promise.resolve(accepted);

    const activeRequest = acceptanceRequests.get(key);
    if (activeRequest) return activeRequest;

    const generation = lifecycleGeneration;
    const request = (async () => {
        const response = await platformRequest<AcceptWorkspaceInvitationResponse>(
            "/workspace-invitations/accept",
            { method: "POST", body: JSON.stringify({ token }) },
        );
        assertActiveLifecycle(generation);
        const result = { workspaceId: response.workspaceId, generation };
        acceptedInvitations.set(key, result);
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

export function synchronizeAcceptedWorkspace(queryClient: QueryClient, userId: string, workspaceId: string) {
    const key = requestKey(userId, workspaceId);
    const activeRequest = synchronizationRequests.get(key);
    if (activeRequest) return activeRequest;

    const generation = lifecycleGeneration;
    const listKey = workspaceKeys.list(userId);
    const request = (async () => {
        await queryClient.cancelQueries({ queryKey: listKey, exact: true });
        assertActiveLifecycle(generation);
        await queryClient.invalidateQueries({ queryKey: listKey, exact: true, refetchType: "none" });
        assertActiveLifecycle(generation);
        const result = await queryClient.fetchQuery(workspacesQueryOptions(userId));
        assertActiveLifecycle(generation);
        const workspace = result.workspaces.find((item) => item.id === workspaceId);
        if (!workspace) throw new InvitationSynchronizationError();
        return { workspace, generation };
    })();
    synchronizationRequests.set(key, request);
    void request.then(
        () => clearSettledRequest(synchronizationRequests, key, request),
        () => clearSettledRequest(synchronizationRequests, key, request),
    );
    return request;
}
