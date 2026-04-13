/**
 * Background service worker — message relay, draft detection, control message
 * decoding, stream data storage, and trace recording.
 *
 * Receives raw stream events from content scripts, detects MoQT draft from
 * the first control stream bytes, decodes control messages with the appropriate
 * codec, writes stream data directly to IndexedDB, and forwards metadata
 * to connected DevTools panels.
 */

import { parseStreamFraming } from '@/entrypoints/devtools-panel/stream-framing'
import { decodeControlMessage, getCodec } from '@/src/codec/control-message'
import type { PayloadMediaInfo } from '@/src/detect/bmff-boxes'
import {
  detectContentType,
  detectPayloadMedia,
  detectStreamMedia,
  type StreamContentType,
} from '@/src/detect/content-detect'
import {
  detectFromControlStream,
  type DetectionResult,
} from '@/src/detect/draft-detect'
import type {
  BackgroundToPanelMsg,
  ContentToBackgroundMsg,
  ExclusionEntry,
  PanelToBackgroundMsg,
} from '@/src/messaging/types'
import { base64ToBytes, bytesToBase64 } from '@/src/messaging/types'
import {
  appendStreamData,
  clearAllData,
  clearSessionData,
  flushStream,
  getKnownSessionIds,
  getSessionTabMap,
  loadStreamData,
  saveSessionTab,
  setAdditionalEvictionFn,
  startEvictionTimer,
} from '@/src/storage/chunk-store'
import {
  appendDatagram,
  clearAllDatagramData,
  clearDatagramData,
  evictStaleDatagramPages,
  flushDatagramHeap,
  getDatagramGroups,
  loadDatagramGroupData,
} from '@/src/storage/datagram-store'
import { createExtensionRecorder } from '@/src/trace/index'
import type { SupportedDraft } from '@/src/types/common'
import { getMessageIdMap } from '@/src/codec/message-ids'
import type { TraceRecorder } from '@moqtap/trace'

interface TabState {
  sessions: Map<string, SessionRecord>
}

interface SessionRecord {
  sessionId: string
  url: string
  createdAt: number
  /** Frame ID — 0 for main frame, non-zero for iframes */
  frameId: number
  streams: Map<number, StreamRecord>
  closed: boolean
  closedReason?: string
  /** Draft detection state */
  detection: DetectionResult | null
  detectedDraft: SupportedDraft | null
  /** Accumulated bytes per stream for buffered detection/decoding */
  streamBuffers: Map<number, { data: Uint8Array; direction: 'tx' | 'rx' }[]>
  /** Whether we've attempted detection on this session */
  detectionAttempted: boolean
  /** Stream ID identified as the control stream (once detected) */
  controlStreamId: number | null
  /** Reassembly buffer for partial control messages that span chunks */
  controlRemainder: Uint8Array | null
  /** Trace recorder for this session (only if MoQT detected) */
  recorder: TraceRecorder | null
  /** History of decoded control messages for replay */
  controlMessages: ControlMessageRecord[]
  /** Track registry: subscribeId -> track info */
  tracks: Map<string, TrackRecord>
  /** Whether stream data recording is active (default true) */
  streamRecording: boolean
  /** Stream IDs whose data should be discarded (cleared while still open) */
  discardedStreamIds: Set<number>
}

interface TrackRecord {
  subscribeId: string
  trackAlias?: string
  trackNamespace: string[]
  trackName: string
  direction: 'tx' | 'rx'
  status: 'pending' | 'active' | 'error' | 'done'
  errorReason?: string
  subscribedAt?: number
  subscribeOkAt?: number
  subscribeErrorAt?: number
  subscribeDoneAt?: number
}

interface StreamRecord {
  streamId: number
  direction: 'tx' | 'rx'
  closed: boolean
  byteCount: number
  contentType?: StreamContentType
  trackAlias?: number
  /** ISO BMFF media info from first object payload */
  mediaInfo?: PayloadMediaInfo
  firstDataAt?: number
}

interface ControlMessageRecord {
  direction: 'tx' | 'rx'
  timestamp: number
  decoded: string | null
  messageType: string
  raw: string
  /** Stack trace from the call site (tx messages only, ephemeral) */
  stack?: string
}

/** Per-tab state */
const tabStates = new Map<number, TabState>()

/** Connected DevTools panel ports, keyed by tabId */
const panelPorts = new Map<number, Browser.runtime.Port>()

/** Connected bridge ports (content script ISOLATED world), keyed by tabId → frameId → port */
const bridgePorts = new Map<number, Map<number, Browser.runtime.Port>>()

/** Tabs that have been activated (instrumentation forwarding enabled) */
const activatedTabs = new Set<number>()

function getTabState(tabId: number): TabState {
  let state = tabStates.get(tabId)
  if (!state) {
    state = { sessions: new Map() }
    tabStates.set(tabId, state)
  }
  return state
}

function sendTrackUpdate(tabId: number, sessionId: string, track: TrackRecord) {
  sendToPanel(tabId, {
    type: 'panel:track-update',
    sessionId,
    subscribeId: track.subscribeId,
    trackAlias: track.trackAlias,
    trackNamespace: track.trackNamespace,
    trackName: track.trackName,
    direction: track.direction,
    status: track.status,
    errorReason: track.errorReason,
    subscribedAt: track.subscribedAt,
    subscribeOkAt: track.subscribeOkAt,
    subscribeErrorAt: track.subscribeErrorAt,
    subscribeDoneAt: track.subscribeDoneAt,
  })
}

function sendToPanel(tabId: number, msg: BackgroundToPanelMsg) {
  const port = panelPorts.get(tabId)
  if (port) {
    try {
      port.postMessage(msg)
    } catch {
      panelPorts.delete(tabId)
    }
  }
}

