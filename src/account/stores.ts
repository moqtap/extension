/**
 * Where the account's pieces live.
 *
 * | what | where | why |
 * | --- | --- | --- |
 * | `mqt_rt_` | IndexedDB of the extension origin, opened only by the background | content scripts run in the page's origin and cannot open it |
 * | `mqt_at_`, PKCE verifier, `state` | `storage.session` | trusted contexts only, cleared with the browser session, and it survives a service worker or event page restart |
 * | account metadata | `storage.local` | content scripts can read it, so it holds nothing secret |
 *
 * The service takes these as interfaces so its tests run on in-memory fakes.
 */

/** A `storage.session` or `storage.local` area, one key at a time. */
export interface KeyValueArea {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

/** The refresh token's home. */
export interface SecretStore {
  getRefresh(): Promise<string | null>
  setRefresh(token: string): Promise<void>
  clear(): Promise<void>
}

interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(key: string): Promise<void>
}

export function storageArea(area: StorageAreaLike): KeyValueArea {
  return {
    get: async (key) => (await area.get(key))[key],
    set: (key, value) => area.set({ [key]: value }),
    remove: (key) => area.remove(key),
  }
}

const DB_NAME = 'moqtap-account'
const DB_VERSION = 1
const STORE = 'credentials'
const REFRESH_KEY = 'refresh'

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** The refresh token in the extension origin's IndexedDB (background only). */
export function indexedDbSecrets(idb: IDBFactory = indexedDB): SecretStore {
  let db: Promise<IDBDatabase> | null = null
  const open = (): Promise<IDBDatabase> => {
    db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    }).catch((err: unknown) => {
      db = null
      throw err
    })
    return db
  }
  const tx = async (mode: IDBTransactionMode): Promise<IDBObjectStore> =>
    (await open()).transaction(STORE, mode).objectStore(STORE)
  return {
    async getRefresh() {
      const v = await request((await tx('readonly')).get(REFRESH_KEY))
      return typeof v === 'string' ? v : null
    },
    async setRefresh(token) {
      await request((await tx('readwrite')).put(token, REFRESH_KEY))
    },
    async clear() {
      await request((await tx('readwrite')).delete(REFRESH_KEY))
    },
  }
}
