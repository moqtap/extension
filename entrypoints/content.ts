/**
 * Content script — runs in MAIN world at document_start.
 *
 * Patches WebTransport and Worker/SharedWorker constructors immediately
 * (before any page JS runs) to intercept all WebTransport connections,
 * including those created inside workers. Intercepted events are buffered
 * until a DevTools panel activates this tab, at which point the buffer
 * is flushed and live forwarding begins.
 *
 * Worker wrapping uses blob URLs with importScripts/import to inject the
 * WebTransport hook before the worker's own code runs. Some sites break
 * when their workers run inside a blob context (self.location changes),
 * so known-incompatible domains are excluded via WORKER_EXCLUSIONS.
 * Sites with strict CSP that blocks blob: in worker-src get an automatic
 * fallback — the original worker is created without instrumentation.
 */

import { installWebTransportHook } from '@/src/intercept/webtransport-hook';
import type { ContentToBackgroundMsg } from '@/src/messaging/types';

/** Max buffered events before oldest are dropped (prevents memory leaks on pages that never open DevTools) */
const MAX_BUFFER = 500;

let activated = false;
let buffer: ContentToBackgroundMsg[] = [];

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  world: 'MAIN',

  main() {
    // Listen for activation signal from bridge (ISOLATED world)
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      if (event.data?.source !== 'moqtap-activate') return;
      if (activated) return;
      activated = true;
      // Flush buffer
      for (const msg of buffer) {
        forward(msg);
      }
      buffer = [];
    });

    // Install hooks immediately — before any page JS can run
    bootstrap();
  },
});

// ─── Bootstrap ────────────────────────────────────────────────────────

function bootstrap() {
  let activeSessionId: string | null = null;
  const streamToSession = new Map<number, string>();

  // The hook code that will be injected into workers (as a string).
  const WORKER_HOOK_SOURCE = buildWorkerHookSource();

  // 1. Patch WebTransport on the main thread
  installWebTransportHook(
    globalThis,
    (session) => {
      activeSessionId = session.id;
      send({
        type: 'session:opened',
        sessionId: session.id,
        url: session.url,
        createdAt: session.createdAt,
      });
    },
    {
      onData(streamId, data, direction, stack) {
        if (!streamToSession.has(streamId) && activeSessionId) {
          streamToSession.set(streamId, activeSessionId);
        }
        const sessionId = streamToSession.get(streamId);
        if (!sessionId) return;
        // Copy the buffer so the page retains the original and we can transfer the copy
        const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
        send({ type: 'stream:data', sessionId, streamId, direction, data: copy, stack });
      },
      onClose(streamId) {
        const sessionId = streamToSession.get(streamId);
        if (!sessionId) return;
        streamToSession.delete(streamId);
        send({ type: 'stream:closed', sessionId, streamId });
      },
      onError(streamId, error) {
        const sessionId = streamToSession.get(streamId);
        if (!sessionId) return;
        streamToSession.delete(streamId);
        send({ type: 'stream:error', sessionId, streamId, error: String(error) });
      },
      onStreamCreated(streamId, stack) {
        if (!streamToSession.has(streamId) && activeSessionId) {
          streamToSession.set(streamId, activeSessionId);
        }
        const sessionId = streamToSession.get(streamId);
        if (!sessionId) return;
        send({ type: 'stream:created', sessionId, streamId, stack });
      },
    },
    (sessionId, reason) => {
      send({ type: 'session:closed', sessionId, reason });
    },
  );

  // 2. Patch Worker and SharedWorker constructors
  patchWorkerConstructor(WORKER_HOOK_SOURCE);
}

// ─── CSP blocklist (learned, per-origin, localStorage) ────────────────

const CSP_BLOCK_KEY = '__moqtap_csp_blocked';
/** How long a CSP block record is valid (24 hours) */
const CSP_BLOCK_TTL = 24 * 60 * 60 * 1000;

/** Check if this origin has previously failed blob: worker creation */
function isCspBlocked(): boolean {
  try {
    const raw = localStorage.getItem(CSP_BLOCK_KEY);
    if (!raw) return false;
    const ts = Number(raw);
    if (Date.now() - ts < CSP_BLOCK_TTL) return true;
    // Expired — remove stale entry
    localStorage.removeItem(CSP_BLOCK_KEY);
  } catch { /* localStorage may be disabled */ }
  return false;
}

/** Record that blob: workers are blocked on this origin */
function markCspBlocked() {
  try {
    localStorage.setItem(CSP_BLOCK_KEY, String(Date.now()));
  } catch { /* localStorage may be disabled */ }
}

