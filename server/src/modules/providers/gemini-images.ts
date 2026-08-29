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

export type GeminiImagesAdapterOptions = {
    baseUrl: string;
    apiKey: string;
    adapterId: string;
    adapterVersion: string;
    capabilityId: "image.generate";
    exactModelId: string;
    fetch: ProviderFetch;
};

const TERMINAL_REJECTION_STATUSES = new Set([400, 401, 403, 404, 405, 413, 415, 422]);
const SAFETY_FINISH_REASONS = new Set(["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "IMAGE_SAFETY"]);
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class GeminiImagesAdapter implements ProviderAdapter {
    readonly descriptor: ProviderDescriptor;
    readonly #apiKey: string;
    readonly #endpoint: URL;
    readonly #fetch: ProviderFetch;

    constructor(options: GeminiImagesAdapterOptions) {
        for (const name of ["baseUrl", "apiKey", "adapterId", "adapterVersion", "capabilityId", "exactModelId"] as const) {
            if (typeof options[name] !== "string" || options[name].length === 0) {
                throw new Error(`Invalid Provider Adapter configuration: ${name}`);
            }
        }
        if (typeof options.fetch !== "function") throw new Error("Invalid Provider Adapter configuration: fetch");

        let origin: URL;
        try {
            origin = new URL(options.baseUrl);
            if (
                (origin.protocol !== "http:" && origin.protocol !== "https:") || origin.pathname !== "/" ||
                origin.search !== "" || origin.hash !== ""
            ) {
                throw new Error();
            }
        } catch {
            throw new Error("Invalid Provider Adapter configuration: baseUrl");
        }
        this.#endpoint = new URL(
            `/v1beta/models/${encodeURIComponent(options.exactModelId)}:generateContent`,
            origin,
        );
        this.descriptor = {
            adapterId: options.adapterId,
            adapterVersion: options.adapterVersion,
            capabilityId: options.capabilityId,
            exactModelId: options.exactModelId,
            supportsPolling: false,
            supportsCancellation: false,
        };
        this.#apiKey = options.apiKey;
        this.#fetch = options.fetch;
    }

    async submit(request: ImageCapabilityRequest, context: ProviderCallContext): Promise<ProviderResult> {
        let response: Response;
        try {
            response = await this.#fetch(this.#endpoint, {
                method: "POST",
                headers: {
                    "x-goog-api-key": this.#apiKey,
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    contents: [{ role: "user", parts: [{ text: request.prompt }] }],
                    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
                }),
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
        if (isSafetyRejection(payload)) {
            return {
                kind: "terminal",
                error: { code: "provider_safety_rejection", message: "Provider rejected the prompt for safety reasons" },
            };
        }

        const output = await firstVerifiedImage(payload);
        if (!output) return ambiguous("provider_output_missing", "Provider success response contained no verifiable image");
        return { kind: "success", output, billing: readBillingFact(payload, response.headers) };
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

async function firstVerifiedImage(payload: unknown): Promise<{ bytes: Uint8Array; mediaType: string } | null> {
    if (!isRecord(payload) || !Array.isArray(payload.candidates)) return null;
    for (const candidate of payload.candidates) {
        if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) continue;
        for (const part of candidate.content.parts) {
            if (!isRecord(part)) continue;
            const inline = isRecord(part.inlineData)
                ? part.inlineData
                : isRecord(part.inline_data)
                  ? part.inline_data
                  : undefined;
            const data = inline?.data;
            if (typeof data !== "string" || !data || !BASE64_PATTERN.test(data)) continue;
            const bytes = Uint8Array.from(Buffer.from(data, "base64"));
            if (Buffer.from(bytes).toString("base64") !== data) continue;
            const detected = await fileTypeFromBuffer(bytes);
            if (detected?.mime.startsWith("image/")) return { bytes, mediaType: detected.mime };
        }
    }
    return null;
}

function isSafetyRejection(payload: unknown): boolean {
    if (!isRecord(payload)) return false;
    const feedback = isRecord(payload.promptFeedback)
        ? payload.promptFeedback
        : isRecord(payload.prompt_feedback)
          ? payload.prompt_feedback
          : undefined;
    if (typeof feedback?.blockReason === "string" || typeof feedback?.block_reason === "string") return true;
    if (!Array.isArray(payload.candidates)) return false;
    return payload.candidates.some((candidate) => {
        if (!isRecord(candidate)) return false;
        const reason = candidate.finishReason ?? candidate.finish_reason;
        return typeof reason === "string" && SAFETY_FINISH_REASONS.has(reason.toUpperCase());
    });
}

function readBillingFact(payload: unknown, headers: Headers): ProviderBillingFact {
    const body = isRecord(payload) ? payload : {};
    const usageMetadata = body.usageMetadata ?? body.usage_metadata;
    const usage = normalizeUsage(usageMetadata);
    const providerRequestId = headers.get("x-request-id") ?? headers.get("request-id") ?? undefined;
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
    return Object.keys(usage).length ? usage : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
