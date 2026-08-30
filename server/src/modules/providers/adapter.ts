export type ProviderDescriptor = {
    adapterId: string;
    adapterVersion: string;
    capabilityId: "image.generate";
    exactModelId: string;
    supportsPolling: boolean;
    supportsCancellation: boolean;
};

export type ImageCapabilityRequest = { prompt: string };
export type ProviderCallContext = { providerIdempotencyKey: string; signal: AbortSignal };
export type ProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type ProviderBillingFact = { providerRequestId?: string; usage?: Record<string, string> };
export type RedactedProviderError = { code: string; message: string };

export type ProviderResult =
    | { kind: "success"; output: { bytes: Uint8Array; mediaType: string }; billing: ProviderBillingFact }
    | { kind: "safe_retry"; error: RedactedProviderError }
    | { kind: "provider_processing"; remoteTaskId: string }
    | { kind: "terminal"; error: RedactedProviderError }
    | { kind: "ambiguous"; error: RedactedProviderError };

export interface ProviderAdapter {
    readonly descriptor: ProviderDescriptor;
    submit(request: ImageCapabilityRequest, context: ProviderCallContext): Promise<ProviderResult>;
    poll?(remoteTaskId: string, context: ProviderCallContext): Promise<ProviderResult>;
    cancel?(remoteTaskId: string, context: ProviderCallContext): Promise<void>;
}

export function assertProviderCapabilities(adapter: ProviderAdapter): void {
    if (adapter.descriptor.supportsPolling !== Boolean(adapter.poll)) {
        throw new Error(`Provider Adapter ${adapter.descriptor.adapterId} poll capability mismatch`);
    }
    if (adapter.descriptor.supportsCancellation !== Boolean(adapter.cancel)) {
        throw new Error(`Provider Adapter ${adapter.descriptor.adapterId} cancel capability mismatch`);
    }
}
