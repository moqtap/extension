/**
 * Page-based stream data storage with memory-first reads.
 *
 * Design goals:
 *  - Handle high-bitrate MoQT streams (12+ Mbps 4K video) without
 *    saturating IDB's transaction queue.
 *  - Serve reads from memory whenever possible; IDB is overflow storage.
 *  - Data persists as long as the session is in the Connections list.
 *    Cleanup happens ONLY when a session is explicitly removed or on
 *    startup (to reclaim storage from a previous crashed/closed DevTools).
 *
 * Architecture:
 *  - Incoming bytes are appended to a per-stream write buffer in memory.
 *  - When the write buffer reaches PAGE_SIZE (1 MB), it's sealed into a
 *    "page" and asynchronously backed to IDB. The sealed page stays in
 *    the memory cache.
 *  - Sealed + backed pages are evictable from memory after EVICT_IDLE_MS
 *    of not being read. The write buffer is NEVER evicted.
 *  - On read, pages are served from the memory cache. Evicted pages are
 *    re-loaded from IDB on demand and re-cached.
 *
 * Key format: `${sessionId}:${streamId}:p${pageIndex}` — deterministic,
 * no lookup table needed.
 */

// ── Constants ──────────────────────────────────────────────────────

const DB_NAME = 'moqtap-streams'
const DB_VERSION = 1
const STORE_NAME = 'pages'

/**
 * Page size: 1 MB. At 12 Mbps (4K video), that's ~0.7 pages/second.
 * At 100 Mbps, ~12 pages/second — still very manageable for IDB.
 */
const PAGE_SIZE = 1024 * 1024

/** Evict backed pages from memory after this idle duration. */
const EVICT_IDLE_MS = 60_000 // 60 seconds

/** How often to run the eviction sweep. */
const EVICT_INTERVAL_MS = 15_000 // 15 seconds

// ── IDB ────────────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase> | null = null

// Delete legacy DB from old per-chunk scheme (one-time migration)
try {
  indexedDB.deleteDatabase('moqtap-chunks')
} catch {
  /* ignore */
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME)
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => {
        console.error('[moqtap store] IDB open failed:', req.error)
        dbPromise = null
        reject(req.error)
      }
    } catch (err) {
      console.error('[moqtap store] indexedDB.open threw:', err)
      dbPromise = null
      reject(err)
    }
  })
  return dbPromise
}

function idbKey(
  sessionId: string,
  streamId: number,
  pageIndex: number,
): string {
  return `${sessionId}:${streamId}:p${pageIndex}`
}

// ── Page cache ─────────────────────────────────────────────────────

interface CachedPage {
  data: Uint8Array
  /** True once the page has been written to IDB (can be evicted). */
  backed: boolean
  /** Timestamp of last read access (for LRU eviction). */
  lastAccessed: number
}

/** Memory cache: idbKey → CachedPage */
const pageCache = new Map<string, CachedPage>()

// ── Per-stream state ───────────────────────────────────────────────

interface StreamState {
  sessionId: string
  streamId: number
  /** Write buffer: incoming bytes not yet sealed into a page. */
  writeBuf: Uint8Array[]
  writeBufBytes: number
  /** Number of sealed pages (both cached and/or in IDB). */
  pageCount: number
  /** Total bytes received for this stream. */
  totalBytes: number
}

const streams = new Map<string, StreamState>()

function streamKey(sessionId: string, streamId: number): string {
  return `${sessionId}:${streamId}`
}

function getOrCreateStream(sessionId: string, streamId: number): StreamState {
  const key = streamKey(sessionId, streamId)
  let st = streams.get(key)
  if (!st) {
    st = {
      sessionId,
      streamId,
      writeBuf: [],
      writeBufBytes: 0,
      pageCount: 0,
      totalBytes: 0,
    }
    streams.set(key, st)
  }
  return st
}

// ── Write path ─────────────────────────────────────────────────────

/**
 * Append incoming stream data. Full pages are automatically sealed,
 * cached in memory, and flushed to IDB in the background.
 */
export function appendStreamData(
  sessionId: string,
  streamId: number,
  data: Uint8Array,
): void {
  const st = getOrCreateStream(sessionId, streamId)
  st.writeBuf.push(data)
  st.writeBufBytes += data.length
  st.totalBytes += data.length

  // Seal full pages
  while (st.writeBufBytes >= PAGE_SIZE) {
    sealPage(st)
  }
}

/**
 * Flush the write buffer as a final (possibly partial) page.
 * Call on stream close to ensure all data is persisted to IDB.
 * The stream state and cached pages remain in memory for reads.
 */