// ── Batched panel notifications for high-frequency messages ──────
// Instead of sending one port.postMessage per stream chunk / datagram,
// we accumulate them and flush periodically.  This reduces the number
// of IPC messages from O(objects) to O(time / BATCH_INTERVAL), which
// prevents the panel from freezing when it returns from background.

const BATCH_INTERVAL = 50 // ms — 20 flushes/sec, barely perceptible latency
const pendingBatches = new Map<number, BackgroundToPanelMsg[]>()
let batchTimer: ReturnType<typeof setTimeout> | null = null

function queueForPanel(tabId: number, msg: BackgroundToPanelMsg) {
  let items = pendingBatches.get(tabId)
  if (!items) {
    items = []
    pendingBatches.set(tabId, items)
  }
  items.push(msg)
  if (!batchTimer) {
    batchTimer = setTimeout(flushPanelBatches, BATCH_INTERVAL)
  }
}

function flushPanelBatches() {
  batchTimer = null
  for (const [tabId, items] of pendingBatches) {
    if (items.length === 0) continue
    const batch = items.splice(0)
    sendToPanel(tabId, { type: 'panel:batch', items: batch })
  }
}

/** Try to detect MoQT draft from accumulated bytes on a given stream.
 *  Returns track updates discovered during initial message decoding. */
function attemptDetection(
  session: SessionRecord,
  streamId: number,
): TrackRecord[] {
  if (session.detectionAttempted) return []

  const chunks = session.streamBuffers.get(streamId)
  if (!chunks || chunks.length === 0) return []

  // Concatenate chunks
  const totalLen = chunks.reduce((s, c) => s + c.data.length, 0)
  if (totalLen < 4) return [] // need enough bytes for detection

  const buf = new Uint8Array(totalLen)
  let offset = 0
  for (const chunk of chunks) {
    buf.set(chunk.data, offset)
    offset += chunk.data.length
  }

  const result = detectFromControlStream(buf)

  // If detection returned 'unknown', this stream may not be the control stream.
  // Don't mark as attempted — another stream might be the control stream.
  if (result.protocol === 'unknown') return []

  session.detectionAttempted = true
  session.detection = result
  session.controlStreamId = streamId

  if (result.protocol === 'moqt') {
    session.detectedDraft = result.draft

    // Create trace recorder for MoQT sessions
    session.recorder = createExtensionRecorder(result.draft, session.url)

    // Build a byte-offset → direction map so tryDecodeBuffered can
    // assign the correct direction to each decoded message.
    const directionMap: { offset: number; direction: 'tx' | 'rx' }[] = []
    let dirOffset = 0
    for (const chunk of chunks) {
      directionMap.push({ offset: dirOffset, direction: chunk.direction })
      dirOffset += chunk.data.length
    }

    // Now try to decode the buffered bytes as control messages
    return tryDecodeBuffered(session, buf, directionMap)
  }
  return []
}

/** Attempt to decode buffered control stream bytes as control messages.
 *  Returns track updates discovered during decoding. */
function tryDecodeBuffered(
  session: SessionRecord,
  buf: Uint8Array,
  directionMap: { offset: number; direction: 'tx' | 'rx' }[],
): TrackRecord[] {
  const trackUpdates: TrackRecord[] = []
  if (!session.detectedDraft) return trackUpdates

  let offset = 0
  while (offset < buf.length) {
    const remaining = buf.subarray(offset)
    if (remaining.length < 2) break

    try {
      const result = decodeControlMessage(remaining, session.detectedDraft)
      if (result.ok) {
        const msg = result.value
        const msgType =
          'type' in msg && typeof msg.type === 'string' ? msg.type : 'unknown'
        const raw = remaining.subarray(0, result.bytesRead)

        // Look up direction from the chunk that contains this offset
        let direction: 'tx' | 'rx' = 'rx'
        for (let i = directionMap.length - 1; i >= 0; i--) {
          if (directionMap[i].offset <= offset) {
            direction = directionMap[i].direction
            break
          }
        }

        const record: ControlMessageRecord = {
          direction,
          timestamp: Date.now(),
          decoded: jsonSafe(msg),
          messageType: msgType,
          raw: bytesToBase64(raw),
        }
        session.controlMessages.push(record)

        // Extract track info
        const trackUpdate = extractTrackInfo(
          session,
          msg as unknown as Record<string, unknown>,
          direction,
        )
        if (trackUpdate) trackUpdates.push(trackUpdate)

        // Record in trace
        if (session.recorder) {
          const idMap = getMessageIdMap(session.detectedDraft!)
          const wireId = idMap.get(msgType)
          session.recorder.record({
            type: 'control',
            seq: session.controlMessages.length - 1,
            timestamp: Math.round(performance.now() * 1000),
            direction: direction === 'tx' ? 0 : 1,
            messageType: wireId != null ? Number(wireId) : 0,
            message: msg as unknown as Record<string, unknown>,
          })
        }

        offset += result.bytesRead
      } else {
        break // incomplete or invalid, wait for more data
      }
    } catch {
      break
    }
  }
  // Save leftover bytes for reassembly with the next chunk
  session.controlRemainder = offset < buf.length ? buf.subarray(offset) : null
  return trackUpdates
}

/** Decode all complete control messages from a chunk, with reassembly
 *  for partial messages that span chunks.  Returns decoded records and
 *  track updates so the caller can forward them to the panel. */
