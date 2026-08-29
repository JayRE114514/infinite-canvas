import { Type, type Static } from "typebox";

import { AssetIdSchema, AssetKindSchema } from "./assets.js";
import { WorkspaceIdSchema } from "./workspaces.js";

export const HostedMediaBindingSchema = Type.Object(
    {
        nodeId: Type.String({ minLength: 1 }),
        kind: AssetKindSchema,
        assetId: AssetIdSchema,
    },
    { additionalProperties: false },
);
export type HostedMediaBinding = Static<typeof HostedMediaBindingSchema>;

export const CreateArtBoxVideoGenerationBodySchema = Type.Object(
    {
        model: Type.String({ minLength: 1 }),
        promptTemplate: Type.String({ minLength: 1 }),
        bindings: Type.Array(HostedMediaBindingSchema),
        seconds: Type.String({ minLength: 1 }),
        aspectRatio: Type.Optional(Type.String({ minLength: 1 })),
        resolution: Type.Optional(Type.String({ minLength: 1 })),
        generateAudio: Type.Boolean(),
    },
    { additionalProperties: false },
);
export type CreateArtBoxVideoGenerationBody = Static<typeof CreateArtBoxVideoGenerationBodySchema>;

export const ArtBoxCreateHeadersSchema = Type.Object({
    "idempotency-key": Type.String({ minLength: 1 }),
});
export type ArtBoxCreateHeaders = Static<typeof ArtBoxCreateHeadersSchema>;

export const ArtBoxVideoGenerationStatusSchema = Type.Union([
    Type.Literal("submitting"),
    Type.Literal("queued"),
    Type.Literal("processing"),
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("reconciling"),
]);
export type ArtBoxVideoGenerationStatus = Static<typeof ArtBoxVideoGenerationStatusSchema>;

export const ArtBoxGenerationErrorSchema = Type.Object(
    {
        code: Type.String({ minLength: 1 }),
        message: Type.String({ minLength: 1 }),
        retryable: Type.Boolean(),
    },
    { additionalProperties: false },
);
export type ArtBoxGenerationError = Static<typeof ArtBoxGenerationErrorSchema>;

export const ArtBoxVideoGenerationSchema = Type.Object(
    {
        id: Type.String({ format: "uuid" }),
        workspaceId: WorkspaceIdSchema,
        status: ArtBoxVideoGenerationStatusSchema,
        resultAssetId: Type.Union([AssetIdSchema, Type.Null()]),
        error: Type.Union([ArtBoxGenerationErrorSchema, Type.Null()]),
        createdAt: Type.String({ format: "date-time" }),
        updatedAt: Type.String({ format: "date-time" }),
    },
    { additionalProperties: false },
);
export type ArtBoxVideoGeneration = Static<typeof ArtBoxVideoGenerationSchema>;

export const ArtBoxVideoGenerationResponseSchema = Type.Object(
    { generation: ArtBoxVideoGenerationSchema },
    { additionalProperties: false },
);
export type ArtBoxVideoGenerationResponse = Static<typeof ArtBoxVideoGenerationResponseSchema>;

export const ArtBoxVideoGenerationPathSchema = Type.Object(
    {
        workspaceId: WorkspaceIdSchema,
        generationId: Type.String({ format: "uuid" }),
    },
    { additionalProperties: false },
);
export type ArtBoxVideoGenerationPath = Static<typeof ArtBoxVideoGenerationPathSchema>;
