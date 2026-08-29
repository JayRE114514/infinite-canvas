import type { Asset, AssetUpload, CreateAssetBody, CreateAssetResponse, ReadAssetResponse } from "@infinite-canvas/contracts";

import { platformRequest } from "./platform-client";

function assetCollectionPath(workspaceId: string) {
    return `/workspaces/${encodeURIComponent(workspaceId)}/assets`;
}

function assetPath(workspaceId: string, assetId: string) {
    return `${assetCollectionPath(workspaceId)}/${encodeURIComponent(assetId)}`;
}

export function createAsset(workspaceId: string, body: CreateAssetBody) {
    return platformRequest<CreateAssetResponse>(assetCollectionPath(workspaceId), { method: "POST", body: JSON.stringify(body) });
}

export async function uploadAsset(upload: AssetUpload, blob: Blob, signal?: AbortSignal) {
    const response = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: blob, credentials: "omit", signal });
    if (!response.ok) throw new Error("Asset upload failed");
}

export async function completeAsset(workspaceId: string, assetId: string): Promise<Asset> {
    const response = await platformRequest<{ asset: Asset }>(`${assetPath(workspaceId, assetId)}/complete`, { method: "POST" });
    return response.asset;
}

export function readAsset(workspaceId: string, assetId: string) {
    return platformRequest<ReadAssetResponse>(assetPath(workspaceId, assetId));
}