function decodeControlChunk(
  session: SessionRecord,
  data: Uint8Array,
  direction: 'tx' | 'rx',
  stack?: string,
): { records: ControlMessageRecord[]; trackUpdates: TrackRecord[] } {
  const records: ControlMessageRecord[] = []
  const trackUpdates: TrackRecord[] = []
  if (!session.detectedDraft) return { records, trackUpdates }

  // Prepend any leftover bytes from the previous chunk
  let buf: Uint8Array
  if (session.controlRemainder && session.controlRemainder.length > 0) {
    buf = new Uint8Array(session.controlRemainder.length + data.length)
    buf.set(session.controlRemainder)
    buf.set(data, session.controlRemainder.length)
    session.controlRemainder = null
  } else {
    buf = data
  }

  let offset = 0
  while (offset < buf.length) {
    const remaining = buf.subarray(offset)
    if (remaining.length < 2) break

    try {
      const result = decodeControlMessage(remaining, session.detectedDraft)
      if (result.ok) {
        const msg = result.value
        const msgType =
          'type' in msg && typeof msg.type === 'string' ? msg.type : 'unknown'
        const raw = remaining.subarray(0, result.bytesRead)
        const record: ControlMessageRecord = {
          direction,
          timestamp: Date.now(),
          decoded: jsonSafe(msg),
          messageType: msgType,
          raw: bytesToBase64(raw),
          stack: direction === 'tx' ? stack : undefined,
        }
        session.controlMessages.push(record)
        records.push(record)

        const trackUpdate = extractTrackInfo(
          session,
          msg as unknown as Record<string, unknown>,
          direction,
        )
        if (trackUpdate) trackUpdates.push(trackUpdate)

        if (session.recorder) {
          const idMap = getMessageIdMap(session.detectedDraft!)
          const wireId = idMap.get(msgType)
          session.recorder.record({
            type: 'control',
            seq: session.controlMessages.length - 1,
            timestamp: Math.round(performance.now() * 1000),
            direction: direction === 'tx' ? 0 : 1,
            messageType: wireId != null ? Number(wireId) : 0,
            message: msg as unknown as Record<string, unknown>,
          })
        }

        offset += result.bytesRead
      } else {
        break // incomplete message, wait for more data
      }
    } catch {
      break
    }
  }

  // Save leftover bytes for reassembly with the next chunk
  session.controlRemainder = offset < buf.length ? buf.subarray(offset) : null

  return { records, trackUpdates }
}

/**
 * Extract track subscription info from a decoded control message.
 * Returns a track update to send to the panel, or null if not track-related.
 */
function extractTrackInfo(
  session: SessionRecord,
  msg: Record<string, unknown>,
  direction: 'tx' | 'rx',
): TrackRecord | null {
  const msgType = String(msg.type ?? '')

  switch (msgType) {
    case 'subscribe': {
      // Draft-07: subscribeId, trackAlias, trackNamespace, trackName
      // Draft-14: request_id, track_namespace, track_name
      const subscribeId = String(msg.subscribeId ?? msg.request_id ?? '')
      const trackAlias =
        msg.trackAlias != null ? String(msg.trackAlias) : undefined
      const trackNamespace = (msg.trackNamespace ??
        msg.track_namespace ??
        []) as string[]
      const trackName = String(msg.trackName ?? msg.track_name ?? '')

      const track: TrackRecord = {
        subscribeId,
        trackAlias,
        trackNamespace,
        trackName,
        direction,
        status: 'pending',
        subscribedAt: Date.now(),
      }
      session.tracks.set(subscribeId, track)
      return track
    }

    case 'subscribe_ok': {
      const subscribeId = String(msg.subscribeId ?? msg.request_id ?? '')
      const track = session.tracks.get(subscribeId)
      if (track) {
        track.status = 'active'
        track.subscribeOkAt = Date.now()
        return track
      }
      return null
    }

    case 'subscribe_error': {
      const subscribeId = String(msg.subscribeId ?? msg.request_id ?? '')
      const track = session.tracks.get(subscribeId)
      if (track) {
        track.status = 'error'
        track.errorReason = String(msg.reasonPhrase ?? msg.reason_phrase ?? '')
        track.subscribeErrorAt = Date.now()
        return track
      }
      return null
    }

    case 'subscribe_done': {
      const subscribeId = String(msg.subscribeId ?? msg.request_id ?? '')
      const track = session.tracks.get(subscribeId)
      if (track) {
        track.status = 'done'
        track.subscribeDoneAt = Date.now()
        return track
      }
      return null
    }

    case 'unsubscribe': {
      const subscribeId = String(msg.subscribeId ?? msg.request_id ?? '')
      const track = session.tracks.get(subscribeId)
      if (track) {
        track.status = 'done'
        track.subscribeDoneAt = Date.now()
        return track
      }
      return null
    }

    default:
      return null
  }
}

/**
 * Safely JSON-stringify a decoded message, handling bigint and Uint8Array.
 *
 * Values that lose their type through JSON round-tripping are wrapped in
 * tagged objects so the panel can recover the original type:
 *   bigint       → { __t: "n", v: "<decimal>" }
 *   Uint8Array   → { __t: "b", v: "<hex>" }
 */
function jsonSafe(obj: unknown): string | null {
  try {
    return JSON.stringify(obj, (_key, value) => {
      if (typeof value === 'bigint') return { __t: 'n', v: value.toString() }
      if (value instanceof Uint8Array) {
        return {
          __t: 'b',
          v: Array.from(value)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(''),
        }
      }
      return value
    })
  } catch {
    return null
  }
}

