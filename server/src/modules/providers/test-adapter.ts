import type {
    ImageCapabilityRequest,
    ProviderAdapter,
    ProviderCallContext,
    ProviderDescriptor,
    ProviderResult,
} from "./adapter.js";

export class TestImageProviderAdapter implements ProviderAdapter {
    readonly descriptor: ProviderDescriptor = {
        adapterId: "test-image",
        adapterVersion: "1",
        capabilityId: "image.generate",
        exactModelId: "test-image-model",
        supportsPolling: false,
        supportsCancellation: false,
    };
    readonly calls: Array<{ request: ImageCapabilityRequest; providerIdempotencyKey: string }> = [];

    constructor(private readonly result: ProviderResult) {}

    async submit(request: ImageCapabilityRequest, context: ProviderCallContext): Promise<ProviderResult> {
        this.calls.push({ request, providerIdempotencyKey: context.providerIdempotencyKey });
        return this.result;
    }
}
