import type { CliView, TabImpairment } from '@/src/cli/messages'
import { isOff } from '@/src/cli/protocol'

export const START_COMMAND = 'moqtap intercept --bridge'

export const PRO_URL = 'https://moqtap.com/pricing/#cli'

const NOT_RUNNING = `The moqtap CLI isn't running. Start it with ${START_COMMAND}.`

export const DIRECT_NOTICE = "Connections opened before the profile was set aren't impaired."

function cliProblem(view: CliView | null): string | null {
  switch (view?.state) {
    case 'connected':
      return null
    case 'confirm':
    case 'declined':
      return 'Allow the moqtap CLI under Impairment.'
    case 'unsupported':
      return 'This browser cannot verify the moqtap CLI. Update it to use impairment.'
    default:
      return NOT_RUNNING
  }
}

/** Why the tab's connections are not going through the CLI, with what to do; null when nothing is wrong. */
export function impairmentProblem(tab: TabImpairment | null, view: CliView | null): string | null {
  if (tab === null || isOff(tab.profile)) return null
  switch (tab.failure) {
    case 'local-network':
      return 'Allow this site to access local network devices, then reload.'
    case 'worker-uninstrumented':
      return "A worker on this page runs without moqtap, so its connections aren't impaired. Allow blob: in the page's worker-src and remove the site from the worker exclusions, then reload."
    case 'blocked-by-page':
      return "This page's Content Security Policy blocks connections to the moqtap CLI. Add https://127.0.0.1:* to its connect-src, then reload."
    case 'cli-session':
      return `A connection couldn't open through the moqtap CLI. Check the terminal running ${START_COMMAND}, then reload.`
    case 'no-answer':
      return "The page didn't hear this tab's profile in time, so its connections weren't opened. Reload the page."
  }
  if (tab.failure === null && tab.error === null) return null
  if (tab.error === 'flag') {
    return "The browser didn't let moqtap hold new pages until this tab's profile is known, so they may connect directly. Restart the browser, then pick the profile again."
  }
  const cli = cliProblem(view)
  if (cli !== null) return cli
  switch (tab.error) {
    case 'limit':
      return 'The moqtap CLI has as many tabs impaired as it allows. Set other tabs to Off or close them.'
    case 'refused':
      return 'The moqtap CLI refused this profile. Update moqtap, then pick the profile again.'
    case 'unreachable':
      return NOT_RUNNING
  }
  return `A connection couldn't open because the moqtap CLI wasn't reachable. Check the terminal running ${START_COMMAND}, then reload.`
}
