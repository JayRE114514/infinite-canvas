import type { AiTaskEvent, AiTaskResponse, CreateAiTaskResponse, CreditBalanceResponse } from "@infinite-canvas/contracts";

import { platformRequest } from "./platform-client";

export function createPlatformImageTask(workspaceId: string, prompt: string, idempotencyKey: string) {
    return platformRequest<CreateAiTaskResponse>("/ai/tasks", {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: JSON.stringify({ workspaceId, prompt }),
    });
}

export function getPlatformAiTask(workspaceId: string, taskId: string) {
    return platformRequest<AiTaskResponse>(
        `/ai/tasks/${encodeURIComponent(taskId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    ).then((response) => response.task);
}

export function getWorkspaceCreditBalance(workspaceId: string) {
    return platformRequest<CreditBalanceResponse>(
        `/workspaces/${encodeURIComponent(workspaceId)}/credits/balance`,
    ).then((response) => response.balance);
}

export function watchPlatformAiTask(workspaceId: string, taskId: string, onEvent: (event: AiTaskEvent) => void) {
    const source = new EventSource(
        `/api/v1/ai/tasks/${encodeURIComponent(taskId)}/events?workspaceId=${encodeURIComponent(workspaceId)}`,
        { withCredentials: true },
    );
    const listener = (event: MessageEvent<string>) => onEvent(JSON.parse(event.data) as AiTaskEvent);
    for (const type of ["queued", "submitting", "processing", "storing", "succeeded", "failed", "reconciling"]) {
        source.addEventListener(type, listener as EventListener);
    }
    return () => source.close();
}

export function readyAssetContentUrl(assetId: string) {
    return `/api/v1/assets/${encodeURIComponent(assetId)}/content`;
}
