import {
    ArtBoxCreateHeadersSchema,
    ArtBoxVideoGenerationSchema,
    CreateArtBoxVideoGenerationBodySchema,
    HostedMediaBindingSchema,
} from "@infinite-canvas/contracts";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";

const assetId = "6f1d3f3c-1f2a-4c6f-9a3b-4d5e6f708192";
const body = {
    model: "Artdance 2 Mini-480p",
    promptTemplate: "参考 @[node:image-1]",
    bindings: [{ nodeId: "image-1", kind: "image" as const, assetId }],
    seconds: "5",
    aspectRatio: "16:9",
    resolution: "480p",
    generateAudio: true,
};

describe("ArtBox public contracts", () => {
    it("accepts only the provider-neutral video body", () => {
        expect(Value.Check(CreateArtBoxVideoGenerationBodySchema, body)).toBe(true);
        expect(
            Value.Check(CreateArtBoxVideoGenerationBodySchema, {
                model: body.model,
                promptTemplate: body.promptTemplate,
                bindings: body.bindings,
                seconds: body.seconds,
                generateAudio: false,
            }),
        ).toBe(true);

        for (const field of ["image_urls", "video_urls", "audio_urls", "url", "storageKey", "providerConfig"]) {
            expect(Value.Check(CreateArtBoxVideoGenerationBodySchema, { ...body, [field]: "forbidden" })).toBe(false);
        }
    });

    it("keeps bindings typed, ordered, asset-backed, and closed", () => {
        expect(Value.Check(HostedMediaBindingSchema, body.bindings[0])).toBe(true);
        expect(Value.Check(HostedMediaBindingSchema, { ...body.bindings[0], kind: "document" })).toBe(false);
        expect(Value.Check(HostedMediaBindingSchema, { ...body.bindings[0], assetId: "asset-1" })).toBe(false);
        expect(Value.Check(HostedMediaBindingSchema, { ...body.bindings[0], url: "https://secret.example/image" })).toBe(
            false,
        );
        expect(Value.Check(CreateArtBoxVideoGenerationBodySchema, { ...body, bindings: "not-an-array" })).toBe(false);
    });

    it("requires a non-empty Idempotency-Key header while allowing ordinary transport headers", () => {
        expect(Value.Check(ArtBoxCreateHeadersSchema, { "idempotency-key": "request-1" })).toBe(true);
        expect(Value.Check(ArtBoxCreateHeadersSchema, {})).toBe(false);
        expect(Value.Check(ArtBoxCreateHeadersSchema, { "idempotency-key": "" })).toBe(false);
        expect(Value.Check(ArtBoxCreateHeadersSchema, { "idempotency-key": "request-1", cookie: "session=value" })).toBe(true);
    });

    it("exposes only the local generation id and result Asset id", () => {
        const generation = {
            id: "7f1d3f3c-1f2a-4c6f-9a3b-4d5e6f708193",
            workspaceId: "workspace-opaque-id",
            status: "succeeded",
            resultAssetId: assetId,
            error: null,
            createdAt: "2026-08-29T10:00:00.000Z",
            updatedAt: "2026-08-29T10:01:00.000Z",
        };
        expect(Value.Check(ArtBoxVideoGenerationSchema, generation)).toBe(true);
        for (const field of ["remoteTaskId", "resultUrl", "signedUrl", "storageKey"]) {
            expect(Value.Check(ArtBoxVideoGenerationSchema, { ...generation, [field]: "secret" })).toBe(false);
        }
    });
});

