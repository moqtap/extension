/**
 * Background service worker — message relay, draft detection, control message
 * decoding, stream data storage, and trace recording.
 *
 * Receives raw stream events from content scripts, detects MoQT draft from
 * the first control stream bytes, decodes control messages with the appropriate
 * codec, writes stream data directly to IndexedDB, and forwards metadata
 * to connected DevTools panels.
 */

import type {
  ContentToBackgroundMsg,
  BackgroundToPanelMsg,
  PanelToBackgroundMsg,
} from '@/src/messaging/types';
import { bytesToBase64, base64ToBytes } from '@/src/messaging/types';
import { detectFromControlStream, type DetectionResult } from '@/src/detect/draft-detect';
import { decodeControlMessage } from '@/src/codec/control-message';
import type { SupportedDraft } from '@/src/types/common';
import { createExtensionRecorder } from '@/src/trace/index';
import type { TraceRecorder } from '@/src/trace/index';
import { MESSAGE_ID_MAP } from '@moqtap/codec/draft14';
import { appendStreamData, flushStream, loadStreamData, clearAllData, clearSessionData, getKnownSessionIds, startEvictionTimer } from '@/src/storage/chunk-store';
import { detectContentType, type StreamContentType } from '@/src/detect/content-detect';
import { parseStreamFraming } from '@/entrypoints/devtools-panel/stream-framing';

interface TabState {
  sessions: Map<string, SessionRecord>;
}

interface SessionRecord {
  sessionId: string;
  url: string;
  createdAt: number;
  streams: Map<number, StreamRecord>;
  closed: boolean;
  closedReason?: string;
  /** Draft detection state */
  detection: DetectionResult | null;
  detectedDraft: SupportedDraft | null;
  /** Accumulated bytes per stream for buffered detection/decoding */
  streamBuffers: Map<number, Uint8Array[]>;
  /** Whether we've attempted detection on this session */
  detectionAttempted: boolean;
  /** Stream ID identified as the control stream (once detected) */
  controlStreamId: number | null;
  /** Trace recorder for this session (only if MoQT detected) */
  recorder: TraceRecorder | null;
  /** History of decoded control messages for replay */
  controlMessages: ControlMessageRecord[];
  /** Track registry: subscribeId -> track info */
  tracks: Map<string, TrackRecord>;
}

interface TrackRecord {
  subscribeId: string;
  trackAlias?: string;
  trackNamespace: string[];
  trackName: string;
  direction: 'tx' | 'rx';
  status: 'pending' | 'active' | 'error' | 'done';
  errorReason?: string;
}

interface StreamRecord {
  streamId: number;
  direction: 'tx' | 'rx';
  closed: boolean;
  byteCount: number;
  contentType?: StreamContentType;
  trackAlias?: number;
  firstDataAt?: number;
}

interface ControlMessageRecord {
  direction: 'tx' | 'rx';
  timestamp: number;
  decoded: string | null;
  messageType: string;
  raw: string;
}

/** Per-tab state */
const tabStates = new Map<number, TabState>();

/** Connected DevTools panel ports, keyed by tabId */
const panelPorts = new Map<number, Browser.runtime.Port>();

/** Connected bridge ports (content script ISOLATED world), keyed by tabId */
const bridgePorts = new Map<number, Browser.runtime.Port>();

/** Tabs that have been activated (instrumentation forwarding enabled) */
const activatedTabs = new Set<number>();

function getTabState(tabId: number): TabState {
  let state = tabStates.get(tabId);
  if (!state) {
    state = { sessions: new Map() };
    tabStates.set(tabId, state);
  }
  return state;
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
  });
}

function sendToPanel(tabId: number, msg: BackgroundToPanelMsg) {
  const port = panelPorts.get(tabId);
  if (port) {
    try {
      port.postMessage(msg);
    } catch {
      panelPorts.delete(tabId);
    }
  }
}

/** Try to detect MoQT draft from accumulated bytes on a given stream.
 *  Returns track updates discovered during initial message decoding. */
