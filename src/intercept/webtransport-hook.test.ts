/**
 * Tests for WebTransport monkey-patching (main-thread interception).
 *
 * The extension intercepts WebTransport in the page's main thread by
 * replacing the global WebTransport constructor. This captures:
 * - Connection setup (URL, options)
 * - Bidirectional streams (control stream = stream #0)
 * - Unidirectional streams (data streams)
 * - Datagrams
 * - Close/error events
 *
 * Worker-based WebTransport is NOT intercepted (spec decision D10).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  installWebTransportHook,
  readNegotiatedProtocol,
  uninstallWebTransportHook,
} from './webtransport-hook'
import type { InterceptedSession, StreamInterceptor, WebTransportRouter } from './webtransport-hook'

// ─── Mock WebTransport ──────────────────────────────────────────────────

class MockReadableStream {
  getReader() {
    return {
      read: vi.fn().mockResolvedValue({ done: true, value: undefined }),
      releaseLock: vi.fn(),
    }
  }
}

class MockWritableStream {
  getWriter() {
    return {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn(),
    }
  }
}

class MockWebTransport {
  url: string
  ready: Promise<void>
  closed: Promise<{ closeCode: number; reason: string }>
  datagrams: {
    readable: MockReadableStream
    writable: MockWritableStream
  }

  private _readyResolve!: () => void
  private _closedResolve!: (v: { closeCode: number; reason: string }) => void

  constructor(url: string, _options?: Record<string, unknown>) {
    this.url = url
    this.ready = new Promise((resolve) => {
      this._readyResolve = resolve
    })
    this.closed = new Promise((resolve) => {
      this._closedResolve = resolve
    })
    this.datagrams = {
      readable: new MockReadableStream(),
      writable: new MockWritableStream(),
    }
    // Auto-resolve ready for testing
    setTimeout(() => this._readyResolve(), 0)
  }

  createBidirectionalStream() {
    return Promise.resolve({
      readable: new MockReadableStream(),
      writable: new MockWritableStream(),
    })
  }

  createUnidirectionalStream() {
    return Promise.resolve(new MockWritableStream())
  }

  get incomingBidirectionalStreams() {
    return new MockReadableStream()
  }

  get incomingUnidirectionalStreams() {
    return new MockReadableStream()
  }

  close(_info?: { closeCode?: number; reason?: string }) {
    this._closedResolve({ closeCode: 0, reason: '' })
  }
}

// ─── Test setup ─────────────────────────────────────────────────────────

function createMockGlobal(): typeof globalThis & {
  WebTransport: typeof MockWebTransport
} {
  return {
    WebTransport: MockWebTransport,
  } as unknown as typeof globalThis & { WebTransport: typeof MockWebTransport }
}

// ═══════════════════════════════════════════════════════════════════════
// Installation and cleanup
// ═══════════════════════════════════════════════════════════════════════

describe('WebTransport hook — installation', () => {
  it('replaces the WebTransport constructor on the global object', () => {
    const mockGlobal = createMockGlobal()
    const originalWT = mockGlobal.WebTransport
    const sessions: InterceptedSession[] = []
    const interceptor: StreamInterceptor = {
      onData: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    }

    installWebTransportHook(mockGlobal, (s) => sessions.push(s), interceptor)
    expect(mockGlobal.WebTransport).not.toBe(originalWT)
  })

  it('returns a cleanup function that restores the original constructor', () => {
    const mockGlobal = createMockGlobal()
    const originalWT = mockGlobal.WebTransport
    const cleanup = installWebTransportHook(mockGlobal, vi.fn(), {
      onData: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    })

    expect(mockGlobal.WebTransport).not.toBe(originalWT)
    cleanup()
    expect(mockGlobal.WebTransport).toBe(originalWT)
  })

  it('leaves a patch installed over ours alone, and goes inert instead', () => {
    // The defect this guards: `@moqtap/collector` installs its own WebTransport
    // hook from `init()` in page JS, while this content script patches in MAIN
    // world at document_start -- so the collector always lands on top of us.
    // Teardown used to restore the global unconditionally, which discarded the
    // collector's patch and left the page silently uninstrumented: no error, no
    // event, the collector just stopped seeing connections.
    const mockGlobal = createMockGlobal()
    const originalWT = mockGlobal.WebTransport
    const onSession = vi.fn()
    const cleanup = installWebTransportHook(mockGlobal, onSession, {
      onData: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    })
    const ours = mockGlobal.WebTransport

    // Somebody else patches over us, capturing our constructor as theirs.
    const Foreign = function (this: unknown, url: string) {
      return new (ours as new (u: string) => object)(url)
    } as unknown as typeof mockGlobal.WebTransport
    mockGlobal.WebTransport = Foreign

    cleanup()

    expect(mockGlobal.WebTransport).toBe(Foreign)
    expect(mockGlobal.WebTransport).not.toBe(originalWT)

    // ...and we observe nothing through the wrapper we could not remove.
    onSession.mockClear()
    new (mockGlobal.WebTransport as new (u: string) => unknown)(
      'https://x.test',
    )
    expect(onSession).not.toHaveBeenCalled()
  })

  it('uninstallWebTransportHook restores the original constructor', () => {
    const mockGlobal = createMockGlobal()
    const originalWT = mockGlobal.WebTransport
    installWebTransportHook(mockGlobal, vi.fn(), {
      onData: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    })

    uninstallWebTransportHook(mockGlobal)
    expect(mockGlobal.WebTransport).toBe(originalWT)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Session interception
// ═══════════════════════════════════════════════════════════════════════

describe('WebTransport hook — session capture', () => {
  it('captures new WebTransport session with URL', () => {
    const mockGlobal = createMockGlobal()
    const sessions: InterceptedSession[] = []
    installWebTransportHook(mockGlobal, (s) => sessions.push(s), {
      onData: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    })

    const _wt = new (mockGlobal.WebTransport as any)(
      'https://relay.example.com/moq',
    )
    expect(sessions).toHaveLength(1)
    expect(sessions[0].url).toBe('https://relay.example.com/moq')
  })

  it('stringifies a URL object so the session stays structured-cloneable', () => {
    const mockGlobal = createMockGlobal()
    const sessions: InterceptedSession[] = []
    installWebTransportHook(mockGlobal, (s) => sessions.push(s), {
      onData: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    })

    const url = new URL('https://relay.example.com/moq')
    const _wt = new (mockGlobal.WebTransport as any)(url)
    expect(sessions).toHaveLength(1)
    expect(typeof sessions[0].url).toBe('string')
    expect(sessions[0].url).toBe('https://relay.example.com/moq')
    // A URL instance would throw DataCloneError here, killing session:opened
    expect(() => structuredClone({ url: sessions[0].url })).not.toThrow()
  })

  it('assigns unique session IDs', () => {
    const mockGlobal = createMockGlobal()
    const sessions: InterceptedSession[] = []
    installWebTransportHook(mockGlobal, (s) => sessions.push(s), {
      onData: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    })

    new (mockGlobal.WebTransport as any)('https://relay1.example.com/moq')
    new (mockGlobal.WebTransport as any)('https://relay2.example.com/moq')
    expect(sessions).toHaveLength(2)
    expect(sessions[0].id).not.toBe(sessions[1].id)
  })

  it('records creation timestamp', () => {
    const mockGlobal = createMockGlobal()
    const sessions: InterceptedSession[] = []
    const before = Date.now()
    installWebTransportHook(mockGlobal, (s) => sessions.push(s), {
      onData: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    })

    new (mockGlobal.WebTransport as any)('https://relay.example.com/moq')
    const after = Date.now()
    expect(sessions[0].createdAt).toBeGreaterThanOrEqual(before)
    expect(sessions[0].createdAt).toBeLessThanOrEqual(after)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Negotiated application protocol
// ═══════════════════════════════════════════════════════════════════════

describe('WebTransport hook — negotiated protocol', () => {
  /** A mock whose `protocol` attribute behaves the way the spec says. */
  class ProtocolWebTransport extends MockWebTransport {
    protocol = ''
    constructor(url: string, options?: Record<string, unknown>) {
      super(url, options)
      // Empty until the session is established, then the server's pick.
      this.ready.then(() => {
        this.protocol = 'moqt-20'
      })
    }
  }

  function globalWith(WT: unknown) {
    return { WebTransport: WT } as unknown as typeof globalThis
  }

  const noopInterceptor: StreamInterceptor = {
    onData: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
  }

  it('reads the server’s pick, but only once ready has resolved', async () => {
    const onProtocol = vi.fn()
    const mockGlobal = globalWith(ProtocolWebTransport)
    installWebTransportHook(
      mockGlobal,
      vi.fn(),
      noopInterceptor,
      undefined,
      onProtocol,
    )

    const wt = new (mockGlobal as any).WebTransport('https://relay.test/moq', {
      protocols: ['moqt-20'],
    })
    // Before ready the attribute is the empty string — reporting that as the
    // negotiated protocol would say the server picked nothing.
    expect(onProtocol).not.toHaveBeenCalled()

    await wt.ready
    await Promise.resolve()

    expect(onProtocol).toHaveBeenCalledTimes(1)
    expect(onProtocol.mock.calls[0][1]).toBe('moqt-20')
  })

  it('reports nothing on a browser without protocol negotiation', async () => {
    // MockWebTransport has no `protocol` attribute at all, which is what an
    // implementation predating WT-Available-Protocols looks like.
    const onProtocol = vi.fn()
    const mockGlobal = createMockGlobal()
    installWebTransportHook(
      mockGlobal,
      vi.fn(),
      noopInterceptor,
      undefined,
      onProtocol,
    )

    const wt = new (mockGlobal.WebTransport as any)('https://relay.test/moq')
    await wt.ready
    await Promise.resolve()

    expect(onProtocol).not.toHaveBeenCalled()
  })

  it('does not report a protocol for a session that never opened', async () => {
    const onProtocol = vi.fn()
    const failing = class {
      ready = Promise.reject(new Error('connection failed'))
      closed = new Promise(() => {})
      datagrams = {
        readable: new MockReadableStream(),
        writable: new MockWritableStream(),
      }
      protocol = 'moqt-20'
    }
    const mockGlobal = globalWith(failing)
    installWebTransportHook(
      mockGlobal,
      vi.fn(),
      noopInterceptor,
      undefined,
      onProtocol,
    )

    const wt = new (mockGlobal as any).WebTransport('https://relay.test/moq')
    await wt.ready.catch(() => {})
    await Promise.resolve()

    expect(onProtocol).not.toHaveBeenCalled()
  })

  it('captures the offered protocols as WT-Available-Protocols', () => {
    const sessions: InterceptedSession[] = []
    const mockGlobal = createMockGlobal()
    installWebTransportHook(
      mockGlobal,
      (s) => sessions.push(s),
      noopInterceptor,
    )

    new (mockGlobal.WebTransport as any)('https://relay.test/moq', {
      protocols: ['moqt-19', 'moqt-20'],
    })

    expect(sessions[0].options?.protocols).toEqual(['moqt-19', 'moqt-20'])
  })
})