// ─── Worker constructor patching ──────────────────────────────────────

function patchWorkerConstructor(hookSource: string) {
  const glob = globalThis as Record<string, unknown>;

  // If this origin previously blocked blob: workers, skip patching entirely.
  // Zero latency — just a synchronous localStorage read.
  if (isCspBlocked()) return;

  // Track within this page load so we don't send multiple warnings
  let cspWarned = false;

  // Patch Worker
  const OriginalWorker = glob.Worker as (new (url: string | URL, options?: WorkerOptions) => Worker) | undefined;
  if (OriginalWorker) {
    // Once we discover CSP blocks blob: workers, skip for rest of page life
    let blocked = false;

    const PatchedWorker = function (this: unknown, url: string | URL, options?: WorkerOptions): Worker {
      if (blocked) return new OriginalWorker(url, options);

      const wrappedUrl = wrapWorkerScript(url, options, hookSource);
      try {
        const worker = new OriginalWorker(wrappedUrl.url, wrappedUrl.options);
        attachWorkerListener(worker);
        return worker;
      } catch (err) {
        // CSP blocked blob: worker — record for this origin and fall back
        blocked = true;
        markCspBlocked();
        revokeIfBlob(wrappedUrl.url);
        if (!cspWarned) {
          cspWarned = true;
          send({
            type: 'worker:csp-blocked',
            workerUrl: new URL(String(url), location.href).href,
            error: String(err),
          } as ContentToBackgroundMsg);
        }
        return new OriginalWorker(url, options);
      }
    } as unknown as typeof Worker;
    PatchedWorker.prototype = OriginalWorker.prototype;
    Object.defineProperty(PatchedWorker, 'name', { value: 'Worker' });
    glob.Worker = PatchedWorker;
  }

  // Patch SharedWorker
  const OriginalSharedWorker = glob.SharedWorker as (new (url: string | URL, options?: string | WorkerOptions) => SharedWorker) | undefined;
  if (OriginalSharedWorker) {
    let sharedBlocked = false;

    const PatchedSharedWorker = function (this: unknown, url: string | URL, options?: string | WorkerOptions): SharedWorker {
      const opts: WorkerOptions | undefined = typeof options === 'string' ? { name: options } : options;

      if (sharedBlocked) {
        const origOpts: string | WorkerOptions | undefined = typeof options === 'string' ? options : opts;
        return new OriginalSharedWorker(url, origOpts);
      }

      const wrappedUrl = wrapWorkerScript(url, opts, hookSource);
      try {
        const worker = new OriginalSharedWorker(wrappedUrl.url, wrappedUrl.options);
        attachSharedWorkerListener(worker);
        return worker;
      } catch (err) {
        sharedBlocked = true;
        markCspBlocked();
        revokeIfBlob(wrappedUrl.url);
        if (!cspWarned) {
          cspWarned = true;
          send({
            type: 'worker:csp-blocked',
            workerUrl: new URL(String(url), location.href).href,
            error: String(err),
          } as ContentToBackgroundMsg);
        }
        const origOpts: string | WorkerOptions | undefined = typeof options === 'string' ? options : opts;
        return new OriginalSharedWorker(url, origOpts);
      }
    } as unknown as typeof SharedWorker;
    PatchedSharedWorker.prototype = OriginalSharedWorker.prototype;
    Object.defineProperty(PatchedSharedWorker, 'name', { value: 'SharedWorker' });
    glob.SharedWorker = PatchedSharedWorker;
  }
}

/** Revoke blob URL to avoid leaking memory */
function revokeIfBlob(url: string | URL) {
  try {
    const s = String(url);
    if (s.startsWith('blob:')) URL.revokeObjectURL(s);
  } catch { /* ignore */ }
}

interface WrappedResult {
  url: string | URL;
  options?: WorkerOptions;
}

/**
 * Snippet prepended to blob workers that restores self.location to match
 * the original worker URL. Without this, self.location.href is "blob:..."
 * which breaks sites that parse their worker's URL (e.g. Google Maps).
 *
 * Uses Object.defineProperty on self — WorkerLocation is typically writable
 * on the global scope. Falls back silently if the property is locked down.
 */
function buildLocationShim(originalUrl: string): string {
  // JSON.stringify to safely embed the URL string in JS source
  const urlStr = JSON.stringify(originalUrl);
  return `try{Object.defineProperty(self,"location",{value:new URL(${urlStr}),configurable:true})}catch(e){}\n`;
}

