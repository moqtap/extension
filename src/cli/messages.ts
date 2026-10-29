/** Messages between the background's CLI bridge and extension pages. */

import type { Preset } from './protocol'

/** Port name the panel and the options page open. */
export const CLI_PORT = 'moqtap-cli'

interface Found {
  readonly identity: string
  readonly fingerprint: string
  readonly port: number
  readonly cliVersion: string
}

export type CliView =
  | { readonly state: 'searching' }
  | { readonly state: 'absent' }
  | { readonly state: 'unsupported' }
  | ({ readonly state: 'confirm' } & Found)
  | ({ readonly state: 'declined' } & Found)
  | ({ readonly state: 'connected' } & Found)

export interface TrustedCli {
  readonly identity: string
  readonly fingerprint: string
  /** ms since epoch */
  readonly at: number
}

/**
 * Why a connection in the tab did not go through the CLI.
 *
 * - `no-session`: the page opened it while no CLI session was ready
 * - `local-network`: the browser refused the page access to 127.0.0.1
 * - `cli-session`: the connection to the CLI failed for another reason
 * - `protocols`: the page offered WebTransport protocols, which the CLI refuses
 * - `blocked-by-page`: the page's CSP does not allow connecting to 127.0.0.1
 * - `opened-early`: the page connected directly before it learned of the profile
 * - `worker-uninstrumented`: a worker runs without the hook, so it connects directly
 */
export type ImpairFailure =
  | 'no-session'
  | 'local-network'
  | 'cli-session'
  | 'protocols'
  | 'blocked-by-page'
  | 'opened-early'
  | 'worker-uninstrumented'

/**
 * Why the tab's sessions cannot be prepared.
 *
 * - `limit`: the CLI holds as many sessions as it allows
 * - `refused`: the CLI refused to open one
 * - `unreachable`: no allowed CLI answers
 */
export type PoolError = 'limit' | 'refused' | 'unreachable'

export interface TabImpairment {
  readonly tabId: number
  readonly preset: Preset
  readonly failure: ImpairFailure | null
  readonly poolError: PoolError | null
}

export type PageCliMsg =
  | { readonly type: 'cli:subscribe' }
  | { readonly type: 'cli:allow'; readonly identity: string }
  | { readonly type: 'cli:decline'; readonly identity: string }
  | { readonly type: 'cli:reconsider' }
  | { readonly type: 'cli:forget'; readonly identity: string }
  | { readonly type: 'cli:watch-tab'; readonly tabId: number }
  | { readonly type: 'cli:set-preset'; readonly tabId: number; readonly preset: Preset }

export type CliStateMsg =
  | {
      readonly type: 'cli:state'
      readonly view: CliView
      readonly trusted: readonly TrustedCli[]
    }
  | { readonly type: 'cli:tab'; readonly tab: TabImpairment }
