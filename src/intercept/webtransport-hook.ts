/**
 * WebTransport monkey-patching for main-thread interception.
 *
 * This module patches the global WebTransport constructor to intercept
 * all WebTransport sessions created in the main thread context.
 * Worker-based WebTransport is NOT intercepted (by design — see spec D10).
 *
 * The hook captures:
 * - Connection setup (URL, options)
 * - The negotiated application protocol, once the session is established
 * - Bidirectional streams (the control stream is stream #0)
 * - Unidirectional streams (data streams: subgroup, fetch)
 * - Datagrams
 * - Close/error events
 */

import type { WebTransportOptionsInfo } from '../messaging/types'

export interface InterceptedSession {
  id: string
  url: string
  createdAt: number
  options?: WebTransportOptionsInfo
}

/**
 * Pull the parseable fields out of the caller's WebTransportOptions.
 *
 * Every read here touches a page-controlled object, so the whole thing is
 * wrapped: a throwing getter must not propagate out of the patched
 * constructor and break the page's connection. Only primitives and string
 * arrays are copied out, keeping the result structured-cloneable.
 */
export function extractSessionOptions(
  options: unknown,
): WebTransportOptionsInfo | undefined {
  try {
    if (!options || typeof options !== 'object') return undefined
    const o = options as Record<string, unknown>
    const info: WebTransportOptionsInfo = {}

    if (Array.isArray(o.protocols)) {
      const protocols = o.protocols.filter(
        (p): p is string => typeof p === 'string',
      )
      if (protocols.length > 0) info.protocols = protocols
    }
    if (typeof o.congestionControl === 'string') {
      info.congestionControl = o.congestionControl
    }
    if (typeof o.allowPooling === 'boolean') {
      info.allowPooling = o.allowPooling
    }
    if (typeof o.requireUnreliable === 'boolean') {
      info.requireUnreliable = o.requireUnreliable
    }
    if (Array.isArray(o.serverCertificateHashes)) {
      info.serverCertificateHashes = o.serverCertificateHashes.length
    }

    return Object.keys(info).length > 0 ? info : undefined
  } catch {
    return undefined
  }
}

/**
 * The application protocol the server picked, read off the session once it is
 * established.
 *
 * This is the other half of the WebTransport protocol negotiation whose client
 * side arrives as `options.protocols` (`WT-Available-Protocols`): the server
 * answers with one of them, and the WebTransport spec exposes the answer as
 * the session's `protocol` attribute. For MoQT that string is `moqt-NN` and it
 * is what names the draft from draft-15 on.
 *
 * Empty until the session is established, so this is only worth calling from
 * the `ready` continuation. Undefined on browsers that have not implemented
 * protocol negotiation, where the attribute is simply absent — the offer list
 * is the fallback, and it settles the draft on its own whenever it names one
 * MoQT protocol.
 *
 * Every read touches a page-controlled object, so a throwing getter must not
 * escape into the page's own connection.
 */
export function readNegotiatedProtocol(instance: unknown): string | undefined {
  try {
    if (!instance || typeof instance !== 'object') return undefined
    const p = (instance as Record<string, unknown>).protocol
    return typeof p === 'string' && p.length > 0 ? p : undefined
  } catch {
    return undefined
  }
}

export interface SessionLifecycleCallbacks {
  onSession: (session: InterceptedSession) => void
  onSessionClosed: (sessionId: string, reason: string) => void
}

export interface StreamInterceptor {
  /**
   * @param direction which side of the stream the bytes crossed — 'tx' for a
   *   write, 'rx' for a read. Not the stream's class.
   * @param bidi true when the bytes belong to a bidirectional stream. Known
   *   for free here because each of the four stream sources (create/incoming ×
   *   bidi/uni) is a separate call site, and worth propagating: every MoQ
   *   dialect puts its control plane on bidi streams and bulk media on uni
   *   ones, so this separates signal from volume without decoding a byte.
   */
  onData(
    sessionId: string,
    streamId: number,
    data: Uint8Array,
    direction: 'tx' | 'rx',
    bidi: boolean,
    stack?: string,
  ): void
  onClose(sessionId: string, streamId: number): void
  onError(sessionId: string, streamId: number, error: unknown): void
  onStreamCreated?(sessionId: string, streamId: number, stack: string): void
  /** Called for each datagram received or sent via WebTransport datagrams. */
  onDatagram?(sessionId: string, data: Uint8Array, direction: 'tx' | 'rx'): void
}

import { joinChain } from './patch-chain'

// The teardown closure per global, so `uninstallWebTransportHook` can run it
// without the return value from `installWebTransportHook`. It holds the closure
// rather than the original constructor because teardown is conditional -- see
// the comment on `teardown` -- and a bare constructor cannot express that.
const installedHooks = new WeakMap<object, () => void>()

let sessionCounter = 0

