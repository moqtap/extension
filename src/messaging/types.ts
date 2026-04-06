/**
 * Message types for content script <-> background <-> DevTools panel communication.
 *
 * Data flow:
 *   Content script (MAIN world) -> background service worker -> DevTools panel
 *
 * The content script intercepts WebTransport and sends raw events to background.
 * Background maintains per-tab state (sessions, detection, streams), writes stream
 * data to IndexedDB, and forwards metadata to any connected DevTools panel.
 *
 * Stream data bytes are sent as ArrayBuffer (via structured clone) rather than
 * base64 strings to avoid encode/decode overhead on the hot path.
 */

import type { DetectionResult } from '../detect/draft-detect';
import type { StreamContentType, PayloadMediaInfo } from '../detect/content-detect';

// ─── Content -> Background messages ─────────────────────────────────

export interface SessionOpenedMsg {
  type: 'session:opened';
  tabId?: number; // filled in by background from sender
  sessionId: string;
  url: string;
  createdAt: number;
}

export interface StreamDataMsg {
  type: 'stream:data';
  tabId?: number;
  sessionId: string;
  streamId: number;
  direction: 'tx' | 'rx';
  /**
   * Raw bytes — ArrayBuffer from content script (MAIN world, zero-copy transfer
   * to bridge via window.postMessage), then cloned to background via persistent
   * port (structured clone). String (base64) accepted as fallback.
   */
  data: ArrayBuffer | string;
  /** Stack trace captured at write site (tx bidirectional stream only) */
  stack?: string;
}

export interface StreamCreatedMsg {
  type: 'stream:created';
  tabId?: number;
  sessionId: string;
  streamId: number;
  /** Stack trace captured at createUnidirectionalStream call site */
  stack: string;
}

export interface StreamClosedMsg {
  type: 'stream:closed';
  tabId?: number;
  sessionId: string;
  streamId: number;
}

export interface StreamErrorMsg {
  type: 'stream:error';
  tabId?: number;
  sessionId: string;
  streamId: number;
  error: string;
}

export interface SessionClosedMsg {
  type: 'session:closed';
  tabId?: number;
  sessionId: string;
  reason?: string;
}

export interface BridgeReadyMsg {
  type: 'bridge:ready';
}

export interface WorkerCspBlockedMsg {
  type: 'worker:csp-blocked';
  tabId?: number;
  workerUrl: string;
  error: string;
}

export interface WorkerCspRecoveredMsg {
  type: 'worker:csp-recovered';
  tabId?: number;
  origin: string;
  workerUrl: string;
  error: string;
}

/** Entry in the worker origin exclusion list (persisted in browser.storage.local) */
export interface ExclusionEntry {
  blockedAt: number;
  source: 'auto' | 'manual';
  error?: string;
}

export interface DatagramDataMsg {
  type: 'datagram:data';
  tabId?: number;
  sessionId: string;
  direction: 'tx' | 'rx';
  /** Raw datagram bytes (full MoQT datagram including header). */
  data: ArrayBuffer | string;
}

/** Messages sent from content script / bridge to background */
export type ContentToBackgroundMsg =
  | SessionOpenedMsg
  | StreamDataMsg
  | StreamCreatedMsg
  | StreamClosedMsg
  | StreamErrorMsg
  | SessionClosedMsg
  | BridgeReadyMsg
  | WorkerCspBlockedMsg
  | WorkerCspRecoveredMsg
  | DatagramDataMsg;

// ─── Background -> Panel messages ────────────────────────────────────

export interface PanelSessionOpenedMsg {
  type: 'panel:session:opened';
  sessionId: string;
  url: string;
  createdAt: number;
  /** Non-zero when session originates from an iframe */
  frameId?: number;
}

export interface PanelDetectionMsg {
  type: 'panel:detection';
  sessionId: string;
  result: DetectionResult;
}

export interface PanelControlMessageMsg {
  type: 'panel:control-message';
  sessionId: string;
  direction: 'tx' | 'rx';
  timestamp: number;
  /** JSON-serialized decoded message (or null if decode failed) */
  decoded: string | null;
  /** Message type name for display */
  messageType: string;
  /** Raw bytes as base64 */
  raw: string;
  /** Stack trace from the call site (tx messages only) */
  stack?: string;
}

