/**
 * Heap-page storage for MoQT datagrams with ref-counted page loading.
 *
 * Design goals:
 *  - Avoid per-datagram IDB writes (datagrams can arrive at 30-60/sec per track).
 *  - Buffer payloads sequentially in memory, flush 1 MB pages to IDB.
 *  - Group datagrams by (trackAlias, groupId) for display in the Streams tab.
 *  - Ref-counted page loading: pages stay in memory while being viewed.
 *
 * Heap format:
 *  Each datagram is stored as [4-byte LE uint32: raw length][raw datagram bytes].
 *  This allows reconstruction of individual datagrams when reading back pages.
 *
 * Key format: `${sessionId}:dg:p${pageIndex}` — deterministic, separate namespace
 * from stream pages.
 */

import type {
  PayloadMediaInfo,
  StreamContentType,
} from '../detect/content-detect'

// ── Constants ──────────────────────────────────────────────────────

const DB_NAME = 'moqtap-streams' // shared DB with chunk-store
const DB_VERSION = 1
const STORE_NAME = 'pages'

/** Page size: 1 MB — matches chunk-store page size. */
const PAGE_SIZE = 1024 * 1024

/** Evict backed pages with refCount=0 after this idle duration. */
const EVICT_IDLE_MS = 60_000

/** Length-prefix size for each datagram entry in the heap. */
const HEADER_SIZE = 4

// ── IDB ────────────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase> | null = null

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
        console.error('[moqtap dg-store] IDB open failed:', req.error)
        dbPromise = null
        reject(req.error)
      }
    } catch (err) {
      console.error('[moqtap dg-store] indexedDB.open threw:', err)
      dbPromise = null
      reject(err)
    }
  })
  return dbPromise
}

function idbKey(sessionId: string, pageIndex: number): string {
  return `${sessionId}:dg:p${pageIndex}`
}

/**
 * Sidecar metadata key — one per page, written on seal/flush.
 * Allows the heap to be reconstructed after a SW restart.
 */
function idbMetaKey(sessionId: string, pageIndex: number): string {
  return `${sessionId}:dg:m${pageIndex}`
}

// ── Per-datagram metadata ──────────────────────────────────────────

export interface DatagramMeta {
  /** Sequential index within the session (for ordering). */
  index: number
  trackAlias: number
  groupId: number
  objectId: number
  publisherPriority: number
  direction: 'tx' | 'rx'
  timestamp: number
  /** Heap page index. */
  pageIndex: number
  /** Byte offset within the page (points to the 4-byte length prefix). */
  offset: number
  /** Length of raw datagram bytes (excludes the 4-byte prefix). */
  rawLength: number
}

// ── Datagram group ─────────────────────────────────────────────────

export interface DatagramGroupState {
  trackAlias: number
  groupId: number
  /** Indices into the session's DatagramMeta array. */
  datagramIndices: number[]
  totalPayloadBytes: number
  count: number
  firstTimestamp: number
  lastTimestamp: number
  direction: 'tx' | 'rx'
  /** Detected content type (from first datagram payload). */
  contentType?: StreamContentType
  /** ISO BMFF media info (from first datagram payload). */
  mediaInfo?: PayloadMediaInfo
  /** True when endOfGroup was received or session closed. */
  closed: boolean
}

export function datagramGroupKey(trackAlias: number, groupId: number): string {
  return `${trackAlias}:${groupId}`
}

// ── Page cache with ref counting ──────────────────────────────────

interface CachedPage {
  data: Uint8Array
  /** True once the page has been written to IDB (can be evicted when refCount=0). */
  backed: boolean
  /** Reference count: pages with refCount > 0 are pinned in memory. */
  refCount: number
  /** Timestamp of last access (for LRU eviction). */
  lastAccessed: number
}

/** Memory cache: idbKey → CachedPage */
const pageCache = new Map<string, CachedPage>()

// ── Per-session heap state ─────────────────────────────────────────

