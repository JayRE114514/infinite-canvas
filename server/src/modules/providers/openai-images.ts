import { Buffer } from "node:buffer";

import { fileTypeFromBuffer } from "file-type";

import type {
    ImageCapabilityRequest,
    ProviderAdapter,
    ProviderBillingFact,
    ProviderCallContext,
    ProviderDescriptor,
    ProviderFetch,
    ProviderResult,
} from "./adapter.js";

export type { ProviderFetch } from "./adapter.js";

export type OpenAIImagesAdapterOptions = {
    baseUrl: string;
    apiKey: string;
    adapterId: string;
    adapterVersion: string;
    capabilityId: "image.generate";
    exactModelId: string;
    fetch: ProviderFetch;
};

type ImageOutput = { bytes: Uint8Array; mediaType: string };

const TERMINAL_REJECTION_STATUSES = new Set([400, 401, 403, 404, 405, 413, 415, 422]);

export class OpenAIImagesAdapter implements ProviderAdapter {
    readonly descriptor: ProviderDescriptor;
    readonly #apiKey: string;
    readonly #endpoint: URL;
    readonly #fetch: ProviderFetch;

    constructor(options: OpenAIImagesAdapterOptions) {
        for (const name of ["baseUrl", "apiKey", "adapterId", "adapterVersion", "capabilityId", "exactModelId"] as const) {
            if (typeof options[name] !== "string" || options[name].length === 0) {
                throw new Error(`Invalid Provider Adapter configuration: ${name}`);
            }
        }
        if (typeof options.fetch !== "function") throw new Error("Invalid Provider Adapter configuration: fetch");

        let endpoint: URL;
        try {
            endpoint = new URL(options.baseUrl);
            if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error();
        } catch {
            throw new Error("Invalid Provider Adapter configuration: baseUrl");
        }
        endpoint.hash = "";
        endpoint.search = "";
        endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/images/generations`;

        this.descriptor = {
            adapterId: options.adapterId,
            adapterVersion: options.adapterVersion,
            capabilityId: options.capabilityId,
            exactModelId: options.exactModelId,
            supportsPolling: false,
            supportsCancellation: false,
        };
        this.#apiKey = options.apiKey;
        this.#endpoint = endpoint;
        this.#fetch = options.fetch;
    }

    async submit(request: ImageCapabilityRequest, context: ProviderCallContext): Promise<ProviderResult> {
        let response: Response;
        try {
            response = await this.#fetch(this.#endpoint, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${this.#apiKey}`,
                    "content-type": "application/json",
                    "idempotency-key": context.providerIdempotencyKey,
                },
                body: JSON.stringify({ model: this.descriptor.exactModelId, prompt: request.prompt }),
                signal: context.signal,
            });
        } catch {
            return ambiguous("provider_request_unconfirmed", "Provider request outcome could not be confirmed");
        }

        if (!response.ok) return classifyHttpFailure(response.status);

        let payload: unknown;
        try {
            payload = await response.json();
        } catch {
            return ambiguous("provider_response_invalid", "Provider success response could not be verified");
        }

        const image = readFirstImage(payload);
        if (!image) return ambiguous("provider_output_missing", "Provider success response contained no verifiable output");

        let output: ImageOutput;
        try {
            output = "b64_json" in image
                ? await decodeImage(image.b64_json)
                : await this.#downloadImage(image.url, context.signal);
        } catch {
            return ambiguous("provider_output_unconfirmed", "Provider output could not be verified");
        }

        return {
            kind: "success",
            output,
            billing: readBillingFact(payload, response.headers),
        };
    }

    async #downloadImage(url: string, signal: AbortSignal): Promise<ImageOutput> {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
        const response = await this.#fetch(parsed, { signal });
        if (!response.ok) throw new Error();
        return inspectImage(new Uint8Array(await response.arrayBuffer()));
    }
}

function classifyHttpFailure(status: number): ProviderResult {
    const error = { code: `provider_http_${status}`, message: "Provider rejected or did not confirm the request" };
    if (status === 429) return { kind: "safe_retry", error };
    if (TERMINAL_REJECTION_STATUSES.has(status)) return { kind: "terminal", error };
    return { kind: "ambiguous", error };
}

function ambiguous(code: string, message: string): ProviderResult {
    return { kind: "ambiguous", error: { code, message } };
}

function readFirstImage(payload: unknown): { b64_json: string } | { url: string } | null {
    if (!isRecord(payload) || !Array.isArray(payload.data) || !isRecord(payload.data[0])) return null;
    const image = payload.data[0];
    if (typeof image.b64_json === "string" && image.b64_json.length > 0) return { b64_json: image.b64_json };
    if (typeof image.url === "string" && image.url.length > 0) return { url: image.url };
    return null;
}

async function decodeImage(base64: string): Promise<ImageOutput> {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error();
    return inspectImage(Uint8Array.from(Buffer.from(base64, "base64")));
}

async function inspectImage(bytes: Uint8Array): Promise<ImageOutput> {
    const detected = await fileTypeFromBuffer(bytes);
    if (!detected?.mime.startsWith("image/")) throw new Error();
    return { bytes, mediaType: detected.mime };
}

function readBillingFact(payload: unknown, headers: Headers): ProviderBillingFact {
    const body = isRecord(payload) ? payload : {};
    const providerRequestId = headers.get("x-request-id") ?? headers.get("request-id")
        ?? (typeof body.id === "string" ? body.id : undefined);
    const usage = normalizeUsage(body.usage);
    return {
        ...(providerRequestId ? { providerRequestId } : {}),
        ...(usage ? { usage } : {}),
    };
}

function normalizeUsage(value: unknown): Record<string, string> | undefined {
    if (!isRecord(value)) return undefined;
    const usage: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
        const serialized = typeof item === "string" ? item : JSON.stringify(item);
        if (serialized !== undefined) usage[key] = serialized;
    }
    return Object.keys(usage).length > 0 ? usage : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
