/**
 * Composable for the DevTools panel — connects to background and
 * provides reactive state for the inspector UI.
 *
 * Stream chunk data is offloaded to IndexedDB to support long-running
 * sessions without OOM. Only metadata stays in memory.
 */

import type { BackgroundToPanelMsg } from '@/src/messaging/types'
import { base64ToBytes } from '@/src/messaging/types'
import { versionToDraft } from '@/src/detect/draft-detect'
import { onMounted, onUnmounted, ref, triggerRef } from 'vue'
// Panel no longer accesses IDB directly — data requests go through background
import { detectMediaInfo, type PayloadMediaInfo } from '@/src/detect/bmff-boxes'
import {
  detectContentType,
  type StreamContentType,
} from '@/src/detect/content-detect'
import type {
  ControlMessageEvent,
  ObjectPayloadEvent,
  StreamClosedEvent,
  StreamOpenedEvent,
  Trace,
} from '@moqtap/trace'
import { readMoqtrace, writeMoqtrace } from '@moqtap/trace'
import { buildTrace } from './build-trace'

export interface SessionEntry {
  sessionId: string
  url: string
  createdAt: number
  closed: boolean
  closedReason?: string
  protocol: 'moqt' | 'moqt-unknown-draft' | 'unknown' | 'detecting'
  draft?: string
  /** Non-zero when session originates from an iframe */
  frameId?: number
  streams: Map<number, StreamEntry>
  messages: MessageEntry[]
  tracks: Map<string, TrackEntry>
  /** Datagram groups indexed by "trackAlias:groupId" */
  datagramGroups: Map<string, DatagramGroupEntry>
  /** True when session was loaded from an imported .moqtrace file */
  imported?: boolean
  /** Whether stream data recording is active (default true) */
  streamRecording?: boolean
}

export interface TrackEntry {
  subscribeId: string
  trackAlias?: string
  trackNamespace: string[]
  trackName: string
  /** Full display name: namespace/trackName */
  fullName: string
  direction: 'tx' | 'rx'
  status: 'pending' | 'active' | 'error' | 'done'
  errorReason?: string
  /** Assigned color index for consistent color-coding */
  colorIndex: number
  subscribedAt?: number
  subscribeOkAt?: number
  subscribeErrorAt?: number
  subscribeDoneAt?: number
}

export interface StreamEntry {
  streamId: number
  direction: 'tx' | 'rx'
  closed: boolean
  byteCount: number
  /** Detected content type from first chunk */
  contentType: StreamContentType
  /** ISO BMFF media info (variant + box types) from first object payload */
  mediaInfo?: PayloadMediaInfo
  /** Timestamp of first data chunk (ms) */
  firstDataAt?: number
  /** Timestamp of most recent data chunk (ms) */
  lastDataAt?: number
  /** Number of data chunks received (for debugging transport behavior) */
  chunkCount: number
  /** MoQT trackAlias from data stream framing header (if detected) */
  trackAlias?: number
  /** True when this stream is the MoQT bidirectional control stream */
  isControl?: boolean
  /** When set, this entry represents a datagram group (not a real stream) */
  datagramGroupKey?: string
  /** Number of datagrams in the group */
  datagramCount?: number
  /** MoQT group ID (for datagram groups) */
  groupId?: number
}

export interface DatagramGroupEntry {
  /** Unique key: "trackAlias:groupId" */
  groupKey: string
  trackAlias: number
  groupId: number
  direction: 'tx' | 'rx'
  closed: boolean
  byteCount: number
  datagramCount: number
  contentType: StreamContentType
  mediaInfo?: PayloadMediaInfo
  firstDataAt?: number
  lastDataAt?: number
}

export interface MessageEntry {
  timestamp: number
  direction: 'tx' | 'rx'
  messageType: string
  /** Raw decoded values for programmatic use (filtering, trace export). */
  decoded: unknown | null
  /** Display-optimised decoded values with PrettifiedValue wrappers. */
  decodedPretty: unknown | null
  raw: Uint8Array
  /** Stack trace from the call site (tx messages only, ephemeral) */
  stack?: string
}

// ---------------------------------------------------------------------------
// Prettified value helpers
// ---------------------------------------------------------------------------

/**
 * A value wrapper that tells JsonTree how to display a decoded field
 * whose wire representation differs from its display form.
 */
export interface PrettifiedValue {
  __pretty: true
  /** Text to display */
  display: string
  /** Original wire representation (shown in tooltip) */
  original: string
  /** Whether to wrap `display` in quotes */
  quoted: boolean
  /** CSS class applied to the value span */
  cssClass: string
}