function attemptDetection(session: SessionRecord, streamId: number): TrackRecord[] {
  if (session.detectionAttempted) return [];

  const chunks = session.streamBuffers.get(streamId);
  if (!chunks || chunks.length === 0) return [];

  // Concatenate chunks
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  if (totalLen < 4) return []; // need enough bytes for detection

  const buf = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.length;
  }

  const result = detectFromControlStream(buf);

  // If detection returned 'unknown', this stream may not be the control stream.
  // Don't mark as attempted — another stream might be the control stream.
  if (result.protocol === 'unknown') return [];

  session.detectionAttempted = true;
  session.detection = result;
  session.controlStreamId = streamId;

  if (result.protocol === 'moqt') {
    session.detectedDraft = result.draft;

    // Create trace recorder for MoQT sessions
    session.recorder = createExtensionRecorder(result.draft, session.url);

    // Now try to decode the buffered bytes as control messages
    return tryDecodeBuffered(session, buf);
  }
  return [];
}

/** Attempt to decode buffered control stream bytes as control messages.
 *  Returns track updates discovered during decoding. */
function tryDecodeBuffered(session: SessionRecord, buf: Uint8Array): TrackRecord[] {
  const trackUpdates: TrackRecord[] = [];
  if (!session.detectedDraft) return trackUpdates;

  let offset = 0;
  while (offset < buf.length) {
    const remaining = buf.subarray(offset);
    if (remaining.length < 2) break;

    try {
      const result = decodeControlMessage(remaining, session.detectedDraft);
      if (result.ok) {
        const msg = result.value;
        const msgType = ('type' in msg && typeof msg.type === 'string')
          ? msg.type
          : 'unknown';
        const raw = remaining.subarray(0, result.bytesRead);
        const record: ControlMessageRecord = {
          direction: 'rx', // first messages on control stream are received
          timestamp: Date.now(),
          decoded: jsonSafe(msg),
          messageType: msgType,
          raw: bytesToBase64(raw),
        };
        session.controlMessages.push(record);

        // Extract track info
        const trackUpdate = extractTrackInfo(session, msg as unknown as Record<string, unknown>, 'rx');
        if (trackUpdate) trackUpdates.push(trackUpdate);

        // Record in trace
        if (session.recorder) {
          const wireId = MESSAGE_ID_MAP.get(msgType);
          session.recorder.record({
            type: 'control',
            seq: session.controlMessages.length - 1,
            timestamp: Math.round(performance.now() * 1000),
            direction: 1, // rx
            messageType: wireId != null ? Number(wireId) : 0,
            message: msg as unknown as Record<string, unknown>,
          });
        }

        offset += result.bytesRead;
      } else {
        break; // incomplete or invalid, wait for more data
      }
    } catch {
      break;
    }
  }
  return trackUpdates;
}

/** Try to decode a single chunk of control stream data.
 *  Returns a track update if the message is track-related. */
