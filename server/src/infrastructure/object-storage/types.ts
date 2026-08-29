export type StoredObject = { key: string; contentType: string; byteSize: number; etag?: string };

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
    putResult(input: { key: string; contentType: string; bytes: Uint8Array }): Promise<StoredObject>;
}