describe('readNegotiatedProtocol', () => {
  it('reads a non-empty protocol string', () => {
    expect(readNegotiatedProtocol({ protocol: 'moqt-20' })).toBe('moqt-20')
  })

  it('treats the pre-established empty string as no answer', () => {
    expect(readNegotiatedProtocol({ protocol: '' })).toBeUndefined()
  })

  it('answers nothing when the attribute is absent or not a string', () => {
    expect(readNegotiatedProtocol({})).toBeUndefined()
    expect(readNegotiatedProtocol({ protocol: 42 })).toBeUndefined()
    expect(readNegotiatedProtocol(null)).toBeUndefined()
    expect(readNegotiatedProtocol(undefined)).toBeUndefined()
  })

  it('survives a throwing getter on a page-controlled object', () => {
    const hostile = Object.defineProperty({}, 'protocol', {
      get() {
        throw new Error('nope')
      },
    })
    expect(() => readNegotiatedProtocol(hostile)).not.toThrow()
    expect(readNegotiatedProtocol(hostile)).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Transparency
// ═══════════════════════════════════════════════════════════════════════

describe('WebTransport hook — transparency', () => {
  it('intercepted WebTransport still exposes .ready', async () => {
    const mockGlobal = createMockGlobal()
    installWebTransportHook(mockGlobal, vi.fn(), {
      onData: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    })

    const wt = new (mockGlobal.WebTransport as any)(
      'https://relay.example.com/moq',
    )
    expect(wt.ready).toBeInstanceOf(Promise)
  })

  it('intercepted WebTransport still exposes .closed', () => {
    const mockGlobal = createMockGlobal()
    installWebTransportHook(mockGlobal, vi.fn(), {
      onData: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    })

    const wt = new (mockGlobal.WebTransport as any)(
      'https://relay.example.com/moq',
    )
    expect(wt.closed).toBeInstanceOf(Promise)
  })

  it('intercepted WebTransport still exposes .datagrams', () => {
    const mockGlobal = createMockGlobal()
    installWebTransportHook(mockGlobal, vi.fn(), {
      onData: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    })

    const wt = new (mockGlobal.WebTransport as any)(
      'https://relay.example.com/moq',
    )
    expect(wt.datagrams).toBeDefined()
    expect(wt.datagrams.readable).toBeDefined()
    expect(wt.datagrams.writable).toBeDefined()
  })

  it('intercepted WebTransport .close() still works', () => {
    const mockGlobal = createMockGlobal()
    installWebTransportHook(mockGlobal, vi.fn(), {
      onData: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    })

    const wt = new (mockGlobal.WebTransport as any)(
      'https://relay.example.com/moq',
    )
    expect(() => wt.close()).not.toThrow()
  })

  it('intercepted createBidirectionalStream returns a promise', async () => {
    const mockGlobal = createMockGlobal()
    installWebTransportHook(mockGlobal, vi.fn(), {
      onData: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    })

    const wt = new (mockGlobal.WebTransport as any)(
      'https://relay.example.com/moq',
    )
    const stream = await wt.createBidirectionalStream()
    expect(stream).toBeDefined()
    expect(stream.readable).toBeDefined()
    expect(stream.writable).toBeDefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Stream class (bidi/uni) tagging
// ═══════════════════════════════════════════════════════════════════════

describe('WebTransport hook — bidi/uni tagging', () => {
  /** Read the `bidi` argument out of the first onData call. */
  function bidiArg(onData: ReturnType<typeof vi.fn>): unknown {
    expect(onData).toHaveBeenCalled()
    return onData.mock.calls[0][4]
  }

  it('tags writes on a locally-opened bidirectional stream as bidi', async () => {
    const mockGlobal = createMockGlobal()
    const onData = vi.fn()
    installWebTransportHook(mockGlobal, vi.fn(), {
      onData,
      onClose: vi.fn(),
      onError: vi.fn(),
    })

    const wt = new (mockGlobal.WebTransport as any)('https://relay.test/moq')
    const stream = await wt.createBidirectionalStream()
    await stream.writable.getWriter().write(new Uint8Array([0x40, 0x40]))

    expect(bidiArg(onData)).toBe(true)
  })

  it('tags writes on a locally-opened unidirectional stream as uni', async () => {
    const mockGlobal = createMockGlobal()
    const onData = vi.fn()
    installWebTransportHook(mockGlobal, vi.fn(), {
      onData,
      onClose: vi.fn(),
      onError: vi.fn(),
    })

    const wt = new (mockGlobal.WebTransport as any)('https://relay.test/moq')
    const writable = await wt.createUnidirectionalStream()
    await writable.getWriter().write(new Uint8Array([0x04]))

    expect(bidiArg(onData)).toBe(false)
  })

  it('tags reads from incoming streams by the queue they arrived on', async () => {
    // Both incoming queues are tapped from the same mock class, so the flag
    // can only come from which tap wrapped the stream — exactly the property
    // that makes it trustworthy for classifying buffered data.
    const chunk = new Uint8Array([0x41])

    /** A ReadableStream-alike that yields `payload` once, then completes. */
    const onceStream = (payload: unknown) => ({
      getReader: () => ({
        read: vi
          .fn()
          .mockResolvedValueOnce({ done: false, value: payload })
          .mockResolvedValue({ done: true, value: undefined }),
        releaseLock: vi.fn(),
      }),
    })

    for (const [queue, expected] of [
      ['incomingBidirectionalStreams', true],
      ['incomingUnidirectionalStreams', false],
    ] as const) {
      const onData = vi.fn()
      const inner = onceStream(chunk)
      // Bidi arrives as {readable, writable}; uni arrives as a bare readable.
      const arriving = expected ? { readable: inner, writable: null } : inner
      // Built once, not per getter access — the hook patches getReader in
      // place, so a fresh object per access would drop the instrumentation.
      const queues = {
        incomingBidirectionalStreams: new MockReadableStream(),
        incomingUnidirectionalStreams: new MockReadableStream(),
        [queue]: onceStream(arriving),
      }
      const mockGlobal = {
        WebTransport: class extends MockWebTransport {
          get incomingBidirectionalStreams() {
            return queues.incomingBidirectionalStreams as MockReadableStream
          }
          get incomingUnidirectionalStreams() {
            return queues.incomingUnidirectionalStreams as MockReadableStream
          }
        },
      } as unknown as typeof globalThis

      installWebTransportHook(mockGlobal, vi.fn(), {
        onData,
        onClose: vi.fn(),
        onError: vi.fn(),
      })

      const wt = new (mockGlobal as any).WebTransport('https://relay.test/moq')
      const { value } = await wt[queue].getReader().read()
      const readable = expected ? (value as any).readable : value
      await readable.getReader().read()

      expect(bidiArg(onData)).toBe(expected)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Main-thread only (spec D10)
// ═══════════════════════════════════════════════════════════════════════

describe('WebTransport hook — main-thread only (D10)', () => {
  it('does not attempt to patch Worker contexts', () => {
    // The hook should only be installed on the main thread global.
    // If the global doesn't have WebTransport, it should be a no-op or throw.
    const emptyGlobal = {} as typeof globalThis
    const cleanup = installWebTransportHook(emptyGlobal, vi.fn(), {
      onData: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    })
    // Should not crash; cleanup should be safe to call
    expect(() => cleanup()).not.toThrow()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Impairment routing
// ═══════════════════════════════════════════════════════════════════════

describe('WebTransport hook — routing through the moqtap CLI', () => {
  const noStreams: StreamInterceptor = { onData: vi.fn(), onClose: vi.fn(), onError: vi.fn() }
  const CLI_URL = 'https://127.0.0.1:50001/moqtap/u/x'
  const SESSION = 'AQEBAQEBAQEBAQEBAQEBAQ'

  function router(route: WebTransportRouter['route'], extra: Partial<WebTransportRouter> = {}): WebTransportRouter {
    return { route, wait: vi.fn(), failed: vi.fn(), threw: vi.fn(), ...extra }
  }

  function install(r: WebTransportRouter) {
    const g = createMockGlobal()
    const built: { url: string; options?: Record<string, unknown> }[] = []
    class Recording extends MockWebTransport {
      static supportsReliableOnly = true
      constructor(url: string, options?: Record<string, unknown>) {
        super(url, options)
        built.push({ url, options })
      }
    }
    g.WebTransport = Recording
    const sessions: InterceptedSession[] = []
    const closed: [string, string][] = []
    installWebTransportHook(g, (s) => sessions.push(s), noStreams, (id, why) => closed.push([id, why]), undefined, r)
    const WT = g.WebTransport as unknown as new (url: string | URL, o?: unknown) => MockWebTransport
    return { WT, built, sessions, closed, Recording }
  }

  it('connects as the page asked when the router has no route', () => {
    const { WT, built, sessions } = install(router(() => null))
    new WT('https://relay.example/moq', { protocols: ['moqt-16'] })
    expect(built).toEqual([{ url: 'https://relay.example/moq', options: { protocols: ['moqt-16'] } }])
    expect(sessions[0]?.cli).toBeUndefined()
  })

  it('keeps the constructor statics', () => {
    const { WT } = install(router(() => null))
    expect((WT as unknown as { supportsReliableOnly: boolean }).supportsReliableOnly).toBe(true)
  })

  it('opens the CLI route and captures the page URL as the session name', () => {
    const options = { serverCertificateHashes: [] }
    const { WT, built, sessions } = install(router(() => ({ url: CLI_URL, options, session: SESSION })))
    new WT(new URL('https://relay.example/moq'))
    expect(built).toEqual([{ url: CLI_URL, options }])
    expect(sessions[0]).toMatchObject({ url: 'https://relay.example/moq', cli: true, cliSession: SESSION })
  })

  it('throws a refused session at the page and shows it closed with the reason', () => {
    const { WT, built, sessions, closed } = install(router(() => ({ refused: 'no session' })))
    expect(() => new WT('https://relay.example/moq')).toThrow('no session')
    expect(built).toEqual([])
    expect(sessions.map((s) => s.url)).toEqual(['https://relay.example/moq'])
    expect(closed).toEqual([[sessions[0]!.id, 'no session']])
  })

  it('throws a SyntaxError for a URL the real constructor would refuse, capturing nothing', () => {
    const { WT, sessions } = install(router(() => ({ refused: 'bad url', name: 'SyntaxError' })))
    expect(() => new WT('http://relay.example/')).toThrow(expect.objectContaining({ name: 'SyntaxError' }))
    expect(sessions).toEqual([])
  })

  it('reports a routed session that fails to establish', async () => {
    const failed = vi.fn()
    const g = createMockGlobal()
    class Refused extends MockWebTransport {
      constructor(url: string) {
        super(url)
        this.ready = Promise.reject(new Error('blocked'))
        this.ready.catch(() => {})
      }
    }
    g.WebTransport = Refused
    installWebTransportHook(
      g,
      vi.fn(),
      noStreams,
      vi.fn(),
      undefined,
      router(() => ({ url: CLI_URL, options: {} }), { failed }),
    )
    new (g.WebTransport as unknown as new (u: string) => unknown)('https://relay.example/moq')
    await new Promise((r) => setTimeout(r, 0))
    expect(failed).toHaveBeenCalledWith('https://relay.example/moq')
  })

  it('reports a routed constructor that throws, shows the session closed and rethrows', () => {
    const threw = vi.fn()
    const g = createMockGlobal()
    const blocked = new DOMException('Refused to connect', 'SecurityError')
    g.WebTransport = class {
      constructor() {
        throw blocked
      }
    } as unknown as typeof g.WebTransport
    const sessions: InterceptedSession[] = []
    const closed: [string, string][] = []
    installWebTransportHook(
      g,
      (s) => sessions.push(s),
      noStreams,
      (id, r) => closed.push([id, r]),
      undefined,
      router(() => ({ url: CLI_URL, options: {} }), { threw }),
    )
    const WT = g.WebTransport as unknown as new (u: string) => unknown
    expect(() => new WT('https://relay.example/moq')).toThrow(blocked)
    expect(threw).toHaveBeenCalledWith('https://relay.example/moq', blocked)
    expect(sessions.map((s) => s.url)).toEqual(['https://relay.example/moq'])
    expect(closed).toEqual([[sessions[0]!.id, 'Refused to connect']])
  })

  describe('while the frame does not know its answer', () => {
    function deferring() {
      let answer: ReturnType<WebTransportRouter['route']> = 'wait'
      const waiters: (() => void)[] = []
      const r = router(() => answer, { wait: (fn) => void waiters.push(fn) })
      const env = install(r)
      const settle = (now: ReturnType<WebTransportRouter['route']>) => {
        answer = now
        for (const fn of waiters.splice(0)) fn()
      }
      return { ...env, settle }
    }

    it('returns a stand-in at once and connects nothing yet', () => {
      const { WT, built, sessions, Recording } = deferring()
      const wt = new WT('https://relay.example/moq', { protocols: ['moqt-16'] })
      expect(wt instanceof Recording).toBe(true)
      expect(built).toEqual([])
      expect(sessions).toEqual([])
    })

    it('connects through the CLI once the answer routes it', async () => {
      const { WT, built, sessions, settle } = deferring()
      const wt = new WT('https://relay.example/moq', { protocols: ['moqt-16'] }) as unknown as {
        ready: Promise<void>
      }
      settle({ url: CLI_URL, options: { protocols: ['moqt-16'], serverCertificateHashes: [] }, session: SESSION })
      expect(built).toEqual([{ url: CLI_URL, options: { protocols: ['moqt-16'], serverCertificateHashes: [] } }])
      expect(sessions[0]).toMatchObject({ url: 'https://relay.example/moq', cli: true })
      await wt.ready
    })

    it('connects directly once the answer says so, with the options as the page passed them', () => {
      const { WT, built, settle } = deferring()
      const options = { protocols: ['moqt-16'] }
      new WT('https://relay.example/moq', options)
      options.protocols.push('moqt-15')
      settle(null)
      expect(built).toEqual([{ url: 'https://relay.example/moq', options: { protocols: ['moqt-16'] } }])
    })

    it('fails the stand-in with the refusal when the answer refuses it', async () => {
      const { WT, built, settle } = deferring()
      const wt = new WT('https://relay.example/moq') as unknown as { ready: Promise<void>; closed: Promise<unknown> }
      settle({ refused: 'no cli' })
      expect(built).toEqual([])
      expect(await wt.ready.catch((e: DOMException) => [e.name, e.message])).toEqual(['NetworkError', 'no cli'])
      expect(await wt.closed.catch((e: DOMException) => e.name)).toBe('NetworkError')
    })

    it('throws what the real constructor throws for the options, connecting nothing', () => {
      const { WT, built, settle } = deferring()
      expect(() => new WT('https://relay.example/moq', { protocols: 'moqt-16' })).toThrow(TypeError)
      const hash = { algorithm: 'sha-256', value: new Uint8Array(32) }
      expect(() => new WT('https://relay.example/moq', { allowPooling: true, serverCertificateHashes: [hash] })).toThrow(
        expect.objectContaining({ name: 'NotSupportedError' }),
      )
      settle(null)
      expect(built).toEqual([])
    })

    it('connects nothing for a stand-in the page closed while waiting', () => {
      const { WT, built, settle } = deferring()
      const wt = new WT('https://relay.example/moq') as unknown as { close(): void }
      wt.close()
      settle({ url: CLI_URL, options: {} })
      expect(built).toEqual([])
    })

    it('throws what reading the page options throws, as the real constructor does', () => {
      const { WT } = deferring()
      const options = {
        get protocols(): string[] {
          throw new TypeError('getter')
        },
      }
      expect(() => new WT('https://relay.example/moq', options)).toThrow('getter')
    })
  })
})
