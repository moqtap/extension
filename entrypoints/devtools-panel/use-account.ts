/**
 * The panel's view of the account, over the `moqtap-account` port.
 *
 * The background owns every credential; the panel holds an access token only
 * for the length of one upload. The port is reopened when the
 * background's worker restarts, and the state is re-sent on every reopen.
 */

import { ACCOUNT_PORT } from '@/src/account/config'
import { libraryClient, type LibraryClient } from '@/src/account/library'
import type {
  AccountView,
  BackgroundAccountMsg,
  PanelAccountMsg,
} from '@/src/account/messages'
import { onBeforeUnmount, ref } from 'vue'

export class AccountTokenError extends Error {
  constructor(readonly reason: 'signed-out' | 'unreachable') {
    super(
      reason === 'signed-out'
        ? 'Sign in to share traces.'
        : "moqtap couldn't be reached. You're still signed in. Try again in a moment.",
    )
    this.name = 'AccountTokenError'
  }
}

export function useAccount() {
  const view = ref<AccountView | null>(null)
  let port: Browser.runtime.Port | null = null
  let closed = false
  let nextRequestId = 1
  const waiting = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>()

  function connect() {
    if (closed) return
    port = browser.runtime.connect({ name: ACCOUNT_PORT })
    port.onMessage.addListener((raw: unknown) => {
      const msg = raw as BackgroundAccountMsg
      if (msg.type === 'account:state') view.value = msg.view
      else if (msg.type === 'account:token') {
        const w = waiting.get(msg.requestId)
        if (w === undefined) return
        waiting.delete(msg.requestId)
        if (msg.token !== null) w.resolve(msg.token)
        else w.reject(new AccountTokenError(msg.error ?? 'unreachable'))
      }
    })
    port.onDisconnect.addListener(() => {
      port = null
      for (const w of waiting.values()) w.reject(new AccountTokenError('unreachable'))
      waiting.clear()
      setTimeout(connect, 250)
    })
    send({ type: 'account:subscribe' })
  }

  function send(msg: PanelAccountMsg) {
    try {
      port?.postMessage(msg)
    } catch {
      // Reconnecting.
    }
  }

  function token(force: boolean): Promise<string> {
    return new Promise((resolve, reject) => {
      if (port === null) {
        reject(new AccountTokenError('unreachable'))
        return
      }
      const requestId = nextRequestId++
      waiting.set(requestId, { resolve, reject })
      send({ type: 'account:get-token', requestId, force })
    })
  }

  connect()
  onBeforeUnmount(() => {
    closed = true
    port?.disconnect()
  })

  const library: LibraryClient = libraryClient(token)

  return {
    view,
    library,
    signIn: () => send({ type: 'account:sign-in' }),
    disconnect: () => send({ type: 'account:disconnect' }),
    refreshOrgs: () => send({ type: 'account:refresh-orgs' }),
  }
}
