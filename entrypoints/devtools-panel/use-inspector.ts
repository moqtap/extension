/**
 * Composable for the DevTools panel — connects to background and
 * provides reactive state for the inspector UI.
 *
 * Stream chunk data is offloaded to IndexedDB to support long-running
 * sessions without OOM. Only metadata stays in memory.
 */

import { ref, triggerRef, onMounted, onUnmounted } from 'vue';
import type { BackgroundToPanelMsg } from '@/src/messaging/types';
import { base64ToBytes } from '@/src/messaging/types';
// Panel no longer accesses IDB directly — data requests go through background
import { detectContentType } from './content-detect';
import type { StreamContentType } from './content-detect';
import { detectMediaInfo } from '@/src/detect/bmff-boxes';
import type { PayloadMediaInfo } from '@/src/detect/content-detect';
export type { StreamContentType, PayloadMediaInfo };
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
  /** Non-zero when session originates from an iframe */
  frameId?: number;
  streams: Map<number, StreamEntry>;
  messages: MessageEntry[];
  tracks: Map<string, TrackEntry>;
  /** Datagram groups indexed by "trackAlias:groupId" */
  datagramGroups: Map<string, DatagramGroupEntry>;
  /** True when session was loaded from an imported .moqtrace file */
  imported?: boolean;
  /** Whether stream data recording is active (default true) */
  streamRecording?: boolean;
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
  subscribedAt?: number;
  subscribeOkAt?: number;
  subscribeErrorAt?: number;
  subscribeDoneAt?: number;
}

export interface StreamEntry {
  streamId: number;
  direction: 'tx' | 'rx';
  closed: boolean;
  byteCount: number;
  /** Detected content type from first chunk */
  contentType: StreamContentType;
  /** ISO BMFF media info (variant + box types) from first object payload */
  mediaInfo?: PayloadMediaInfo;
  /** Timestamp of first data chunk (ms) */
  firstDataAt?: number;
  /** Timestamp of most recent data chunk (ms) */
  lastDataAt?: number;
  /** Number of data chunks received (for debugging transport behavior) */
  chunkCount: number;
  /** MoQT trackAlias from data stream framing header (if detected) */
  trackAlias?: number;
  /** True when this stream is the MoQT bidirectional control stream */
  isControl?: boolean;
  /** When set, this entry represents a datagram group (not a real stream) */
  datagramGroupKey?: string;
  /** Number of datagrams in the group */
  datagramCount?: number;
  /** MoQT group ID (for datagram groups) */
  groupId?: number;
}

export interface DatagramGroupEntry {
  /** Unique key: "trackAlias:groupId" */
  groupKey: string;
  trackAlias: number;
  groupId: number;
  direction: 'tx' | 'rx';
  closed: boolean;
  byteCount: number;
  datagramCount: number;
  contentType: StreamContentType;
  mediaInfo?: PayloadMediaInfo;
  firstDataAt?: number;
  lastDataAt?: number;
}

export interface MessageEntry {
  timestamp: number;
  direction: 'tx' | 'rx';
  messageType: string;
  decoded: unknown | null;
  raw: Uint8Array;
  /** Stack trace from the call site (tx messages only, ephemeral) */
  stack?: string;
}

