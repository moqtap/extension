/**
 * WebTransport monkey-patching for main-thread interception.
 *
 * This module patches the global WebTransport constructor to intercept
 * all WebTransport sessions created in the main thread context.
 * Worker-based WebTransport is NOT intercepted (by design — see spec D10).
 *
 * The hook captures:
 * - Connection setup (URL, options)
 * - Bidirectional streams (the control stream is stream #0)
 * - Unidirectional streams (data streams: subgroup, fetch)
 * - Datagrams
 * - Close/error events
 */

export interface InterceptedSession {
  id: string;
  url: string;
  createdAt: number;
}

export interface SessionLifecycleCallbacks {
  onSession: (session: InterceptedSession) => void;
  onSessionClosed: (sessionId: string, reason: string) => void;
}

export interface StreamInterceptor {
  onData(streamId: number, data: Uint8Array, direction: 'tx' | 'rx', stack?: string): void;
  onClose(streamId: number): void;
  onError(streamId: number, error: unknown): void;
  onStreamCreated?(streamId: number, stack: string): void;
}

// Stored per-global so uninstallWebTransportHook can restore without
// needing the return value from installWebTransportHook.
const originalConstructors = new WeakMap<object, unknown>();

let sessionCounter = 0;

function generateSessionId(): string {
  return `wt-${Date.now()}-${++sessionCounter}`;
}

/** Install the WebTransport monkey-patch on the given global object */
export function installWebTransportHook(
  target: typeof globalThis,
  onSession: (session: InterceptedSession) => void,
  onStream: StreamInterceptor,
  onSessionClosed?: (sessionId: string, reason: string) => void,
): () => void {
  const glob = target as Record<string, unknown>;
  const OriginalWebTransport = glob.WebTransport as (new (...args: unknown[]) => unknown) | undefined;

  // No WebTransport on this global (e.g. Worker without WebTransport support).
  // Return a safe no-op cleanup.
  if (!OriginalWebTransport) {
    return () => {};
  }

  originalConstructors.set(target, OriginalWebTransport);

  let nextStreamId = 0;

  function PatchedWebTransport(this: unknown, url: string, options?: Record<string, unknown>) {
    // Delegate to the real constructor
    const instance = new (OriginalWebTransport as new (url: string, options?: Record<string, unknown>) => Record<string, unknown>)(url, options);

    // Notify the session callback
    const session: InterceptedSession = {
      id: generateSessionId(),
      url,
      createdAt: Date.now(),
    };
    onSession(session);

    // Wrap createBidirectionalStream to intercept stream data
    const origCreateBidi = instance.createBidirectionalStream as (...args: unknown[]) => Promise<unknown>;
    if (typeof origCreateBidi === 'function') {
      instance.createBidirectionalStream = (...args: unknown[]) => {
        const streamId = nextStreamId++;
        return origCreateBidi.apply(instance, args).then((stream: unknown) => {
          const s = stream as Record<string, unknown>;
          wrapReadableStream(s.readable, streamId, 'rx', onStream);
          wrapWritableStream(s.writable, streamId, 'tx', onStream, true);
          return stream;
        });
      };
    }

    // Wrap createUnidirectionalStream to intercept outgoing data
    const origCreateUni = instance.createUnidirectionalStream as (...args: unknown[]) => Promise<unknown>;
    if (typeof origCreateUni === 'function') {
      instance.createUnidirectionalStream = (...args: unknown[]) => {
        const streamId = nextStreamId++;
        // Capture synchronously before the async boundary
        const stack = new Error().stack ?? '';
        return origCreateUni.apply(instance, args).then((writable: unknown) => {
          wrapWritableStream(writable, streamId, 'tx', onStream);
          onStream.onStreamCreated?.(streamId, stack);
          return writable;
        });
      };
    }

    // Tap into incoming bidirectional streams
    tapIncomingStreams(
      instance.incomingBidirectionalStreams,
      () => nextStreamId++,
      onStream,
      true,
    );

    // Tap into incoming unidirectional streams
    tapIncomingStreams(
      instance.incomingUnidirectionalStreams,
      () => nextStreamId++,
      onStream,
      false,
    );

    // Monitor the session-level close promise
    if (onSessionClosed) {
      const closed = instance.closed as Promise<{ closeCode?: number; reason?: string }> | undefined;
      if (closed && typeof closed.then === 'function') {
        closed.then(
          (info) => {
            const reason = (info && typeof info === 'object')
              ? (info.reason || `code ${info.closeCode ?? 0}`)
              : 'closed';
            onSessionClosed(session.id, reason);
          },
          (err) => {
            onSessionClosed(session.id, String(err));
          },
        );
      }
    }

    return instance;
  }

  // Preserve prototype chain so instanceof checks still work
  PatchedWebTransport.prototype = (OriginalWebTransport as { prototype: unknown }).prototype;
  Object.defineProperty(PatchedWebTransport, 'name', { value: 'WebTransport' });

  glob.WebTransport = PatchedWebTransport;

  // Return cleanup function
  return () => {
    glob.WebTransport = OriginalWebTransport;
    originalConstructors.delete(target);
  };
}

