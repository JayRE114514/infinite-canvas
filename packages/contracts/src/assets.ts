import { Type, type Static } from "typebox";

import { WorkspaceIdSchema } from "./workspaces.js";

export const AssetIdSchema = Type.String({ format: "uuid" });
export type AssetId = Static<typeof AssetIdSchema>;

export const AssetKindSchema = Type.Union([Type.Literal("image"), Type.Literal("video"), Type.Literal("audio")]);
export type AssetKind = Static<typeof AssetKindSchema>;

export const AssetStatusSchema = Type.Union([
    Type.Literal("staging"),
    Type.Literal("ready"),
    Type.Literal("failed"),
    Type.Literal("deleted"),
]);
export type AssetStatus = Static<typeof AssetStatusSchema>;

export const AssetSchema = Type.Object(
    {
        id: AssetIdSchema,
        workspaceId: WorkspaceIdSchema,
        kind: AssetKindSchema,
        status: AssetStatusSchema,
        fileName: Type.String({ minLength: 1 }),
        contentType: Type.String({ minLength: 1 }),
        byteSize: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
        createdAt: Type.String({ format: "date-time" }),
        updatedAt: Type.String({ format: "date-time" }),
    },
    { additionalProperties: false },
);
export type Asset = Static<typeof AssetSchema>;

export const CreateAssetBodySchema = Type.Object(
    {
        kind: AssetKindSchema,
        fileName: Type.String({ minLength: 1 }),
        contentType: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
);
export type CreateAssetBody = Static<typeof CreateAssetBodySchema>;

export const AssetPathSchema = Type.Object(
    { workspaceId: WorkspaceIdSchema, assetId: AssetIdSchema },
    { additionalProperties: false },
);
export type AssetPath = Static<typeof AssetPathSchema>;

export const AssetUploadSchema = Type.Object(
    { url: Type.String({ minLength: 1 }), headers: Type.Record(Type.String(), Type.String()) },
    { additionalProperties: false },
);
export type AssetUpload = Static<typeof AssetUploadSchema>;

export const CreateAssetResponseSchema = Type.Object(
    { asset: AssetSchema, upload: AssetUploadSchema },
    { additionalProperties: false },
);
export type CreateAssetResponse = Static<typeof CreateAssetResponseSchema>;

export const CompleteAssetResponseSchema = Type.Object({ asset: AssetSchema }, { additionalProperties: false });
export type CompleteAssetResponse = Static<typeof CompleteAssetResponseSchema>;

export const ReadAssetResponseSchema = Type.Object(
    { asset: AssetSchema, displayUrl: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
);
export type ReadAssetResponse = Static<typeof ReadAssetResponseSchema>;
