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
 * WebTransport hook before the worker's own code runs. A Proxy-based
 * recovery system handles CSP failures transparently: if the blob worker
 * fails (sync or async), the Proxy terminates it and creates the original
 * uninstrumented worker, replaying any buffered operations. The origin is
 * then auto-excluded so future page loads skip wrapping entirely.
 */

import { installWebTransportHook } from '@/src/intercept/webtransport-hook'
import type { ContentToBackgroundMsg } from '@/src/messaging/types'

/**
 * Max buffered events before oldest are dropped (prevents memory leaks on
 * pages that never open DevTools).
 *
 * Split three ways rather than one shared FIFO, because a high-bitrate session
 * produces hundreds of stream:data events per second and would otherwise evict
 * everything that makes the session interpretable within seconds:
 *
 *   1. Lifecycle — session:opened and friends. Losing session:opened makes the
 *      background drop every later event for that session, so the panel shows
 *      nothing at all.
 *   2. Control plane — stream:data on bidirectional streams. Every MoQ dialect
 *      puts SETUP, ANNOUNCE, SUBSCRIBE and the rest here; it is what lets the
 *      panel name a draft and reconstruct track state. Keeping only the first
 *      few events would recover the SETUP exchange but not the track mapping,
 *      so this is budgeted by bytes: a whole session's control plane is a few
 *      kilobytes (~150 B of SETUP, ~100 B per track), so the budget below is
 *      generous by orders of magnitude while still holding less memory than
 *      the bulk buffer.
 *   3. Bulk — media on unidirectional streams and datagrams. Genuinely
 *      unbounded, and the least valuable per byte, so it stays a small FIFO.
 *
 * Tier 2 is also capped by entry count: a page writing tiny chunks to a bidi
 * stream would otherwise build a huge array well under the byte budget.
 */
const MAX_LIFECYCLE_BUFFER = 500
const MAX_CONTROL_BUFFER = 2000
const MAX_CONTROL_BYTES = 256 * 1024
const MAX_DATA_BUFFER = 500

/**
 * Origins where worker wrapping is known to fail (CSP, etc.).
 * Seeded synchronously from localStorage, then merged with the global
 * exclusion list relayed by the bridge from browser.storage.local.
 */
const excludedOrigins = new Set<string>()

let currentOrigin = ''
try {
  currentOrigin = location.origin
} catch {
  /* opaque origin */
}

// Seed from localStorage for instant synchronous check
try {
  const raw = localStorage.getItem('__moqtap_excluded_origins')
  if (raw) {
    const arr = JSON.parse(raw) as string[]
    for (const o of arr) excludedOrigins.add(o)
  }
  // Also check legacy single-origin flag
  const legacy = localStorage.getItem('__moqtap_csp_blocked')
  if (legacy && currentOrigin) {
    const ts = Number(legacy)
    if (Date.now() - ts < 24 * 60 * 60 * 1000) {
      excludedOrigins.add(currentOrigin)
    } else {
      localStorage.removeItem('__moqtap_csp_blocked')
    }
  }
} catch {
  /* localStorage may be disabled */
}

let activated = false

/** A buffered event plus its arrival order, so the buffers can be
 *  re-merged into the original sequence when they are flushed. */
interface BufferedMsg {
  seq: number
  msg: ContentToBackgroundMsg
  /** Payload size, for the byte-budgeted control buffer */
  bytes: number
}
let bufferSeq = 0
let lifecycleBuffer: BufferedMsg[] = []
let controlBuffer: BufferedMsg[] = []
let controlBytes = 0
let dataBuffer: BufferedMsg[] = []

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  matchOriginAsFallback: true,
  runAt: 'document_start',
  world: 'MAIN',

  main() {
    // Listen for exclusion list from bridge (relayed from browser.storage.local).
    // This arrives async but merges into the set used by the fast-path check.
    // Workers created before it arrives still go through the Proxy safety net.
    window.addEventListener('message', (event) => {
      if (event.source !== window) return
      if (event.data?.source === 'moqtap-exclusions') {
        const origins = event.data.origins as string[]
        for (const o of origins) excludedOrigins.add(o)
      }
    })

    // Listen for activation signal from bridge (ISOLATED world)
    window.addEventListener('message', (event) => {
      if (event.source !== window) return
      if (event.data?.source !== 'moqtap-activate') return
      if (activated) return
      activated = true
      flushBuffers()
    })

    // Install hooks immediately — before any page JS can run
    bootstrap()
  },
})

