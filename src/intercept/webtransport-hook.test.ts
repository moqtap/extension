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
  uninstallWebTransportHook,
} from './webtransport-hook'
import type { InterceptedSession, StreamInterceptor } from './webtransport-hook'

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
