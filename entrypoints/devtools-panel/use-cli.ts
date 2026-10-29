/**
 * The moqtap CLI bridge as an extension page sees it, over the `moqtap-cli`
 * port. Reopened when the background's worker restarts.
 */

import { CLI_PORT, type CliStateMsg, type CliView, type PageCliMsg, type TrustedCli } from '@/src/cli/messages'
import { isLink, type Link } from '@/src/cli/protocol'
import { onBeforeUnmount, ref } from 'vue'

export function useCli() {
  const view = ref<CliView | null>(null)
  const trusted = ref<readonly TrustedCli[]>([])
  let port: Browser.runtime.Port | null = null
  let closed = false

  function connect() {
    if (closed) return
    port = browser.runtime.connect({ name: CLI_PORT })
    port.onMessage.addListener((raw: unknown) => {
      const msg = raw as CliStateMsg
      if (msg.type !== 'cli:state') return
      view.value = msg.view
      trusted.value = msg.trusted
    })
    port.onDisconnect.addListener(() => {
      port = null
      setTimeout(connect, 250)
    })
    send({ type: 'cli:subscribe' })
  }

  function send(msg: PageCliMsg) {
    try {
      port?.postMessage(msg)
    } catch {
      // Reconnecting.
    }
  }

  connect()
  onBeforeUnmount(() => {
    closed = true
    port?.disconnect()
  })

  return {
    view,
    trusted,
    allow: (identity: string) => send({ type: 'cli:allow', identity }),
    decline: (identity: string) => send({ type: 'cli:decline', identity }),
    reconsider: () => send({ type: 'cli:reconsider' }),
    setLink: (link: Link) => {
      if (isLink(link)) send({ type: 'cli:set-link', link })
    },
    forget: (identity: string) => send({ type: 'cli:forget', identity }),
  }
}
