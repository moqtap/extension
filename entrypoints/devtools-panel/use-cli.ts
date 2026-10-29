/**
 * The moqtap CLI bridge as an extension page sees it, over the `moqtap-cli`
 * port, and the impairment of `tabId` when given. Reopened when the
 * background's worker restarts.
 */

import {
  CLI_PORT,
  type CliStateMsg,
  type CliView,
  type PageCliMsg,
  type TabImpairment,
  type TrustedCli,
} from '@/src/cli/messages'
import { isPreset, type Preset } from '@/src/cli/protocol'
import { onBeforeUnmount, ref } from 'vue'

export function useCli(tabId?: number) {
  const view = ref<CliView | null>(null)
  const trusted = ref<readonly TrustedCli[]>([])
  const tab = ref<TabImpairment | null>(null)
  let port: Browser.runtime.Port | null = null
  let closed = false

  function connect() {
    if (closed) return
    port = browser.runtime.connect({ name: CLI_PORT })
    port.onMessage.addListener((raw: unknown) => {
      const msg = raw as CliStateMsg
      if (msg.type === 'cli:state') {
        view.value = msg.view
        trusted.value = msg.trusted
      } else if (msg.type === 'cli:tab' && msg.tab.tabId === tabId) {
        tab.value = msg.tab
      }
    })
    port.onDisconnect.addListener(() => {
      port = null
      setTimeout(connect, 250)
    })
    send({ type: 'cli:subscribe' })
    if (tabId !== undefined) send({ type: 'cli:watch-tab', tabId })
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
    tab,
    allow: (identity: string) => send({ type: 'cli:allow', identity }),
    decline: (identity: string) => send({ type: 'cli:decline', identity }),
    reconsider: () => send({ type: 'cli:reconsider' }),
    forget: (identity: string) => send({ type: 'cli:forget', identity }),
    setPreset: (preset: Preset) => {
      if (tabId !== undefined && isPreset(preset)) send({ type: 'cli:set-preset', tabId, preset })
    },
  }
}