interface HeapState {
  sessionId: string
  /** Write buffer: incoming datagram bytes not yet sealed into a page. */
  writeBuf: Uint8Array[]
  writeBufBytes: number
  /** Number of sealed pages. */
  pageCount: number
  /** Total raw bytes stored (including length prefixes). */
  totalHeapBytes: number
  /** All datagram metadata entries (ordered by arrival). */
  datagrams: DatagramMeta[]
  /** Groups indexed by "trackAlias:groupId". */
  groups: Map<string, DatagramGroupState>
}

const heaps = new Map<string, HeapState>()

function getOrCreateHeap(sessionId: string): HeapState {
  let heap = heaps.get(sessionId)
  if (!heap) {
    heap = {
      sessionId,
      writeBuf: [],
      writeBufBytes: 0,
      pageCount: 0,
      totalHeapBytes: 0,
      datagrams: [],
      groups: new Map(),
    }
    heaps.set(sessionId, heap)
  }
  return heap
}

// ── Write path ─────────────────────────────────────────────────────

export interface AppendDatagramResult {
  meta: DatagramMeta
  group: DatagramGroupState
  /** True if this is the first datagram in the group. */
  isNewGroup: boolean
}

/**
 * Append a raw datagram to the session heap.
 *
 * The caller must decode the datagram header first and provide the
 * extracted fields. The raw bytes (full datagram including MoQT header)
 * are stored in the heap for later retrieval.
 */
export function appendDatagram(
  sessionId: string,
  raw: Uint8Array,
  decoded: {
    trackAlias: number
    groupId: number
    objectId: number
    publisherPriority: number
    endOfGroup?: boolean
  },
  direction: 'tx' | 'rx',
): AppendDatagramResult {
  const heap = getOrCreateHeap(sessionId)
  const now = Date.now()

  // Calculate where this datagram will land in the heap
  const entrySize = HEADER_SIZE + raw.length
  const pageIndex =
    heap.pageCount +
    (heap.writeBufBytes + entrySize > PAGE_SIZE && heap.writeBufBytes > 0
      ? 1
      : 0)
  // Determine offset: if we're about to seal, it will be at offset 0 of new page,
  // otherwise at current writeBufBytes
  let offset: number
  if (heap.writeBufBytes > 0 && heap.writeBufBytes + entrySize > PAGE_SIZE) {
    // Will seal current page first, so this goes at offset 0 of next page
    offset = 0
  } else {
    offset = heap.writeBufBytes
  }

  // Build metadata entry
  const meta: DatagramMeta = {
    index: heap.datagrams.length,
    trackAlias: decoded.trackAlias,
    groupId: decoded.groupId,
    objectId: decoded.objectId,
    publisherPriority: decoded.publisherPriority,
    direction,
    timestamp: now,
    pageIndex: pageIndex,
    offset,
    rawLength: raw.length,
  }

  heap.datagrams.push(meta)

  // Write length-prefixed entry to heap buffer
  const header = new Uint8Array(HEADER_SIZE)
  const view = new DataView(header.buffer)
  view.setUint32(0, raw.length, true) // little-endian

  // Check if we need to seal before appending
  if (heap.writeBufBytes > 0 && heap.writeBufBytes + entrySize > PAGE_SIZE) {
    sealPage(heap)
  }

  heap.writeBuf.push(header, raw)
  heap.writeBufBytes += entrySize
  heap.totalHeapBytes += entrySize

  // Seal full pages
  while (heap.writeBufBytes >= PAGE_SIZE) {
    sealPage(heap)
  }

  // Update group
  const gk = datagramGroupKey(decoded.trackAlias, decoded.groupId)
  let group = heap.groups.get(gk)
  const isNewGroup = !group
  if (!group) {
    group = {
      trackAlias: decoded.trackAlias,
      groupId: decoded.groupId,
      datagramIndices: [],
      totalPayloadBytes: 0,
      count: 0,
      firstTimestamp: now,
      lastTimestamp: now,
      direction,
      closed: false,
    }
    heap.groups.set(gk, group)
  }

  group.datagramIndices.push(meta.index)
  group.totalPayloadBytes += raw.length
  group.count++
  group.lastTimestamp = now

  if (decoded.endOfGroup) {
    group.closed = true
  }

  return { meta, group, isNewGroup }
}