function wrapWorkerScript(
  url: string | URL,
  options: WorkerOptions | undefined,
  hookSource: string,
): WrappedResult {
  const isModule = options?.type === 'module';
  const resolvedUrl = new URL(String(url), location.href).href;
  const locationShim = buildLocationShim(resolvedUrl);

  if (isModule) {
    const wrapper = `${locationShim}${hookSource}\nimport "${resolvedUrl}";`;
    const blob = new Blob([wrapper], { type: 'application/javascript' });
    return { url: URL.createObjectURL(blob), options };
  } else {
    const wrapper = `${locationShim}${hookSource}\nimportScripts("${resolvedUrl}");`;
    const blob = new Blob([wrapper], { type: 'application/javascript' });
    return { url: URL.createObjectURL(blob), options };
  }
}

function attachWorkerListener(worker: Worker) {
  worker.addEventListener('message', (event: MessageEvent) => {
    if (event.data?.source === 'moqtap-worker') {
      event.stopImmediatePropagation();
      const payload = event.data.payload as ContentToBackgroundMsg;
      send(payload);
    }
  });
}

function attachSharedWorkerListener(worker: SharedWorker) {
  worker.port.addEventListener('message', (event: MessageEvent) => {
    if (event.data?.source === 'moqtap-worker') {
      event.stopImmediatePropagation();
      const payload = event.data.payload as ContentToBackgroundMsg;
      send(payload);
    }
  });
  worker.port.start();
}

// ─── Worker hook source builder ───────────────────────────────────────

/**
 * Build the JavaScript source code that will be prepended/imported into workers.
 * Self-contained IIFE — patches WebTransport inside the worker and sends
 * intercepted data back via self.postMessage with a discriminator.
 */
