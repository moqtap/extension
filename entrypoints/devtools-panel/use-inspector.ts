/**
 * Composable for the DevTools panel — connects to background and
 * provides reactive state for the inspector UI.
 *
 * Stream chunk data is offloaded to IndexedDB to support long-running
 * sessions without OOM. Only metadata stays in memory.
 */

import { ref, onMounted, onUnmounted } from 'vue';
import type { BackgroundToPanelMsg } from '@/src/messaging/types';
import { base64ToBytes } from '@/src/messaging/types';
// Panel no longer accesses IDB directly — data requests go through background
import { detectContentType } from './content-detect';
import type { StreamContentType } from './content-detect';
export type { StreamContentType };
import { readMoqtrace, writeMoqtrace } from '@/src/trace/index';
import type { Trace, ControlMessageEvent, StreamOpenedEvent, StreamClosedEvent, ObjectPayloadEvent } from '@/src/trace/index';
import { buildTrace } from './build-trace';

export interface SessionEntry {
  sessionId: string;
  url: string;
  createdAt: number;
  closed: boolean;
  closedReason?: string;
  protocol: 'moqt' | 'moqt-unknown-draft' | 'unknown' | 'detecting';
  draft?: string;
  streams: Map<number, StreamEntry>;
  messages: MessageEntry[];
  tracks: Map<string, TrackEntry>;
  /** True when session was loaded from an imported .moqtrace file */
  imported?: boolean;
}

export interface TrackEntry {
  subscribeId: string;
  trackAlias?: string;
  trackNamespace: string[];
  trackName: string;
  /** Full display name: namespace/trackName */
  fullName: string;
  direction: 'tx' | 'rx';
  status: 'pending' | 'active' | 'error' | 'done';
  errorReason?: string;
  /** Assigned color index for consistent color-coding */
  colorIndex: number;
}

export interface StreamEntry {
  streamId: number;
  direction: 'tx' | 'rx';
  closed: boolean;
  byteCount: number;
  /** Detected content type from first chunk */
  contentType: StreamContentType;
  /** Timestamp of first data chunk (ms) */
  firstDataAt?: number;
  /** Timestamp of most recent data chunk (ms) */
  lastDataAt?: number;
  /** Number of data chunks received (for debugging transport behavior) */
  chunkCount: number;
  /** MoQT trackAlias from data stream framing header (if detected) */
  trackAlias?: number;
}

export interface MessageEntry {
  timestamp: number;
  direction: 'tx' | 'rx';
  messageType: string;
  decoded: unknown | null;
  raw: Uint8Array;
}

