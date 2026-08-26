import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";

export function hashCanonicalRequest(payload: unknown): string {
    return createHash("sha256").update(canonicalize(payload)).digest("hex");
}
