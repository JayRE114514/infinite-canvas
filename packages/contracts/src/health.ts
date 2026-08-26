import { Type, type Static } from "typebox";

export const HealthResponseSchema = Type.Object({ status: Type.Literal("ok") });

export type HealthResponse = Static<typeof HealthResponseSchema>;

export const UnavailableResponseSchema = Type.Object({ status: Type.Literal("unavailable") });

export type UnavailableResponse = Static<typeof UnavailableResponseSchema>;