/** Seal the current write buffer into a page and flush to IDB. */
function sealPage(heap: HeapState): void {
  const page = drainWriteBuf(heap, Math.min(heap.writeBufBytes, PAGE_SIZE))
  const pi = heap.pageCount++
  const key = idbKey(heap.sessionId, pi)

  pageCache.set(key, {
    data: page,
    backed: false,
    refCount: 0,
    lastAccessed: Date.now(),
  })
  writePageToIdb(key, page)
  writeMetaSidecar(heap, pi)
}

function drainWriteBuf(heap: HeapState, count: number): Uint8Array {
  const out = new Uint8Array(count)
  let offset = 0
  while (offset < count && heap.writeBuf.length > 0) {
    const chunk = heap.writeBuf[0]
    const need = count - offset
    if (chunk.length <= need) {
      out.set(chunk, offset)
      offset += chunk.length
      heap.writeBuf.shift()
    } else {
      out.set(chunk.subarray(0, need), offset)
      heap.writeBuf[0] = chunk.subarray(need)
      offset += need
    }
  }
  heap.writeBufBytes -= count
  return out
}

/** Flush remaining write buffer as final page. Call on session close. */
export function flushDatagramHeap(sessionId: string): void {
  const heap = heaps.get(sessionId)
  if (!heap || heap.writeBufBytes === 0) return

  const page = drainWriteBuf(heap, heap.writeBufBytes)
  const pi = heap.pageCount++
  const key = idbKey(sessionId, pi)

  pageCache.set(key, {
    data: page,
    backed: false,
    refCount: 0,
    lastAccessed: Date.now(),
  })
  writePageToIdb(key, page)
  writeMetaSidecar(heap, pi)
}

/**
 * Persist per-page datagram metadata so the heap can be reconstructed
 * after a SW restart. Stores DatagramMeta entries whose pageIndex matches.
 *
 * The group's `closed` flag is recorded too so endOfGroup state is preserved;
 * we attach it to the last sidecar that touches each group.
 */
function writeMetaSidecar(heap: HeapState, pageIndex: number): void {
  const metas: DatagramMeta[] = []
  // Walk from the end backwards: per-page metas are contiguous and the
  // most recent batch will be at the tail.
  for (let i = heap.datagrams.length - 1; i >= 0; i--) {
    const m = heap.datagrams[i]
    if (m.pageIndex !== pageIndex) {
      if (metas.length > 0) break // we've moved past this page's run
      continue
    }
    metas.unshift(m)
  }
  if (metas.length === 0) return

  // Snapshot the closed flag for any group that has datagrams on this page,
  // so reconstruction can recover endOfGroup state.
  const groupClosed: Record<string, boolean> = {}
  const seen = new Set<string>()
  for (const m of metas) {
    const gk = datagramGroupKey(m.trackAlias, m.groupId)
    if (seen.has(gk)) continue
    seen.add(gk)
    const g = heap.groups.get(gk)
    if (g?.closed) groupClosed[gk] = true
  }

  const sidecar = { metas, groupClosed }
  const key = idbMetaKey(heap.sessionId, pageIndex)
  openDb()
    .then((db) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(sidecar, key)
      tx.onerror = () => {
        console.error('[moqtap dg-store] meta write failed:', key, tx.error)
      }
    })
    .catch(() => {})
}

/** Fire-and-forget write to IDB. */
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
        console.error('[moqtap dg-store] page write failed:', key, tx.error)
      }
    })
    .catch((err) => {
      console.error('[moqtap dg-store] page write failed (no db):', err)
    })
}

// ── Read path ──────────────────────────────────────────────────────

/**
 * Load all raw datagram bytes for a datagram group.
 *
 * Returns a buffer where datagrams are concatenated with 4-byte LE
 * length prefixes: [len1][raw1][len2][raw2]...
 * Datagrams are sorted by objectId.
 */