/** Replay current state to a newly connected panel */
function replayState(tabId: number) {
  const state = tabStates.get(tabId)
  if (!state) return

  for (const session of state.sessions.values()) {
    sendToPanel(tabId, {
      type: 'panel:session:opened',
      sessionId: session.sessionId,
      url: session.url,
      createdAt: session.createdAt,
      ...(session.frameId !== 0 ? { frameId: session.frameId } : {}),
    })

    // Replay detection result
    if (session.detection) {
      sendToPanel(tabId, {
        type: 'panel:detection',
        sessionId: session.sessionId,
        result: session.detection,
      })
    }

    // Replay control messages
    for (const msg of session.controlMessages) {
      sendToPanel(tabId, {
        type: 'panel:control-message',
        sessionId: session.sessionId,
        direction: msg.direction,
        timestamp: msg.timestamp,
        decoded: msg.decoded,
        messageType: msg.messageType,
        raw: msg.raw,
        stack: msg.stack,
      })
    }

    // Replay track registry
    for (const track of session.tracks.values()) {
      sendTrackUpdate(tabId, session.sessionId, track)
    }

    // Replay stream recording state
    if (!session.streamRecording) {
      sendToPanel(tabId, {
        type: 'panel:stream-recording',
        sessionId: session.sessionId,
        recording: false,
      })
    }

    // Replay stream metadata (data is in memory buffer + IDB pages)
    for (const stream of session.streams.values()) {
      if (stream.byteCount > 0) {
        sendToPanel(tabId, {
          type: 'panel:stream:info',
          sessionId: session.sessionId,
          streamId: stream.streamId,
          direction: stream.direction,
          byteCount: stream.byteCount,
          contentType: stream.contentType ?? 'binary',
          trackAlias: stream.trackAlias,
          mediaInfo: stream.mediaInfo,
          ...(session.controlStreamId === stream.streamId
            ? { isControl: true }
            : {}),
          firstDataAt: stream.firstDataAt,
          closed: stream.closed,
        })
      }
    }

    // Replay datagram group metadata
    const dgGroups = getDatagramGroups(session.sessionId)
    for (const [gk, group] of dgGroups) {
      sendToPanel(tabId, {
        type: 'panel:datagram-group:info',
        sessionId: session.sessionId,
        groupKey: gk,
        trackAlias: group.trackAlias,
        groupId: group.groupId,
        direction: group.direction,
        byteCount: group.totalPayloadBytes,
        datagramCount: group.count,
        contentType: group.contentType,
        mediaInfo: group.mediaInfo,
        firstDataAt: group.firstTimestamp,
        closed: group.closed,
      })
    }

    if (session.closed) {
      sendToPanel(tabId, {
        type: 'panel:session:closed',
        sessionId: session.sessionId,
        reason: session.closedReason,
      })
    }
  }
}

/** Send activation signal to a tab's bridge content script via persistent port */
function activateTab(tabId: number) {
  if (activatedTabs.has(tabId)) return
  const framePorts = bridgePorts.get(tabId)
  if (!framePorts || framePorts.size === 0) return // Bridge not connected yet — will activate when it connects
  activatedTabs.add(tabId)
  for (const [frameId, port] of framePorts) {
    try {
      port.postMessage({ type: 'activate-tab' })
    } catch {
      framePorts.delete(frameId)
    }
  }
  if (framePorts.size === 0) {
    activatedTabs.delete(tabId)
    bridgePorts.delete(tabId)
  }
}

/** Handle bridge ready — page (re)loaded. Close stale sessions and re-activate.
 *  Only closes existing sessions when the main frame (frameId 0) reconnects,
 *  since that implies a full page navigation. Iframe reconnects don't affect
 *  sessions from other frames. */
function handleBridgeReady(tabId: number, frameId: number) {
  // Only main frame navigation should close existing sessions
  if (frameId === 0) {
    const existing = tabStates.get(tabId)
    if (existing) {
      for (const session of existing.sessions.values()) {
        if (!session.closed) {
          for (const stream of session.streams.values()) {
            if (!stream.closed) {
              stream.closed = true
              if (session.recorder) {
                session.recorder.recordStreamClosed(BigInt(stream.streamId))
              }
              sendToPanel(tabId, {
                type: 'panel:stream:closed',
                sessionId: session.sessionId,
                streamId: stream.streamId,
              })
            }
          }

          session.closed = true
          session.closedReason = 'page reloaded'
          if (session.recorder?.recording) {
            session.recorder.annotate('page-reload', {})
            session.recorder.finalize()
          }
          sendToPanel(tabId, {
            type: 'panel:session:closed',
            sessionId: session.sessionId,
            reason: 'page reloaded',
          })
        }
      }
    }

    activatedTabs.delete(tabId)
  }

  if (panelPorts.has(tabId)) {
    if (activatedTabs.has(tabId)) {
      // Tab already activated — just activate the new frame's bridge directly
      const framePorts = bridgePorts.get(tabId)
      const framePort = framePorts?.get(frameId)
      if (framePort) {
        try {
          framePort.postMessage({ type: 'activate-tab' })
        } catch {
          /* port dead */
        }
      }
    } else {
      activateTab(tabId)
    }
  }
}