// ─── Bootstrap ────────────────────────────────────────────────────────

function bootstrap() {
  // The hook code that will be injected into workers (as a string).
  const WORKER_HOOK_SOURCE = buildWorkerHookSource()

  // 1. Patch WebTransport on the main thread
  installWebTransportHook(
    globalThis,
    (session) => {
      send({
        type: 'session:opened',
        sessionId: session.id,
        url: session.url,
        createdAt: session.createdAt,
        options: session.options,
      })
    },
    {
      onData(sessionId, streamId, data, direction, bidi, stack) {
        // Copy the buffer so the page retains the original and we can transfer the copy
        const copy = data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength,
        ) as ArrayBuffer
        send({
          type: 'stream:data',
          sessionId,
          streamId,
          direction,
          bidi,
          data: copy,
          stack,
          capturedAt: Date.now(),
        })
      },
      onClose(sessionId, streamId) {
        send({ type: 'stream:closed', sessionId, streamId })
      },
      onError(sessionId, streamId, error) {
        send({
          type: 'stream:error',
          sessionId,
          streamId,
          error: String(error),
        })
      },
      onStreamCreated(sessionId, streamId, stack) {
        send({ type: 'stream:created', sessionId, streamId, stack })
      },
      onDatagram(sessionId, data, direction) {
        const copy = data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength,
        ) as ArrayBuffer
        send({
          type: 'datagram:data',
          sessionId,
          direction,
          data: copy,
          capturedAt: Date.now(),
        })
      },
    },
    (sessionId, reason) => {
      send({ type: 'session:closed', sessionId, reason })
    },
  )

  // 2. Patch Worker and SharedWorker constructors
  patchWorkerConstructor(WORKER_HOOK_SOURCE)
}

// ─── Exclusion persistence ────────────────────────────────────────────

/** Persist a new auto-exclusion to localStorage + notify bridge for global storage */
function addExclusion(origin: string, workerUrl: string, error: string) {
  excludedOrigins.add(origin)
  // Persist to localStorage for fast synchronous check on future loads
  try {
    const raw = localStorage.getItem('__moqtap_excluded_origins')
    const arr: string[] = raw ? JSON.parse(raw) : []
    if (!arr.includes(origin)) {
      arr.push(origin)
      localStorage.setItem('__moqtap_excluded_origins', JSON.stringify(arr))
    }
    // Clean up legacy key
    localStorage.removeItem('__moqtap_csp_blocked')
  } catch {
    /* localStorage may be disabled */
  }
  // Notify bridge → background for global persistence
  send({
    type: 'worker:csp-recovered',
    origin,
    workerUrl,
    error,
  } as ContentToBackgroundMsg)
}

// ─── Worker Proxy with recovery ──────────────────────────────────────

/** How long to wait for heartbeat/error before committing (ms) */
const PROBATION_MS = 500

type BufferedOp =
  | { k: 'pm'; args: [message: unknown, transfer: Transferable[]] }
  | {
      k: 'ael'
      args: [
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ]
    }
  | {
      k: 'rel'
      args: [
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
      ]
    }
  | {
      k: 'set'
      prop: 'onmessage' | 'onerror' | 'onmessageerror'
      value: unknown
    }

/**
 * Wrap an instrumented Worker in a Proxy that detects async CSP failures
 * and transparently recovers by creating the original uninstrumented Worker.
 *
 * During a short probation period, all caller operations are buffered.
 * The proxy commits to the instrumented worker on heartbeat receipt,
 * or recovers on error, or commits on timeout.
 */
