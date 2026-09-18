/**
 * The injected worker hook has to reach the page from both kinds of worker.
 *
 * A dedicated Worker talks to its creator through `self.postMessage`. A
 * SharedWorker cannot: `SharedWorkerGlobalScope` has no `postMessage` at all,
 * and its connections are the ports delivered by the `connect` event. The hook
 * called `self.postMessage` unconditionally, so inside a SharedWorker every
 * intercepted event threw a TypeError that `__moqtapSend`'s catch swallowed --
 * it only warns for `DataCloneError` -- and SharedWorker capture produced
 * nothing, silently, with the main thread already listening on `worker.port`
 * for messages that were never sent.
 *
 * These run the real hook source in a fake global scope, so a regression shows
 * up as a message that does not arrive rather than as an absent export.
 *
 * It sits in `__tests__/` rather than beside `content.ts` because every
 * top-level file in `entrypoints/` is an entrypoint to wxt: it globs
 * `*.[jt]s?(x)` there and imports each match to read its options, so a test
 * file in that position is imported by `wxt build`, pulls in vitest outside a
 * vitest run, and fails the build. Nested directories are not globbed.
 */

import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  // `content.ts` calls wxt's auto-imported `defineContentScript` at module
  // scope; vitest does not run wxt's plugin, so stand one in before import.
  ;(globalThis as unknown as Record<string, unknown>).defineContentScript = (c: unknown) => c
})

import { buildWorkerHookSource } from '../content'

// The fake scopes are deliberately loose: the hook is JavaScript in a string
// and is handed whatever global the worker happens to have.
// biome-ignore lint/suspicious/noExplicitAny: see above
type AnyScope = any

function evaluateHook(scope: AnyScope, sharedCtor: unknown): void {
  const src = buildWorkerHookSource()
  new Function('self', 'SharedWorkerGlobalScope', src)(scope, sharedCtor)
}

function fakeDedicated(): AnyScope {
  const scope: AnyScope = {
    postMessage: vi.fn(),
    addEventListener: vi.fn(),
  }
  return scope
}

function fakeShared(): { scope: AnyScope; ctor: unknown; connect: (port: unknown) => void } {
  class SharedWorkerGlobalScope {}
  const listeners: Record<string, ((e: unknown) => void)[]> = {}
  const scope = new SharedWorkerGlobalScope() as AnyScope
  // Deliberately no postMessage — that is the whole point.
  scope.addEventListener = (type: string, fn: (e: unknown) => void) => {
    ;(listeners[type] ??= []).push(fn)
  }
  const connect = (port: unknown) => {
    for (const fn of listeners.connect ?? []) fn({ ports: [port] })
  }
  return { scope, ctor: SharedWorkerGlobalScope, connect }
}

const fakePort = () => ({ postMessage: vi.fn() })

describe('a dedicated worker still posts through self', () => {
  it('routes messages to self.postMessage', () => {
    const scope = fakeDedicated()
    evaluateHook(scope, undefined)
    scope.__moqtapPost({ hello: 'world' })
    expect(scope.postMessage).toHaveBeenCalledTimes(1)
    expect(scope.postMessage.mock.calls[0]?.[0]).toEqual({ hello: 'world' })
  })
})

describe('a shared worker posts through its connected port', () => {
  it('evaluates without throwing in a scope that has no postMessage', () => {
    const { scope, ctor } = fakeShared()
    expect(scope.postMessage).toBeUndefined()
    expect(() => evaluateHook(scope, ctor)).not.toThrow()
    // A shared worker scope has no self.postMessage, so this export is the
    // only thing that can reach a connected port.
    expect(scope.__moqtapPost).toBeTypeOf('function')
  })

  it('delivers a message posted after a connection', () => {
    const { scope, ctor, connect } = fakeShared()
    evaluateHook(scope, ctor)
    const port = fakePort()
    connect(port)
    scope.__moqtapPost({ source: 'moqtap-worker', payload: { type: 'x' } })
    expect(port.postMessage).toHaveBeenCalledTimes(1)
    expect(port.postMessage.mock.calls[0]?.[0]).toEqual({
      source: 'moqtap-worker',
      payload: { type: 'x' },
    })
  })

  it('holds a message posted before any connection, then delivers it', () => {
    const { scope, ctor, connect } = fakeShared()
    evaluateHook(scope, ctor)
    // The heartbeat is posted at script evaluation, before any page can be
    // attached; dropping it makes a working hook look like a failed one.
    scope.__moqtapPost({ source: 'moqtap-hook-ready' })
    const port = fakePort()
    expect(port.postMessage).not.toHaveBeenCalled()
    connect(port)
    expect(port.postMessage).toHaveBeenCalledTimes(1)
    expect(port.postMessage.mock.calls[0]?.[0]).toEqual({ source: 'moqtap-hook-ready' })
  })

  it('does not transfer when more than one page is connected', () => {
    const { scope, ctor, connect } = fakeShared()
    evaluateHook(scope, ctor)
    const a = fakePort()
    const b = fakePort()
    connect(a)
    connect(b)
    const buf = new ArrayBuffer(8)
    scope.__moqtapPost({ data: buf }, [buf])
    // Both get it, and neither call carries a transfer list: transferring to
    // the first would detach the buffer and the second post would throw.
    expect(a.postMessage).toHaveBeenCalledTimes(1)
    expect(b.postMessage).toHaveBeenCalledTimes(1)
    expect(a.postMessage.mock.calls[0]).toHaveLength(1)
    expect(b.postMessage.mock.calls[0]).toHaveLength(1)
  })

  it('delivers a real intercepted session, not just the shim', () => {
    // The strongest form of the test: drive the actual interception path
    // rather than the transport helper. `__moqtapSend` is what every hooked
    // event goes through, and it is inside the IIFE where a test cannot reach
    // it -- so reach it the way the page does, by constructing a WebTransport.
    const { scope, ctor, connect } = fakeShared()
    class FakeWT {
      constructor(public url: string) {}
    }
    scope.WebTransport = FakeWT
    evaluateHook(scope, ctor)
    const port = fakePort()
    connect(port)

    new scope.WebTransport('https://relay.example/moq')

    const opened = port.postMessage.mock.calls
      .map((c) => c[0])
      .find((m: AnyScope) => m?.payload?.type === 'session:opened')
    expect(opened).toBeDefined()
    expect(opened.source).toBe('moqtap-worker')
    expect(opened.payload.url).toBe('https://relay.example/moq')
  })

  it('replays the backlog only to the first connection', () => {
    const { scope, ctor, connect } = fakeShared()
    evaluateHook(scope, ctor)
    scope.__moqtapPost({ n: 1 })
    const first = fakePort()
    const second = fakePort()
    connect(first)
    connect(second)
    expect(first.postMessage).toHaveBeenCalledTimes(1)
    // A page that connects later did not miss anything it was entitled to;
    // replaying to it would duplicate the event in the panel.
    expect(second.postMessage).not.toHaveBeenCalled()
  })
})