/** Handle a content-to-background message from the bridge port */
function handleContentMessage(
  message: ContentToBackgroundMsg,
  tabId: number,
  frameId: number,
) {
  // bridge:ready is now handled by port connection, but keep as no-op guard
  if (message.type === 'bridge:ready') return

  const state = getTabState(tabId)

  switch (message.type) {
    case 'session:opened': {
      const record: SessionRecord = {
        sessionId: message.sessionId,
        url: message.url,
        createdAt: message.createdAt,
        frameId,
        streams: new Map(),
        closed: false,
        detection: null,
        detectedDraft: null,
        streamBuffers: new Map(),
        detectionAttempted: false,
        controlStreamId: null,
        controlRemainder: null,
        recorder: null,
        controlMessages: [],
        tracks: new Map(),
        streamRecording: true,
        discardedStreamIds: new Set(),
      }
      state.sessions.set(message.sessionId, record)

      // Persist session→tab mapping so cleanupOrphanedData can identify
      // which tab owns this session even after a SW restart.
      saveSessionTab(message.sessionId, tabId)

      sendToPanel(tabId, {
        type: 'panel:session:opened',
        sessionId: message.sessionId,
        url: message.url,
        createdAt: message.createdAt,
        ...(frameId !== 0 ? { frameId } : {}),
      })
      break
    }

    case 'stream:data': {
      const session = state.sessions.get(message.sessionId)
      if (!session) break

      // Port uses structured clone for ArrayBuffer. Keep base64 string
      // fallback for robustness (e.g. if sendMessage is ever used).
      const bytes =
        typeof message.data === 'string'
          ? base64ToBytes(message.data)
          : new Uint8Array(message.data)

      let stream = session.streams.get(message.streamId)
      const isFirstChunk = !stream

      if (!stream) {
        stream = {
          streamId: message.streamId,
          direction: message.direction,
          closed: false,
          byteCount: 0,
        }
        session.streams.set(message.streamId, stream)
      }

      if (!stream.firstDataAt) stream.firstDataAt = Date.now()

      // Buffer stream data for detection (any stream could be the control stream)
      if (!session.detectionAttempted) {
        let chunks = session.streamBuffers.get(message.streamId)
        if (!chunks) {
          chunks = []
          session.streamBuffers.set(message.streamId, chunks)
        }
        chunks.push({ data: bytes, direction: message.direction })

        const trackUpdates = attemptDetection(session, message.streamId)
        if (session.detection) {
          sendToPanel(tabId, {
            type: 'panel:detection',
            sessionId: message.sessionId,
            result: session.detection,
          })
          // Send detection-phase control messages to the panel
          // (replayState already ran before the buffer flush, so these
          // would otherwise never reach the panel)
          for (const msg of session.controlMessages) {
            sendToPanel(tabId, {
              type: 'panel:control-message',
              sessionId: message.sessionId,
              direction: msg.direction,
              timestamp: msg.timestamp,
              decoded: msg.decoded,
              messageType: msg.messageType,
              raw: msg.raw,
              stack: msg.stack,
            })
          }
          for (const track of trackUpdates) {
            sendTrackUpdate(tabId, message.sessionId, track)
          }
        }
      } else if (
        session.detectedDraft &&
        message.streamId === session.controlStreamId
      ) {
        const { records, trackUpdates } = decodeControlChunk(
          session,
          bytes,
          message.direction,
          message.stack,
        )
        for (const rec of records) {
          sendToPanel(tabId, {
            type: 'panel:control-message',
            sessionId: message.sessionId,
            direction: rec.direction,
            timestamp: rec.timestamp,
            decoded: rec.decoded,
            messageType: rec.messageType,
            raw: rec.raw,
            stack: rec.stack,
          })
        }
        for (const track of trackUpdates) {
          sendTrackUpdate(tabId, message.sessionId, track)
        }
      }

      // Skip data processing for non-control streams when recording is
      // paused or the stream has been discarded (cleared while still open).
      const isControlStream =
        session.controlStreamId != null &&
        message.streamId === session.controlStreamId
      const skipData =
        !isControlStream &&
        (!session.streamRecording ||
          session.discardedStreamIds.has(message.streamId))

      if (!skipData) {
        // First-chunk processing: detect content type and parse stream framing
        let detectionUpdated = false
        if (isFirstChunk) {
          stream.contentType = detectContentType(bytes)

          if (session.detectedDraft && !isControlStream) {
            const framing = parseStreamFraming(bytes, session.detectedDraft)
            if (framing) {
              stream.trackAlias = framing.headerFields.trackAlias

              // Use framing boundaries for precise BMFF detection on first object payload
              if (framing.objects.length > 0) {
                const obj = framing.objects[0]
                const end = Math.min(
                  obj.payloadOffset + obj.payloadLength,
                  bytes.length,
                )
                if (end > obj.payloadOffset) {
                  const payload = bytes.subarray(obj.payloadOffset, end)
                  const media = detectPayloadMedia(payload)
                  if (media) {
                    stream.contentType = 'fmp4'
                    stream.mediaInfo = media
                  }
                }
              }
            }
          }

          // Fallback: if no framing available, try scanning raw bytes for BMFF
          if (!stream.mediaInfo && stream.contentType === 'fmp4') {
            stream.mediaInfo = detectStreamMedia(bytes) ?? undefined
          }
        }

        // Retry detection on subsequent chunks if first chunk failed.
        // Common cause: first chunk arrived before draft detection or was too
        // small (just MoQT header bytes with no payload).
        if (
          !isFirstChunk &&
          stream.contentType === 'binary' &&
          stream.byteCount < 16384
        ) {
          const media = detectStreamMedia(bytes)
          if (media) {
            stream.contentType = 'fmp4'
            stream.mediaInfo = media
            detectionUpdated = true
          } else {
            const ct = detectContentType(bytes)
            if (ct !== 'binary') {
              stream.contentType = ct
              detectionUpdated = true
            }
          }
        }

        // Buffer in memory, auto-flush to IDB in 1MB pages
        appendStreamData(message.sessionId, message.streamId, bytes)
        stream.byteCount += bytes.length

        // Queue metadata-only notification for panel (batched)
        const panelMsg: BackgroundToPanelMsg = {
          type: 'panel:stream:data',
          sessionId: message.sessionId,
          streamId: message.streamId,
          direction: message.direction,
          byteLength: bytes.length,
          ...(isFirstChunk || detectionUpdated
            ? {
                contentType: stream.contentType,
                trackAlias: stream.trackAlias,
                mediaInfo: stream.mediaInfo,
                ...(isControlStream ? { isControl: true } : {}),
              }
            : {}),
        }
        queueForPanel(tabId, panelMsg)

        // Record stream data in trace
        if (session.recorder) {
          session.recorder.recordStreamOpened(
            BigInt(message.streamId),
            message.direction === 'tx' ? 0 : 1,
            0, // bidi by default, we don't distinguish yet
          )
        }
      }

      break
    }

    case 'stream:created': {
      // Unistream creation stack — ephemeral, forward to panel but don't store
      sendToPanel(tabId, {
        type: 'panel:stream-created',
        sessionId: message.sessionId,
        streamId: message.streamId,
        stack: message.stack,
      })
      break
    }

    case 'stream:closed': {
      const session = state.sessions.get(message.sessionId)
      if (session) {
        const stream = session.streams.get(message.streamId)
        if (stream) stream.closed = true
        session.discardedStreamIds.delete(message.streamId)
        // Flush remaining buffered data to IDB (data stays accessible for traces)
        flushStream(message.sessionId, message.streamId)

        if (session.recorder) {
          session.recorder.recordStreamClosed(BigInt(message.streamId))
        }
      }

      sendToPanel(tabId, {
        type: 'panel:stream:closed',
        sessionId: message.sessionId,
        streamId: message.streamId,
      })
      break
    }

    case 'stream:error': {
      const session = state.sessions.get(message.sessionId)
      if (session) {
        const stream = session.streams.get(message.streamId)
        if (stream) stream.closed = true
        session.discardedStreamIds.delete(message.streamId)
        // Flush remaining buffered data to IDB (data stays accessible for traces)
        flushStream(message.sessionId, message.streamId)

        if (session.recorder) {
          session.recorder.recordStreamClosed(BigInt(message.streamId))
          session.recorder.recordError(0, message.error)
        }
      }

      sendToPanel(tabId, {
        type: 'panel:stream:closed',
        sessionId: message.sessionId,
        streamId: message.streamId,
      })
      break
    }

    case 'session:closed': {
      const session = state.sessions.get(message.sessionId)
      if (session) {
        session.closed = true
        session.closedReason = message.reason

        // Flush datagram heap to IDB
        flushDatagramHeap(message.sessionId)

        if (session.recorder?.recording) {
          session.recorder.annotate('session-closed', {
            reason: message.reason,
          })
          session.recorder.finalize()
        }
      }

      sendToPanel(tabId, {
        type: 'panel:session:closed',
        sessionId: message.sessionId,
        reason: message.reason,
      })
      break
    }

    case 'datagram:data': {
      const session = state.sessions.get(message.sessionId)
      if (!session) break

      const bytes =
        typeof message.data === 'string'
          ? base64ToBytes(message.data)
          : new Uint8Array(message.data)

      // Skip when recording is paused
      if (!session.streamRecording) break

      // Datagrams require a detected draft to decode the MoQT header
      if (!session.detectedDraft) break

      // Decode the MoQT datagram header
      // All draft codecs have decodeDatagram at runtime; the base Codec type
      // doesn't declare it, so we use a type assertion with a minimal interface.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const codec = getCodec(session.detectedDraft) as any
      if (typeof codec.decodeDatagram !== 'function') break
      const result = codec.decodeDatagram(bytes)
      if (!result.ok) break // Not a valid MoQT datagram — drop silently

      const dg = result.value as {
        trackAlias: bigint
        groupId: bigint
        objectId: bigint
        publisherPriority: number
        endOfGroup?: boolean
        payload: Uint8Array
        payloadLength: number
      }
      const decoded = {
        trackAlias: Number(dg.trackAlias),
        groupId: Number(dg.groupId),
        objectId: Number(dg.objectId),
        publisherPriority: dg.publisherPriority,
        endOfGroup: dg.endOfGroup,
      }

      // Append to datagram heap store
      const appendResult = appendDatagram(
        message.sessionId,
        bytes,
        decoded,
        message.direction,
      )

      // First-datagram-in-group detection: detect content type from payload
      if (appendResult.isNewGroup && dg.payload.length > 0) {
        const ct = detectContentType(dg.payload)
        appendResult.group.contentType = ct
        if (ct === 'fmp4') {
          appendResult.group.mediaInfo =
            detectPayloadMedia(dg.payload) ?? undefined
        }
      }

      // Queue datagram notification for panel (batched)
      const panelMsg: BackgroundToPanelMsg = {
        type: 'panel:datagram:data',
        sessionId: message.sessionId,
        direction: message.direction,
        trackAlias: decoded.trackAlias,
        groupId: decoded.groupId,
        objectId: decoded.objectId,
        byteLength: bytes.length,
        isNewGroup: appendResult.isNewGroup,
        ...(appendResult.isNewGroup
          ? {
              contentType: appendResult.group.contentType,
              mediaInfo: appendResult.group.mediaInfo,
            }
          : {}),
        ...(decoded.endOfGroup ? { endOfGroup: true } : {}),
      }
      queueForPanel(tabId, panelMsg)

      // Record in trace
      if (session.recorder) {
        session.recorder.recordObjectHeader(
          0n, // no streamId for datagrams — use 0
          BigInt(decoded.groupId),
          BigInt(decoded.objectId),
          decoded.publisherPriority,
          0, // objectStatus
        )
      }

      break
    }

    case 'worker:csp-blocked': {
      sendToPanel(tabId, {
        type: 'panel:worker-csp-warning',
        workerUrl: message.workerUrl,
      })
      break
    }

    case 'worker:csp-recovered': {
      // Persist auto-exclusion to global storage
      persistExclusion(message.origin, 'auto', message.error)
      sendToPanel(tabId, {
        type: 'panel:worker-csp-warning',
        workerUrl: message.workerUrl || message.origin,
      })
      break
    }
  }
}