function createWorkerProxy(
  OrigWorker: new (url: string | URL, options?: WorkerOptions) => Worker,
  instrumentedWorker: Worker,
  originalUrl: string | URL,
  originalOptions: WorkerOptions | undefined,
  blobUrl: string | URL,
): Worker {
  let worker = instrumentedWorker
  let settled = false
  const ops: BufferedOp[] = []

  function flush(target: Worker) {
    for (const op of ops) {
      switch (op.k) {
        case 'pm':
          target.postMessage(op.args[0], op.args[1])
          break
        case 'ael':
          target.addEventListener(...op.args)
          break
        case 'rel':
          target.removeEventListener(...op.args)
          break
        case 'set':
          ;(target as unknown as Record<string, unknown>)[op.prop] = op.value
          break
      }
    }
    ops.length = 0
  }

  function commit() {
    if (settled) return
    settled = true
    clearTimeout(timer)
    worker.removeEventListener('message', heartbeatListener)
    worker.removeEventListener('error', errorListener, true)
    attachWorkerListener(worker)
    flush(worker)
  }

  function recover(errMsg: string) {
    if (settled) return
    settled = true
    clearTimeout(timer)
    worker.removeEventListener('message', heartbeatListener)
    worker.removeEventListener('error', errorListener, true)
    worker.terminate()
    revokeIfBlob(blobUrl)
    // Create uninstrumented worker
    worker = new OrigWorker(originalUrl, originalOptions)
    flush(worker)
    // Record exclusion
    addExclusion(
      currentOrigin,
      new URL(String(originalUrl), location.href).href,
      errMsg,
    )
  }

  // Heartbeat: hook sends {source:"moqtap-hook-ready"} on successful load
  const heartbeatListener = (ev: MessageEvent) => {
    if (ev.data?.source === 'moqtap-hook-ready') {
      ev.stopImmediatePropagation()
      commit()
    }
  }
  worker.addEventListener('message', heartbeatListener)

  // Error: CSP or other load failure inside the blob worker
  const errorListener = (ev: Event) => {
    if (settled) return
    ev.stopImmediatePropagation()
    ;(ev as ErrorEvent).preventDefault?.()
    recover(String((ev as ErrorEvent).message || 'Worker load error'))
  }
  worker.addEventListener('error', errorListener, {
    capture: true,
    once: true,
  })

  // Timeout fallback: if no signal within PROBATION_MS, assume success
  const timer = setTimeout(() => {
    if (!settled) commit()
  }, PROBATION_MS)

  return new Proxy({} as Worker, {
    get(_, prop) {
      if (prop === 'postMessage') {
        return (data: unknown, transfer?: Transferable[]) => {
          if (settled) worker.postMessage(data, transfer ?? [])
          else ops.push({ k: 'pm', args: [data, transfer ?? []] })
        }
      }
      if (prop === 'terminate') {
        return () => {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            worker.removeEventListener('message', heartbeatListener)
            worker.removeEventListener('error', errorListener, true)
          }
          worker.terminate()
        }
      }
      if (prop === 'addEventListener') {
        return (
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | AddEventListenerOptions,
        ) => {
          if (settled) worker.addEventListener(type, listener, options)
          else ops.push({ k: 'ael', args: [type, listener, options] })
        }
      }
      if (prop === 'removeEventListener') {
        return (
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | EventListenerOptions,
        ) => {
          if (settled) worker.removeEventListener(type, listener, options)
          else ops.push({ k: 'rel', args: [type, listener, options] })
        }
      }
      const val = (worker as unknown as Record<string, unknown>)[prop as string]
      return typeof val === 'function' ? (val as Function).bind(worker) : val
    },

    set(_, prop, value) {
      const p = prop as string
      if (
        !settled &&
        (p === 'onmessage' || p === 'onerror' || p === 'onmessageerror')
      ) {
        ops.push({ k: 'set', prop: p, value })
        return true
      }
      ;(worker as unknown as Record<string, unknown>)[p] = value
      return true
    },

    getPrototypeOf() {
      return OrigWorker.prototype
    },
  })
}

// ─── Worker constructor patching ──────────────────────────────────────

