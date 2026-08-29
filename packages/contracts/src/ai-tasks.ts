import { Type, type Static } from "typebox";

import { CreditAmountStringSchema } from "./credits.js";
import { WorkspaceIdSchema } from "./workspaces.js";

export const CreateAiTaskBodySchema = Type.Object(
    { workspaceId: WorkspaceIdSchema, prompt: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
);
export type CreateAiTaskBody = Static<typeof CreateAiTaskBodySchema>;

export const CreateAiTaskResponseSchema = Type.Object(
    {
        taskId: Type.String({ format: "uuid" }),
        status: Type.Literal("queued"),
        estimatedCredits: CreditAmountStringSchema,
        replayed: Type.Boolean(),
    },
    { additionalProperties: false },
);
export type CreateAiTaskResponse = Static<typeof CreateAiTaskResponseSchema>;

export const AiTaskStatusSchema = Type.Union([
    Type.Literal("queued"), Type.Literal("submitting"), Type.Literal("processing"), Type.Literal("storing"),
    Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("reconciling"),
]);
export const EventSequenceStringSchema = Type.String({ pattern: "^(?:0|[1-9][0-9]*)$" });

export const AiTaskSchema = Type.Object({
    id: Type.String({ format: "uuid" }),
    workspaceId: WorkspaceIdSchema,
    status: AiTaskStatusSchema,
    resultAssetId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    publicErrorCode: Type.Union([Type.String(), Type.Null()]),
    latestSequence: EventSequenceStringSchema,
    estimatedCredits: CreditAmountStringSchema,
    actualCredits: Type.Union([CreditAmountStringSchema, Type.Null()]),
}, { additionalProperties: false });
export type AiTask = Static<typeof AiTaskSchema>;

export const AiTaskResponseSchema = Type.Object({ task: AiTaskSchema }, { additionalProperties: false });
export type AiTaskResponse = Static<typeof AiTaskResponseSchema>;

export const AiTaskEventSchema = Type.Object({
    sequence: EventSequenceStringSchema,
    type: Type.String(),
    payload: Type.Record(Type.String(), Type.String()),
    createdAt: Type.String({ format: "date-time" }),
}, { additionalProperties: false });
export type AiTaskEvent = Static<typeof AiTaskEventSchema>;
