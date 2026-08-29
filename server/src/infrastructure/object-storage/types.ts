export type StoredObject = { key: string; contentType: string; byteSize: number; etag?: string };

/** Only this typed failure proves the uploaded/final bytes cannot satisfy the declared Asset metadata. */
export class ObjectStorageVerificationError extends Error {
    constructor() {
        super("Object storage verification failed");
        this.name = "ObjectStorageVerificationError";
    }
}

export interface ObjectStorage {
    createUpload(input: {
        stagingKey: string;
        contentType: string;
        expiresInSeconds: number;
    }): Promise<{ url: string; headers: Record<string, string> }>;
    completeUpload(input: {
        stagingKey: string;
        finalKey: string;
        expectedContentType: string;
    }): Promise<StoredObject>;
    createReadUrl(input: { key: string; expiresInSeconds: number }): Promise<string>;
    /** Atomically creates one immutable result per owner, or returns the already verified authoritative object. */
    putResult(input: { key: string; ownerId: string; contentType: string; bytes: Uint8Array }): Promise<StoredObject>;
}