function patchWorkerConstructor(hookSource: string) {
  const glob = globalThis as Record<string, unknown>

  // If this origin is already excluded, skip worker patching entirely
  if (excludedOrigins.has(currentOrigin)) return

  // Track within this page load so we don't send multiple warnings
  let cspWarned = false
  // Once we discover CSP blocks blob: workers, skip for rest of page life
  let blocked = false

  // Patch Worker
  const OriginalWorker = glob.Worker as
    (new (url: string | URL, options?: WorkerOptions) => Worker) | undefined
  if (OriginalWorker) {
    const PatchedWorker = function (
      this: unknown,
      url: string | URL,
      options?: WorkerOptions,
    ): Worker {
      if (blocked || excludedOrigins.has(currentOrigin)) {
        return new OriginalWorker(url, options)
      }

      const wrappedUrl = wrapWorkerScript(url, options, hookSource)
      try {
        const instrumentedWorker = new OriginalWorker(
          wrappedUrl.url,
          wrappedUrl.options,
        )
        // Wrap in recovery proxy to handle async CSP failures
        return createWorkerProxy(
          OriginalWorker,
          instrumentedWorker,
          url,
          options,
          wrappedUrl.url,
        )
      } catch (err) {
        // Synchronous CSP failure — blob: worker creation blocked
        blocked = true
        revokeIfBlob(wrappedUrl.url)
        addExclusion(
          currentOrigin,
          new URL(String(url), location.href).href,
          String(err),
        )
        if (!cspWarned) {
          cspWarned = true
          send({
            type: 'worker:csp-blocked',
            workerUrl: new URL(String(url), location.href).href,
            error: String(err),
          } as ContentToBackgroundMsg)
        }
        return new OriginalWorker(url, options)
      }
    } as unknown as typeof Worker
    PatchedWorker.prototype = OriginalWorker.prototype
    Object.defineProperty(PatchedWorker, 'name', { value: 'Worker' })
    glob.Worker = PatchedWorker
  }

  // Patch SharedWorker (simpler: async error detection, no Proxy recovery)
  const OriginalSharedWorker = glob.SharedWorker as
    | (new (
        url: string | URL,
        options?: string | WorkerOptions,
      ) => SharedWorker)
    | undefined
  if (OriginalSharedWorker) {
    let sharedBlocked = false

    const PatchedSharedWorker = function (
      this: unknown,
      url: string | URL,
      options?: string | WorkerOptions,
    ): SharedWorker {
      const opts: WorkerOptions | undefined =
        typeof options === 'string' ? { name: options } : options

      if (sharedBlocked || excludedOrigins.has(currentOrigin)) {
        const origOpts: string | WorkerOptions | undefined =
          typeof options === 'string' ? options : opts
        return new OriginalSharedWorker(url, origOpts)
      }

      const wrappedUrl = wrapWorkerScript(url, opts, hookSource)
      try {
        const worker = new OriginalSharedWorker(
          wrappedUrl.url,
          wrappedUrl.options,
        )
        attachSharedWorkerListener(worker)
        // Async error detection for SharedWorker
        worker.addEventListener(
          'error',
          () => {
            if (!sharedBlocked) {
              sharedBlocked = true
              addExclusion(
                currentOrigin,
                new URL(String(url), location.href).href,
                'SharedWorker async CSP failure',
              )
            }
          },
          { once: true },
        )
        return worker
      } catch (err) {
        sharedBlocked = true
        revokeIfBlob(wrappedUrl.url)
        addExclusion(
          currentOrigin,
          new URL(String(url), location.href).href,
          String(err),
        )
        if (!cspWarned) {
          cspWarned = true
          send({
            type: 'worker:csp-blocked',
            workerUrl: new URL(String(url), location.href).href,
            error: String(err),
          } as ContentToBackgroundMsg)
        }
        const origOpts: string | WorkerOptions | undefined =
          typeof options === 'string' ? options : opts
        return new OriginalSharedWorker(url, origOpts)
      }
    } as unknown as typeof SharedWorker
    PatchedSharedWorker.prototype = OriginalSharedWorker.prototype
    Object.defineProperty(PatchedSharedWorker, 'name', {
      value: 'SharedWorker',
    })
    glob.SharedWorker = PatchedSharedWorker
  }
}

/** Revoke blob URL to avoid leaking memory */
function revokeIfBlob(url: string | URL) {
  try {
    const s = String(url)
    if (s.startsWith('blob:')) URL.revokeObjectURL(s)
  } catch {
    /* ignore */
  }
}

interface WrappedResult {
  url: string | URL
  options?: WorkerOptions
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
  const urlStr = JSON.stringify(originalUrl)
  return `try{Object.defineProperty(self,"location",{value:new URL(${urlStr}),configurable:true})}catch(e){}\n`
}