export function useInspector() {
  const sessions = ref<Map<string, SessionEntry>>(new Map());
  const selectedSessionId = ref<string | null>(null);
  const connected = ref(false);
  /** True when DevTools was opened mid-session (some connections may have been missed) */
  const midSessionOpen = ref(false);
  /** Worker URLs where instrumentation was blocked by CSP */
  const cspBlockedWorkers = ref<string[]>([]);
  /** Worker origin exclusion list (auto-detected + manual) */
  const workerExclusions = ref<Record<string, import('@/src/messaging/types').ExclusionEntry>>({});
  /** Unistream creation stacks (ephemeral, keyed by "sessionId:streamId") */
  const streamCreationStacks = ref<Map<string, string>>(new Map());

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
        datagramGroups: new Map(),
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
        if (msg.frameId) session.frameId = msg.frameId;
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
            stack: msg.stack,
          });
          triggerUpdate();
        }
        break;
      }

      case 'panel:stream:data': {
        // Metadata-only: background has already written bytes to IndexedDB
        const session = sessions.value.get(msg.sessionId);
        if (!session) break;
        // When recording is paused, ignore stream data notifications
        // (background will also stop sending them once it processes the toggle,
        // but this guards against in-flight messages)
        if (session.streamRecording === false) break;

        {
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
              mediaInfo: msg.mediaInfo,
              firstDataAt: now,
              trackAlias: msg.trackAlias,
              isControl: msg.isControl,
            };
            session.streams.set(msg.streamId, stream);
          } else if (msg.contentType != null) {
            // First-chunk metadata arrived (possible if stream was created by an earlier message)
            stream.contentType = msg.contentType;
            stream.mediaInfo = msg.mediaInfo;
            stream.trackAlias = msg.trackAlias;
            if (msg.isControl) stream.isControl = true;
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
            mediaInfo: msg.mediaInfo,
            trackAlias: msg.trackAlias,
            isControl: msg.isControl,
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

      case 'panel:stream-created': {
        const key = `${msg.sessionId}:${msg.streamId}`;
        streamCreationStacks.value.set(key, msg.stack);
        triggerUpdate();
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
              subscribedAt: msg.subscribedAt,
              subscribeOkAt: msg.subscribeOkAt,
              subscribeErrorAt: msg.subscribeErrorAt,
              subscribeDoneAt: msg.subscribeDoneAt,
            };
            session.tracks.set(msg.subscribeId, track);
          } else {
            track.status = msg.status;
            track.errorReason = msg.errorReason;
            if (msg.subscribedAt != null) track.subscribedAt = msg.subscribedAt;
            if (msg.subscribeOkAt != null) track.subscribeOkAt = msg.subscribeOkAt;
            if (msg.subscribeErrorAt != null) track.subscribeErrorAt = msg.subscribeErrorAt;
            if (msg.subscribeDoneAt != null) track.subscribeDoneAt = msg.subscribeDoneAt;
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

      case 'panel:exclusion-list': {
        workerExclusions.value = msg.exclusions;
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

      case 'panel:stream-recording': {
        const session = sessions.value.get(msg.sessionId);
        if (session) {
          session.streamRecording = msg.recording;
          triggerUpdate();
        }
        break;
      }

      case 'panel:datagram:data': {
        const session = sessions.value.get(msg.sessionId);
        if (!session) break;
        if (session.streamRecording === false) break;

        {
          const gk = `${msg.trackAlias}:${msg.groupId}`;
          let group = session.datagramGroups.get(gk);
          const now = Date.now();
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
            };
            session.datagramGroups.set(gk, group);
          } else if (msg.isNewGroup && msg.contentType != null) {
            group.contentType = msg.contentType;
            group.mediaInfo = msg.mediaInfo;
          }
          group.byteCount += msg.byteLength;
          group.datagramCount++;
          group.lastDataAt = now;
          if (msg.endOfGroup) group.closed = true;

          triggerUpdate();
        }
        break;
      }

      case 'panel:datagram-group:info': {
        // State replay: background tells us about existing datagram groups
        const session = sessions.value.get(msg.sessionId);
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
          });
          triggerUpdate();
        }
        break;
      }

      case 'panel:datagram-group-data-response': {
        const pending = pendingDataRequests.get(msg.requestId);
        if (pending) {
          pendingDataRequests.delete(msg.requestId);
          pending.resolve(msg.data ? base64ToBytes(msg.data) : null);
        }
        break;
      }

      case 'panel:streams-cleared': {
        // No-op: the optimistic clear in clearStreams() already removed
        // streams from the UI. Acting on this confirmation would incorrectly
        // remove streams that arrived between the optimistic clear and this
        // response (race condition with in-flight stream:data messages).
        break;
      }

    }
  }

  // Force reactivity trigger since we mutate objects in place.
  // Uses shallowRef + triggerRef to avoid copying the entire Map.
  // We use rAF instead of setTimeout so that:
  //  - updates naturally pause when the panel is backgrounded/minimized
  //  - on refocus we get exactly one batched trigger per frame, avoiding
  //    the burst of work that setTimeout (throttled to 1/sec) would cause
  let updateScheduled = false;
  function triggerUpdate() {
    if (updateScheduled) return;
    updateScheduled = true;
    requestAnimationFrame(() => {
      updateScheduled = false;
      triggerRef(sessions);
    });
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
    // Request the current exclusion list
    port.postMessage({ type: 'panel:request-exclusions', tabId });
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

  function addWorkerExclusion(origin: string) {
    if (!port) return;
    const tabId = chrome.devtools.inspectedWindow.tabId;
    port.postMessage({ type: 'panel:add-exclusion', tabId, origin });
  }

  function removeWorkerExclusion(origin: string) {
    if (!port) return;
    const tabId = chrome.devtools.inspectedWindow.tabId;
    port.postMessage({ type: 'panel:remove-exclusion', tabId, origin });
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

  /** Load datagram group data — from local cache (imports) or background (live sessions) */
  async function getDatagramGroupData(sessionId: string, groupKey: string): Promise<Uint8Array | null> {
    const session = sessions.value.get(sessionId);
    if (!session) return null;
    const group = session.datagramGroups.get(groupKey);
    if (!group || group.byteCount === 0) return null;

    // Imported traces: data is in local memory
    const importKey = `${sessionId}:dg:${groupKey}`;
    const imported = importedStreamData.get(importKey);
    if (imported) return imported;

    if (!port) return null;

    const requestId = nextRequestId++;
    const tabId = chrome.devtools.inspectedWindow.tabId;
    return new Promise<Uint8Array | null>((resolve) => {
      const timeout = setTimeout(() => {
        pendingDataRequests.delete(requestId);
        console.warn('[moqtap panel] datagram group data request timed out');
        resolve(null);
      }, 10000);
      pendingDataRequests.set(requestId, {
        resolve: (data) => {
          clearTimeout(timeout);
          resolve(data);
        },
      });
      port!.postMessage({ type: 'panel:request-datagram-group-data', tabId, sessionId, groupKey, requestId });
    });
  }

  function setStreamRecording(sessionId: string, recording: boolean) {
    // Optimistic update — apply immediately so UI responds instantly
    const session = sessions.value.get(sessionId);
    if (session) {
      session.streamRecording = recording;
      triggerUpdate();
    }
    if (!port) return;
    const tabId = chrome.devtools.inspectedWindow.tabId;
    port.postMessage({ type: 'panel:set-stream-recording', tabId, sessionId, recording });
  }

  function clearStreams(sessionId: string) {
    // Optimistic update — clear streams and datagram groups from UI immediately,
    // but preserve the control stream (it's always-open and unrecoverable)
    const session = sessions.value.get(sessionId);
    if (session) {
      for (const [id, stream] of session.streams) {
        if (!stream.isControl) session.streams.delete(id);
      }
      session.datagramGroups.clear();
      triggerUpdate();
    }
    if (!port) return;
    const tabId = chrome.devtools.inspectedWindow.tabId;
    port.postMessage({ type: 'panel:clear-streams', tabId, sessionId });
  }

  async function exportTrace(sessionId: string) {
    const session = sessions.value.get(sessionId);
    if (!session || session.protocol !== 'moqt') return;

    try {
      const trace = await buildTrace(session, getStreamData, getDatagramGroupData);
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
      datagramGroups: new Map(),
      imported: true,
    };

    // Collect payload data per stream to write to IndexedDB after session is built
    const streamPayloads = new Map<number, Uint8Array[]>();
    // Collect datagram payloads keyed by groupKey ("trackAlias:groupId")
    // For imported traces, we use trackAlias=0 since we don't have it
    const dgPayloads = new Map<string, Uint8Array[]>();

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
          extractTrackFromImported(session, msg, ce.direction === 0 ? 'tx' : 'rx', ce.timestamp);
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

          // Detect datagram-style events: streamId=0 with groupId
          if (streamId === 0 && op.groupId !== undefined) {
            const groupId = Number(op.groupId);
            const gk = `0:${groupId}`; // trackAlias=0 for imports
            if (op.payload && op.payload.length > 0) {
              let payloads = dgPayloads.get(gk);
              if (!payloads) {
                payloads = [];
                dgPayloads.set(gk, payloads);
              }
              payloads.push(op.payload instanceof Uint8Array ? op.payload : new Uint8Array(op.payload as ArrayLike<number>));
            }
            break;
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
        if (i === 0) {
          stream.contentType = detectContentType(chunk);
          if (stream.contentType === 'fmp4') {
            // Imported payloads are raw object data — detect BMFF boxes directly
            stream.mediaInfo = detectMediaInfo(chunk) ?? undefined;
          }
        }
      }
      stream.byteCount = totalLen;
      importedStreamData.set(`${sessionId}:${streamId}`, merged);
    }

    // Reconstruct datagram groups from imported trace
    for (const [gk, payloads] of dgPayloads) {
      const parts = gk.split(':');
      const trackAlias = Number(parts[0]);
      const groupId = Number(parts[1]);

      // Build length-prefixed datagram group data (matching heap store format)
      let totalLen = 0;
      for (const chunk of payloads) totalLen += 4 + chunk.length;
      const merged = new Uint8Array(totalLen);
      const dv = new DataView(merged.buffer);
      let offset = 0;
      for (let i = 0; i < payloads.length; i++) {
        const chunk = payloads[i];
        dv.setUint32(offset, chunk.length, true);
        merged.set(chunk, offset + 4);
        offset += 4 + chunk.length;
      }

      // Detect content from first payload
      let ct: StreamContentType = 'binary';
      let mediaInfo: PayloadMediaInfo | undefined;
      if (payloads.length > 0) {
        ct = detectContentType(payloads[0]);
        if (ct === 'fmp4') {
          mediaInfo = detectMediaInfo(payloads[0]) ?? undefined;
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
      });

      importedStreamData.set(`${sessionId}:dg:${gk}`, merged);
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
    timestamp?: number,
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
        subscribedAt: timestamp,
      });
    } else if (msgType === 'subscribe_ok') {
      const subscribeId = String(msg.subscribeId ?? msg.request_id ?? '');
      const track = session.tracks.get(subscribeId);
      if (track) {
        track.status = 'active';
        track.subscribeOkAt = timestamp;
      }
    } else if (msgType === 'subscribe_error') {
      const subscribeId = String(msg.subscribeId ?? msg.request_id ?? '');
      const track = session.tracks.get(subscribeId);
      if (track) {
        track.status = 'error';
        track.errorReason = String(msg.reasonPhrase ?? msg.reason_phrase ?? '');
        track.subscribeErrorAt = timestamp;
      }
    } else if (msgType === 'subscribe_done' || msgType === 'unsubscribe') {
      const subscribeId = String(msg.subscribeId ?? msg.request_id ?? '');
      const track = session.tracks.get(subscribeId);
      if (track) {
        track.status = 'done';
        track.subscribeDoneAt = timestamp;
      }
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
  };
}