function generateSessionId(): string {
  return `wt-${Date.now()}-${++sessionCounter}`
}

/** Install the WebTransport monkey-patch on the given global object */
export function installWebTransportHook(
  target: typeof globalThis,
  onSession: (session: InterceptedSession) => void,
  onStream: StreamInterceptor,
  onSessionClosed?: (sessionId: string, reason: string) => void,
  /**
   * Called once, after `ready` resolves, when the server's protocol pick is
   * visible. Separate from `onSession` because the pick does not exist yet at
   * construction time — see readNegotiatedProtocol.
   */
  onSessionProtocol?: (sessionId: string, protocol: string) => void,
): () => void {
  const glob = target as Record<string, unknown>
  /**
   * What we delegate to. **`let`, not `const`**: when a moqtap patch below us
   * leaves the chain it hands us its delegate and we splice it out, which only
   * works if the constructor reads this variable rather than a captured value.
   * See `patch-chain.ts`.
   */
  let OriginalWebTransport = glob.WebTransport as
    (new (...args: unknown[]) => unknown) | undefined

  // No WebTransport on this global (e.g. Worker without WebTransport support).
  // Return a safe no-op cleanup.
  if (!OriginalWebTransport) {
    return () => {}
  }

  let nextStreamId = 0

  /**
   * Cleared by teardown. Restoring the global is **not** guaranteed to be
   * possible (see the teardown comment below), so going inert is what actually
   * stops observation, and it is the half that always works.
   */
  let live = true

  function PatchedWebTransport(
    this: unknown,
    url: string | URL,
    options?: Record<string, unknown>,
  ) {
    // Delegate to the real constructor with the caller's original argument
    const instance = new (
      OriginalWebTransport as new (
        url: string | URL,
        options?: Record<string, unknown>,
      ) => Record<string, unknown>
    )(url, options)

    // Torn down but still in the constructor chain, because something patched
    // over us and we could not safely unwind. Delegate and observe nothing.
    if (!live) return instance

    // Notify the session callback.
    // The spec allows a URL object here, and several MoQ libraries pass one.
    // It must be stringified: URL is not structured-cloneable, so leaving it
    // as-is makes the postMessage carrying session:opened throw DataCloneError
    // and the session is never reported.
    const session: InterceptedSession = {
      id: generateSessionId(),
      url: String(url),
      createdAt: Date.now(),
      options: extractSessionOptions(options),
    }
    const sessionId = session.id
    onSession(session)

    // Wrap createBidirectionalStream to intercept stream data
    const origCreateBidi = instance.createBidirectionalStream as (
      ...args: unknown[]
    ) => Promise<unknown>
    if (typeof origCreateBidi === 'function') {
      instance.createBidirectionalStream = (...args: unknown[]) => {
        const streamId = nextStreamId++
        return origCreateBidi.apply(instance, args).then((stream: unknown) => {
          const s = stream as Record<string, unknown>
          wrapReadableStream(
            s.readable,
            sessionId,
            streamId,
            'rx',
            true,
            onStream,
          )
          wrapWritableStream(
            s.writable,
            sessionId,
            streamId,
            'tx',
            true,
            onStream,
            true,
          )
          return stream
        })
      }
    }

    // Wrap createUnidirectionalStream to intercept outgoing data
    const origCreateUni = instance.createUnidirectionalStream as (
      ...args: unknown[]
    ) => Promise<unknown>
    if (typeof origCreateUni === 'function') {
      instance.createUnidirectionalStream = (...args: unknown[]) => {
        const streamId = nextStreamId++
        // Capture synchronously before the async boundary
        const stack = new Error().stack ?? ''
        return origCreateUni.apply(instance, args).then((writable: unknown) => {
          wrapWritableStream(
            writable,
            sessionId,
            streamId,
            'tx',
            false,
            onStream,
          )
          onStream.onStreamCreated?.(sessionId, streamId, stack)
          return writable
        })
      }
    }

    // Tap into incoming bidirectional streams
    tapIncomingStreams(
      instance.incomingBidirectionalStreams,
      sessionId,
      () => nextStreamId++,
      onStream,
      true,
    )

    // Tap into incoming unidirectional streams
    tapIncomingStreams(
      instance.incomingUnidirectionalStreams,
      sessionId,
      () => nextStreamId++,
      onStream,
      false,
    )

    // Intercept datagrams (readable = rx, writable = tx)
    if (onStream.onDatagram) {
      interceptDatagrams(instance.datagrams, sessionId, onStream)
    }

    // Report the server's protocol pick once the session is established. It is
    // the empty string before that, so the read has to wait for `ready`.
    if (onSessionProtocol) {
      const ready = instance.ready as Promise<unknown> | undefined
      if (ready && typeof ready.then === 'function') {
        ready.then(
          () => {
            const protocol = readNegotiatedProtocol(instance)
            if (protocol) onSessionProtocol(sessionId, protocol)
          },
          () => {},
        )
      }
    }

    // Monitor connection lifecycle promises
    if (onSessionClosed) {
      let reported = false
      const reportClose = (reason: string) => {
        if (reported) return
        reported = true
        onSessionClosed(session.id, reason)
      }

      // .ready rejects when the connection fails to establish
      // (e.g. server unreachable, TLS error, QUIC handshake failure)
      const ready = instance.ready as Promise<unknown> | undefined
      if (ready && typeof ready.then === 'function') {
        ready.then(undefined, (err) => {
          reportClose(String(err))
        })
      }

      // .closed resolves on clean close, rejects on error-based closure
      const closed = instance.closed as
        Promise<{ closeCode?: number; reason?: string }> | undefined
      if (closed && typeof closed.then === 'function') {
        closed.then(
          (info) => {
            const reason =
              info && typeof info === 'object'
                ? info.reason || `code ${info.closeCode ?? 0}`
                : 'closed'
            reportClose(reason)
          },
          (err) => {
            reportClose(String(err))
          },
        )
      }
    }

    return instance
  }

  // Preserve prototype chain so instanceof checks still work
  PatchedWebTransport.prototype = (
    OriginalWebTransport as { prototype: unknown }
  ).prototype
  Object.defineProperty(PatchedWebTransport, 'name', { value: 'WebTransport' })

  glob.WebTransport = PatchedWebTransport

  const chain = joinChain(target, {
    id: 'extension',
    patched: PatchedWebTransport,
    original: OriginalWebTransport,
    repoint(next: unknown): void {
      OriginalWebTransport = next as typeof OriginalWebTransport
    },
  })

  /**
   * Teardown, in two halves that must not be confused.
   *
   * **Going inert always works.** Clearing `live` stops every future
   * construction from being observed, whatever else is true of the global.
   *
   * **Restoring the global only sometimes does, and doing it unconditionally
   * is a bug.** This content script runs in MAIN world at `document_start`, so
   * it patches before any page script; `@moqtap/collector` installs its own
   * hook from `init()` in page JS, which therefore lands *on top* of this one.
   * A blind `glob.WebTransport = OriginalWebTransport` there discards the
   * collector's patch, and the page goes silently uninstrumented — no error, no
   * event, the collector simply stops seeing connections it was created to
   * watch. The collector's own teardown already makes exactly this check for
   * exactly this reason (`webtransport-hook.ts`, `if (glob.WebTransport ===
   * PatchedWebTransport)`), so the asymmetry was ours.
   *
   * Leaving our wrapper in the chain is the lesser cost: it delegates, `live`
   * is false, and it observes nothing.
   */
  const teardown = (): void => {
    if (!live) return
    live = false
    installedHooks.delete(target)
    // Leave the chain first. If a moqtap patch is above us it takes our
    // delegate and the global keeps naming it, which is correct and removes our
    // wrapper for real. Only when nothing claims it do we touch the global, and
    // only if we are still outermost -- a non-participant may be on top.
    const handover = chain.release()
    if (handover !== null && glob.WebTransport === PatchedWebTransport) {
      glob.WebTransport = handover.restore as typeof OriginalWebTransport
    }
  }

  installedHooks.set(target, teardown)
  return teardown
}