function tryDecodeStreamData(
  session: SessionRecord,
  data: Uint8Array,
  direction: 'tx' | 'rx',
): TrackRecord | null {
  if (!session.detectedDraft) return null;

  try {
    const result = decodeControlMessage(data, session.detectedDraft);
    if (result.ok) {
      const msg = result.value;
      const msgType = ('type' in msg && typeof msg.type === 'string')
        ? msg.type
        : 'unknown';
      const record: ControlMessageRecord = {
        direction,
        timestamp: Date.now(),
        decoded: jsonSafe(msg),
        messageType: msgType,
        raw: bytesToBase64(data),
      };
      session.controlMessages.push(record);

      // Extract track info
      const trackUpdate = extractTrackInfo(session, msg as unknown as Record<string, unknown>, direction);

      // Record in trace
      if (session.recorder) {
        const wireId = MESSAGE_ID_MAP.get(msgType);
        session.recorder.record({
          type: 'control',
          seq: session.controlMessages.length - 1,
          timestamp: Math.round(performance.now() * 1000),
          direction: direction === 'tx' ? 0 : 1,
          messageType: wireId != null ? Number(wireId) : 0,
          message: msg as unknown as Record<string, unknown>,
        });
      }

      return trackUpdate;
    }
  } catch {
    // Decode failed — not a complete message or not control stream data
  }
  return null;
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
  const msgType = String(msg.type ?? '');

  switch (msgType) {
    case 'subscribe': {
      // Draft-07: subscribeId, trackAlias, trackNamespace, trackName
      // Draft-14: request_id, track_namespace, track_name
      const subscribeId = String(msg.subscribeId ?? msg.request_id ?? '');
      const trackAlias = msg.trackAlias != null ? String(msg.trackAlias) : undefined;
      const trackNamespace = (msg.trackNamespace ?? msg.track_namespace ?? []) as string[];
      const trackName = String(msg.trackName ?? msg.track_name ?? '');

      const track: TrackRecord = {
        subscribeId,
        trackAlias,
        trackNamespace,
        trackName,
        direction,
        status: 'pending',
      };
      session.tracks.set(subscribeId, track);
      return track;
    }

    case 'subscribe_ok': {
      const subscribeId = String(msg.subscribeId ?? msg.request_id ?? '');
      const track = session.tracks.get(subscribeId);
      if (track) {
        track.status = 'active';
        return track;
      }
      return null;
    }

    case 'subscribe_error': {
      const subscribeId = String(msg.subscribeId ?? msg.request_id ?? '');
      const track = session.tracks.get(subscribeId);
      if (track) {
        track.status = 'error';
        track.errorReason = String(msg.reasonPhrase ?? msg.reason_phrase ?? '');
        return track;
      }
      return null;
    }

    case 'subscribe_done': {
      const subscribeId = String(msg.subscribeId ?? msg.request_id ?? '');
      const track = session.tracks.get(subscribeId);
      if (track) {
        track.status = 'done';
        return track;
      }
      return null;
    }

    case 'unsubscribe': {
      const subscribeId = String(msg.subscribeId ?? msg.request_id ?? '');
      const track = session.tracks.get(subscribeId);
      if (track) {
        track.status = 'done';
        return track;
      }
      return null;
    }

    default:
      return null;
  }
}

/** Safely JSON-stringify a decoded message, handling bigint and Uint8Array */
function jsonSafe(obj: unknown): string | null {
  try {
    return JSON.stringify(obj, (_key, value) => {
      if (typeof value === 'bigint') return value.toString();
      if (value instanceof Uint8Array) {
        return Array.from(value).map(b => b.toString(16).padStart(2, '0')).join('');
      }
      return value;
    });
  } catch {
    return null;
  }
}

/** Replay current state to a newly connected panel */
function replayState(tabId: number) {
  const state = tabStates.get(tabId);
  if (!state) return;

  for (const session of state.sessions.values()) {
    sendToPanel(tabId, {
      type: 'panel:session:opened',
      sessionId: session.sessionId,
      url: session.url,
      createdAt: session.createdAt,
    });

    // Replay detection result
    if (session.detection) {
      sendToPanel(tabId, {
        type: 'panel:detection',
        sessionId: session.sessionId,
        result: session.detection,
      });
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
      });
    }

    // Replay track registry
    for (const track of session.tracks.values()) {
      sendTrackUpdate(tabId, session.sessionId, track);
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
          firstDataAt: stream.firstDataAt,
          closed: stream.closed,
        });
      }
    }

    if (session.closed) {
      sendToPanel(tabId, {
        type: 'panel:session:closed',
        sessionId: session.sessionId,
        reason: session.closedReason,
      });
    }
  }
}

/** Send activation signal to a tab's bridge content script via persistent port */
function activateTab(tabId: number) {
  if (activatedTabs.has(tabId)) return;
  const bridgePort = bridgePorts.get(tabId);
  if (!bridgePort) return; // Bridge not connected yet — will activate when it connects
  activatedTabs.add(tabId);
  try {
    bridgePort.postMessage({ type: 'activate-tab' });
  } catch {
    activatedTabs.delete(tabId);
    bridgePorts.delete(tabId);
  }
}

/** Handle bridge ready — page (re)loaded. Close stale sessions and re-activate. */
function handleBridgeReady(tabId: number) {
  const existing = tabStates.get(tabId);
  if (existing) {
    for (const session of existing.sessions.values()) {
      if (!session.closed) {
        for (const stream of session.streams.values()) {
          if (!stream.closed) {
            stream.closed = true;
            if (session.recorder) {
              session.recorder.recordStreamClosed(BigInt(stream.streamId));
            }
            sendToPanel(tabId, {
              type: 'panel:stream:closed',
              sessionId: session.sessionId,
              streamId: stream.streamId,
            });
          }
        }

        session.closed = true;
        session.closedReason = 'page reloaded';
        if (session.recorder?.recording) {
          session.recorder.annotate('page-reload', {});
          session.recorder.finalize();
        }
        sendToPanel(tabId, {
          type: 'panel:session:closed',
          sessionId: session.sessionId,
          reason: 'page reloaded',
        });
      }
    }
  }

  activatedTabs.delete(tabId);
  if (panelPorts.has(tabId)) {
    activateTab(tabId);
  }
}

