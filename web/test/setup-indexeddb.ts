import { IDBFactory } from "fake-indexeddb";

/**
 * A brand-new empty IDBFactory per call. Two factories model two independent browsers;
 * two connections from ONE factory model two tabs of the same browser.
 */
export function freshIndexedDB(): IDBFactory {
    return new IDBFactory();
}
