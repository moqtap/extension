import type { CliView, TabImpairment } from '@/src/cli/messages'
import type { Preset } from '@/src/cli/protocol'

export const PRESET_LABELS: Record<Preset, string> = {
  none: 'Off',
  offline: 'Offline',
  '3g': '3G',
  '4g': '4G',
}

export const START_COMMAND = 'moqtap intercept --bridge'

export const PRO_URL = 'https://moqtap.com/pricing/#cli'

const NOT_RUNNING = `The moqtap CLI isn't running. Start it with ${START_COMMAND}, then reload.`

function cliProblem(view: CliView | null): string | null {
  switch (view?.state) {
    case 'connected':
      return null
    case 'confirm':
    case 'declined':
      return 'Allow the moqtap CLI under Impairment, then reload.'
    case 'unsupported':
      return 'This browser cannot verify the moqtap CLI. Update it to use impairment.'
    default:
      return NOT_RUNNING
  }
}

/** Why the tab's connections are not going through the CLI, with what to do; null when nothing is wrong. */
export function impairmentProblem(tab: TabImpairment | null, view: CliView | null): string | null {
  if (tab === null || tab.preset === 'none') return null
  if (tab.failure === 'local-network') return 'Allow this site to access local network devices, then reload.'
  if (tab.failure === 'opened-early') {
    return "A connection opened before the profile reached this page, so it isn't impaired. Reload the page."
  }
  if (tab.failure === 'worker-uninstrumented') {
    return "A worker on this page runs without moqtap, so its connections aren't impaired. Allow blob: in the page's worker-src and remove the site from the worker exclusions, then reload."
  }
  if (tab.failure === 'blocked-by-page') {
    return "This page's Content Security Policy blocks connections to the moqtap CLI. Add https://127.0.0.1:* to its connect-src, then reload."
  }
  if (tab.failure === 'protocols') {
    return "This page offers WebTransport protocols, which the moqtap CLI can't impair. Set Impairment to Off to connect."
  }
  if (tab.failure === 'cli-session') {
    return `A connection couldn't open through the moqtap CLI. Check the terminal running ${START_COMMAND}, then reload.`
  }
  if (tab.failure === null && tab.poolError === null) return null
  const cli = cliProblem(view)
  if (cli !== null) return cli
  switch (tab.poolError) {
    case 'limit':
      return 'The moqtap CLI has as many sessions open as it allows. Close other impaired tabs, then reload.'
    case 'refused':
      return 'The moqtap CLI refused to open a session. Update moqtap, then reload.'
    case 'unreachable':
      return NOT_RUNNING
  }
  return "A connection opened before a moqtap CLI session was ready, so it wasn't opened. Connect again after the page has loaded."
}
