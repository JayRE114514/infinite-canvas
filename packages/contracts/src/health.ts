import { Type, type Static } from "typebox";

export const HealthResponseSchema = Type.Object({ status: Type.Literal("ok") });

export type HealthResponse = Static<typeof HealthResponseSchema>;
