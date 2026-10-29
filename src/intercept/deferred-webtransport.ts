/**
 * A WebTransport the page can use at once while the real connection starts
 * later: when the frame learns whether its tab's sessions go through the CLI.
 *
 * Every member the page can touch is an own property shadowing the
 * prototype's: promises and streams are stable stand-ins that follow the real
 * session once it is attached; calls made before then wait for it.
 *
 * Self-contained: the worker hook embeds this function's source.
 */

export interface DeferredWebTransport {
  /** What the constructor returns to the page. */
  readonly transport: object
  /** False once the page closed it, so no connection may start. */
  wanted(): boolean
  /** The real session, constructed by the hook. */
  attach(real: object): void
  /** The real session could not be constructed. */
  fail(error: unknown): void
}

export function deferWebTransport(
  Original: { prototype: object },
  options: unknown,
): DeferredWebTransport {
  // biome-ignore lint/suspicious/noExplicitAny: a real WebTransport, typed loosely so this compiles anywhere
  type Real = Record<string, any>
  const g = globalThis as Record<string, unknown>
  const proto = Original.prototype as Record<string, unknown>
  let real: Real | null = null
  let failed = false

  const handled = <T>(p: Promise<T>): Promise<T> => {
    p.catch(() => {})
    return p
  }
  const settle = () => {
    let resolve!: (v: unknown) => void
    let reject!: (e: unknown) => void
    const promise = handled(
      new Promise<unknown>((a, b) => {
        resolve = a
        reject = b
      }),
    )
    return { promise, resolve, reject }
  }
  const connected = settle()
  const ready = settle()
  const closed = settle()
  const draining = settle()
  const whenReal = connected.promise as Promise<Real>

  const invalid = () => new DOMException('The WebTransport session is closed.', 'InvalidStateError')
  const sessionError = (message: string): unknown => {
    const E = g.WebTransportError as (new (...a: unknown[]) => Error) | undefined
    let e: unknown
    if (typeof E === 'function') {
      try {
        e = new E(message, { source: 'session' })
      } catch {
        try {
          e = new E({ message })
        } catch {
          e = undefined
        }
      }
    }
    if (e === undefined) e = new DOMException(message, 'AbortError')
    if ((e as { source?: unknown }).source !== 'session') {
      try {
        Object.defineProperty(e, 'source', { value: 'session', configurable: true })
      } catch {
        // Leave it as constructed.
      }
    }
    return e
  }

  const cleanup = (error: unknown) => {
    if (real !== null || failed) return
    failed = true
    ready.reject(error)
    closed.reject(error)
    connected.reject(error)
  }

  const follow = (p: unknown, s: { resolve: (v: unknown) => void; reject: (e: unknown) => void }) => {
    if (p !== null && typeof p === 'object' && typeof (p as Promise<unknown>).then === 'function') {
      ;(p as Promise<unknown>).then(s.resolve, s.reject)
    } else {
      s.resolve(p)
    }
  }

  /** A call that waits for the real session. */
  const later =
    (name: string) =>
    (...args: unknown[]): unknown => {
      if (real !== null) return real[name](...args)
      if (failed) return Promise.reject(invalid())
      return whenReal.then(
        (r) => r[name](...args),
        () => {
          throw invalid()
        },
      )
    }

  /** Stand-ins handed out before the real session existed, by name. */
  const standIns = new Map<string, unknown>()
  const lazy = (key: string, make: () => unknown, fromReal: (r: Real) => unknown): unknown => {
    if (standIns.has(key)) return standIns.get(key)
    if (real !== null) return fromReal(real)
    const v = make()
    standIns.set(key, v)
    return v
  }

  const objectStream = (get: (r: Real) => ReadableStream<unknown>) => {
    let reader: ReadableStreamDefaultReader<unknown> | null = null
    return new ReadableStream<unknown>(
      {
        pull: (c) =>
          whenReal
            .then((r) => {
              reader ??= get(r).getReader()
              return reader.read()
            })
            .then((res) => {
              if (res.done) c.close()
              else c.enqueue(res.value)
            }),
        cancel: (reason) =>
          reader !== null
            ? reader.cancel(reason)
            : whenReal.then(
                (r) => get(r).cancel(reason),
                () => undefined,
              ),
      },
      { highWaterMark: 0 },
    )
  }

  const byteStream = (get: (r: Real) => ReadableStream<unknown>) => {
    let reader: ReadableStreamDefaultReader<unknown> | null = null
    return new ReadableStream({
      type: 'bytes',
      pull: async (c: ReadableByteStreamController) => {
        const r = await whenReal
        reader ??= get(r).getReader()
        for (;;) {
          const res = await reader.read()
          if (res.done) {
            c.close()
            c.byobRequest?.respond(0)
            return
          }
          const v = res.value
          if (ArrayBuffer.isView(v) && v.byteLength > 0) {
            c.enqueue(new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice())
            return
          }
        }
      },
      cancel: (reason: unknown) =>
        reader !== null
          ? reader.cancel(reason)
          : whenReal.then(
              (r) => get(r).cancel(reason),
              () => undefined,
            ),
    })
  }

  const writableStream = (get: (r: Real) => WritableStream<unknown>) => {
    let writer: WritableStreamDefaultWriter<unknown> | null = null
    const w = () =>
      whenReal.then((r) => {
        writer ??= get(r).getWriter()
        return writer
      })
    return new WritableStream<unknown>(
      {
        write: (chunk) => w().then((x) => x.write(chunk)),
        close: () => w().then((x) => x.close()),
        abort: (reason) =>
          writer !== null
            ? writer.abort(reason)
            : whenReal.then(
                (r) => get(r).abort(reason),
                () => undefined,
              ),
      },
      { highWaterMark: 1 },
    )
  }

  const define = (target: object, name: string, desc: PropertyDescriptor) =>
    Object.defineProperty(target, name, { configurable: true, enumerable: false, ...desc })

  /** Accessors and methods of `p` not handled by name: delegate once real, inert before. */
  const generic = (
    target: object,
    p: Record<string, unknown>,
    handledNames: readonly string[],
    of: () => Real | null,
    stored: Map<string, unknown>,
    initial: Record<string, unknown> = {},
  ) => {
    for (const name of Object.getOwnPropertyNames(p)) {
      if (name === 'constructor' || handledNames.includes(name)) continue
      const d = Object.getOwnPropertyDescriptor(p, name)
      if (d === undefined) continue
      if (typeof d.get === 'function') {
        define(target, name, {
          get: () => {
            const r = of()
            if (r !== null) return r[name]
            return stored.has(name) ? stored.get(name) : initial[name]
          },
          ...(typeof d.set === 'function'
            ? {
                set: (v: unknown) => {
                  const r = of()
                  if (r !== null) r[name] = v
                  else stored.set(name, v)
                },
              }
            : {}),
        })
      } else if (typeof d.value === 'function') {
        define(target, name, {
          writable: true,
          value: (...args: unknown[]) => {
            const r = of()
            if (r !== null) return r[name](...args)
            throw invalid()
          },
        })
      }
    }
  }

  const ccOption = (options as { congestionControl?: unknown } | null | undefined)?.congestionControl
  const congestionControl = typeof ccOption === 'string' ? ccOption : 'default'

  const transport = Object.create(proto) as Record<string, unknown>
  const transportSets = new Map<string, unknown>()
  const datagramSets = new Map<string, unknown>()

  const makeDatagrams = () => {
    const D = g.WebTransportDatagramDuplexStream as unknown
    const dproto = (typeof D === 'function' ? (D as { prototype: object }).prototype : Object.prototype) as Record<
      string,
      unknown
    >
    const dg = Object.create(dproto) as object
    const ofReal = () => (real === null ? null : (real.datagrams as Real))
    const initial: Record<string, unknown> = {
      maxDatagramSize: 1024,
      incomingMaxAge: null,
      outgoingMaxAge: null,
      incomingHighWaterMark: 1,
    }
    define(dg, 'readable', {
      get: () =>
        lazy(
          'datagrams.readable',
          () => byteStream((r) => r.datagrams.readable),
          (r) => r.datagrams.readable,
        ),
    })
    define(dg, 'writable', {
      get: () =>
        lazy(
          'datagrams.writable',
          () => writableStream((r) => r.datagrams.writable),
          (r) => r.datagrams.writable,
        ),
    })
    define(dg, 'maxDatagramSize', {
      get: () => (real !== null ? real.datagrams.maxDatagramSize : initial.maxDatagramSize),
    })
    const handledNames = ['readable', 'writable', 'maxDatagramSize']
    for (const name of ['incomingMaxAge', 'outgoingMaxAge', 'incomingHighWaterMark', 'outgoingHighWaterMark']) {
      handledNames.push(name)
      define(dg, name, {
        get: () => {
          if (real !== null) return real.datagrams[name]
          return datagramSets.has(name) ? datagramSets.get(name) : initial[name]
        },
        set: (v: unknown) => {
          if (real !== null) real.datagrams[name] = v
          else datagramSets.set(name, v)
        },
      })
    }
    if (typeof dproto.createWritable === 'function') {
      handledNames.push('createWritable')
      define(dg, 'createWritable', {
        writable: true,
        value: (...args: unknown[]) => {
          if (real !== null) return real.datagrams.createWritable(...args)
          if (failed) throw invalid()
          return writableStream((r) => r.datagrams.createWritable(...args))
        },
      })
    }
    generic(dg, dproto, handledNames, ofReal, datagramSets, initial)
    return dg
  }

  define(transport, 'ready', { get: () => ready.promise })
  define(transport, 'closed', { get: () => closed.promise })
  const named = ['ready', 'closed', 'close', 'datagrams', 'incomingBidirectionalStreams', 'incomingUnidirectionalStreams']
  if ('draining' in proto) {
    named.push('draining')
    define(transport, 'draining', { get: () => draining.promise })
  }
  define(transport, 'datagrams', {
    get: () => lazy('datagrams', makeDatagrams, (r) => r.datagrams),
  })
  define(transport, 'incomingBidirectionalStreams', {
    get: () =>
      lazy(
        'incomingBidirectionalStreams',
        () => objectStream((r) => r.incomingBidirectionalStreams),
        (r) => r.incomingBidirectionalStreams,
      ),
  })
  define(transport, 'incomingUnidirectionalStreams', {
    get: () =>
      lazy(
        'incomingUnidirectionalStreams',
        () => objectStream((r) => r.incomingUnidirectionalStreams),
        (r) => r.incomingUnidirectionalStreams,
      ),
  })
  define(transport, 'protocol', { get: () => (real !== null ? real.protocol : '') })
  define(transport, 'reliability', { get: () => (real !== null ? real.reliability : 'pending') })
  define(transport, 'congestionControl', {
    get: () => (real !== null ? real.congestionControl : congestionControl),
  })
  named.push('protocol', 'reliability', 'congestionControl')
  for (const name of ['createBidirectionalStream', 'createUnidirectionalStream', 'getStats', 'exportKeyingMaterial']) {
    if (typeof proto[name] !== 'function') continue
    named.push(name)
    define(transport, name, { writable: true, value: later(name) })
  }
  define(transport, 'close', {
    writable: true,
    value: (info?: unknown) => {
      if (real !== null) return real.close(info)
      if (!failed) cleanup(sessionError('close() is called while connecting.'))
      return undefined
    },
  })
  generic(transport, proto, named, () => real, transportSets)

  return {
    transport,
    wanted: () => !failed,
    attach(r: object) {
      if (real !== null || failed) return
      const rr = r as Real
      real = rr
      for (const [name, value] of transportSets) {
        try {
          rr[name] = value
        } catch {
          // The real session refuses it as it would have refused the page.
        }
      }
      for (const [name, value] of datagramSets) {
        try {
          rr.datagrams[name] = value
        } catch {
          // As above.
        }
      }
      follow(rr.ready, ready)
      follow(rr.closed, closed)
      if ('draining' in proto) follow(rr.draining, draining)
      connected.resolve(rr)
    },
    fail(error: unknown) {
      cleanup(error)
    },
  }
}
