/**
 * The background's two account doors: the bridge's one-shot message, which
 * is never answered, and the panel's port, which only an extension page may
 * open. Together they are why a token never reaches a content script or the page.
 */

import { describe, expect, it } from 'vitest'
import { installAccount, type PortLike, servePanelPort } from './background'
import type { BackgroundAccountMsg, PanelAccountMsg } from './messages'
import type { SenderLike } from './service'
import { APP, appSender, callbackMsg, EXT_ID, hintMsg, signIn, World } from './test-fakes'

const EXT_BASE = `chrome-extension://${EXT_ID}/`

class FakePort implements PortLike {
  readonly sent: BackgroundAccountMsg[] = []
  disconnected = false
  private readonly onMsg: ((m: unknown) => void)[] = []
  private readonly onDisc: (() => void)[] = []
  constructor(
    readonly name: string,
    readonly sender: SenderLike,
  ) {}
  postMessage(msg: BackgroundAccountMsg) {
    // What crosses a real port is a structured clone.
    this.sent.push(structuredClone(msg))
  }
  disconnect() {
    this.disconnected = true
  }
  readonly onMessage = { addListener: (fn: (m: unknown) => void) => void this.onMsg.push(fn) }
  readonly onDisconnect = { addListener: (fn: () => void) => void this.onDisc.push(fn) }
  deliver(msg: PanelAccountMsg) {
    for (const fn of this.onMsg) fn(msg)
  }
  close() {
    for (const fn of this.onDisc) fn()
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

const panelSender: SenderLike = { id: EXT_ID, url: `${EXT_BASE}devtools-panel.html` }
const contentScriptSender = (url: string): SenderLike => ({ id: EXT_ID, url, frameId: 0, tab: { id: 9 } })

function harness() {
  const w = new World()
  const svc = w.service()
  let onMessage!: (msg: unknown, sender: SenderLike) => undefined
  let onConnect!: (port: PortLike) => void
  installAccount(svc, {
    runtime: {
      id: EXT_ID,
      getURL: (p) => `chrome-extension://${EXT_ID}${p}`,
      onMessage: { addListener: (fn) => void (onMessage = fn) },
      onConnect: { addListener: (fn) => void (onConnect = fn) },
    },
    tabs: { onRemoved: { addListener: () => {} } },
  })
  return { w, svc, onMessage: (m: unknown, s: SenderLike) => onMessage(m, s), onConnect: (p: PortLike) => onConnect(p) }
}

describe('the panel port', () => {
  it('hands an access token to the DevTools panel', async () => {
    const h = harness()
    await signIn(h.w, h.svc)
    const port = new FakePort('moqtap-account', panelSender)
    h.onConnect(port)
    port.deliver({ type: 'account:get-token', requestId: 1, force: false })
    await settle()
    expect(port.disconnected).toBe(false)
    expect(port.sent).toContainEqual({ type: 'account:token', requestId: 1, token: 'mqt_at_access1', error: null })
  })

  for (const url of [`${APP}/ext/cb`, 'https://evil.example/', 'chrome-extension://another-extension/panel.html']) {
    it(`is closed, unread, for a content script or page at ${url}`, async () => {
      const h = harness()
      await signIn(h.w, h.svc)
      const port = new FakePort('moqtap-account', contentScriptSender(url))
      h.onConnect(port)
      port.deliver({ type: 'account:get-token', requestId: 1, force: false })
      port.deliver({ type: 'account:subscribe' })
      await settle()
      expect(port.disconnected).toBe(true)
      expect(port.sent).toEqual([])
    })
  }

  it('reports signed-out or unreachable instead of a token, and never sends the refresh token', async () => {
    const h = harness()
    const port = new FakePort('moqtap-account', panelSender)
    h.onConnect(port)
    port.deliver({ type: 'account:subscribe' })
    port.deliver({ type: 'account:get-token', requestId: 1, force: false })
    await settle()
    expect(port.sent).toContainEqual({ type: 'account:token', requestId: 1, token: null, error: 'signed-out' })
    await signIn(h.w, h.svc)
    h.w.net.token = () => Promise.reject(new TypeError('offline'))
    port.deliver({ type: 'account:get-token', requestId: 2, force: true })
    await settle()
    expect(port.sent).toContainEqual({ type: 'account:token', requestId: 2, token: null, error: 'unreachable' })
    expect(JSON.stringify(port.sent)).not.toContain('mqt_rt_')
  })

  it('pushes state changes to a subscribed panel until it disconnects', async () => {
    const h = harness()
    const port = new FakePort('moqtap-account', panelSender)
    h.onConnect(port)
    port.deliver({ type: 'account:subscribe' })
    await settle()
    expect(port.sent.at(-1)).toEqual({
      type: 'account:state',
      view: { status: 'signed-out', signingIn: false, notice: null },
    })
    await signIn(h.w, h.svc)
    expect(port.sent.at(-1)).toMatchObject({ type: 'account:state', view: { status: 'signed-in', handle: 'alice' } })
    port.close()
    const count = port.sent.length
    await h.svc.disconnect()
    expect(port.sent).toHaveLength(count)
  })

  it('servePanelPort refuses a sender that is not an extension page', () => {
    const svc = new World().service()
    const port = new FakePort('moqtap-account', contentScriptSender(`${APP}/`))
    expect(servePanelPort(svc, port, EXT_BASE)).toBe(false)
  })
})

describe('the bridge message', () => {
  it('is never answered, so a content script receives nothing back', async () => {
    const h = harness()
    await h.svc.beginSignIn(false)
    const state = h.w.lastAuthorize().get('state')
    const answer = h.onMessage(callbackMsg(state), appSender(h.w.opened[0]!.id))
    expect(answer).toBeUndefined()
    await settle()
    await settle()
    expect((await h.svc.view()).status).toBe('signed-in')
    expect(h.onMessage(hintMsg('signed-in'), appSender(1, `${APP}/`))).toBeUndefined()
    expect(h.onMessage({ type: 'anything-else' }, appSender(1))).toBeUndefined()
  })

  it('from a content script on another origin changes nothing', async () => {
    const h = harness()
    await h.svc.beginSignIn(false)
    const state = h.w.lastAuthorize().get('state')
    h.onMessage(callbackMsg(state), contentScriptSender('https://evil.example/'))
    h.onMessage(hintMsg('signed-out'), contentScriptSender('https://evil.example/'))
    await settle()
    expect(h.w.net.calls).toHaveLength(0)
  })
})