function buildWorkerHookSource(): string {
  return `(function(){
"use strict";
var __moqtapSessionCounter = 0;
function __moqtapGenId() { return "wt-w-" + Date.now() + "-" + (++__moqtapSessionCounter); }

function __moqtapCopyBuf(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function __moqtapSend(msg) {
  try {
    var transfers = [];
    if (msg.data instanceof ArrayBuffer) transfers.push(msg.data);
    self.postMessage({ source: "moqtap-worker", payload: msg }, transfers);
  } catch(e) {}
}

var __moqtapActiveSession = null;
var __moqtapStreamMap = new Map();

function __moqtapWrapReadable(rs, sid, dir) {
  if (!rs || typeof rs !== "object" || typeof rs.getReader !== "function") return;
  var orig = rs.getReader.bind(rs);
  rs.getReader = function() {
    var reader = orig();
    var origRead = reader.read.bind(reader);
    reader.read = function() {
      return origRead().then(function(result) {
        if (result.done) {
          var sessId = __moqtapStreamMap.get(sid);
          if (sessId) { __moqtapStreamMap.delete(sid); __moqtapSend({ type: "stream:closed", sessionId: sessId, streamId: sid }); }
        } else if (result.value instanceof Uint8Array) {
          if (!__moqtapStreamMap.has(sid) && __moqtapActiveSession) __moqtapStreamMap.set(sid, __moqtapActiveSession);
          var sessId2 = __moqtapStreamMap.get(sid);
          if (sessId2) __moqtapSend({ type: "stream:data", sessionId: sessId2, streamId: sid, direction: dir, data: __moqtapCopyBuf(result.value) });
        }
        return result;
      }, function(err) {
        var sessId = __moqtapStreamMap.get(sid);
        if (sessId) { __moqtapStreamMap.delete(sid); __moqtapSend({ type: "stream:error", sessionId: sessId, streamId: sid, error: String(err) }); }
        throw err;
      });
    };
    return reader;
  };
}

function __moqtapWrapWritable(ws, sid, dir, captureStack) {
  if (!ws || typeof ws !== "object" || typeof ws.getWriter !== "function") return;
  var orig = ws.getWriter.bind(ws);
  ws.getWriter = function() {
    var writer = orig();
    var origWrite = writer.write.bind(writer);
    writer.write = function(chunk) {
      if (chunk instanceof Uint8Array) {
        if (!__moqtapStreamMap.has(sid) && __moqtapActiveSession) __moqtapStreamMap.set(sid, __moqtapActiveSession);
        var sessId = __moqtapStreamMap.get(sid);
        var stack = captureStack ? (new Error().stack || "") : undefined;
        if (sessId) __moqtapSend({ type: "stream:data", sessionId: sessId, streamId: sid, direction: dir, data: __moqtapCopyBuf(chunk), stack: stack });
      }
      return origWrite(chunk);
    };
    var origClose = writer.close.bind(writer);
    writer.close = function() {
      var sessId = __moqtapStreamMap.get(sid);
      if (sessId) { __moqtapStreamMap.delete(sid); __moqtapSend({ type: "stream:closed", sessionId: sessId, streamId: sid }); }
      return origClose();
    };
    return writer;
  };
}

function __moqtapTapIncoming(incoming, isBidi) {
  if (!incoming || typeof incoming !== "object" || typeof incoming.getReader !== "function") return;
  var orig = incoming.getReader.bind(incoming);
  incoming.getReader = function() {
    var reader = orig();
    var origRead = reader.read.bind(reader);
    reader.read = function() {
      return origRead().then(function(result) {
        if (!result.done && result.value) {
          var sid = __moqtapNextStreamId++;
          var stream = result.value;
          if (isBidi) {
            __moqtapWrapReadable(stream.readable, sid, "rx");
            __moqtapWrapWritable(stream.writable, sid, "tx");
          } else {
            __moqtapWrapReadable(stream, sid, "rx");
          }
        }
        return result;
      });
    };
    return reader;
  };
}

var __moqtapNextStreamId = 0;
var OrigWT = self.WebTransport;
if (OrigWT) {
  var PatchedWT = function(url, options) {
    var inst = new OrigWT(url, options);
    var session = { id: __moqtapGenId(), url: url, createdAt: Date.now() };
    __moqtapActiveSession = session.id;
    __moqtapSend({ type: "session:opened", sessionId: session.id, url: url, createdAt: session.createdAt });
    var origBidi = inst.createBidirectionalStream;
    if (typeof origBidi === "function") {
      inst.createBidirectionalStream = function() {
        var sid = __moqtapNextStreamId++;
        return origBidi.apply(inst, arguments).then(function(stream) {
          __moqtapWrapReadable(stream.readable, sid, "rx");
          __moqtapWrapWritable(stream.writable, sid, "tx", true);
          return stream;
        });
      };
    }
    var origUni = inst.createUnidirectionalStream;
    if (typeof origUni === "function") {
      inst.createUnidirectionalStream = function() {
        var sid = __moqtapNextStreamId++;
        var stack = new Error().stack || "";
        return origUni.apply(inst, arguments).then(function(writable) {
          __moqtapWrapWritable(writable, sid, "tx");
          if (!__moqtapStreamMap.has(sid) && __moqtapActiveSession) __moqtapStreamMap.set(sid, __moqtapActiveSession);
          var sessId = __moqtapStreamMap.get(sid);
          if (sessId) __moqtapSend({ type: "stream:created", sessionId: sessId, streamId: sid, stack: stack });
          return writable;
        });
      };
    }
    __moqtapTapIncoming(inst.incomingBidirectionalStreams, true);
    __moqtapTapIncoming(inst.incomingUnidirectionalStreams, false);
    if (inst.closed && typeof inst.closed.then === "function") {
      inst.closed.then(function(info) {
        var reason = (info && typeof info === "object") ? (info.reason || "code " + (info.closeCode || 0)) : "closed";
        __moqtapSend({ type: "session:closed", sessionId: session.id, reason: reason });
      }, function(err) {
        __moqtapSend({ type: "session:closed", sessionId: session.id, reason: String(err) });
      });
    }
    return inst;
  };
  PatchedWT.prototype = OrigWT.prototype;
  Object.defineProperty(PatchedWT, "name", { value: "WebTransport" });
  self.WebTransport = PatchedWT;
}
})();`;
}

// ─── Send helpers ─────────────────────────────────────────────────────

/** Queue or forward a message depending on activation state */
function send(msg: ContentToBackgroundMsg) {
  if (activated) {
    forward(msg);
  } else {
    buffer.push(msg);
    // Cap buffer to prevent memory leaks on pages that never open DevTools
    if (buffer.length > MAX_BUFFER) {
      buffer.shift();
    }
  }
}

/** Actually send to bridge via window.postMessage (transfers ArrayBuffer for zero-copy) */
function forward(msg: ContentToBackgroundMsg) {
  try {
    const transfers: Transferable[] = [];
    if (msg.type === 'stream:data' && msg.data instanceof ArrayBuffer) {
      transfers.push(msg.data);
    }
    window.postMessage({ source: 'moqtap-content', payload: msg }, '*', transfers);
  } catch {
    // Extension context invalidated
  }
}