function wrapWorkerScript(
  url: string | URL,
  options: WorkerOptions | undefined,
  hookSource: string,
): WrappedResult {
  const isModule = options?.type === 'module'
  const resolvedUrl = new URL(String(url), location.href).href
  const locationShim = buildLocationShim(resolvedUrl)

  // Heartbeat: signals the hook loaded successfully.
  // Classic workers: importScripts is synchronous — if it throws, the heartbeat never fires.
  // Module workers: static import failure prevents module evaluation, so we use dynamic import.
  const heartbeat = `try{self.postMessage({source:"moqtap-hook-ready"})}catch(e){}`

  if (isModule) {
    const wrapper = `${locationShim}${hookSource}\nimport("${resolvedUrl}").then(function(){${heartbeat}},function(){});`
    const blob = new Blob([wrapper], { type: 'application/javascript' })
    return { url: URL.createObjectURL(blob), options }
  } else {
    const wrapper = `${locationShim}${hookSource}\nimportScripts("${resolvedUrl}");\n${heartbeat}`
    const blob = new Blob([wrapper], { type: 'application/javascript' })
    return { url: URL.createObjectURL(blob), options }
  }
}

function attachWorkerListener(worker: Worker) {
  worker.addEventListener('message', (event: MessageEvent) => {
    if (event.data?.source === 'moqtap-worker') {
      event.stopImmediatePropagation()
      const payload = event.data.payload as ContentToBackgroundMsg
      send(payload)
    }
  })
}

function attachSharedWorkerListener(worker: SharedWorker) {
  worker.port.addEventListener('message', (event: MessageEvent) => {
    if (event.data?.source === 'moqtap-worker') {
      event.stopImmediatePropagation()
      const payload = event.data.payload as ContentToBackgroundMsg
      send(payload)
    }
  })
  worker.port.start()
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
var __moqtapInstanceId = Math.random().toString(36).slice(2, 10);
var __moqtapSessionCounter = 0;
function __moqtapGenId() { return "wt-w-" + __moqtapInstanceId + "-" + (++__moqtapSessionCounter); }

function __moqtapCopyBuf(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// Whitelist the parseable WebTransportOptions fields. Wrapped because every
// read touches a page-controlled object — a throwing getter here would break
// the page's own connection.
function __moqtapOptions(o) {
  try {
    if (!o || typeof o !== "object") return undefined;
    var info = {};
    if (Array.isArray(o.protocols)) {
      var ps = o.protocols.filter(function(p) { return typeof p === "string"; });
      if (ps.length > 0) info.protocols = ps;
    }
    if (typeof o.congestionControl === "string") info.congestionControl = o.congestionControl;
    if (typeof o.allowPooling === "boolean") info.allowPooling = o.allowPooling;
    if (typeof o.requireUnreliable === "boolean") info.requireUnreliable = o.requireUnreliable;
    if (Array.isArray(o.serverCertificateHashes)) info.serverCertificateHashes = o.serverCertificateHashes.length;
    return Object.keys(info).length > 0 ? info : undefined;
  } catch(e) { return undefined; }
}

var __moqtapCloneWarned = {};
function __moqtapSend(msg) {
  try {
    var transfers = [];
    if (msg.data instanceof ArrayBuffer) transfers.push(msg.data);
    self.postMessage({ source: "moqtap-worker", payload: msg }, transfers);
  } catch(e) {
    // Surface unserializable payloads — silently dropping them hides the
    // event from the panel with no trace (see forward() on the main thread).
    if (e && e.name === "DataCloneError" && !__moqtapCloneWarned[msg.type]) {
      __moqtapCloneWarned[msg.type] = true;
      try { console.warn('[moqtap] dropped "' + msg.type + '" event from worker — payload is not structured-cloneable:', e.message); } catch(_) {}
    }
  }
}

function __moqtapWrapReadable(rs, sessionId, sid, dir, bidi) {
  if (!rs || typeof rs !== "object" || typeof rs.getReader !== "function") return;
  var orig = rs.getReader.bind(rs);
  rs.getReader = function() {
    var reader = orig();
    var origRead = reader.read.bind(reader);
    reader.read = function() {
      return origRead().then(function(result) {
        if (result.done) {
          __moqtapSend({ type: "stream:closed", sessionId: sessionId, streamId: sid });
        } else if (result.value instanceof Uint8Array) {
          __moqtapSend({ type: "stream:data", sessionId: sessionId, streamId: sid, direction: dir, bidi: bidi, data: __moqtapCopyBuf(result.value), capturedAt: Date.now() });
        }
        return result;
      }, function(err) {
        __moqtapSend({ type: "stream:error", sessionId: sessionId, streamId: sid, error: String(err) });
        throw err;
      });
    };
    return reader;
  };
}

function __moqtapWrapWritable(ws, sessionId, sid, dir, bidi, captureStack) {
  if (!ws || typeof ws !== "object" || typeof ws.getWriter !== "function") return;
  var orig = ws.getWriter.bind(ws);
  ws.getWriter = function() {
    var writer = orig();
    var origWrite = writer.write.bind(writer);
    writer.write = function(chunk) {
      if (chunk instanceof Uint8Array) {
        var stack = captureStack ? (new Error().stack || "") : undefined;
        __moqtapSend({ type: "stream:data", sessionId: sessionId, streamId: sid, direction: dir, bidi: bidi, data: __moqtapCopyBuf(chunk), stack: stack, capturedAt: Date.now() });
      }
      return origWrite(chunk);
    };
    var origClose = writer.close.bind(writer);
    writer.close = function() {
      __moqtapSend({ type: "stream:closed", sessionId: sessionId, streamId: sid });
      return origClose();
    };
    return writer;
  };
}

function __moqtapTapIncoming(incoming, sessionId, isBidi) {
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
            __moqtapWrapReadable(stream.readable, sessionId, sid, "rx", true);
            __moqtapWrapWritable(stream.writable, sessionId, sid, "tx", true);
          } else {
            __moqtapWrapReadable(stream, sessionId, sid, "rx", false);
          }
        }
        return result;
      });
    };
    return reader;
  };
}