// ─── Worker origin exclusion list (browser.storage.local) ────────────

const EXCLUSIONS_KEY = 'moqtap-worker-exclusions'

async function loadExclusions(): Promise<Record<string, ExclusionEntry>> {
  try {
    const result = await browser.storage.local.get(EXCLUSIONS_KEY)
    return (result[EXCLUSIONS_KEY] as Record<string, ExclusionEntry>) ?? {}
  } catch {
    return {}
  }
}

async function saveExclusions(
  exclusions: Record<string, ExclusionEntry>,
): Promise<void> {
  try {
    await browser.storage.local.set({ [EXCLUSIONS_KEY]: exclusions })
  } catch {
    /* storage not available */
  }
}

async function persistExclusion(
  origin: string,
  source: 'auto' | 'manual',
  error?: string,
): Promise<void> {
  const exclusions = await loadExclusions()
  exclusions[origin] = { blockedAt: Date.now(), source, error }
  await saveExclusions(exclusions)
}

async function removeExclusion(origin: string): Promise<void> {
  const exclusions = await loadExclusions()
  delete exclusions[origin]
  await saveExclusions(exclusions)
}

/**
 * Clean up IDB data from sessions whose tabs no longer exist.
 * Unlike clearAllData(), this preserves data for tabs that are still open,
 * which is critical because the SW can restart after idle and must not
 * destroy data that connected DevTools panels still need.
 *
 * Uses a persisted sessionId→tabId mapping in IDB (written when each
 * session is opened) so we can positively identify which tab owns each
 * session and only delete data for tabs that are confirmed closed.
 * This avoids the race condition where panels reconnect after a SW
 * restart but haven't re-claimed their sessions yet.
 */
