const UPGRADE_KEY = "canvas-recovery-upgrade";
const UPGRADE_VALUE = "native-idb-v1";

export type LegacyUpgradeOutcome = "upgraded" | "already-upgraded" | "failed";

/**
 * The one explicit upgrade action. It only DROPS the legacy localforage store; it never reads it,
 * never uploads it and never runs at module import. The project is unreleased, so no legacy data
 * is migrated: a user who wants old test drafts must export them before upgrading.
 * Called once from the app entry point, never from the recovery store.
 *
 * Every failure mode stays inside the declared union, including a storage that throws on read or
 * write. Because a dropped store whose receipt could not be persisted reports "failed" and will be
 * retried, `dropLegacy` MUST be idempotent: dropping an absent legacy store has to resolve, not throw.
 */
export async function upgradeRecoveryStorage(deps: { storage: Pick<Storage, "getItem" | "setItem">; dropLegacy: () => Promise<void> }): Promise<LegacyUpgradeOutcome> {
    let recorded: string | null;
    try {
        recorded = deps.storage.getItem(UPGRADE_KEY);
    } catch {
        /** An unreadable flag cannot prove the upgrade state, so nothing is dropped. */
        return "failed";
    }
    if (recorded === UPGRADE_VALUE) return "already-upgraded";
    try {
        await deps.dropLegacy();
    } catch {
        /** Not recorded: a failed drop must remain retryable on the next explicit run. */
        return "failed";
    }
    try {
        deps.storage.setItem(UPGRADE_KEY, UPGRADE_VALUE);
    } catch {
        /** The drop succeeded but is unproven; report failure so the idempotent drop runs again. */
        return "failed";
    }
    return "upgraded";
}
