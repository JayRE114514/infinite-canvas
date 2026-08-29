import { Type, type Static } from "typebox";
import type { FastifyInstance } from "fastify";

import { requireSession } from "../identity/session.js";
import type { AssetModule } from "./service.js";

const ParamsSchema = Type.Object({ assetId: Type.String({ format: "uuid" }) }, { additionalProperties: false });
type Params = Static<typeof ParamsSchema>;

export function registerAssetRoutes(app: FastifyInstance, assets: AssetModule): void {
    app.get<{ Params: Params }>(
        "/api/v1/assets/:assetId/content",
        { schema: { params: ParamsSchema } },
        async (request, reply) => {
            const { userId } = await requireSession(request);
            const abort = new AbortController();
            request.raw.once("aborted", () => abort.abort());
            reply.raw.once("close", () => abort.abort());
            const output = await assets.openReadyAssetContent({
                userId,
                assetId: request.params.assetId,
                signal: abort.signal,
            });
            reply.header("Content-Length", output.byteSize.toString());
            reply.header("Digest", `sha-256=${Buffer.from(output.sha256, "hex").toString("base64")}`);
            return reply.type(output.mediaType).send(output.stream);
        },
    );
}