/** Remove the monkey-patch and restore original WebTransport */
export function uninstallWebTransportHook(target: typeof globalThis): void {
  installedHooks.get(target)?.()
}

// ─── Stream interception helpers ───────────────────────────────────

/**
 * Wrap a ReadableStream to intercept chunks as they are read.
 * Non-destructive: the original stream is still consumed normally.
 */
function wrapReadableStream(
  readable: unknown,
  sessionId: string,
  streamId: number,
  direction: 'tx' | 'rx',
  bidi: boolean,
  interceptor: StreamInterceptor,
): void {
  if (!readable || typeof readable !== 'object') return
  const rs = readable as { getReader: () => ReadableStreamReader }
  if (typeof rs.getReader !== 'function') return

  const origGetReader = rs.getReader.bind(rs)
  rs.getReader = () => {
    const reader = origGetReader()
    const origRead = reader.read.bind(reader)
    reader.read = () =>
      origRead().then(
        (result: ReadableStreamReadResult<unknown>) => {
          if (result.done) {
            interceptor.onClose(sessionId, streamId)
          } else if (result.value instanceof Uint8Array) {
            interceptor.onData(
              sessionId,
              streamId,
              result.value,
              direction,
              bidi,
            )
          }
          return result
        },
        (err: unknown) => {
          interceptor.onError(sessionId, streamId, err)
          throw err
        },
      )
    return reader
  }
}