describe("ArtBox configuration", () => {
    const baseEnv: NodeJS.ProcessEnv = {
        NODE_ENV: "test",
        DATABASE_URL_API: "postgres://app_api:test@localhost/test",
        BETTER_AUTH_SECRET: "x".repeat(32),
        APP_ORIGIN: "http://localhost:3000",
        SMTP_HOST: "localhost",
        SMTP_FROM: "no-reply@example.com",
    };
    const artBoxEnv = {
        ARTBOX_BASE_URL: "https://artbox.test",
        ARTBOX_API_KEY: "test-key",
        ARTBOX_VIDEO_MODELS: "Artdance 2 Mini-480p, Another Model",
        ARTBOX_REQUEST_TIMEOUT_MS: "2500",
        ARTBOX_RESULT_MAX_BYTES: "50000000",
        ARTBOX_RESULT_ALLOWED_HOSTS: "results.artbox.test,cdn.artbox.test",
        ARTBOX_POLL_LEASE_SECONDS: "20",
    };

    it("parses the complete required block without inventing defaults", () => {
        expect(loadConfig({ ...baseEnv, ...artBoxEnv }).artbox).toEqual({
            baseUrl: "https://artbox.test",
            apiKey: "test-key",
            videoModels: ["Artdance 2 Mini-480p", "Another Model"],
            requestTimeoutMs: 2500,
            resultMaxBytes: 50_000_000,
            resultAllowedHosts: ["results.artbox.test", "cdn.artbox.test"],
            pollLeaseSeconds: 20,
        });
        expect(loadConfig(baseEnv)).not.toHaveProperty("artbox");
    });

    it.each(Object.keys(artBoxEnv))("rejects a partial block missing %s", (name) => {
        expect(() => loadConfig({ ...baseEnv, ...artBoxEnv, [name]: undefined })).toThrow("ARTBOX configuration");
    });

    it.each(["ARTBOX_REQUEST_TIMEOUT_MS", "ARTBOX_RESULT_MAX_BYTES", "ARTBOX_POLL_LEASE_SECONDS"])(
        "requires a positive safe integer for %s",
        (name) => {
            for (const value of ["0", "-1", "1.5", "", "abc", "9007199254740992"]) {
                expect(() => loadConfig({ ...baseEnv, ...artBoxEnv, [name]: value })).toThrow(name);
            }
        },
    );

    it("requires model and result-host allowlists to contain valid entries", () => {
        for (const [name, value] of [
            ["ARTBOX_VIDEO_MODELS", ", ,"],
            ["ARTBOX_RESULT_ALLOWED_HOSTS", "https://results.artbox.test"],
            ["ARTBOX_RESULT_ALLOWED_HOSTS", "results.artbox.test/path"],
            ["ARTBOX_RESULT_ALLOWED_HOSTS", "*.artbox.test"],
        ] as const) {
            expect(() => loadConfig({ ...baseEnv, ...artBoxEnv, [name]: value })).toThrow(name);
        }
    });

    it("requires an HTTPS credential-free provider origin in production", () => {
        expect(() =>
            loadConfig({
                ...baseEnv,
                ...artBoxEnv,
                NODE_ENV: "production",
                APP_ORIGIN: "https://canvas.test",
                ARTBOX_BASE_URL: "http://artbox.test",
            }),
        ).toThrow("ARTBOX_BASE_URL must use HTTPS in production");
        expect(() => loadConfig({ ...baseEnv, ...artBoxEnv, ARTBOX_BASE_URL: "https://user:pass@artbox.test" })).toThrow(
            "ARTBOX_BASE_URL",
        );
    });
});

describe("ArtBox migration invariants", () => {
    it("keeps created_by nullable through its ON DELETE SET NULL foreign key and bounds the numeric lease epoch", async () => {
        const sql = await readFile(new URL("../../migrations/0009_artbox_video_generations.sql", import.meta.url), "utf8");
        expect(sql).toContain('"created_by" text');
        expect(sql).toContain("ON DELETE set null");
        expect(sql).not.toContain("NEW.created_by IS DISTINCT FROM OLD.created_by");
        expect(sql).toContain("poll_lease_epoch <= 9007199254740991");
    });

    it("keeps committed 0009 immutable and adds a narrowly granted 0010 create-outcome finalizer", async () => {
        const migration9 = await readFile(
            new URL("../../migrations/0009_artbox_video_generations.sql", import.meta.url),
            "utf8",
        );
        expect(createHash("sha256").update(migration9).digest("hex")).toBe(
            "207cec4b3c79c445f7e2a990d22e2fd4a95f3f5788d3a4e74d65ec62a03b6ed8",
        );

        const migration10 = await readFile(
            new URL("../../migrations/0010_artbox_create_outcome_finalizer.sql", import.meta.url),
            "utf8",
        );
        expect(migration10).toContain("SECURITY DEFINER");
        expect(migration10).toContain("SET search_path = pg_catalog, public");
        expect(migration10).toContain("finalize_artbox_video_generation_create");
        expect(migration10).toContain("TO schema_owner");
        expect(migration10).toContain("GRANT EXECUTE ON FUNCTION");
        expect(migration10).toContain("TO app_api");
        expect(migration10).toContain("REVOKE ALL ON FUNCTION");
        expect(migration10).toContain("app.artbox_finalize_generation_id");
        expect(migration10).toContain("app.artbox_finalize_request_hash");
    });
});