export async function loadDatagramGroupData(
  sessionId: string,
  groupKey: string,
): Promise<Uint8Array> {
  let heap: HeapState | undefined = heaps.get(sessionId)

  // SW restart recovery: rebuild heap from per-page metadata sidecars in IDB.
  if (!heap) {
    heap = (await reconstructHeapFromIdb(sessionId)) ?? undefined
    if (!heap) return new Uint8Array(0)
  }

  const group = heap.groups.get(groupKey)
  if (!group || group.count === 0) return new Uint8Array(0)

  // Collect metadata for this group, sorted by objectId
  const metas = group.datagramIndices
    .map((i) => heap.datagrams[i])
    .sort((a, b) => a.objectId - b.objectId)

  // Determine which pages we need
  const neededPages = new Set<number>()
  for (const m of metas) {
    neededPages.add(m.pageIndex)
  }

  // Load and pin pages
  const pages = new Map<number, Uint8Array>()
  for (const pi of neededPages) {
    const page = await getPage(sessionId, pi, heap)
    if (page) pages.set(pi, page)
  }

  // Calculate total size and build output
  let totalSize = 0
  for (const m of metas) {
    totalSize += HEADER_SIZE + m.rawLength
  }

  const out = new Uint8Array(totalSize)
  let offset = 0

  for (const m of metas) {
    const page = pages.get(m.pageIndex)
    if (page) {
      // Copy the length-prefixed entry from the page
      const entrySize = HEADER_SIZE + m.rawLength
      const src = page.subarray(m.offset, m.offset + entrySize)
      out.set(src, offset)
      offset += entrySize
    }
  }

  // Release page refs
  for (const pi of neededPages) {
    releasePageRef(sessionId, pi)
  }

  return out
}

/**
 * Load all raw datagram bytes for a session (for trace export).
 * Returns all datagram metadata + the ability to extract raw bytes.
 */
export function getDatagramMetas(sessionId: string): DatagramMeta[] {
  const heap = heaps.get(sessionId)
  return heap ? heap.datagrams : []
}

export function getDatagramGroups(
  sessionId: string,
): Map<string, DatagramGroupState> {
  const heap = heaps.get(sessionId)
  return heap ? heap.groups : new Map()
}

/**
 * Rebuild a session's heap state from sidecar metadata in IDB.
 * Called when in-memory state was wiped (SW restart) but pages survive.
 *
 * Reconstructs heap.datagrams, heap.groups, and heap.pageCount.
 * The write buffer stays empty — anything that wasn't sealed before the
 * restart is unrecoverable. totalHeapBytes is approximated from sealed pages.
 */