/**
 * Wrap a WritableStream to intercept chunks as they are written.
 * When captureStack is true, captures a stack trace at each write site
 * and passes it to the interceptor (used for bidirectional/control streams).
 */
function wrapWritableStream(
  writable: unknown,
  sessionId: string,
  streamId: number,
  direction: 'tx' | 'rx',
  bidi: boolean,
  interceptor: StreamInterceptor,
  captureStack = false,
): void {
  if (!writable || typeof writable !== 'object') return
  const ws = writable as { getWriter: () => WritableStreamWriter }
  if (typeof ws.getWriter !== 'function') return

  const origGetWriter = ws.getWriter.bind(ws)
  ws.getWriter = () => {
    const writer = origGetWriter()
    const origWrite = writer.write.bind(writer)
    writer.write = (chunk?: unknown) => {
      if (chunk instanceof Uint8Array) {
        const stack = captureStack ? new Error().stack : undefined
        interceptor.onData(sessionId, streamId, chunk, direction, bidi, stack)
      }
      return origWrite(chunk)
    }
    const origClose = writer.close.bind(writer)
    writer.close = () => {
      interceptor.onClose(sessionId, streamId)
      return origClose()
    }
    return writer
  }
}

/**
 * Tap into an incoming streams ReadableStream (bidirectional or unidirectional).
 * Each new incoming stream gets its own stream ID and interception.
 */
function tapIncomingStreams(
  incomingStreams: unknown,
  sessionId: string,
  allocStreamId: () => number,
  interceptor: StreamInterceptor,
  isBidirectional: boolean,
): void {
  if (!incomingStreams || typeof incomingStreams !== 'object') return
  const rs = incomingStreams as { getReader: () => ReadableStreamReader }
  if (typeof rs.getReader !== 'function') return

  const origGetReader = rs.getReader.bind(rs)
  rs.getReader = () => {
    const reader = origGetReader()
    const origRead = reader.read.bind(reader)
    reader.read = () =>
      origRead().then((result: ReadableStreamReadResult<unknown>) => {
        if (!result.done && result.value) {
          const streamId = allocStreamId()
          const stream = result.value as Record<string, unknown>
          if (isBidirectional) {
            wrapReadableStream(
              stream.readable,
              sessionId,
              streamId,
              'rx',
              true,
              interceptor,
            )
            wrapWritableStream(
              stream.writable,
              sessionId,
              streamId,
              'tx',
              true,
              interceptor,
            )
          } else {
            wrapReadableStream(
              stream,
              sessionId,
              streamId,
              'rx',
              false,
              interceptor,
            )
          }
        }
        return result
      })
    return reader
  }
}

/**
 * Intercept the datagrams property of a WebTransport instance.
 * Tees the readable side (rx) and wraps the writable side (tx).
 */
function interceptDatagrams(
  datagrams: unknown,
  sessionId: string,
  interceptor: StreamInterceptor,
): void {
  if (!datagrams || typeof datagrams !== 'object') return
  const dg = datagrams as {
    readable?: unknown
    writable?: unknown
  }

  // Intercept incoming datagrams (rx) by wrapping getReader
  if (dg.readable && typeof dg.readable === 'object') {
    const rs = dg.readable as { getReader: () => ReadableStreamReader }
    if (typeof rs.getReader === 'function') {
      const origGetReader = rs.getReader.bind(rs)
      rs.getReader = () => {
        const reader = origGetReader()
        const origRead = reader.read.bind(reader)
        reader.read = () =>
          origRead().then((result: ReadableStreamReadResult<unknown>) => {
            if (!result.done && result.value instanceof Uint8Array) {
              interceptor.onDatagram!(sessionId, result.value, 'rx')
            }
            return result
          })
        return reader
      }
    }
  }

  // Intercept outgoing datagrams (tx) by wrapping getWriter
  if (dg.writable && typeof dg.writable === 'object') {
    const ws = dg.writable as { getWriter: () => WritableStreamWriter }
    if (typeof ws.getWriter === 'function') {
      const origGetWriter = ws.getWriter.bind(ws)
      ws.getWriter = () => {
        const writer = origGetWriter()
        const origWrite = writer.write.bind(writer)
        writer.write = (chunk?: unknown) => {
          if (chunk instanceof Uint8Array) {
            interceptor.onDatagram!(sessionId, chunk, 'tx')
          }
          return origWrite(chunk)
        }
        return writer
      }
    }
  }
}

// Minimal type stubs for stream reader/writer used in interception.
// These are intentionally narrow — we only need the methods we wrap.
interface ReadableStreamReader {
  read: () => Promise<ReadableStreamReadResult<unknown>>
  releaseLock: () => void
}
interface ReadableStreamReadResult<T> {
  done: boolean
  value?: T
}
interface WritableStreamWriter {
  write: (chunk?: unknown) => Promise<void>
  close: () => Promise<void>
  releaseLock: () => void
}