export interface PanelStreamCreatedMsg {
  type: 'panel:stream-created';
  sessionId: string;
  streamId: number;
  /** Stack trace captured at createUnidirectionalStream call site */
  stack: string;
}

export interface PanelStreamOpenedMsg {
  type: 'panel:stream:opened';
  sessionId: string;
  streamId: number;
  streamType: 'bidi' | 'uni';
  direction: 'tx' | 'rx';
}

/**
 * Sent on every data chunk — metadata only, no payload bytes.
 * Background writes the payload directly to IndexedDB.
 *
 * On the first chunk for a stream, includes contentType and trackAlias
 * so the panel can initialize the stream entry without decoding bytes.
 */
export interface PanelStreamDataMsg {
  type: 'panel:stream:data';
  sessionId: string;
  streamId: number;
  direction: 'tx' | 'rx';
  byteLength: number;
  /** Only present on the first chunk for a stream */
  contentType?: StreamContentType;
  /** MoQT trackAlias from stream framing header (first chunk only, if MoQT) */
  trackAlias?: number;
  /** ISO BMFF media info from first object payload (first chunk only, if fMP4) */
  mediaInfo?: PayloadMediaInfo;
  /** True when this stream is the MoQT bidirectional control stream */
  isControl?: boolean;
}

/**
 * Sent during state replay to inform the panel about streams
 * that already have data in IndexedDB.
 */
export interface PanelStreamInfoMsg {
  type: 'panel:stream:info';
  sessionId: string;
  streamId: number;
  direction: 'tx' | 'rx';
  byteCount: number;
  contentType: StreamContentType;
  trackAlias?: number;
  /** ISO BMFF media info from first object payload (if fMP4) */
  mediaInfo?: PayloadMediaInfo;
  /** True when this stream is the MoQT bidirectional control stream */
  isControl?: boolean;
  firstDataAt?: number;
  closed: boolean;
}

export interface PanelStreamClosedMsg {
  type: 'panel:stream:closed';
  sessionId: string;
  streamId: number;
}

export interface PanelSessionClosedMsg {
  type: 'panel:session:closed';
  sessionId: string;
  reason?: string;
}

export interface PanelInstrumentedMsg {
  type: 'panel:instrumented';
  /** Whether there were pre-existing sessions before activation (mid-session open) */
  hadPreExistingSessions: boolean;
}

export interface PanelTrackUpdateMsg {
  type: 'panel:track-update';
  sessionId: string;
  subscribeId: string;
  trackAlias?: string;
  trackNamespace: string[];
  trackName: string;
  /** Direction of the SUBSCRIBE message (tx = we subscribed, rx = peer subscribed) */
  direction: 'tx' | 'rx';
  status: 'pending' | 'active' | 'error' | 'done';
  errorReason?: string;
  subscribedAt?: number;
  subscribeOkAt?: number;
  subscribeErrorAt?: number;
  subscribeDoneAt?: number;
}

export interface PanelWorkerCspWarningMsg {
  type: 'panel:worker-csp-warning';
  workerUrl: string;
}

export interface PanelStreamDataResponseMsg {
  type: 'panel:stream-data-response';
  requestId: number;
  /** base64-encoded stream data, or null if not found */
  data: string | null;
}

export interface PanelStreamRecordingMsg {
  type: 'panel:stream-recording';
  sessionId: string;
  recording: boolean;
}

export interface PanelStreamsClearedMsg {
  type: 'panel:streams-cleared';
  sessionId: string;
}

/**
 * Sent on every datagram — metadata only, no payload bytes.
 * Background writes the payload to the datagram heap store.
 *
 * On the first datagram for a group, includes contentType and mediaInfo
 * so the panel can initialize the datagram group entry.
 */
export interface PanelDatagramDataMsg {
  type: 'panel:datagram:data';
  sessionId: string;
  direction: 'tx' | 'rx';
  trackAlias: number;
  groupId: number;
  objectId: number;
  byteLength: number;
  /** True if this datagram created a new group. */
  isNewGroup: boolean;
  /** Content type (first datagram in group only). */
  contentType?: StreamContentType;
  /** ISO BMFF media info (first datagram in group only, if fMP4). */
  mediaInfo?: PayloadMediaInfo;
  /** True when endOfGroup flag was set. */
  endOfGroup?: boolean;
}

