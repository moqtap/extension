import type { CliView, TabError, TabImpairment } from '@/src/cli/messages'
import { isOff, type Refusal } from '@/src/cli/protocol'

export const START_COMMAND = 'moqtap intercept --bridge'

export const PRO_URL = 'https://moqtap.com/pricing/#cli'
/** What the impairment menu's Pro line leads to: custom scenarios, shown */
export const IMPAIRMENT_URL = 'https://moqtap.com/products/network-impairment/'
/** How to get and start the CLI, for a panel that finds none running */
export const GET_CLI_URL = 'https://moqtap.com/getting-started/cli/'

const NOT_RUNNING = `The moqtap CLI isn't running. Start it with ${START_COMMAND}.`

export const DIRECT_NOTICE = "Connections opened before the profile was set aren't impaired."

function notAllowedText(extensionId: string): string {
  const setting = extensionId ? `MOQTAP_BRIDGE_EXTENSION_IDS=${extensionId}` : 'MOQTAP_BRIDGE_EXTENSION_IDS set to this build'
  return `The moqtap CLI doesn't accept this build of the extension. Restart it with ${setting}.`
}

function cliProblem(view: CliView | null): string | null {
  switch (view?.state) {
    case 'connected':
      return null
    case 'not-allowed':
      return notAllowedText(view.extensionId)
    case 'confirm':
    case 'declined':
      return 'Allow the moqtap CLI under Impairment.'
    case 'unsupported':
      return 'This browser cannot verify the moqtap CLI. Update it to use impairment.'
    default:
      return NOT_RUNNING
  }
}

function refusalText(refusal: Refusal | null, name: string | null): string {
  if (refusal?.plan) return `${refusal.plan} plan is required to run this scenario.`
  const what = name === null ? 'this profile' : `"${name}"`
  switch (refusal?.reason) {
    case 'unknown_scenario':
      return `Couldn't apply ${what}: there's no scenario with that name.`
    case 'invalid_scenario':
      return `Couldn't apply ${what}: its scenario file can't run in the browser.`
  }
  return refusal ? `Couldn't apply ${what}. ${refusal.error}` : `Couldn't apply ${what}.`
}

/** Errors a pick ran into: the pick was not taken and the notice can be dismissed. */
const PICK_ERRORS: ReadonlySet<TabError> = new Set(['refused', 'not-allowed', 'protocol'])

/** What a pick ran into, worded. */
function pickText(error: TabError, refusal: Refusal | null, name: string | null): string {
  const what = name === null ? 'this profile' : `"${name}"`
  if (error === 'not-allowed') return notAllowedText('')
  if (error === 'protocol') return `The moqtap CLI can't run ${what}. Update the moqtap CLI, then pick it again.`
  return refusalText(refusal, name)
}

/** Whether the tab's notice is about its last pick, which the user can dismiss. */
export function pickProblem(tab: TabImpairment | null): boolean {
  return tab !== null && tab.error !== null && PICK_ERRORS.has(tab.error)
}

/** The tab's last pick was refused and nothing else is in the way. */
function tabRefused(tab: TabImpairment | null, view: CliView | null): tab is TabImpairment {
  return (
    tab !== null &&
    tab.error === 'refused' &&
    (tab.failure === null || tab.failure === 'no-cli') &&
    cliProblem(view) === null
  )
}

/** Why the tab's connections are not going through the CLI, with what to do; null when nothing is wrong. */
export function impairmentProblem(tab: TabImpairment | null, view: CliView | null): string | null {
  if (tab === null) return null
  // A pick not taken leaves the tab on what was in force before, Off included.
  if (pickProblem(tab) && (tab.failure === null || tab.failure === 'no-cli')) {
    return cliProblem(view) ?? pickText(tab.error!, tab.refusal, tab.refusedName)
  }
  if (isOff(tab.profile)) return null
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
      return refusalText(tab.refusal, null)
    case 'unreachable':
      return NOT_RUNNING
  }
  return `A connection couldn't open because the moqtap CLI wasn't reachable. Check the terminal running ${START_COMMAND}, then reload.`
}

/** Why the CLI did not take the profile picked for one session, with what to do; null when it did. */
export function sessionImpairmentProblem(
  tab: TabImpairment | null,
  session: string,
  view: CliView | null,
): string | null {
  const failed = tab?.sessionErrors.find((e) => e.session === session)
  if (failed === undefined) return null
  const cli = cliProblem(view)
  if (cli !== null) return cli
  return failed.error === 'unreachable'
    ? `The moqtap CLI didn't answer. Check the terminal running ${START_COMMAND}, then pick the profile again.`
    : pickText(failed.error, failed.refusal, null)
}

export interface Upgrade {
  readonly plan: string
  readonly url: string
}

function upgradeFor(refusal: Refusal | null | undefined): Upgrade | null {
  if (!refusal?.plan) return null
  return { plan: refusal.plan, url: refusal.upgrade?.url ?? PRO_URL }
}

/** Where to upgrade to run the profile the CLI refused for the tab, or with `session` for that session. */
export function refusalUpgrade(
  tab: TabImpairment | null,
  view: CliView | null,
  session: string | null = null,
): Upgrade | null {
  if (tab === null || cliProblem(view) !== null) return null
  if (session !== null) return upgradeFor(tab.sessionErrors.find((e) => e.session === session)?.refusal)
  return tabRefused(tab, view) ? upgradeFor(tab.refusal) : null
}

/**
 * What the tab's notice offers: the upgrade for a plan refusal, another pick
 * for any other refusal; null when the problem is not a refusal.
 */
export function refusalAction(tab: TabImpairment | null, view: CliView | null): 'upgrade' | 'choose' | null {
  if (!tabRefused(tab, view)) return null
  return upgradeFor(tab.refusal) ? 'upgrade' : 'choose'
}