export function flushStream(sessionId: string, streamId: number): void {
  const st = streams.get(streamKey(sessionId, streamId))
  if (!st || st.writeBufBytes === 0) return

  const page = drainWriteBuf(st, st.writeBufBytes)
  const pi = st.pageCount++
  const key = idbKey(sessionId, streamId, pi)

  // Cache in memory and flush to IDB
  pageCache.set(key, { data: page, backed: false, lastAccessed: Date.now() })
  writePageToIdb(key, page)
}

/** Drain `count` bytes from the write buffer into a sealed page. */
function sealPage(st: StreamState): void {
  const page = drainWriteBuf(st, PAGE_SIZE)
  const pi = st.pageCount++
  const key = idbKey(st.sessionId, st.streamId, pi)

  // Keep in memory cache + write to IDB
  pageCache.set(key, { data: page, backed: false, lastAccessed: Date.now() })
  writePageToIdb(key, page)
}

function drainWriteBuf(st: StreamState, count: number): Uint8Array {
  const out = new Uint8Array(count)
  let offset = 0
  while (offset < count && st.writeBuf.length > 0) {
    const chunk = st.writeBuf[0]
    const need = count - offset
    if (chunk.length <= need) {
      out.set(chunk, offset)
      offset += chunk.length
      st.writeBuf.shift()
    } else {
      out.set(chunk.subarray(0, need), offset)
      st.writeBuf[0] = chunk.subarray(need)
      offset += need
    }
  }
  st.writeBufBytes -= count
  return out
}

/** Fire-and-forget write to IDB. Marks the cached page as backed on success. */
function writePageToIdb(key: string, data: Uint8Array): void {
  openDb()
    .then((db) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(data, key)
      tx.oncomplete = () => {
        const cached = pageCache.get(key)
        if (cached) cached.backed = true
      }
      tx.onerror = () => {
        console.error('[moqtap store] page write failed:', key, tx.error)
      }
    })
    .catch((err) => {
      console.error('[moqtap store] page write failed (no db):', err)
    })
}

// ── Read path ──────────────────────────────────────────────────────

/**
 * Load all data for a stream. Reads from:
 *  1. Memory cache (sealed pages)
 *  2. IDB (for evicted pages — re-cached on load)
 *  3. Write buffer (unflushed tail)
 *
 * Called from the background service worker.
 */
export async function loadStreamData(
  sessionId: string,
  streamId: number,
): Promise<Uint8Array> {
  const st = streams.get(streamKey(sessionId, streamId))
  if (!st) return new Uint8Array(0)

  const parts: Uint8Array[] = []
  let totalLen = 0

  // 1. Sealed pages (memory cache or IDB)
  for (let i = 0; i < st.pageCount; i++) {
    const page = await getPage(sessionId, streamId, i)
    if (page) {
      parts.push(page)
      totalLen += page.length
    }
  }

  // 2. Write buffer (unflushed tail — always in memory)
  for (const chunk of st.writeBuf) {
    parts.push(chunk)
    totalLen += chunk.length
  }

  // Merge
  if (parts.length === 0) return new Uint8Array(0)
  if (parts.length === 1) return parts[0]
  const merged = new Uint8Array(totalLen)
  let offset = 0
  for (const part of parts) {
    merged.set(part, offset)
    offset += part.length
  }
  return merged
}

/** Get a sealed page — from memory cache, or reload from IDB. */
async function getPage(
  sessionId: string,
  streamId: number,
  pageIndex: number,
): Promise<Uint8Array | null> {
  const key = idbKey(sessionId, streamId, pageIndex)

  // Check memory cache
  const cached = pageCache.get(key)
  if (cached) {
    cached.lastAccessed = Date.now()
    return cached.data
  }

  // Load from IDB and re-cache
  try {
    const db = await openDb()
    const data = await readPageFromIdb(db, key)
    if (data) {
      pageCache.set(key, { data, backed: true, lastAccessed: Date.now() })
    }
    return data
  } catch {
    return null
  }
}

function readPageFromIdb(
  db: IDBDatabase,
  key: string,
): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(key)
    req.onsuccess = () => {
      const result = req.result
      if (result == null) resolve(null)
      else if (result instanceof Uint8Array) resolve(result)
      else if (result instanceof ArrayBuffer) resolve(new Uint8Array(result))
      else resolve(null)
    }
    req.onerror = () => reject(req.error)
  })
}

// ── Memory eviction ────────────────────────────────────────────────

/**
 * Evict backed pages that haven't been accessed recently.
 * The write buffer and un-backed pages are never evicted.
 */