function __moqtapInterceptDatagrams(dg, sessionId) {
  if (!dg || typeof dg !== "object") return;
  if (dg.readable && typeof dg.readable === "object" && typeof dg.readable.getReader === "function") {
    var origGetReader = dg.readable.getReader.bind(dg.readable);
    dg.readable.getReader = function() {
      var reader = origGetReader();
      var origRead = reader.read.bind(reader);
      reader.read = function() {
        return origRead().then(function(result) {
          if (!result.done && result.value instanceof Uint8Array) {
            __moqtapSend({ type: "datagram:data", sessionId: sessionId, direction: "rx", data: __moqtapCopyBuf(result.value), capturedAt: Date.now() });
          }
          return result;
        });
      };
      return reader;
    };
  }
  if (dg.writable && typeof dg.writable === "object" && typeof dg.writable.getWriter === "function") {
    var origGetWriter = dg.writable.getWriter.bind(dg.writable);
    dg.writable.getWriter = function() {
      var writer = origGetWriter();
      var origWrite = writer.write.bind(writer);
      writer.write = function(chunk) {
        if (chunk instanceof Uint8Array) {
          __moqtapSend({ type: "datagram:data", sessionId: sessionId, direction: "tx", data: __moqtapCopyBuf(chunk), capturedAt: Date.now() });
        }
        return origWrite(chunk);
      };
      return writer;
    };
  }
}

