import { assertProviderCapabilities, type ProviderAdapter, type ProviderFetch } from "./adapter.js";
import { GeminiImagesAdapter } from "./gemini-images.js";
import { OpenAIImagesAdapter } from "./openai-images.js";

export type OwnerProviderAdapterOptions = {
    baseUrl: string;
    apiKey: string;
    adapterId: string;
    adapterVersion: string;
    capabilityId: "image.generate";
    exactModelId: string;
    fetch: ProviderFetch;
};

const OWNER_ADAPTER_FACTORIES: Readonly<Record<string, (options: OwnerProviderAdapterOptions) => ProviderAdapter>> = {
    "openai-images-v1": (options) => new OpenAIImagesAdapter(options),
    "gemini-images-v1": (options) => new GeminiImagesAdapter(options),
};

export function createOwnerProviderAdapter(options: OwnerProviderAdapterOptions): ProviderAdapter {
    const create = OWNER_ADAPTER_FACTORIES[options.adapterId];
    if (!create) throw new Error(`Provider Adapter is not owner-registered: ${options.adapterId}`);
    const adapter = create(options);
    assertProviderCapabilities(adapter);
    return adapter;
}

export class ProviderRegistry {
    readonly #adapters = new Map<string, ProviderAdapter>();

    constructor(adapters: readonly ProviderAdapter[]) {
        for (const adapter of adapters) {
            assertProviderCapabilities(adapter);
            const key = `${adapter.descriptor.capabilityId}:${adapter.descriptor.adapterId}`;
            if (this.#adapters.has(key)) throw new Error(`Duplicate Provider Adapter: ${key}`);
            this.#adapters.set(key, adapter);
        }
    }

    get(capabilityId: "image.generate", adapterId: string): ProviderAdapter {
        const adapter = this.#adapters.get(`${capabilityId}:${adapterId}`);
        if (!adapter) throw new Error(`Provider Adapter is not registered: ${capabilityId}:${adapterId}`);
        return adapter;
    }
}