export function isPrettifiedValue(v: unknown): v is PrettifiedValue {
  return v != null && typeof v === 'object' && (v as any).__pretty === true
}

function makePretty(
  display: string,
  original: string,
  quoted: boolean,
  cssClass: string,
): PrettifiedValue {
  return { __pretty: true, display, original, quoted, cssClass }
}

// --- Tagged-value detection (produced by background jsonSafe) ---

function isTaggedBigInt(v: unknown): v is { __t: 'n'; v: string } {
  return v != null && typeof v === 'object' && (v as any).__t === 'n'
}

function isTaggedBytes(v: unknown): v is { __t: 'b'; v: string } {
  return v != null && typeof v === 'object' && (v as any).__t === 'b'
}

/**
 * Try to decode a hex string as printable ASCII (0x20–0x7E).
 * Leading NUL (0x00) bytes are stripped — common in protocol-prefixed
 * tokens that carry a type/version byte before the human-readable payload.
 * Returns the decoded string on success, `null` if any non-NUL byte falls
 * outside the printable range or the input is malformed.
 */
function hexToAscii(hex: string): string | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null
  // Skip leading 0x00 bytes (protocol prefix / padding)
  let start = 0
  while (start < hex.length - 1 && hex[start] === '0' && hex[start + 1] === '0') {
    start += 2
  }
  if (start >= hex.length) return null // all NULs
  const chars: string[] = []
  for (let i = start; i < hex.length; i += 2) {
    const byte = parseInt(hex.substring(i, i + 2), 16)
    if (byte < 0x20 || byte > 0x7e) return null
    chars.push(String.fromCharCode(byte))
  }
  return chars.length > 0 ? chars.join('') : null
}


/** Strip type tags, restoring simple JS values for programmatic use. */
function untagDecoded(obj: unknown): unknown {
  if (isTaggedBigInt(obj)) {
    const n = Number(obj.v)
    return Number.isSafeInteger(n) ? n : obj.v
  }
  if (isTaggedBytes(obj)) return obj.v
  if (Array.isArray(obj)) return obj.map(untagDecoded)
  if (obj != null && typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) result[k] = untagDecoded(v)
    return result
  }
  return obj
}

/**
 * Prettify a hex string (either from a tagged Uint8Array or from a codec
 * that returns bytesToHex() directly).
 */
function prettifyHex(hex: string): PrettifiedValue {
  const ascii = hexToAscii(hex)
  if (ascii) {
    // Printable ASCII: show as a quoted string, tooltip has hex.
    return makePretty(ascii, hex, true, 'json-string')
  }
  // Binary: show hex without quotes, styled distinctly.
  return makePretty(hex, hex, false, 'json-bytes')
}

/** Convert tagged values to PrettifiedValue wrappers for display. */
function prettifyValues(obj: unknown): unknown {
  if (isTaggedBigInt(obj)) {
    const n = Number(obj.v)
    // Safe integers can be represented as native numbers — no wrapper needed.
    if (Number.isSafeInteger(n)) return n
    // Unsafe BigInt: show the full decimal, styled as a number, no quotes.
    return makePretty(obj.v, obj.v, false, 'json-number')
  }
  if (isTaggedBytes(obj)) {
    return prettifyHex(obj.v)
  }

  if (Array.isArray(obj)) return obj.map(prettifyValues)
  if (obj != null && typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) result[k] = prettifyValues(v)
    return result
  }
  return obj
}

/**
 * Prettify version numbers in CLIENT_SETUP / SERVER_SETUP decoded payloads.
 * Returns PrettifiedValue wrappers so the UI shows a human-readable label
 * with the original hex value available as a tooltip.
 */
function prettifySetupVersions(
  messageType: string,
  decoded: Record<string, unknown>,
): Record<string, unknown> {
  const formatVersion = (v: unknown): unknown => {
    if (typeof v !== 'number') return v
    if (!Number.isFinite(v) || v < 0xff000000) return v
    const draft = versionToDraft(v)
    const hex = '0x' + v.toString(16).padStart(8, '0')
    return makePretty(
      draft ? `draft-${draft}` : hex,
      hex,
      false,
      'json-pretty',
    )
  }

  if (
    messageType === 'client_setup' &&
    Array.isArray(decoded.supported_versions)
  ) {
    return {
      ...decoded,
      supported_versions: decoded.supported_versions.map(formatVersion),
    }
  }
  if (messageType === 'server_setup' && decoded.selected_version != null) {
    return { ...decoded, selected_version: formatVersion(decoded.selected_version) }
  }
  // draft-17+: unified SETUP message may contain selected_version
  if (messageType === 'setup' && decoded.selected_version != null) {
    return { ...decoded, selected_version: formatVersion(decoded.selected_version) }
  }
  return decoded
}