/** Remove the monkey-patch and restore original WebTransport */
export function uninstallWebTransportHook(target: typeof globalThis): void {
  const glob = target as Record<string, unknown>;
  const original = originalConstructors.get(target);
  if (original) {
    glob.WebTransport = original;
    originalConstructors.delete(target);
  }
}

// ─── Stream interception helpers ───────────────────────────────────

/**
 * Wrap a ReadableStream to intercept chunks as they are read.
 * Non-destructive: the original stream is still consumed normally.
 */
function wrapReadableStream(
  readable: unknown,
  streamId: number,
  direction: 'tx' | 'rx',
  interceptor: StreamInterceptor,
): void {
  if (!readable || typeof readable !== 'object') return;
  const rs = readable as { getReader: () => ReadableStreamReader };
  if (typeof rs.getReader !== 'function') return;

  const origGetReader = rs.getReader.bind(rs);
  rs.getReader = () => {
    const reader = origGetReader();
    const origRead = reader.read.bind(reader);
    reader.read = () =>
      origRead().then(
        (result: ReadableStreamReadResult<unknown>) => {
          if (result.done) {
            interceptor.onClose(streamId);
          } else if (result.value instanceof Uint8Array) {
            interceptor.onData(streamId, result.value, direction);
          }
          return result;
        },
        (err: unknown) => {
          interceptor.onError(streamId, err);
          throw err;
        },
      );
    return reader;
  };
}

/**
 * Wrap a WritableStream to intercept chunks as they are written.
 * When captureStack is true, captures a stack trace at each write site
 * and passes it to the interceptor (used for bidirectional/control streams).
 */
function wrapWritableStream(
  writable: unknown,
  streamId: number,
  direction: 'tx' | 'rx',
  interceptor: StreamInterceptor,
  captureStack = false,
): void {
  if (!writable || typeof writable !== 'object') return;
  const ws = writable as { getWriter: () => WritableStreamWriter };
  if (typeof ws.getWriter !== 'function') return;

  const origGetWriter = ws.getWriter.bind(ws);
  ws.getWriter = () => {
    const writer = origGetWriter();
    const origWrite = writer.write.bind(writer);
    writer.write = (chunk?: unknown) => {
      if (chunk instanceof Uint8Array) {
        const stack = captureStack ? new Error().stack : undefined;
        interceptor.onData(streamId, chunk, direction, stack);
      }
      return origWrite(chunk);
    };
    const origClose = writer.close.bind(writer);
    writer.close = () => {
      interceptor.onClose(streamId);
      return origClose();
    };
    return writer;
  };
}

/**
 * Tap into an incoming streams ReadableStream (bidirectional or unidirectional).
 * Each new incoming stream gets its own stream ID and interception.
 */
function tapIncomingStreams(
  incomingStreams: unknown,
  allocStreamId: () => number,
  interceptor: StreamInterceptor,
  isBidirectional: boolean,
): void {
  if (!incomingStreams || typeof incomingStreams !== 'object') return;
  const rs = incomingStreams as { getReader: () => ReadableStreamReader };
  if (typeof rs.getReader !== 'function') return;

  const origGetReader = rs.getReader.bind(rs);
  rs.getReader = () => {
    const reader = origGetReader();
    const origRead = reader.read.bind(reader);
    reader.read = () =>
      origRead().then((result: ReadableStreamReadResult<unknown>) => {
        if (!result.done && result.value) {
          const streamId = allocStreamId();
          const stream = result.value as Record<string, unknown>;
          if (isBidirectional) {
            wrapReadableStream(stream.readable, streamId, 'rx', interceptor);
            wrapWritableStream(stream.writable, streamId, 'tx', interceptor);
          } else {
            wrapReadableStream(stream, streamId, 'rx', interceptor);
          }
        }
        return result;
      });
    return reader;
  };
}

// Minimal type stubs for stream reader/writer used in interception.
// These are intentionally narrow — we only need the methods we wrap.
interface ReadableStreamReader {
  read: () => Promise<ReadableStreamReadResult<unknown>>;
  releaseLock: () => void;
}
interface ReadableStreamReadResult<T> {
  done: boolean;
  value?: T;
}
interface WritableStreamWriter {
  write: (chunk?: unknown) => Promise<void>;
  close: () => Promise<void>;
  releaseLock: () => void;
}