function evictStalePages(): void {
  const cutoff = Date.now() - EVICT_IDLE_MS
  for (const [key, page] of pageCache) {
    if (page.backed && page.lastAccessed < cutoff) {
      pageCache.delete(key)
    }
  }
}

// Run eviction sweep periodically
let evictTimer: ReturnType<typeof setInterval> | null = null

/** Optional callback run alongside stream page eviction (e.g., datagram pages). */
let additionalEvictionFn: (() => void) | null = null

export function setAdditionalEvictionFn(fn: () => void): void {
  additionalEvictionFn = fn
}

export function startEvictionTimer(): void {
  if (evictTimer) return
  evictTimer = setInterval(() => {
    evictStalePages()
    additionalEvictionFn?.()
  }, EVICT_INTERVAL_MS)
}

export function stopEvictionTimer(): void {
  if (evictTimer) {
    clearInterval(evictTimer)
    evictTimer = null
  }
}

// ── Session → tab mapping ─────────────────────────────────────────
//
// Persists which tab owns each session so that cleanupOrphanedData()
// can positively identify orphaned sessions after a SW restart,
// rather than relying on in-memory tabStates (which is empty after
// restart and can race with panel reconnection).

const TAB_KEY_PREFIX = 'meta:tab:'

/** Fire-and-forget: persist the owning tabId for a session. */
export function saveSessionTab(sessionId: string, tabId: number): void {
  openDb()
    .then((db) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(tabId, `${TAB_KEY_PREFIX}${sessionId}`)
    })
    .catch(() => {})
}

/** Read all persisted session→tabId mappings from IDB. */
export async function getSessionTabMap(): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const range = IDBKeyRange.bound(TAB_KEY_PREFIX, `${TAB_KEY_PREFIX}\uffff`)
      const req = tx.objectStore(STORE_NAME).openCursor(range)
      req.onsuccess = () => {
        const cursor = req.result
        if (cursor) {
          const sessionId = (cursor.key as string).substring(
            TAB_KEY_PREFIX.length,
          )
          if (typeof cursor.value === 'number') {
            map.set(sessionId, cursor.value)
          }
          cursor.continue()
        }
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    /* IDB not available */
  }
  return map
}

// ── Introspection ─────────────────────────────────────────────────

/**
 * Return the set of distinct sessionIds that have data in IDB.
 * Used on startup to detect orphaned sessions whose tabs no longer exist.
 */
export async function getKnownSessionIds(): Promise<Set<string>> {
  const ids = new Set<string>()
  // In-memory streams (still alive from current SW lifetime)
  for (const key of streams.keys()) {
    ids.add(key.split(':')[0])
  }
  // IDB pages (survived SW restart)
  try {
    const db = await openDb()
    const keys = await new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).getAllKeys()
      req.onsuccess = () => resolve(req.result as string[])
      req.onerror = () => reject(req.error)
    })
    for (const key of keys) {
      if (typeof key !== 'string' || key.startsWith('meta:')) continue
      // Key format: sessionId:streamId:pN
      const sep = key.indexOf(':')
      if (sep > 0) ids.add(key.substring(0, sep))
    }
  } catch {
    // IDB not available — return what we have from memory
  }
  return ids
}

// ── Cleanup ────────────────────────────────────────────────────────

/**
 * Remove all data for a specific session.
 * Call when a session is removed from the Connections list.
 * Clears both memory (stream state + cached pages) and IDB pages.
 */
export async function clearSessionData(sessionId: string): Promise<void> {
  const prefix = `${sessionId}:`

  // Clear stream state
  for (const key of streams.keys()) {
    if (key.startsWith(prefix)) streams.delete(key)
  }

  // Clear memory cache
  for (const key of pageCache.keys()) {
    if (key.startsWith(prefix)) pageCache.delete(key)
  }

  // Clear IDB pages + tab mapping entry
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)

      // Delete the session→tab mapping
      store.delete(`${TAB_KEY_PREFIX}${sessionId}`)

      // Delete all data pages for this session
      const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`)
      const req = store.openCursor(range)
      req.onsuccess = () => {
        const cursor = req.result
        if (cursor) {
          cursor.delete()
          cursor.continue()
        }
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // IDB not available — memory already cleared
  }
}

/**
 * Clear ALL stored data. Call on:
 *  - "Clear" button in panel (user removes all sessions)
 *  - Startup (reclaim storage from previous DevTools session)
 */
export async function clearAllData(): Promise<void> {
  streams.clear()
  pageCache.clear()
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // IDB not available — memory already cleared
  }
}