var __moqtapNextStreamId = 0;
var OrigWT = self.WebTransport;
if (OrigWT) {
  var PatchedWT = function(url, options) {
    var inst = new OrigWT(url, options);
    // String(url): callers may pass a URL object, which is not structured-cloneable
    var session = { id: __moqtapGenId(), url: String(url), createdAt: Date.now(), options: __moqtapOptions(options) };
    var sessionId = session.id;
    __moqtapSend({ type: "session:opened", sessionId: sessionId, url: session.url, createdAt: session.createdAt, options: session.options });
    var origBidi = inst.createBidirectionalStream;
    if (typeof origBidi === "function") {
      inst.createBidirectionalStream = function() {
        var sid = __moqtapNextStreamId++;
        return origBidi.apply(inst, arguments).then(function(stream) {
          __moqtapWrapReadable(stream.readable, sessionId, sid, "rx", true);
          __moqtapWrapWritable(stream.writable, sessionId, sid, "tx", true, true);
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
          __moqtapWrapWritable(writable, sessionId, sid, "tx", false);
          __moqtapSend({ type: "stream:created", sessionId: sessionId, streamId: sid, stack: stack });
          return writable;
        });
      };
    }
    __moqtapTapIncoming(inst.incomingBidirectionalStreams, sessionId, true);
    __moqtapTapIncoming(inst.incomingUnidirectionalStreams, sessionId, false);
    __moqtapInterceptDatagrams(inst.datagrams, sessionId);
    var __reported = false;
    function __reportClose(reason) {
      if (__reported) return;
      __reported = true;
      __moqtapSend({ type: "session:closed", sessionId: session.id, reason: reason });
    }
    if (inst.ready && typeof inst.ready.then === "function") {
      inst.ready.then(undefined, function(err) {
        __reportClose(String(err));
      });
    }
    if (inst.closed && typeof inst.closed.then === "function") {
      inst.closed.then(function(info) {
        var reason = (info && typeof info === "object") ? (info.reason || "code " + (info.closeCode || 0)) : "closed";
        __reportClose(reason);
      }, function(err) {
        __reportClose(String(err));
      });
    }
    return inst;
  };
  PatchedWT.prototype = OrigWT.prototype;
  Object.defineProperty(PatchedWT, "name", { value: "WebTransport" });
  self.WebTransport = PatchedWT;
}
})();`
}

// ─── Send helpers ─────────────────────────────────────────────────────

/** Byte size of a message's payload, or 0 for messages that carry none */
function payloadBytes(msg: ContentToBackgroundMsg): number {
  if (msg.type !== 'stream:data' && msg.type !== 'datagram:data') return 0
  return msg.data instanceof ArrayBuffer ? msg.data.byteLength : msg.data.length
}

/** Queue or forward a message depending on activation state */
function send(msg: ContentToBackgroundMsg) {
  if (activated) {
    forward(msg)
    return
  }
  const entry: BufferedMsg = { seq: bufferSeq++, msg, bytes: payloadBytes(msg) }
  // Cap each buffer to prevent memory leaks on pages that never open DevTools
  if (msg.type === 'stream:data' && msg.bidi === true) {
    controlBuffer.push(entry)
    controlBytes += entry.bytes
    while (
      controlBuffer.length > MAX_CONTROL_BUFFER ||
      controlBytes > MAX_CONTROL_BYTES
    ) {
      const dropped = controlBuffer.shift()
      if (!dropped) break
      controlBytes -= dropped.bytes
    }
  } else if (msg.type === 'stream:data' || msg.type === 'datagram:data') {
    // Includes bidi === undefined: a hook predating the flag reports no stream
    // class, so treat it as bulk and keep the pre-existing behaviour.
    dataBuffer.push(entry)
    if (dataBuffer.length > MAX_DATA_BUFFER) dataBuffer.shift()
  } else {
    lifecycleBuffer.push(entry)
    if (lifecycleBuffer.length > MAX_LIFECYCLE_BUFFER) lifecycleBuffer.shift()
  }
}

/** Flush every buffer in the original arrival order */
function flushBuffers() {
  const pending = [...lifecycleBuffer, ...controlBuffer, ...dataBuffer]
  lifecycleBuffer = []
  controlBuffer = []
  dataBuffer = []
  controlBytes = 0
  // Each buffer is already ordered; sorting the union is simpler than an
  // n-way merge and the combined length is capped in the low thousands.
  pending.sort((a, b) => a.seq - b.seq)
  for (const entry of pending) forward(entry.msg)
}

/**
 * Message types already reported as unserializable, so a repeating failure
 * warns once instead of flooding the page console.
 */
const cloneFailuresWarned = new Set<string>()

/** Actually send to bridge via window.postMessage (transfers ArrayBuffer for zero-copy) */
function forward(msg: ContentToBackgroundMsg) {
  try {
    const transfers: Transferable[] = []
    if (
      (msg.type === 'stream:data' || msg.type === 'datagram:data') &&
      msg.data instanceof ArrayBuffer
    ) {
      transfers.push(msg.data)
    }
    window.postMessage(
      { source: 'moqtap-content', payload: msg },
      '*',
      transfers,
    )
  } catch (err) {
    // A DataCloneError means the payload picked up a value the structured
    // clone algorithm rejects (e.g. a URL object handed to the WebTransport
    // constructor). That drops the event, so surface it rather than let the
    // session silently never appear in the panel.
    if (
      err instanceof DOMException &&
      err.name === 'DataCloneError' &&
      !cloneFailuresWarned.has(msg.type)
    ) {
      cloneFailuresWarned.add(msg.type)
      console.warn(
        `[moqtap] dropped "${msg.type}" event — payload is not structured-cloneable:`,
        err.message,
      )
      return
    }
    // Otherwise: extension context invalidated (disabled/uninstalled/updated)
  }
}
