import type { AppErrorResponse } from "@infinite-canvas/contracts";

const STATUS_ERROR_CODES: Record<number, string> = {
    400: "platform_bad_request",
    401: "platform_unauthorized",
    403: "platform_forbidden",
    404: "platform_not_found",
    409: "platform_conflict",
    429: "platform_rate_limited",
};
const SAFE_PLATFORM_CODE = /^[a-z][a-z0-9_]{0,79}$/;

function parseErrorPayload(value: unknown): AppErrorResponse["error"] | null {
    if (!value || typeof value !== "object" || !("error" in value)) return null;
    const error = value.error;
    if (!error || typeof error !== "object") return null;
    if (!("code" in error) || typeof error.code !== "string" || !SAFE_PLATFORM_CODE.test(error.code)) return null;
    return {
        code: error.code,
        message: "",
        retryable: "retryable" in error && typeof error.retryable === "boolean" ? error.retryable : false,
        requestId: "requestId" in error && typeof error.requestId === "string" ? error.requestId : "",
    };
}

export class PlatformApiError extends Error {
    readonly code: string;
    readonly status: number;
    readonly retryable: boolean;
    readonly requestId: string;

    constructor(code: string, status: number, retryable = false, requestId = "") {
        super("Platform request failed");
        this.name = "PlatformApiError";
        this.code = code;
        this.status = status;
        this.retryable = retryable;
        this.requestId = requestId;
    }

    static async fromResponse(response: Response) {
        const body = await response.json().catch(() => null);
        const error = parseErrorPayload(body);
        return new PlatformApiError(
            error?.code || STATUS_ERROR_CODES[response.status] || "platform_request_failed",
            response.status,
            error?.retryable ?? response.status >= 500,
            error?.requestId,
        );
    }
}

export async function platformRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");

    let response: Response;
    try {
        response = await fetch(`/api/v1${path}`, { ...init, credentials: "include", headers });
    } catch {
        throw new PlatformApiError("platform_network_error", 0, true);
    }

    if (!response.ok) throw await PlatformApiError.fromResponse(response);
    try {
        return (await response.json()) as T;
    } catch {
        throw new PlatformApiError("platform_invalid_response", response.status);
    }
}

export function platformErrorTranslationKey(error: unknown, fallback: string) {
    if (!(error instanceof PlatformApiError)) return fallback;
    const keys: Record<string, string> = {
        email_verification_required: "auth.errors.emailNotVerified",
        personal_workspace_single_member: "workspace.errors.personalSingleMember",
        platform_forbidden: "workspace.errors.forbidden",
        platform_network_error: "workspace.errors.network",
        platform_unauthorized: "auth.errors.sessionExpired",
        workspace_admin_required: "workspace.errors.adminRequired",
        workspace_forbidden: "workspace.errors.forbidden",
        workspace_invitation_conflict: "workspace.errors.invitationConflict",
        workspace_owner_cannot_be_removed: "workspace.errors.ownerCannotBeRemoved",
        workspace_slug_taken: "workspace.errors.slugTaken",
    };
    return keys[error.code] ?? fallback;
}
