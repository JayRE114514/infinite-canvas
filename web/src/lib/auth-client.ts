import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

const SAFE_AUTH_CODE = /^[A-Z][A-Z0-9_]*$/;

export const authClient = createAuthClient({
    baseURL: window.location.origin,
    plugins: [organizationClient()],
});

export class AuthApiError extends Error {
    readonly code: string;

    constructor(code: string) {
        super("Authentication request failed");
        this.name = "AuthApiError";
        this.code = code;
    }
}

export function getAuthErrorCode(error: unknown, fallback = "AUTH_REQUEST_FAILED") {
    if (!error || typeof error !== "object") return fallback;
    const code = "code" in error ? error.code : undefined;
    return typeof code === "string" && SAFE_AUTH_CODE.test(code) ? code : fallback;
}

export function unwrapAuthResponse<T>(response: { data: T | null; error: unknown }): T {
    if (response.error || response.data === null) throw new AuthApiError(getAuthErrorCode(response.error));
    return response.data;
}

export function authErrorTranslationKey(error: unknown, fallback: string) {
    const code = error instanceof AuthApiError ? error.code : getAuthErrorCode(error);
    const keys: Record<string, string> = {
        AUTH_REQUEST_FAILED: fallback,
        EMAIL_NOT_VERIFIED: "auth.errors.emailNotVerified",
        INVALID_EMAIL: "auth.errors.invalidEmail",
        INVALID_EMAIL_OR_PASSWORD: "auth.errors.invalidCredentials",
        INVALID_PASSWORD: "auth.errors.invalidCredentials",
        PASSWORD_TOO_LONG: "auth.errors.passwordTooLong",
        PASSWORD_TOO_SHORT: "auth.errors.passwordTooShort",
        SESSION_EXPIRED: "auth.errors.sessionExpired",
        USER_ALREADY_EXISTS: "auth.errors.accountExists",
        USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "auth.errors.accountExists",
        EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION: "auth.errors.emailNotVerified",
        EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION: "auth.errors.emailNotVerified",
        INVITATION_NOT_FOUND: "auth.invitation.errors.notFound",
        INVITATION_EXPIRED: "auth.invitation.errors.expired",
        YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION: "auth.invitation.errors.wrongRecipient",
        USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION: "auth.invitation.errors.alreadyMember",
    };
    return keys[code] ?? fallback;
}

export function resolveSafeReturnTo(value: string | null | undefined, origin: string, fallback = "/") {
    if (!value?.startsWith("/") || value.startsWith("//")) return fallback;
    try {
        const target = new URL(value, origin);
        const normalizedPath = target.pathname.replace(/\/+$/, "") || "/";
        if (target.origin !== origin || normalizedPath === "/login" || normalizedPath === "/register") return fallback;
        return `${target.pathname}${target.search}${target.hash}`;
    } catch {
        return fallback;
    }
}

export function createLoginPath(returnTo: string, origin = window.location.origin) {
    const safeReturnTo = resolveSafeReturnTo(returnTo, origin);
    return `/login?returnTo=${encodeURIComponent(safeReturnTo)}`;
}