/**
 * Sent during state replay to inform the panel about datagram groups
 * that already have data in the heap/IDB.
 */
export interface PanelDatagramGroupInfoMsg {
  type: 'panel:datagram-group:info';
  sessionId: string;
  groupKey: string;
  trackAlias: number;
  groupId: number;
  direction: 'tx' | 'rx';
  byteCount: number;
  datagramCount: number;
  contentType?: StreamContentType;
  mediaInfo?: PayloadMediaInfo;
  firstDataAt?: number;
  closed: boolean;
}

export interface PanelDatagramGroupDataResponseMsg {
  type: 'panel:datagram-group-data-response';
  requestId: number;
  /** base64-encoded datagram group data, or null if not found */
  data: string | null;
}

export interface PanelExclusionListMsg {
  type: 'panel:exclusion-list';
  exclusions: Record<string, ExclusionEntry>;
}

/** Messages sent from background to DevTools panel */
export type BackgroundToPanelMsg =
  | PanelSessionOpenedMsg
  | PanelDetectionMsg
  | PanelControlMessageMsg
  | PanelStreamOpenedMsg
  | PanelStreamDataMsg
  | PanelStreamInfoMsg
  | PanelStreamClosedMsg
  | PanelSessionClosedMsg
  | PanelInstrumentedMsg
  | PanelTrackUpdateMsg
  | PanelWorkerCspWarningMsg
  | PanelStreamDataResponseMsg
  | PanelStreamCreatedMsg
  | PanelStreamRecordingMsg
  | PanelStreamsClearedMsg
  | PanelDatagramDataMsg
  | PanelDatagramGroupInfoMsg
  | PanelDatagramGroupDataResponseMsg
  | PanelExclusionListMsg;

// ─── Background -> Bridge messages ───────────────────────────────────

export interface ActivateTabMsg {
  type: 'activate-tab';
}

// ─── Panel -> Background messages ────────────────────────────────────

export interface PanelConnectMsg {
  type: 'panel:connect';
  tabId: number;
}

export interface PanelDisconnectMsg {
  type: 'panel:disconnect';
  tabId: number;
}

export interface PanelRequestStateMsg {
  type: 'panel:request-state';
  tabId: number;
}

export interface PanelClearMsg {
  type: 'panel:clear';
  tabId: number;
}

export interface PanelRequestStreamDataMsg {
  type: 'panel:request-stream-data';
  tabId: number;
  sessionId: string;
  streamId: number;
  requestId: number;
}

export interface PanelSetStreamRecordingMsg {
  type: 'panel:set-stream-recording';
  tabId: number;
  sessionId: string;
  recording: boolean;
}

export interface PanelClearStreamsMsg {
  type: 'panel:clear-streams';
  tabId: number;
  sessionId: string;
}

export interface PanelRequestDatagramGroupDataMsg {
  type: 'panel:request-datagram-group-data';
  tabId: number;
  sessionId: string;
  groupKey: string;
  requestId: number;
}

export interface PanelRequestExclusionsMsg {
  type: 'panel:request-exclusions';
  tabId: number;
}

export interface PanelAddExclusionMsg {
  type: 'panel:add-exclusion';
  tabId: number;
  origin: string;
}

export interface PanelRemoveExclusionMsg {
  type: 'panel:remove-exclusion';
  tabId: number;
  origin: string;
}

/** Messages sent from DevTools panel to background */
export type PanelToBackgroundMsg =
  | PanelConnectMsg
  | PanelDisconnectMsg
  | PanelRequestStateMsg
  | PanelClearMsg
  | PanelRequestStreamDataMsg
  | PanelSetStreamRecordingMsg
  | PanelClearStreamsMsg
  | PanelRequestDatagramGroupDataMsg
  | PanelRequestExclusionsMsg
  | PanelAddExclusionMsg
  | PanelRemoveExclusionMsg;

// ─── Helpers ────────────────────────────────────────────────────────

/** Encode bytes to base64 (used only for small control message raw bytes) */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Decode base64 back to bytes */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