/** Handle a content-to-background message from the bridge port */
function handleContentMessage(message: ContentToBackgroundMsg, tabId: number) {

  // bridge:ready is now handled by port connection, but keep as no-op guard
  if (message.type === 'bridge:ready') return;

  const state = getTabState(tabId);

  switch (message.type) {
    case 'session:opened': {
      const record: SessionRecord = {
        sessionId: message.sessionId,
        url: message.url,
        createdAt: message.createdAt,
        streams: new Map(),
        closed: false,
        detection: null,
        detectedDraft: null,
        streamBuffers: new Map(),
        detectionAttempted: false,
        controlStreamId: null,
        recorder: null,
        controlMessages: [],
        tracks: new Map(),
      };
      state.sessions.set(message.sessionId, record);

      sendToPanel(tabId, {
        type: 'panel:session:opened',
        sessionId: message.sessionId,
        url: message.url,
        createdAt: message.createdAt,
      });
      break;
    }

    case 'stream:data': {
      const session = state.sessions.get(message.sessionId);
      if (!session) break;

      // Port uses structured clone for ArrayBuffer. Keep base64 string
      // fallback for robustness (e.g. if sendMessage is ever used).
      const bytes = typeof message.data === 'string'
        ? base64ToBytes(message.data)
        : new Uint8Array(message.data);

      let stream = session.streams.get(message.streamId);
      const isFirstChunk = !stream;

      if (!stream) {
        stream = {
          streamId: message.streamId,
          direction: message.direction,
          closed: false,
          byteCount: 0,
        };
        session.streams.set(message.streamId, stream);
      }

      if (!stream.firstDataAt) stream.firstDataAt = Date.now();

      // Buffer stream data for detection (any stream could be the control stream)
      if (!session.detectionAttempted) {
        let chunks = session.streamBuffers.get(message.streamId);
        if (!chunks) {
          chunks = [];
          session.streamBuffers.set(message.streamId, chunks);
        }
        chunks.push(bytes);

        const trackUpdates = attemptDetection(session, message.streamId);
        if (session.detection) {
          sendToPanel(tabId, {
            type: 'panel:detection',
            sessionId: message.sessionId,
            result: session.detection,
          });
          for (const track of trackUpdates) {
            sendTrackUpdate(tabId, message.sessionId, track);
          }
        }
      } else if (session.detectedDraft && message.streamId === session.controlStreamId) {
        const trackUpdate = tryDecodeStreamData(session, bytes, message.direction);
        const lastMsg = session.controlMessages[session.controlMessages.length - 1];
        if (lastMsg) {
          sendToPanel(tabId, {
            type: 'panel:control-message',
            sessionId: message.sessionId,
            direction: lastMsg.direction,
            timestamp: lastMsg.timestamp,
            decoded: lastMsg.decoded,
            messageType: lastMsg.messageType,
            raw: lastMsg.raw,
          });
        }
        if (trackUpdate) {
          sendTrackUpdate(tabId, message.sessionId, trackUpdate);
        }
      }

      // First-chunk processing: detect content type and parse stream framing
      if (isFirstChunk) {
        stream.contentType = detectContentType(bytes);
        if (session.detectedDraft) {
          const framing = parseStreamFraming(bytes, session.detectedDraft);
          if (framing) {
            stream.trackAlias = framing.headerFields.trackAlias;
          }
        }
      }

      // Buffer in memory, auto-flush to IDB in 1MB pages
      appendStreamData(message.sessionId, message.streamId, bytes);
      stream.byteCount += bytes.length;

      // Send metadata-only notification to panel
      const panelMsg: BackgroundToPanelMsg = {
        type: 'panel:stream:data',
        sessionId: message.sessionId,
        streamId: message.streamId,
        direction: message.direction,
        byteLength: bytes.length,
        ...(isFirstChunk ? {
          contentType: stream.contentType,
          trackAlias: stream.trackAlias,
        } : {}),
      };
      sendToPanel(tabId, panelMsg);

      // Record stream data in trace
      if (session.recorder) {
        session.recorder.recordStreamOpened(
          BigInt(message.streamId),
          message.direction === 'tx' ? 0 : 1,
          0, // bidi by default, we don't distinguish yet
        );
      }

      break;
    }

    case 'stream:closed': {
      const session = state.sessions.get(message.sessionId);
      if (session) {
        const stream = session.streams.get(message.streamId);
        if (stream) stream.closed = true;
        // Flush remaining buffered data to IDB (data stays accessible for traces)
        flushStream(message.sessionId, message.streamId);

        if (session.recorder) {
          session.recorder.recordStreamClosed(BigInt(message.streamId));
        }
      }

      sendToPanel(tabId, {
        type: 'panel:stream:closed',
        sessionId: message.sessionId,
        streamId: message.streamId,
      });
      break;
    }

    case 'stream:error': {
      const session = state.sessions.get(message.sessionId);
      if (session) {
        const stream = session.streams.get(message.streamId);
        if (stream) stream.closed = true;
        // Flush remaining buffered data to IDB (data stays accessible for traces)
        flushStream(message.sessionId, message.streamId);

        if (session.recorder) {
          session.recorder.recordStreamClosed(BigInt(message.streamId));
          session.recorder.recordError(0, message.error);
        }
      }

      sendToPanel(tabId, {
        type: 'panel:stream:closed',
        sessionId: message.sessionId,
        streamId: message.streamId,
      });
      break;
    }

    case 'session:closed': {
      const session = state.sessions.get(message.sessionId);
      if (session) {
        session.closed = true;
        session.closedReason = message.reason;

        if (session.recorder?.recording) {
          session.recorder.annotate('session-closed', { reason: message.reason });
          session.recorder.finalize();
        }
      }

      sendToPanel(tabId, {
        type: 'panel:session:closed',
        sessionId: message.sessionId,
        reason: message.reason,
      });
      break;
    }

    case 'worker:csp-blocked': {
      sendToPanel(tabId, {
        type: 'panel:worker-csp-warning',
        workerUrl: message.workerUrl,
      });
      break;
    }
  }
}

