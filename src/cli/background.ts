/**
 * Serves the `moqtap-cli` port to extension pages (the DevTools panel and the
 * options page). A port from anything else is disconnected unread.
 */

import { isExtensionPage, type PortLike } from '@/src/account/background'
import type { ImpairManager } from '@/src/impair/manager'
import type { CliStateMsg, PageCliMsg } from './messages'
import { isProfile } from './protocol'
import type { CliBridge } from './service'

export interface CliPortLike extends Omit<PortLike, 'postMessage'> {
  postMessage(msg: CliStateMsg): void
}

const REFRESH_MS = 2000

const isTabId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const isName = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64

export function serveCliPort(
  bridge: CliBridge,
  impair: ImpairManager,
  port: CliPortLike,
  extensionBase: string,
): boolean {
  if (!isExtensionPage(port.sender, extensionBase)) {
    port.disconnect()
    return false
  }

  const send = (msg: CliStateMsg) => {
    try {
      port.postMessage(msg)
    } catch {
      // The page closed.
    }
  }
  let unsubscribe: (() => void) | null = null
  let unwatch: (() => void) | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  port.onDisconnect.addListener(() => {
    unsubscribe?.()
    unwatch?.()
    if (timer !== null) clearInterval(timer)
  })

  const fail = (err: unknown) => console.warn('[moqtap cli]', err)

  port.onMessage.addListener((raw) => {
    const msg = raw as PageCliMsg
    switch (msg?.type) {
      case 'cli:subscribe':
        if (unsubscribe !== null) break
        unsubscribe = bridge.onChange((view, trusted) => send({ type: 'cli:state', view, trusted }))
        void bridge.trusted().then((trusted) => send({ type: 'cli:state', view: bridge.view(), trusted }))
        void bridge.refresh().catch(fail)
        timer = setInterval(() => void bridge.refresh().catch(fail), REFRESH_MS)
        break
      case 'cli:allow':
        if (typeof msg.identity === 'string') void bridge.allow(msg.identity).catch(fail)
        break
      case 'cli:decline':
        if (typeof msg.identity === 'string') bridge.decline(msg.identity)
        break
      case 'cli:reconsider':
        bridge.reconsider()
        break
      case 'cli:forget':
        if (typeof msg.identity === 'string') void bridge.forget(msg.identity).catch(fail)
        break
      case 'cli:watch-tab': {
        if (!isTabId(msg.tabId) || unwatch !== null) break
        const tabId = msg.tabId
        unwatch = impair.onTab((tab) => {
          if (tab.tabId === tabId) send({ type: 'cli:tab', tab })
        })
        void impair.ready.then(() => send({ type: 'cli:tab', tab: impair.view(tabId) }))
        break
      }
      case 'cli:set-profile':
        if (isTabId(msg.tabId) && isProfile(msg.profile) && isName(msg.name)) {
          void impair.setProfile(msg.tabId, msg.profile, msg.name).catch(fail)
        }
        break
      case 'cli:profiles':
        void bridge
          .profiles()
          .catch(() => null)
          .then((profiles) => send({ type: 'cli:profiles', profiles }))
        break
    }
  })
  return true
}