async function cleanupOrphanedData(): Promise<void> {
  const storedIds = await getKnownSessionIds()
  if (storedIds.size === 0) return

  // Read the persisted session→tab mapping from IDB
  const sessionTabMap = await getSessionTabMap()

  // Query the browser for currently open tabs
  let openTabIds: Set<number>
  try {
    const tabs = await browser.tabs.query({})
    openTabIds = new Set(
      tabs.map((t) => t.id).filter((id): id is number => id != null),
    )
  } catch {
    // Can't query tabs — be conservative, don't clean up anything
    return
  }

  for (const sessionId of storedIds) {
    const ownerTabId = sessionTabMap.get(sessionId)
    if (ownerTabId == null) {
      // No tab mapping — session predates the mapping feature, or the
      // mapping write didn't land. Be conservative: only clean up if
      // there are no open tabs at all.
      if (openTabIds.size === 0) {
        await clearSessionData(sessionId)
      }
      continue
    }
    if (!openTabIds.has(ownerTabId)) {
      // Owner tab no longer exists — safe to clean up
      await clearSessionData(sessionId)
    }
  }
}

export default defineBackground(() => {
  // Reclaim IDB storage from orphaned sessions (tabs that no longer exist).
  // We intentionally do NOT call clearAllData() here because the service worker
  // can restart after idle (~5 min), and wiping IDB would destroy live session
  // data that panels still need.
  cleanupOrphanedData().catch(() => {})

  // Start periodic eviction of backed pages from memory cache
  setAdditionalEvictionFn(evictStaleDatagramPages)
  startEvictionTimer()

  // Handle long-lived connections from bridge content scripts and DevTools panels
  browser.runtime.onConnect.addListener((port) => {
    // ── Bridge port (content script ISOLATED world → background) ─────
    if (port.name === 'moqtap-bridge') {
      const sender = port.sender as { tab?: { id?: number }; frameId?: number }
      const tabId = sender?.tab?.id
      if (!tabId) return
      const frameId = sender?.frameId ?? 0

      // Store port in per-tab, per-frame map
      let framePorts = bridgePorts.get(tabId)
      if (!framePorts) {
        framePorts = new Map()
        bridgePorts.set(tabId, framePorts)
      }
      framePorts.set(frameId, port)

      // Port connection itself signals bridge:ready (page loaded/reloaded)
      handleBridgeReady(tabId, frameId)

      port.onMessage.addListener((message: ContentToBackgroundMsg) => {
        handleContentMessage(message, tabId, frameId)
      })

      port.onDisconnect.addListener(() => {
        const fp = bridgePorts.get(tabId)
        if (fp?.get(frameId) === port) {
          fp.delete(frameId)
          if (fp.size === 0) bridgePorts.delete(tabId)
        }

        // If this is an iframe (not main frame) and the tab is still alive,
        // the iframe was destroyed. Close any open sessions from this frame
        // since WebTransport won't fire a clean close event.
        if (frameId !== 0) {
          const state = tabStates.get(tabId)
          if (!state) return
          for (const session of state.sessions.values()) {
            if (session.frameId !== frameId || session.closed) continue
            for (const stream of session.streams.values()) {
              if (!stream.closed) {
                stream.closed = true
                if (session.recorder) {
                  session.recorder.recordStreamClosed(BigInt(stream.streamId))
                }
                sendToPanel(tabId, {
                  type: 'panel:stream:closed',
                  sessionId: session.sessionId,
                  streamId: stream.streamId,
                })
              }
            }
            session.closed = true
            session.closedReason = 'iframe removed'
            if (session.recorder?.recording) {
              session.recorder.annotate('iframe-removed', {})
              session.recorder.finalize()
            }
            sendToPanel(tabId, {
              type: 'panel:session:closed',
              sessionId: session.sessionId,
              reason: 'iframe removed',
            })
          }
        }
      })
      return
    }

    // ── Panel port (DevTools panel → background) ─────────────────────
    if (port.name !== 'moqtap-panel') return

    let connectedTabId: number | null = null

    port.onMessage.addListener((msg: PanelToBackgroundMsg) => {
      switch (msg.type) {
        case 'panel:connect': {
          connectedTabId = msg.tabId
          panelPorts.set(msg.tabId, port)

          // Check if there were pre-existing sessions (mid-session open)
          const existingState = tabStates.get(msg.tabId)
          const hadPreExisting = existingState
            ? existingState.sessions.size > 0
            : false

          // Activate the tab's content script (start forwarding intercepted events)
          activateTab(msg.tabId)

          // Replay any state we already have
          replayState(msg.tabId)

          // Tell panel about instrumentation status
          sendToPanel(msg.tabId, {
            type: 'panel:instrumented',
            hadPreExistingSessions: hadPreExisting,
          })
          break
        }

        case 'panel:disconnect':
          if (connectedTabId !== null) {
            panelPorts.delete(connectedTabId)
            connectedTabId = null
          }
          break

        case 'panel:request-state':
          replayState(msg.tabId)
          break

        case 'panel:request-stream-data': {
          // Panel requests stream data — background reads from memory + IDB pages
          const { sessionId, streamId, requestId } = msg
          const replyTabId = connectedTabId
          if (replyTabId === null) break
          loadStreamData(sessionId, streamId)
            .then((bytes) => {
              sendToPanel(replyTabId, {
                type: 'panel:stream-data-response',
                requestId,
                data: bytes.length > 0 ? bytesToBase64(bytes) : null,
              })
            })
            .catch((err) => {
              console.error('[moqtap bg] loadStreamData failed:', err)
              sendToPanel(replyTabId, {
                type: 'panel:stream-data-response',
                requestId,
                data: null,
              })
            })
          break
        }

        case 'panel:clear':
          // Panel is clearing its state — clear IDB and in-memory state.
          // Drop all session records so future events from the content script
          // (which is still running) are silently ignored.
          clearAllData().catch(() => {})
          clearAllDatagramData()
          if (connectedTabId !== null) {
            const state = tabStates.get(connectedTabId)
            if (state) {
              state.sessions.clear()
            }
          }
          break

        case 'panel:set-stream-recording': {
          if (connectedTabId === null) break
          const state = tabStates.get(connectedTabId)
          const session = state?.sessions.get(msg.sessionId)
          if (session) {
            session.streamRecording = msg.recording
            sendToPanel(connectedTabId, {
              type: 'panel:stream-recording',
              sessionId: msg.sessionId,
              recording: msg.recording,
            })
          }
          break
        }

        case 'panel:request-datagram-group-data': {
          const { sessionId, groupKey, requestId } = msg
          const replyTabId = connectedTabId
          if (replyTabId === null) break
          loadDatagramGroupData(sessionId, groupKey)
            .then((bytes) => {
              sendToPanel(replyTabId, {
                type: 'panel:datagram-group-data-response',
                requestId,
                data: bytes.length > 0 ? bytesToBase64(bytes) : null,
              })
            })
            .catch((err) => {
              console.error('[moqtap bg] loadDatagramGroupData failed:', err)
              sendToPanel(replyTabId, {
                type: 'panel:datagram-group-data-response',
                requestId,
                data: null,
              })
            })
          break
        }

        case 'panel:clear-streams': {
          if (connectedTabId === null) break
          const state = tabStates.get(connectedTabId)
          const session = state?.sessions.get(msg.sessionId)
          if (session) {
            // Mark open non-control streams as discarded
            for (const stream of session.streams.values()) {
              if (
                !stream.closed &&
                stream.streamId !== session.controlStreamId
              ) {
                session.discardedStreamIds.add(stream.streamId)
              }
            }
            // Remove all stream records (except control stream)
            for (const streamId of [...session.streams.keys()]) {
              if (streamId !== session.controlStreamId) {
                session.streams.delete(streamId)
              }
            }
            // Clear stored stream data and datagrams from memory and IDB
            clearSessionData(msg.sessionId).catch(() => {})
            clearDatagramData(msg.sessionId).catch(() => {})

            sendToPanel(connectedTabId, {
              type: 'panel:streams-cleared',
              sessionId: msg.sessionId,
            })
          }
          break
        }

        case 'panel:request-exclusions': {
          loadExclusions().then((exclusions) => {
            if (connectedTabId !== null) {
              sendToPanel(connectedTabId, {
                type: 'panel:exclusion-list',
                exclusions,
              })
            }
          })
          break
        }

        case 'panel:add-exclusion': {
          persistExclusion(msg.origin, 'manual')
            .then(() => {
              return loadExclusions()
            })
            .then((exclusions) => {
              if (connectedTabId !== null) {
                sendToPanel(connectedTabId, {
                  type: 'panel:exclusion-list',
                  exclusions,
                })
              }
            })
          break
        }

        case 'panel:remove-exclusion': {
          removeExclusion(msg.origin)
            .then(() => {
              return loadExclusions()
            })
            .then((exclusions) => {
              if (connectedTabId !== null) {
                sendToPanel(connectedTabId, {
                  type: 'panel:exclusion-list',
                  exclusions,
                })
              }
            })
          break
        }
      }
    })

    port.onDisconnect.addListener(() => {
      if (connectedTabId !== null) {
        panelPorts.delete(connectedTabId)
        activatedTabs.delete(connectedTabId)
      }
    })
  })

  // Clean up tab state when tab is closed
  browser.tabs.onRemoved.addListener((tabId) => {
    const state = tabStates.get(tabId)
    if (state) {
      for (const session of state.sessions.values()) {
        if (session.recorder?.recording) {
          session.recorder.finalize()
        }
        // Flush remaining stream buffers and datagram heap to IDB, then clean up
        for (const stream of session.streams.values()) {
          flushStream(session.sessionId, stream.streamId)
        }
        flushDatagramHeap(session.sessionId)
        clearSessionData(session.sessionId).catch(() => {})
        clearDatagramData(session.sessionId).catch(() => {})
      }
    }
    tabStates.delete(tabId)
    panelPorts.delete(tabId)
    bridgePorts.delete(tabId)
    activatedTabs.delete(tabId)
  })
})