/**
 * Clean up IDB data from sessions whose tabs no longer exist.
 * Unlike clearAllData(), this preserves data for tabs that are still open,
 * which is critical because the SW can restart after idle and must not
 * destroy data that connected DevTools panels still need.
 */
async function cleanupOrphanedData(): Promise<void> {
  const storedIds = await getKnownSessionIds();
  if (storedIds.size === 0) return;

  // Collect sessionIds that belong to currently open tabs
  const liveSessionIds = new Set<string>();
  for (const state of tabStates.values()) {
    for (const sessionId of state.sessions.keys()) {
      liveSessionIds.add(sessionId);
    }
  }

  // Also check which tabs still exist in the browser — tabStates may be empty
  // after a SW restart, so query the browser for open tabs and be conservative:
  // only clean up if we can confirm the tab no longer exists.
  let openTabIds: Set<number>;
  try {
    const tabs = await browser.tabs.query({});
    openTabIds = new Set(tabs.map((t) => t.id).filter((id): id is number => id != null));
  } catch {
    // Can't query tabs — be conservative, don't clean up anything
    return;
  }

  // Session IDs encode the tabId as the first segment before the dash.
  // But sessionIds are opaque UUIDs — we can't extract tabId from them.
  // So if tabStates is empty (SW just restarted with no reconnections yet),
  // we wait: data in IDB is harmless, and panels will reconnect shortly.
  if (tabStates.size === 0 && openTabIds.size > 0) {
    // SW just restarted — don't clean anything until panels reconnect
    // and we know which sessions are still alive.
    return;
  }

  // Clean up sessions not claimed by any connected tab
  for (const sessionId of storedIds) {
    if (!liveSessionIds.has(sessionId)) {
      await clearSessionData(sessionId);
    }
  }
}