export function useInspector() {
  const sessions = ref<Map<string, SessionEntry>>(new Map());
  const selectedSessionId = ref<string | null>(null);
  const connected = ref(false);
  /** True when DevTools was opened mid-session (some connections may have been missed) */
  const midSessionOpen = ref(false);
  /** Worker URLs where instrumentation was blocked by CSP */
  const cspBlockedWorkers = ref<string[]>([]);

  let port: chrome.runtime.Port | null = null;
  let nextColorIndex = 0;
  let nextRequestId = 1;
  const pendingDataRequests = new Map<number, { resolve: (data: Uint8Array | null) => void }>();

  /** Imported trace data stored locally (not in IDB) — keyed by "sessionId:streamId" */
  const importedStreamData = new Map<string, Uint8Array>();

  function getOrCreateSession(sessionId: string): SessionEntry {
    let session = sessions.value.get(sessionId);
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
      };
      sessions.value.set(sessionId, session);
    }
    return session;
  }

  function handleMessage(msg: BackgroundToPanelMsg) {
    switch (msg.type) {
      case 'panel:session:opened': {
        const session = getOrCreateSession(msg.sessionId);
        session.url = msg.url;
        session.createdAt = msg.createdAt;
        session.protocol = 'detecting';
        // Auto-select first session
        if (!selectedSessionId.value) {
          selectedSessionId.value = msg.sessionId;
        }
        triggerUpdate();
        break;
      }

      case 'panel:detection': {
        const session = sessions.value.get(msg.sessionId);
        if (session) {
          session.protocol = msg.result.protocol === 'moqt' ? 'moqt' : msg.result.protocol;
          if (msg.result.protocol === 'moqt') {
            session.draft = msg.result.draft;
          }
          triggerUpdate();
        }
        break;
      }

      case 'panel:control-message': {
        const session = sessions.value.get(msg.sessionId);
        if (session) {
          session.messages.push({
            timestamp: msg.timestamp,
            direction: msg.direction,
            messageType: msg.messageType,
            decoded: msg.decoded ? JSON.parse(msg.decoded) : null,
            raw: base64ToBytes(msg.raw),
          });
          triggerUpdate();
        }
        break;
      }

      case 'panel:stream:data': {
        // Metadata-only: background has already written bytes to IndexedDB
        const session = sessions.value.get(msg.sessionId);
        if (session) {
          let stream = session.streams.get(msg.streamId);
          const now = Date.now();
          if (!stream) {
            stream = {
              streamId: msg.streamId,
              direction: msg.direction,
              closed: false,
              byteCount: 0,
              chunkCount: 0,
              contentType: msg.contentType ?? 'binary',
              firstDataAt: now,
              trackAlias: msg.trackAlias,
            };
            session.streams.set(msg.streamId, stream);
          } else if (msg.contentType != null) {
            // First-chunk metadata arrived (possible if stream was created by an earlier message)
            stream.contentType = msg.contentType;
            stream.trackAlias = msg.trackAlias;
          }
          stream.lastDataAt = now;
          stream.byteCount += msg.byteLength;
          stream.chunkCount++;


          triggerUpdate();
        }
        break;
      }

      case 'panel:stream:info': {
        // State replay: background tells us about streams that already have data in IDB
        const session = sessions.value.get(msg.sessionId);
        if (session) {
          session.streams.set(msg.streamId, {
            streamId: msg.streamId,
            direction: msg.direction,
            closed: msg.closed,
            byteCount: msg.byteCount,
            chunkCount: 0, // not tracked during replay
            contentType: msg.contentType,
            trackAlias: msg.trackAlias,
            firstDataAt: msg.firstDataAt,
          });
          triggerUpdate();
        }
        break;
      }

      case 'panel:stream:closed': {
        const session = sessions.value.get(msg.sessionId);
        if (session) {
          const stream = session.streams.get(msg.streamId);
          if (stream) {
            stream.closed = true;
            triggerUpdate();
          }
        }
        break;
      }

      case 'panel:session:closed': {
        const session = sessions.value.get(msg.sessionId);
        if (session) {
          session.closed = true;
          session.closedReason = msg.reason;
          triggerUpdate();
        }
        break;
      }

      case 'panel:track-update': {
        const session = sessions.value.get(msg.sessionId);
        if (session) {
          let track = session.tracks.get(msg.subscribeId);
          if (!track) {
            const ns = msg.trackNamespace;
            const fullName = [...ns, msg.trackName].join('/');
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
            };
            session.tracks.set(msg.subscribeId, track);
          } else {
            track.status = msg.status;
            track.errorReason = msg.errorReason;
          }
          triggerUpdate();
        }
        break;
      }

      case 'panel:instrumented': {
        midSessionOpen.value = msg.hadPreExistingSessions;
        break;
      }

      case 'panel:worker-csp-warning': {
        const url = msg.workerUrl;
        if (!cspBlockedWorkers.value.includes(url)) {
          cspBlockedWorkers.value = [...cspBlockedWorkers.value, url];
        }
        break;
      }

      case 'panel:stream-data-response': {
        const pending = pendingDataRequests.get(msg.requestId);
        if (pending) {
          pendingDataRequests.delete(msg.requestId);
          pending.resolve(msg.data ? base64ToBytes(msg.data) : null);
        }
        break;
      }

    }
  }

  // Force reactivity trigger since we mutate objects in place
  let updateTimer: ReturnType<typeof setTimeout> | null = null;
  function triggerUpdate() {
    if (updateTimer) return;
    updateTimer = setTimeout(() => {
      updateTimer = null;
      sessions.value = new Map(sessions.value);
    }, 16); // batch at ~60fps
  }

  function connect() {
    const tabId = chrome.devtools.inspectedWindow.tabId;
    port = chrome.runtime.connect({ name: 'moqtap-panel' });
    connected.value = true;

    port.onMessage.addListener((msg: BackgroundToPanelMsg) => {
      handleMessage(msg);
    });

    port.onDisconnect.addListener(() => {
      connected.value = false;
      port = null;
    });

    // Tell background which tab we're inspecting
    port.postMessage({ type: 'panel:connect', tabId });
  }

  function selectSession(sessionId: string | null) {
    selectedSessionId.value = sessionId;
  }

  function clearSessions() {
    sessions.value = new Map();
    selectedSessionId.value = null;
    cspBlockedWorkers.value = [];
    importedStreamData.clear();
    // Tell background to clear IDB and reset stream counters
    if (port) {
      const tabId = chrome.devtools.inspectedWindow.tabId;
      port.postMessage({ type: 'panel:clear', tabId });
    }
  }

  /** Load stream data — from local cache (imports) or background (live sessions) */
  async function getStreamData(sessionId: string, streamId: number): Promise<Uint8Array | null> {
    const session = sessions.value.get(sessionId);
    if (!session) return null;
    const stream = session.streams.get(streamId);
    if (!stream || stream.byteCount === 0) return null;

    // Imported traces: data is in local memory
    const importKey = `${sessionId}:${streamId}`;
    const imported = importedStreamData.get(importKey);
    if (imported) return imported;

    if (!port) return null;

    const requestId = nextRequestId++;
    const tabId = chrome.devtools.inspectedWindow.tabId;
    return new Promise<Uint8Array | null>((resolve) => {
      const timeout = setTimeout(() => {
        pendingDataRequests.delete(requestId);
        console.warn('[moqtap panel] stream data request timed out');
        resolve(null);
      }, 10000);
      pendingDataRequests.set(requestId, {
        resolve: (data) => {
          clearTimeout(timeout);
          resolve(data);
        },
      });
      port!.postMessage({ type: 'panel:request-stream-data', tabId, sessionId, streamId, requestId });
    });
  }

  async function exportTrace(sessionId: string) {
    const session = sessions.value.get(sessionId);
    if (!session || session.protocol !== 'moqt') return;

    try {
      const trace = await buildTrace(session, getStreamData);
      const binary = writeMoqtrace(trace);
      const draft = session.draft ?? 'unknown';
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `moqtap-${draft}-${timestamp}.moqtrace`;

      const blob = new Blob([binary as BlobPart], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
    } catch (err) {
      console.error('[moqtap] Export failed:', err);
    }
  }

  /** Import a .moqtrace file and create a synthetic session from it */
  function importTrace(file: File) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const bytes = new Uint8Array(reader.result as ArrayBuffer);
        const trace = readMoqtrace(bytes);
        await loadTraceAsSession(trace, file.name);
      } catch (err) {
        console.error('[moqtap] Failed to read .moqtrace file:', err);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  async function loadTraceAsSession(trace: Trace, filename: string) {
    const sessionId = `imported-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const header = trace.header;

    // Determine draft from protocol string (e.g. "moq-transport-14")
    const draftMatch = header.protocol.match(/moq-transport-(\d+)/);
    const draft = draftMatch ? draftMatch[1] : undefined;

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
      imported: true,
    };

    // Collect payload data per stream to write to IndexedDB after session is built
    const streamPayloads = new Map<number, Uint8Array[]>();

    // Reconstruct state from trace events
    for (const event of trace.events) {
      switch (event.type) {
        case 'control': {
          const ce = event as ControlMessageEvent;
          const msg = ce.message;
          const msgType = typeof msg.type === 'string' ? msg.type : `0x${(ce.messageType ?? 0).toString(16)}`;
          session.messages.push({
            timestamp: ce.timestamp,
            direction: ce.direction === 0 ? 'tx' : 'rx',
            messageType: msgType,
            decoded: msg,
            raw: ce.raw ?? new Uint8Array(0),
          });

          // Extract track info from control messages
          extractTrackFromImported(session, msg, ce.direction === 0 ? 'tx' : 'rx');
          break;
        }

        case 'stream-opened': {
          const se = event as StreamOpenedEvent;
          const streamId = Number(se.streamId);
          if (!session.streams.has(streamId)) {
            session.streams.set(streamId, {
              streamId,
              direction: se.direction === 0 ? 'tx' : 'rx',
              closed: false,
              byteCount: 0,
              chunkCount: 0,
              contentType: 'binary',
            });
          }
          break;
        }

        case 'object-payload': {
          const op = event as ObjectPayloadEvent;
          const streamId = Number(op.streamId);

          // Ensure stream entry exists
          if (!session.streams.has(streamId)) {
            session.streams.set(streamId, {
              streamId,
              direction: 'rx',
              closed: false,
              byteCount: 0,
              chunkCount: 0,
              contentType: 'binary',
            });
          }

          if (op.payload && op.payload.length > 0) {
            let payloads = streamPayloads.get(streamId);
            if (!payloads) {
              payloads = [];
              streamPayloads.set(streamId, payloads);
            }
            payloads.push(op.payload instanceof Uint8Array ? op.payload : new Uint8Array(op.payload as ArrayLike<number>));
          }
          break;
        }

        case 'stream-closed': {
          const sc = event as StreamClosedEvent;
          const streamId = Number(sc.streamId);
          const stream = session.streams.get(streamId);
          if (stream) stream.closed = true;
          break;
        }
      }
    }

    // Store collected payloads in local map (imports don't use IDB)
    for (const [streamId, payloads] of streamPayloads) {
      const stream = session.streams.get(streamId);
      if (!stream) continue;

      // Merge all payloads into a single Uint8Array
      let totalLen = 0;
      for (const chunk of payloads) totalLen += chunk.length;
      const merged = new Uint8Array(totalLen);
      let offset = 0;
      for (let i = 0; i < payloads.length; i++) {
        const chunk = payloads[i];
        merged.set(chunk, offset);
        offset += chunk.length;
        if (i === 0) stream.contentType = detectContentType(chunk);
      }
      stream.byteCount = totalLen;
      importedStreamData.set(`${sessionId}:${streamId}`, merged);
    }

    sessions.value.set(sessionId, session);
    selectedSessionId.value = sessionId;
    triggerUpdate();
  }

  /** Extract track subscription info from an imported control message */
  function extractTrackFromImported(
    session: SessionEntry,
    msg: Record<string, unknown>,
    direction: 'tx' | 'rx',
  ) {
    const msgType = String(msg.type ?? '');

    if (msgType === 'subscribe') {
      const subscribeId = String(msg.subscribeId ?? msg.request_id ?? '');
      const ns = (msg.trackNamespace ?? msg.track_namespace ?? []) as string[];
      const name = String(msg.trackName ?? msg.track_name ?? '');
      const fullName = [...ns, name].join('/');
      session.tracks.set(subscribeId, {
        subscribeId,
        trackAlias: msg.trackAlias != null ? String(msg.trackAlias) : undefined,
        trackNamespace: ns,
        trackName: name,
        fullName,
        direction,
        status: 'pending',
        colorIndex: nextColorIndex++,
      });
    } else if (msgType === 'subscribe_ok') {
      const subscribeId = String(msg.subscribeId ?? msg.request_id ?? '');
      const track = session.tracks.get(subscribeId);
      if (track) track.status = 'active';
    } else if (msgType === 'subscribe_error') {
      const subscribeId = String(msg.subscribeId ?? msg.request_id ?? '');
      const track = session.tracks.get(subscribeId);
      if (track) {
        track.status = 'error';
        track.errorReason = String(msg.reasonPhrase ?? msg.reason_phrase ?? '');
      }
    } else if (msgType === 'subscribe_done' || msgType === 'unsubscribe') {
      const subscribeId = String(msg.subscribeId ?? msg.request_id ?? '');
      const track = session.tracks.get(subscribeId);
      if (track) track.status = 'done';
    }
  }

  onMounted(() => {
    connect();
  });

  onUnmounted(() => {
    if (port) {
      port.disconnect();
      port = null;
    }
  });

  return {
    sessions,
    selectedSessionId,
    connected,
    midSessionOpen,
    cspBlockedWorkers,
    selectSession,
    clearSessions,
    getStreamData,
    exportTrace,
    importTrace,
  };
}
