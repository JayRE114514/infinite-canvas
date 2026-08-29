import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { registerErrorHandler } from "../../src/error-handler.js";
import { registerArtBoxRoutes } from "../../src/modules/artbox/routes.js";

const openApps: ReturnType<typeof Fastify>[] = [];

function app() {
    const server = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } })
        .withTypeProvider<TypeBoxTypeProvider>();
    openApps.push(server);
    registerErrorHandler(server);
    registerArtBoxRoutes(server);
    return server;
}

afterEach(async () => {
    for (const server of openApps.splice(0)) await server.close();
});

describe("ArtBox routes", () => {
    const url = "/api/v1/workspaces/workspace-1/integrations/artbox/video-generations";
    const payload = {
        model: "Artdance 2 Mini-480p",
        promptTemplate: "参考 @[node:image-1]",
        bindings: [
            {
                nodeId: "image-1",
                kind: "image",
                assetId: "6f1d3f3c-1f2a-4c6f-9a3b-4d5e6f708192",
            },
        ],
        seconds: "5",
        generateAudio: true,
    };

    it("requires Idempotency-Key before entering the authenticated handler", async () => {
        const response = await app().inject({ method: "POST", url, payload });
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe("invalid_request");
    });

    it.each(["image_urls", "video_urls", "audio_urls", "url", "storageKey", "apiKey"])(
        "rejects forbidden public field %s",
        async (field) => {
            const response = await app().inject({
                method: "POST",
                url,
                headers: { "idempotency-key": "request-1" },
                payload: { ...payload, [field]: "forbidden" },
            });
            expect(response.statusCode).toBe(400);
            expect(response.json().error.code).toBe("invalid_request");
        },
    );
});
