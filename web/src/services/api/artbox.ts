import type { ArtBoxVideoGeneration, ArtBoxVideoGenerationResponse, CreateArtBoxVideoGenerationBody } from "@infinite-canvas/contracts";

import { platformRequest } from "./platform-client";

function generationCollectionPath(workspaceId: string) {
    return `/workspaces/${encodeURIComponent(workspaceId)}/integrations/artbox/video-generations`;
}

export async function createArtBoxVideoGeneration(workspaceId: string, body: CreateArtBoxVideoGenerationBody, idempotencyKey: string, signal?: AbortSignal): Promise<ArtBoxVideoGeneration> {
    const response = await platformRequest<ArtBoxVideoGenerationResponse>(generationCollectionPath(workspaceId), {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(body),
        signal,
    });
    return response.generation;
}

export async function pollArtBoxVideoGeneration(workspaceId: string, generationId: string, signal?: AbortSignal): Promise<ArtBoxVideoGeneration> {
    const response = await platformRequest<ArtBoxVideoGenerationResponse>(`${generationCollectionPath(workspaceId)}/${encodeURIComponent(generationId)}/poll`, { method: "POST", signal });
    return response.generation;
}
