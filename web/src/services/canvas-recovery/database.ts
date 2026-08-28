export const RECOVERY_DB_NAME = "infinite-canvas-recovery";
export const RECOVERY_DB_VERSION = 1;
export const DRAFTS_STORE = "drafts";
export const MARKERS_STORE = "markers";
export const EPOCHS_STORE = "epochs";
export const SCOPE_INDEX = "by_scope";
export const RECOVERY_OPEN_TIMEOUT_MS = 2_000;
export const RECOVERY_TRANSACTION_TIMEOUT_MS = 2_000;

export type RecoveryFailureReason = "blocked" | "timeout" | "aborted" | "corrupt" | "unsupported" | "error";
export type RecoveryRun<T> = { status: "ok"; value: T } | { status: "failed"; reason: RecoveryFailureReason };
export type RecoveryStoreName = typeof DRAFTS_STORE | typeof MARKERS_STORE | typeof EPOCHS_STORE;
export type RecoveryTxn = { store(name: RecoveryStoreName): IDBObjectStore; req<T>(request: IDBRequest<T>): Promise<T> };

export type RecoveryDatabase = {
    run<T>(mode: IDBTransactionMode, stores: RecoveryStoreName[], timeoutMs: number, work: (txn: RecoveryTxn) => Promise<T>, signal?: AbortSignal): Promise<RecoveryRun<T>>;
    close(): void;
};

/** version 1 layout is fixed: three stores, one scope index each on drafts/markers, nothing else. */
function upgrade(db: IDBDatabase) {
    db.createObjectStore(DRAFTS_STORE, { keyPath: ["scopeId", "draftId"] }).createIndex(SCOPE_INDEX, "scopeId");
    db.createObjectStore(MARKERS_STORE, { keyPath: ["scopeId", "markerId"] }).createIndex(SCOPE_INDEX, "scopeId");
    db.createObjectStore(EPOCHS_STORE, { keyPath: "scopeId" });
}

/** The factory is injected and opening happens on first run() only: importing this module never touches storage. */
export function createRecoveryDatabase(factory: IDBFactory): RecoveryDatabase {
    let connection: IDBDatabase | null = null;
    let opening: Promise<RecoveryRun<IDBDatabase>> | null = null;

    function open(): Promise<RecoveryRun<IDBDatabase>> {
        if (connection) return Promise.resolve({ status: "ok", value: connection });
        if (opening) return opening;
        opening = new Promise<RecoveryRun<IDBDatabase>>((resolve) => {
            let settled = false;
            const finish = (result: RecoveryRun<IDBDatabase>) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                opening = null;
                resolve(result);
            };
            /** An open blocked by another tab must never wait without bound. */
            const timer = setTimeout(() => finish({ status: "failed", reason: "blocked" }), RECOVERY_OPEN_TIMEOUT_MS);
            let request: IDBOpenDBRequest;
            try {
                request = factory.open(RECOVERY_DB_NAME, RECOVERY_DB_VERSION);
            } catch {
                finish({ status: "failed", reason: "error" });
                return;
            }
            request.onupgradeneeded = () => {
                /** A timed-out/blocked open must not perform a late schema upgrade when later unblocked. */
                if (settled) return request.transaction?.abort();
                upgrade(request.result);
            };
            request.onblocked = () => finish({ status: "failed", reason: "blocked" });
            request.onerror = () => finish({ status: "failed", reason: "error" });
            request.onsuccess = () => {
                const db = request.result;
                /** IDBOpenDBRequest is not cancellable; close a late connection instead of publishing it. */
                if (settled) {
                    db.close();
                    return;
                }
                /** A newer tab is upgrading: release at once so this connection is never the blocker. */
                db.onversionchange = () => {
                    db.close();
                    if (connection === db) connection = null;
                };
                db.onclose = () => {
                    if (connection === db) connection = null;
                };
                connection = db;
                finish({ status: "ok", value: db });
            };
        });
        return opening;
    }

    async function run<T>(mode: IDBTransactionMode, stores: RecoveryStoreName[], timeoutMs: number, work: (txn: RecoveryTxn) => Promise<T>, signal?: AbortSignal): Promise<RecoveryRun<T>> {
        if (signal?.aborted) return { status: "failed", reason: "aborted" };
        const opened = await open();
        if (opened.status !== "ok") return opened;
        if (signal?.aborted) return { status: "failed", reason: "aborted" };
        return new Promise<RecoveryRun<T>>((resolve) => {
            let settled = false;
            let produced = false;
            let value: T;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let abortFromSignal: (() => void) | null = null;
            const finish = (result: RecoveryRun<T>) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (abortFromSignal) signal?.removeEventListener("abort", abortFromSignal);
                resolve(result);
            };
            let transaction: IDBTransaction;
            try {
                transaction = opened.value.transaction(stores, mode);
            } catch {
                return finish({ status: "failed", reason: "error" });
            }
            /**
             * The deadline ABORTS. A timed-out promise alone would let this transaction commit
             * afterwards, which is exactly the late write this layer exists to prevent.
             * `work` may await only txn.req(...): if it awaits an external promise after the
             * request queue drains, IndexedDB auto-commits before this timer can roll it back.
             */
            timer = setTimeout(() => {
                try {
                    transaction.abort();
                } catch {
                    /** Already finished; onabort/oncomplete decides. */
                }
                finish({ status: "failed", reason: "timeout" });
            }, timeoutMs);
            transaction.onabort = () => finish({ status: "failed", reason: "aborted" });
            transaction.onerror = () => finish({ status: "failed", reason: "error" });
            transaction.oncomplete = () => finish(produced ? { status: "ok", value } : { status: "failed", reason: "error" });
            abortFromSignal = () => {
                try {
                    transaction.abort();
                } catch {
                    /** Already finished; finish still returns the controlled owner-aborted result. */
                }
                finish({ status: "failed", reason: "aborted" });
            };
            signal?.addEventListener("abort", abortFromSignal, { once: true });
            if (signal?.aborted) return abortFromSignal();

            const txn: RecoveryTxn = {
                store: (name) => transaction.objectStore(name),
                req: <R,>(request: IDBRequest<R>) =>
                    new Promise<R>((resolveReq, rejectReq) => {
                        request.onsuccess = () => resolveReq(request.result);
                        request.onerror = () => rejectReq(request.error ?? new Error("request_failed"));
                    }),
            };

            void work(txn).then(
                (result) => {
                    value = result;
                    produced = true;
                },
                () => {
                    try {
                        transaction.abort();
                    } catch {
                        /** Already finished; the abort/error handler resolves. */
                    }
                },
            );
        });
    }

    return {
        run,
        close: () => {
            connection?.close();
            connection = null;
        },
    };
}
