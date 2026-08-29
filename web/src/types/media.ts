export type ReferenceVideo = {
    id: string;
    name: string;
    type: string;
    url: string;
    storageKey?: string;
    assetId?: string;
    bytes?: number;
    width?: number;
    height?: number;
    durationMs?: number;
};

export type ReferenceAudio = {
    id: string;
    name: string;
    type: string;
    url: string;
    storageKey?: string;
    assetId?: string;
    durationMs?: number;
};

export type HostedMediaSource = {
    nodeId: string;
    kind: "image" | "video" | "audio";
    assetId?: string;
    storageKey?: string;
    fileName: string;
    contentType: string;
};
