/**
 * Wires {@link AccountService} into the background's browser events.
 *
 * Two doors, each with its own gate:
 *
 * - **`runtime.onMessage`** takes only {@link BridgeAccountMsg} from the
 *   bridge, and answers nothing: a content script is never sent a token or
 *   any account state through it.
 * - **the `moqtap-account` port** serves state and access tokens, and only to
 *   an extension page (the DevTools panel). A port from anything else, a
 *   content script included, is disconnected before a message is read.
 */

import { ACCOUNT_PORT } from './config'
import type {
  AccountTokenReply,
  BackgroundAccountMsg,
  BridgeAccountMsg,
  PanelAccountMsg,
} from './messages'
import { AccountService, type SenderLike, SignedOutError } from './service'

export interface PortLike {
  readonly name: string
  readonly sender?: SenderLike
  postMessage(msg: BackgroundAccountMsg): void
  disconnect(): void
  readonly onMessage: { addListener(fn: (msg: unknown) => void): void }
  readonly onDisconnect: { addListener(fn: () => void): void }
}

/** `runtime.getURL('')`, e.g. `chrome-extension://<id>/`. */
export function isExtensionPage(sender: SenderLike | undefined, extensionBase: string): boolean {
  const url = sender?.url
  return typeof url === 'string' && url.startsWith(extensionBase)
}

export const isBridgeAccountMsg = (m: unknown): m is BridgeAccountMsg =>
  typeof m === 'object' &&
  m !== null &&
  (m as { kind?: unknown }).kind === 'moqtap-account' &&
  typeof (m as { message?: unknown }).message === 'object'

/**
 * Serves one panel port. Returns false (and disconnects) for a port that is
 * not an extension page's.
 */
export function servePanelPort(
  account: AccountService,
  port: PortLike,
  extensionBase: string,
): boolean {
  if (!isExtensionPage(port.sender, extensionBase)) {
    port.disconnect()
    return false
  }
  const send = (msg: BackgroundAccountMsg) => {
    try {
      port.postMessage(msg)
    } catch {
      // The panel closed.
    }
  }
  let unsubscribe: (() => void) | null = null
  port.onDisconnect.addListener(() => unsubscribe?.())
  port.onMessage.addListener((raw) => {
    const msg = raw as PanelAccountMsg
    switch (msg?.type) {
      case 'account:subscribe':
        unsubscribe ??= account.onChange((view) => send({ type: 'account:state', view }))
        void account.view().then((view) => send({ type: 'account:state', view }))
        break
      case 'account:sign-in':
        void account.beginSignIn(false).catch((err: unknown) => {
          console.warn('[moqtap account] sign-in did not start', err)
        })
        break
      case 'account:disconnect':
        void account.disconnect()
        break
      case 'account:refresh-orgs':
        void account.refreshOrgs().catch(() => {})
        break
      case 'account:get-token': {
        const requestId = msg.requestId
        account
          .accessToken({ force: msg.force === true })
          .then(
            (token): AccountTokenReply => ({ type: 'account:token', requestId, token, error: null }),
            (err: unknown): AccountTokenReply => ({
              type: 'account:token',
              requestId,
              token: null,
              error: err instanceof SignedOutError ? 'signed-out' : 'unreachable',
            }),
          )
          .then(send)
        break
      }
    }
  })
  return true
}

interface BrowserLike {
  runtime: {
    id: string
    getURL(path: string): string
    onMessage: {
      addListener(fn: (msg: unknown, sender: SenderLike) => undefined): void
    }
    onConnect: { addListener(fn: (port: PortLike) => void): void }
  }
  tabs: {
    onRemoved: { addListener(fn: (tabId: number) => void): void }
  }
}

export function installAccount(account: AccountService, b: BrowserLike): void {
  const extensionBase = b.runtime.getURL('/')
  b.runtime.onMessage.addListener((msg, sender) => {
    if (isBridgeAccountMsg(msg)) {
      void account.handleBridge(msg, sender).catch((err: unknown) => {
        console.warn('[moqtap account] bridge message failed', err)
      })
    }
    // No response, ever: the sender may be a content script.
    return undefined
  })
  b.runtime.onConnect.addListener((port) => {
    if (port.name === ACCOUNT_PORT) servePanelPort(account, port, extensionBase)
  })
  b.tabs.onRemoved.addListener((tabId) => {
    void account.forgetTab(tabId).catch(() => {})
  })
}
