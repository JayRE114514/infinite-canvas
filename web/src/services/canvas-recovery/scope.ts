export type RecoveryScopeId = string & { readonly __recoveryScope: unique symbol };

export type RecoveryScopeSource =
    | { kind: "local"; installationId: string; localCanvasId: string }
    | { kind: "account"; userId: string; workspaceId: string; canvasId: string };

const INSTALLATION_KEY = "canvas-recovery-installation";
/** Trusted ids only: no separator, no whitespace, bounded length. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const safe = (id: unknown): id is string => typeof id === "string" && SAFE_ID.test(id);

/**
 * The scope id is opaque and always derived here, never accepted from page input.
 * Returning null instead of a sanitised string keeps a malformed identity from
 * silently addressing a neighbouring scope's drafts.
 */
export function buildRecoveryScopeId(source: RecoveryScopeSource): RecoveryScopeId | null {
    if (source.kind === "local") {
        if (!safe(source.installationId) || !safe(source.localCanvasId)) return null;
        return ("local:" + source.installationId + ":" + source.localCanvasId) as RecoveryScopeId;
    }
    if (source.kind !== "account") return null;
    if (!safe(source.userId) || !safe(source.workspaceId) || !safe(source.canvasId)) return null;
    return ("account:" + source.userId + ":workspace:" + source.workspaceId + ":canvas:" + source.canvasId) as RecoveryScopeId;
}

/** The installation id is a tiny local value, so localStorage is the correct home for it. */
export function readInstallationId(storage: Pick<Storage, "getItem" | "setItem">, createId: () => string): string | null {
    let existing: string | null;
    try {
        existing = storage.getItem(INSTALLATION_KEY);
    } catch {
        return null;
    }
    if (safe(existing)) return existing;
    const created = createId();
    if (!safe(created)) return null;
    try {
        storage.setItem(INSTALLATION_KEY, created);
    } catch {
        return null;
    }
    return created;
}