export default defineBackground(() => {

  // Reclaim IDB storage from orphaned sessions (tabs that no longer exist).
  // We intentionally do NOT call clearAllData() here because the service worker
  // can restart after idle (~5 min), and wiping IDB would destroy live session
  // data that panels still need.
  cleanupOrphanedData().catch(() => {});

  // Start periodic eviction of backed pages from memory cache
  startEvictionTimer();

  // Handle long-lived connections from bridge content scripts and DevTools panels
  browser.runtime.onConnect.addListener((port) => {
    // ── Bridge port (content script ISOLATED world → background) ─────
    if (port.name === 'moqtap-bridge') {
      const tabId = (port.sender as { tab?: { id?: number } })?.tab?.id;
      if (!tabId) return;

      // Port connection itself signals bridge:ready (page loaded/reloaded)
      bridgePorts.set(tabId, port);
      handleBridgeReady(tabId);

      port.onMessage.addListener((message: ContentToBackgroundMsg) => {
        handleContentMessage(message, tabId);
      });

      port.onDisconnect.addListener(() => {
        if (bridgePorts.get(tabId) === port) {
          bridgePorts.delete(tabId);
        }
      });
      return;
    }

    // ── Panel port (DevTools panel → background) ─────────────────────
    if (port.name !== 'moqtap-panel') return;

    let connectedTabId: number | null = null;

    port.onMessage.addListener((msg: PanelToBackgroundMsg) => {
      switch (msg.type) {
        case 'panel:connect': {
          connectedTabId = msg.tabId;
          panelPorts.set(msg.tabId, port);

          // Check if there were pre-existing sessions (mid-session open)
          const existingState = tabStates.get(msg.tabId);
          const hadPreExisting = existingState ? existingState.sessions.size > 0 : false;

          // Activate the tab's content script (start forwarding intercepted events)
          activateTab(msg.tabId);

          // Replay any state we already have
          replayState(msg.tabId);

          // Tell panel about instrumentation status
          sendToPanel(msg.tabId, {
            type: 'panel:instrumented',
            hadPreExistingSessions: hadPreExisting,
          });
          break;
        }

        case 'panel:disconnect':
          if (connectedTabId !== null) {
            panelPorts.delete(connectedTabId);
            connectedTabId = null;
          }
          break;

        case 'panel:request-state':
          replayState(msg.tabId);
          break;

        case 'panel:request-stream-data': {
          // Panel requests stream data — background reads from memory + IDB pages
          const { sessionId, streamId, requestId } = msg;
          const replyTabId = connectedTabId;
          if (replyTabId === null) break;
          loadStreamData(sessionId, streamId)
            .then((bytes) => {
              sendToPanel(replyTabId, {
                type: 'panel:stream-data-response',
                requestId,
                data: bytes.length > 0 ? bytesToBase64(bytes) : null,
              });
            })
            .catch((err) => {
              console.error('[moqtap bg] loadStreamData failed:', err);
              sendToPanel(replyTabId, { type: 'panel:stream-data-response', requestId, data: null });
            });
          break;
        }

        case 'panel:clear':
          // Panel is clearing its state — clear IDB and in-memory state
          clearAllData().catch(() => {});
          if (connectedTabId !== null) {
            const state = tabStates.get(connectedTabId);
            if (state) {
              for (const session of state.sessions.values()) {
                for (const stream of session.streams.values()) {
                  stream.byteCount = 0;
                }
              }
            }
          }
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      if (connectedTabId !== null) {
        panelPorts.delete(connectedTabId);
        activatedTabs.delete(connectedTabId);
      }
    });
  });

  // Clean up tab state when tab is closed
  browser.tabs.onRemoved.addListener((tabId) => {
    const state = tabStates.get(tabId);
    if (state) {
      for (const session of state.sessions.values()) {
        if (session.recorder?.recording) {
          session.recorder.finalize();
        }
        // Flush remaining stream buffers to IDB, then clean up all session data
        for (const stream of session.streams.values()) {
          flushStream(session.sessionId, stream.streamId);
        }
        clearSessionData(session.sessionId).catch(() => {});
      }
    }
    tabStates.delete(tabId);
    panelPorts.delete(tabId);
    bridgePorts.delete(tabId);
    activatedTabs.delete(tabId);
  });
});