export function useInspector() {
  const sessions = ref<Map<string, SessionEntry>>(new Map())
  const selectedSessionId = ref<string | null>(null)
  const connected = ref(false)
  /** True when DevTools was opened mid-session (some connections may have been missed) */
  const midSessionOpen = ref(false)
  /** Worker URLs where instrumentation was blocked by CSP */
  const cspBlockedWorkers = ref<string[]>([])
  /** Worker origin exclusion list (auto-detected + manual) */
  const workerExclusions = ref<
    Record<string, import('@/src/messaging/types').ExclusionEntry>
  >({})
  /** Unistream creation stacks (ephemeral, keyed by "sessionId:streamId") */
  const streamCreationStacks = ref<Map<string, string>>(new Map())

  let port: Browser.runtime.Port | null = null
  let nextColorIndex = 0
  let nextRequestId = 1
  const pendingDataRequests = new Map<
    number,
    { resolve: (data: Uint8Array | null) => void }
  >()

  /** Imported trace data stored locally (not in IDB) — keyed by "sessionId:streamId" */
  const importedStreamData = new Map<string, Uint8Array>()

  function getOrCreateSession(sessionId: string): SessionEntry {
    let session = sessions.value.get(sessionId)
    if (!session) {
      session = {
        sessionId,
        url: '',
        createdAt: Date.now(),
        closed: false,
        protocol: 'detecting',
        streams: new Map(),
        messages: [],
        tracks: new Map(),
        datagramGroups: new Map(),
      }
      sessions.value.set(sessionId, session)
    }
    return session
  }

  /** Process a single message, mutating state in place.
   *  Returns true if the sessions Map was mutated (needs triggerRef). */
  function handleMessage(msg: BackgroundToPanelMsg): boolean {
    switch (msg.type) {
      case 'panel:session:opened': {
        const session = getOrCreateSession(msg.sessionId)
        session.url = msg.url
        session.createdAt = msg.createdAt
        session.protocol = 'detecting'
        if (msg.frameId) session.frameId = msg.frameId
        // Auto-select first session
        if (!selectedSessionId.value) {
          selectedSessionId.value = msg.sessionId
        }
        return true
      }

      case 'panel:detection': {
        const session = sessions.value.get(msg.sessionId)
        if (session) {
          session.protocol =
            msg.result.protocol === 'moqt' ? 'moqt' : msg.result.protocol
          if (msg.result.protocol === 'moqt') {
            session.draft = msg.result.draft
          }
          return true
        }
        return false
      }

      case 'panel:control-message': {
        const session = sessions.value.get(msg.sessionId)
        if (session) {
          const tagged = msg.decoded ? JSON.parse(msg.decoded) : null
          const pretty = tagged
            ? prettifySetupVersions(
                msg.messageType,
                prettifyValues(tagged) as Record<string, unknown>,
              )
            : null
          session.messages.push({
            timestamp: msg.timestamp,
            direction: msg.direction,
            messageType: msg.messageType,
            decoded: tagged ? untagDecoded(tagged) : null,
            decodedPretty: pretty,
            raw: base64ToBytes(msg.raw),
            stack: msg.stack,
          })
          return true
        }
        return false
      }

      case 'panel:stream:data': {
        // Metadata-only: background has already written bytes to IndexedDB
        const session = sessions.value.get(msg.sessionId)
        if (!session) return false
        // When recording is paused, ignore stream data notifications
        // (background will also stop sending them once it processes the toggle,
        // but this guards against in-flight messages)
        if (session.streamRecording === false) return false

        {
          let stream = session.streams.get(msg.streamId)
          const now = Date.now()
          if (!stream) {
            stream = {
              streamId: msg.streamId,
              direction: msg.direction,
              closed: false,
              byteCount: 0,
              chunkCount: 0,
              contentType: msg.contentType ?? 'binary',
              mediaInfo: msg.mediaInfo,
              firstDataAt: now,
              trackAlias: msg.trackAlias,
              isControl: msg.isControl,
            }
            session.streams.set(msg.streamId, stream)
          } else if (msg.contentType != null) {
            // First-chunk metadata arrived (possible if stream was created by an earlier message)
            stream.contentType = msg.contentType
            stream.mediaInfo = msg.mediaInfo
            stream.trackAlias = msg.trackAlias
            if (msg.isControl) stream.isControl = true
          }
          stream.lastDataAt = now
          stream.byteCount += msg.byteLength
          stream.chunkCount++
        }
        return true
      }

      case 'panel:stream:info': {
        // State replay: background tells us about streams that already have data in IDB
        const session = sessions.value.get(msg.sessionId)
        if (session) {
          session.streams.set(msg.streamId, {
            streamId: msg.streamId,
            direction: msg.direction,
            closed: msg.closed,
            byteCount: msg.byteCount,
            chunkCount: 0, // not tracked during replay
            contentType: msg.contentType,
            mediaInfo: msg.mediaInfo,
            trackAlias: msg.trackAlias,
            isControl: msg.isControl,
            firstDataAt: msg.firstDataAt,
          })
          return true
        }
        return false
      }

      case 'panel:stream:closed': {
        const session = sessions.value.get(msg.sessionId)
        if (session) {
          const stream = session.streams.get(msg.streamId)
          if (stream) {
            stream.closed = true
            return true
          }
        }
        return false
      }

      case 'panel:stream-created': {
        const key = `${msg.sessionId}:${msg.streamId}`
        streamCreationStacks.value.set(key, msg.stack)
        return true
      }

      case 'panel:session:closed': {
        const session = sessions.value.get(msg.sessionId)
        if (session) {
          session.closed = true
          session.closedReason = msg.reason
          return true
        }
        return false
      }

      case 'panel:track-update': {
        const session = sessions.value.get(msg.sessionId)
        if (session) {
          let track = session.tracks.get(msg.subscribeId)
          if (!track) {
            const ns = msg.trackNamespace
            const fullName = [...ns, msg.trackName].join('/')
            track = {
              subscribeId: msg.subscribeId,
              trackAlias: msg.trackAlias,
              trackNamespace: ns,
              trackName: msg.trackName,
              fullName,
              direction: msg.direction,
              status: msg.status,
              errorReason: msg.errorReason,
              colorIndex: nextColorIndex++,
              subscribedAt: msg.subscribedAt,
              subscribeOkAt: msg.subscribeOkAt,
              subscribeErrorAt: msg.subscribeErrorAt,
              subscribeDoneAt: msg.subscribeDoneAt,
            }
            session.tracks.set(msg.subscribeId, track)
          } else {
            track.status = msg.status
            track.errorReason = msg.errorReason
            if (msg.subscribedAt != null) track.subscribedAt = msg.subscribedAt
            if (msg.subscribeOkAt != null)
              track.subscribeOkAt = msg.subscribeOkAt
            if (msg.subscribeErrorAt != null)
              track.subscribeErrorAt = msg.subscribeErrorAt
            if (msg.subscribeDoneAt != null)
              track.subscribeDoneAt = msg.subscribeDoneAt
          }
          return true
        }
        return false
      }

      case 'panel:instrumented': {
        midSessionOpen.value = msg.hadPreExistingSessions
        return false
      }

      case 'panel:worker-csp-warning': {
        const url = msg.workerUrl
        if (!cspBlockedWorkers.value.includes(url)) {
          cspBlockedWorkers.value = [...cspBlockedWorkers.value, url]
        }
        return false
      }

      case 'panel:exclusion-list': {
        workerExclusions.value = msg.exclusions
        return false
      }

      case 'panel:stream-data-response': {
        const pending = pendingDataRequests.get(msg.requestId)
        if (pending) {
          pendingDataRequests.delete(msg.requestId)
          pending.resolve(msg.data ? base64ToBytes(msg.data) : null)
        }
        return false
      }

      case 'panel:stream-recording': {
        const session = sessions.value.get(msg.sessionId)
        if (session) {
          session.streamRecording = msg.recording
          return true
        }
        return false
      }

      case 'panel:datagram:data': {
        const session = sessions.value.get(msg.sessionId)
        if (!session) return false
        if (session.streamRecording === false) return false

        {
          const gk = `${msg.trackAlias}:${msg.groupId}`
          let group = session.datagramGroups.get(gk)
          const now = Date.now()
          if (!group) {
            group = {
              groupKey: gk,
              trackAlias: msg.trackAlias,
              groupId: msg.groupId,
              direction: msg.direction,
              closed: false,
              byteCount: 0,
              datagramCount: 0,
              contentType: msg.contentType ?? 'binary',
              mediaInfo: msg.mediaInfo,
              firstDataAt: now,
            }
            session.datagramGroups.set(gk, group)
          } else if (msg.isNewGroup && msg.contentType != null) {
            group.contentType = msg.contentType
            group.mediaInfo = msg.mediaInfo
          }
          group.byteCount += msg.byteLength
          group.datagramCount++
          group.lastDataAt = now
          if (msg.endOfGroup) group.closed = true
        }
        return true
      }

      case 'panel:datagram-group:info': {
        // State replay: background tells us about existing datagram groups
        const session = sessions.value.get(msg.sessionId)
        if (session) {
          session.datagramGroups.set(msg.groupKey, {
            groupKey: msg.groupKey,
            trackAlias: msg.trackAlias,
            groupId: msg.groupId,
            direction: msg.direction,
            closed: msg.closed,
            byteCount: msg.byteCount,
            datagramCount: msg.datagramCount,
            contentType: msg.contentType ?? 'binary',
            mediaInfo: msg.mediaInfo,
            firstDataAt: msg.firstDataAt,
          })
          return true
        }
        return false
      }

      case 'panel:datagram-group-data-response': {
        const pending = pendingDataRequests.get(msg.requestId)
        if (pending) {
          pendingDataRequests.delete(msg.requestId)
          pending.resolve(msg.data ? base64ToBytes(msg.data) : null)
        }
        return false
      }

      case 'panel:streams-cleared': {
        // No-op: the optimistic clear in clearStreams() already removed
        // streams from the UI. Acting on this confirmation would incorrectly
        // remove streams that arrived between the optimistic clear and this
        // response (race condition with in-flight stream:data messages).
        return false
      }

      default:
        return false
    }
  }

  // ── Message queue + render coalescing ────────────────────────────
  // Instead of processing each port.onMessage synchronously (which
  // causes the browser to interleave message tasks with expensive Vue
  // renders when thousands of messages are queued), we accumulate
  // incoming messages and drain the entire queue in a single rAF pass.
  // This way ALL pending mutations are applied before a single
  // triggerRef / Vue render, turning O(messages × render) into
  // O(messages) + O(1 render).

  const messageQueue: BackgroundToPanelMsg[] = []
  let drainScheduled = false

  function enqueueMessage(msg: BackgroundToPanelMsg) {
    messageQueue.push(msg)
    if (!drainScheduled) {
      drainScheduled = true
      requestAnimationFrame(drainMessageQueue)
    }
  }

  function drainMessageQueue() {
    drainScheduled = false
    // Drain fully — new messages arriving mid-drain are appended to
    // the same array and picked up by the loop's length check.
    let mutated = false
    for (let i = 0; i < messageQueue.length; i++) {
      if (applyMessage(messageQueue[i])) mutated = true
    }
    messageQueue.length = 0
    if (mutated) triggerRef(sessions)
  }

  /** Apply a single message, mutating state in place.
   *  Returns true if sessions Map was mutated (needs triggerRef). */
  function applyMessage(msg: BackgroundToPanelMsg): boolean {
    switch (msg.type) {
      case 'panel:batch': {
        let m = false
        for (const item of msg.items) {
          if (applyMessage(item)) m = true
        }
        return m
      }
      default:
        return handleMessage(msg)
    }
  }

  function connect() {
    const tabId = browser.devtools.inspectedWindow.tabId
    port = browser.runtime.connect({ name: 'moqtap-panel' })
    connected.value = true

    port.onMessage.addListener(enqueueMessage)

    port.onDisconnect.addListener(() => {
      connected.value = false
      port = null
    })

    // Tell background which tab we're inspecting
    port.postMessage({ type: 'panel:connect', tabId })
    // Request the current exclusion list
    port.postMessage({ type: 'panel:request-exclusions', tabId })
  }

  function selectSession(sessionId: string | null) {
    selectedSessionId.value = sessionId
  }

  function clearSessions() {
    sessions.value = new Map()
    selectedSessionId.value = null
    cspBlockedWorkers.value = []
    importedStreamData.clear()
    // Tell background to clear IDB and reset stream counters
    if (port) {
      const tabId = browser.devtools.inspectedWindow.tabId
      port.postMessage({ type: 'panel:clear', tabId })
    }
  }

  function addWorkerExclusion(origin: string) {
    if (!port) return
    const tabId = browser.devtools.inspectedWindow.tabId
    port.postMessage({ type: 'panel:add-exclusion', tabId, origin })
  }

  function removeWorkerExclusion(origin: string) {
    if (!port) return
    const tabId = browser.devtools.inspectedWindow.tabId
    port.postMessage({ type: 'panel:remove-exclusion', tabId, origin })
  }

  /** Load stream data — from local cache (imports) or background (live sessions) */
  async function getStreamData(
    sessionId: string,
    streamId: number,
  ): Promise<Uint8Array | null> {
    const session = sessions.value.get(sessionId)
    if (!session) return null
    const stream = session.streams.get(streamId)
    if (!stream || stream.byteCount === 0) return null

    // Imported traces: data is in local memory
    const importKey = `${sessionId}:${streamId}`
    const imported = importedStreamData.get(importKey)
    if (imported) return imported

    if (!port) return null

    const requestId = nextRequestId++
    const tabId = browser.devtools.inspectedWindow.tabId
    return new Promise<Uint8Array | null>((resolve) => {
      const timeout = setTimeout(() => {
        pendingDataRequests.delete(requestId)
        console.warn('[moqtap panel] stream data request timed out')
        resolve(null)
      }, 10000)
      pendingDataRequests.set(requestId, {
        resolve: (data) => {
          clearTimeout(timeout)
          resolve(data)
        },
      })
      port!.postMessage({
        type: 'panel:request-stream-data',
        tabId,
        sessionId,
        streamId,
        requestId,
      })
    })
  }

  /** Load datagram group data — from local cache (imports) or background (live sessions) */
  async function getDatagramGroupData(
    sessionId: string,
    groupKey: string,
  ): Promise<Uint8Array | null> {
    const session = sessions.value.get(sessionId)
    if (!session) return null
    const group = session.datagramGroups.get(groupKey)
    if (!group || group.byteCount === 0) return null

    // Imported traces: data is in local memory
    const importKey = `${sessionId}:dg:${groupKey}`
    const imported = importedStreamData.get(importKey)
    if (imported) return imported

    if (!port) return null

    const requestId = nextRequestId++
    const tabId = browser.devtools.inspectedWindow.tabId
    return new Promise<Uint8Array | null>((resolve) => {
      const timeout = setTimeout(() => {
        pendingDataRequests.delete(requestId)
        console.warn('[moqtap panel] datagram group data request timed out')
        resolve(null)
      }, 10000)
      pendingDataRequests.set(requestId, {
        resolve: (data) => {
          clearTimeout(timeout)
          resolve(data)
        },
      })
      port!.postMessage({
        type: 'panel:request-datagram-group-data',
        tabId,
        sessionId,
        groupKey,
        requestId,
      })
    })
  }

  function setStreamRecording(sessionId: string, recording: boolean) {
    // Optimistic update — apply immediately so UI responds instantly
    const session = sessions.value.get(sessionId)
    if (session) {
      session.streamRecording = recording
      triggerRef(sessions)
    }
    if (!port) return
    const tabId = browser.devtools.inspectedWindow.tabId
    port.postMessage({
      type: 'panel:set-stream-recording',
      tabId,
      sessionId,
      recording,
    })
  }

  function clearStreams(sessionId: string) {
    // Optimistic update — clear streams and datagram groups from UI immediately,
    // but preserve the control stream (it's always-open and unrecoverable)
    const session = sessions.value.get(sessionId)
    if (session) {
      for (const [id, stream] of session.streams) {
        if (!stream.isControl) session.streams.delete(id)
      }
      session.datagramGroups.clear()
      triggerRef(sessions)
    }
    if (!port) return
    const tabId = browser.devtools.inspectedWindow.tabId
    port.postMessage({ type: 'panel:clear-streams', tabId, sessionId })
  }

  async function exportTrace(sessionId: string) {
    const session = sessions.value.get(sessionId)
    if (!session || session.protocol !== 'moqt') return

    try {
      const trace = await buildTrace(
        session,
        getStreamData,
        getDatagramGroupData,
      )
      const binary = writeMoqtrace(trace)
      const draft = session.draft ?? 'unknown'
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, 19)
      const filename = `moqtap-${draft}-${timestamp}.moqtrace`

      const blob = new Blob([binary as BlobPart], {
        type: 'application/octet-stream',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      setTimeout(() => {
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      }, 100)
    } catch (err) {
      console.error('[moqtap] Export failed:', err)
    }
  }

  /** Import a .moqtrace file and create a synthetic session from it */
  function importTrace(file: File) {
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const bytes = new Uint8Array(reader.result as ArrayBuffer)
        const trace = readMoqtrace(bytes)
        await loadTraceAsSession(trace, file.name)
      } catch (err) {
        console.error('[moqtap] Failed to read .moqtrace file:', err)
      }
    }
    reader.readAsArrayBuffer(file)
  }

  async function loadTraceAsSession(trace: Trace, filename: string) {
    const sessionId = `imported-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const header = trace.header

    // Determine draft from protocol string (e.g. "moq-transport-14")
    const draftMatch = header.protocol.match(/moq-transport-(\d+)/)
    const draft = draftMatch ? draftMatch[1] : undefined

    const session: SessionEntry = {
      sessionId,
      url: header.endpoint ?? filename,
      createdAt: header.startTime,
      closed: true,
      closedReason: 'imported',
      protocol: draft ? 'moqt' : 'unknown',
      draft,
      streams: new Map(),
      messages: [],
      tracks: new Map(),
      datagramGroups: new Map(),
      imported: true,
    }

    // Collect payload data per stream to write to IndexedDB after session is built
    const streamPayloads = new Map<number, Uint8Array[]>()
    // Collect datagram payloads keyed by groupKey ("trackAlias:groupId")
    // For imported traces, we use trackAlias=0 since we don't have it
    const dgPayloads = new Map<string, Uint8Array[]>()

    // Reconstruct state from trace events
    for (const event of trace.events) {
      switch (event.type) {
        case 'control': {
          const ce = event as ControlMessageEvent
          const msg = ce.message
          const msgType =
            typeof msg.type === 'string'
              ? msg.type
              : `0x${(ce.messageType ?? 0).toString(16)}`
          session.messages.push({
            timestamp: ce.timestamp,
            direction: ce.direction === 0 ? 'tx' : 'rx',
            messageType: msgType,
            decoded: msg,
            decodedPretty: prettifySetupVersions(
              msgType,
              msg as Record<string, unknown>,
            ),
            raw: ce.raw ?? new Uint8Array(0),
          })

          // Extract track info from control messages
          extractTrackFromImported(
            session,
            msg,
            ce.direction === 0 ? 'tx' : 'rx',
            ce.timestamp,
          )
          break
        }

        case 'stream-opened': {
          const se = event as StreamOpenedEvent
          const streamId = Number(se.streamId)
          if (!session.streams.has(streamId)) {
            session.streams.set(streamId, {
              streamId,
              direction: se.direction === 0 ? 'tx' : 'rx',
              closed: false,
              byteCount: 0,
              chunkCount: 0,
              contentType: 'binary',
            })
          }
          break
        }

        case 'object-payload': {
          const op = event as ObjectPayloadEvent
          const streamId = Number(op.streamId)

          // Detect datagram-style events: streamId=0 with groupId
          if (streamId === 0 && op.groupId !== undefined) {
            const groupId = Number(op.groupId)
            const gk = `0:${groupId}` // trackAlias=0 for imports
            if (op.payload && op.payload.length > 0) {
              let payloads = dgPayloads.get(gk)
              if (!payloads) {
                payloads = []
                dgPayloads.set(gk, payloads)
              }
              payloads.push(
                op.payload instanceof Uint8Array
                  ? op.payload
                  : new Uint8Array(op.payload as ArrayLike<number>),
              )
            }
            break
          }

          // Ensure stream entry exists
          if (!session.streams.has(streamId)) {
            session.streams.set(streamId, {
              streamId,
              direction: 'rx',
              closed: false,
              byteCount: 0,
              chunkCount: 0,
              contentType: 'binary',
            })
          }

          if (op.payload && op.payload.length > 0) {
            let payloads = streamPayloads.get(streamId)
            if (!payloads) {
              payloads = []
              streamPayloads.set(streamId, payloads)
            }
            payloads.push(
              op.payload instanceof Uint8Array
                ? op.payload
                : new Uint8Array(op.payload as ArrayLike<number>),
            )
          }
          break
        }

        case 'stream-closed': {
          const sc = event as StreamClosedEvent
          const streamId = Number(sc.streamId)
          const stream = session.streams.get(streamId)
          if (stream) stream.closed = true
          break
        }
      }
    }

    // Store collected payloads in local map (imports don't use IDB)
    for (const [streamId, payloads] of streamPayloads) {
      const stream = session.streams.get(streamId)
      if (!stream) continue

      // Merge all payloads into a single Uint8Array
      let totalLen = 0
      for (const chunk of payloads) totalLen += chunk.length
      const merged = new Uint8Array(totalLen)
      let offset = 0
      for (let i = 0; i < payloads.length; i++) {
        const chunk = payloads[i]
        merged.set(chunk, offset)
        offset += chunk.length
        if (i === 0) {
          stream.contentType = detectContentType(chunk)
          if (stream.contentType === 'fmp4') {
            // Imported payloads are raw object data — detect BMFF boxes directly
            stream.mediaInfo = detectMediaInfo(chunk) ?? undefined
          }
        }
      }
      stream.byteCount = totalLen
      importedStreamData.set(`${sessionId}:${streamId}`, merged)
    }

    // Reconstruct datagram groups from imported trace
    for (const [gk, payloads] of dgPayloads) {
      const parts = gk.split(':')
      const trackAlias = Number(parts[0])
      const groupId = Number(parts[1])

      // Build length-prefixed datagram group data (matching heap store format)
      let totalLen = 0
      for (const chunk of payloads) totalLen += 4 + chunk.length
      const merged = new Uint8Array(totalLen)
      const dv = new DataView(merged.buffer)
      let offset = 0
      for (let i = 0; i < payloads.length; i++) {
        const chunk = payloads[i]
        dv.setUint32(offset, chunk.length, true)
        merged.set(chunk, offset + 4)
        offset += 4 + chunk.length
      }

      // Detect content from first payload
      let ct: StreamContentType = 'binary'
      let mediaInfo: PayloadMediaInfo | undefined
      if (payloads.length > 0) {
        ct = detectContentType(payloads[0])
        if (ct === 'fmp4') {
          mediaInfo = detectMediaInfo(payloads[0]) ?? undefined
        }
      }

      session.datagramGroups.set(gk, {
        groupKey: gk,
        trackAlias,
        groupId,
        direction: 'rx',
        closed: true,
        byteCount: totalLen,
        datagramCount: payloads.length,
        contentType: ct,
        mediaInfo,
      })

      importedStreamData.set(`${sessionId}:dg:${gk}`, merged)
    }

    sessions.value.set(sessionId, session)
    selectedSessionId.value = sessionId
    triggerRef(sessions)
  }

  /** Extract track subscription info from an imported control message */
  function extractTrackFromImported(
    session: SessionEntry,
    msg: Record<string, unknown>,
    direction: 'tx' | 'rx',
    timestamp?: number,
  ) {
    const msgType = String(msg.type ?? '')

    if (msgType === 'subscribe') {
      const subscribeId = String(msg.subscribeId ?? msg.request_id ?? '')
      const ns = (msg.trackNamespace ?? msg.track_namespace ?? []) as string[]
      const name = String(msg.trackName ?? msg.track_name ?? '')
      const fullName = [...ns, name].join('/')
      session.tracks.set(subscribeId, {
        subscribeId,
        trackAlias: msg.trackAlias != null ? String(msg.trackAlias) : undefined,
        trackNamespace: ns,
        trackName: name,
        fullName,
        direction,
        status: 'pending',
        colorIndex: nextColorIndex++,
        subscribedAt: timestamp,
      })
    } else if (msgType === 'subscribe_ok') {
      const subscribeId = String(msg.subscribeId ?? msg.request_id ?? '')
      const track = session.tracks.get(subscribeId)
      if (track) {
        track.status = 'active'
        track.subscribeOkAt = timestamp
      }
    } else if (msgType === 'subscribe_error') {
      const subscribeId = String(msg.subscribeId ?? msg.request_id ?? '')
      const track = session.tracks.get(subscribeId)
      if (track) {
        track.status = 'error'
        track.errorReason = String(msg.reasonPhrase ?? msg.reason_phrase ?? '')
        track.subscribeErrorAt = timestamp
      }
    } else if (msgType === 'subscribe_done' || msgType === 'unsubscribe') {
      const subscribeId = String(msg.subscribeId ?? msg.request_id ?? '')
      const track = session.tracks.get(subscribeId)
      if (track) {
        track.status = 'done'
        track.subscribeDoneAt = timestamp
      }
    }
  }

  onMounted(() => {
    connect()
  })

  onUnmounted(() => {
    if (port) {
      port.disconnect()
      port = null
    }
  })

  return {
    sessions,
    selectedSessionId,
    connected,
    midSessionOpen,
    cspBlockedWorkers,
    workerExclusions,
    streamCreationStacks,
    selectSession,
    clearSessions,
    getStreamData,
    getDatagramGroupData,
    exportTrace,
    importTrace,
    setStreamRecording,
    clearStreams,
    addWorkerExclusion,
    removeWorkerExclusion,
  }
}