async function reconstructHeapFromIdb(
  sessionId: string,
): Promise<HeapState | null> {
  const prefix = `${sessionId}:dg:m`
  let cursor: { pageIndex: number; sidecar: SidecarV1 }[] = []
  try {
    const db = await openDb()
    cursor = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`)
      const req = tx.objectStore(STORE_NAME).openCursor(range)
      const out: { pageIndex: number; sidecar: SidecarV1 }[] = []
      req.onsuccess = () => {
        const c = req.result
        if (c) {
          const k = c.key as string
          const pi = Number(k.substring(prefix.length))
          if (Number.isFinite(pi) && c.value && typeof c.value === 'object') {
            out.push({ pageIndex: pi, sidecar: c.value as SidecarV1 })
          }
          c.continue()
        } else {
          resolve(out)
        }
      }
      req.onerror = () => reject(req.error)
    })
  } catch {
    return null
  }

  if (cursor.length === 0) return null

  cursor.sort((a, b) => a.pageIndex - b.pageIndex)

  const heap: HeapState = {
    sessionId,
    writeBuf: [],
    writeBufBytes: 0,
    pageCount: cursor[cursor.length - 1].pageIndex + 1,
    totalHeapBytes: 0,
    datagrams: [],
    groups: new Map(),
  }

  for (const { sidecar } of cursor) {
    if (!Array.isArray(sidecar.metas)) continue
    for (const m of sidecar.metas) {
      const meta: DatagramMeta = {
        index: heap.datagrams.length,
        trackAlias: m.trackAlias,
        groupId: m.groupId,
        objectId: m.objectId,
        publisherPriority: m.publisherPriority,
        direction: m.direction,
        timestamp: m.timestamp,
        pageIndex: m.pageIndex,
        offset: m.offset,
        rawLength: m.rawLength,
      }
      heap.datagrams.push(meta)
      heap.totalHeapBytes += HEADER_SIZE + meta.rawLength

      const gk = datagramGroupKey(meta.trackAlias, meta.groupId)
      let group = heap.groups.get(gk)
      if (!group) {
        group = {
          trackAlias: meta.trackAlias,
          groupId: meta.groupId,
          datagramIndices: [],
          totalPayloadBytes: 0,
          count: 0,
          firstTimestamp: meta.timestamp,
          lastTimestamp: meta.timestamp,
          direction: meta.direction,
          closed: false,
        }
        heap.groups.set(gk, group)
      }
      group.datagramIndices.push(meta.index)
      group.totalPayloadBytes += meta.rawLength
      group.count++
      if (meta.timestamp < group.firstTimestamp) {
        group.firstTimestamp = meta.timestamp
      }
      if (meta.timestamp > group.lastTimestamp) {
        group.lastTimestamp = meta.timestamp
      }
    }
    if (sidecar.groupClosed) {
      for (const gk of Object.keys(sidecar.groupClosed)) {
        const g = heap.groups.get(gk)
        if (g) g.closed = true
      }
    }
  }

  heaps.set(sessionId, heap)
  return heap
}

interface SidecarV1 {
  metas: DatagramMeta[]
  groupClosed?: Record<string, boolean>
}

/** Get a page with ref counting — from memory cache, or reload from IDB. */
async function getPage(
  sessionId: string,
  pageIndex: number,
  heap: HeapState,
): Promise<Uint8Array | null> {
  const key = idbKey(sessionId, pageIndex)

  // Check memory cache
  const cached = pageCache.get(key)
  if (cached) {
    cached.refCount++
    cached.lastAccessed = Date.now()
    return cached.data
  }

  // Check write buffer (current unflushed page)
  if (pageIndex === heap.pageCount && heap.writeBufBytes > 0) {
    // Materialize write buffer into a temporary page
    let totalLen = 0
    for (const chunk of heap.writeBuf) totalLen += chunk.length
    const temp = new Uint8Array(totalLen)
    let off = 0
    for (const chunk of heap.writeBuf) {
      temp.set(chunk, off)
      off += chunk.length
    }
    // Don't cache — it's mutable
    return temp
  }

  // Load from IDB and cache with ref
  try {
    const db = await openDb()
    const data = await readPageFromIdb(db, key)
    if (data) {
      pageCache.set(key, {
        data,
        backed: true,
        refCount: 1,
        lastAccessed: Date.now(),
      })
    }
    return data
  } catch {
    return null
  }
}

function releasePageRef(sessionId: string, pageIndex: number): void {
  const key = idbKey(sessionId, pageIndex)
  const cached = pageCache.get(key)
  if (cached && cached.refCount > 0) {
    cached.refCount--
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
 * Evict backed pages with refCount=0 that haven't been accessed recently.
 * Called by chunk-store's eviction timer (shared).
 */
export function evictStaleDatagramPages(): void {
  const cutoff = Date.now() - EVICT_IDLE_MS
  for (const [key, page] of pageCache) {
    if (page.backed && page.refCount === 0 && page.lastAccessed < cutoff) {
      pageCache.delete(key)
    }
  }
}

// ── Cleanup ────────────────────────────────────────────────────────

/** Remove all datagram data for a session. */
export async function clearDatagramData(sessionId: string): Promise<void> {
  heaps.delete(sessionId)

  // Clear page cache entries for this session's datagram pages
  const prefix = `${sessionId}:dg:`
  for (const key of pageCache.keys()) {
    if (key.startsWith(prefix)) pageCache.delete(key)
  }

  // Clear IDB pages
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
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

/** Clear all datagram data across all sessions. */
export function clearAllDatagramData(): void {
  heaps.clear()
  // IDB pages are cleared by chunk-store's clearAllData (shared store)
}
