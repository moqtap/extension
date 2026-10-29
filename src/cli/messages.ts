/** Messages between the background's CLI bridge and extension pages. */

import type { CliStatus, Link } from './protocol'

/** Port name the panel and the options page open. */
export const CLI_PORT = 'moqtap-cli'

/**
 * - `scenario`: the run plays a scenario, so the link is fixed
 * - `refused`: the CLI answered the change with an error
 * - `unreachable`: the CLI stopped answering
 */
export type CliError = 'scenario' | 'refused' | 'unreachable'

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
  | ({
      readonly state: 'connected'
      readonly status: CliStatus | null
      readonly error: CliError | null
    } & Found)

export interface TrustedCli {
  readonly identity: string
  readonly fingerprint: string
  /** ms since epoch */
  readonly at: number
}

export type PageCliMsg =
  | { readonly type: 'cli:subscribe' }
  | { readonly type: 'cli:allow'; readonly identity: string }
  | { readonly type: 'cli:decline'; readonly identity: string }
  | { readonly type: 'cli:reconsider' }
  | { readonly type: 'cli:set-link'; readonly link: Link }
  | { readonly type: 'cli:forget'; readonly identity: string }

export interface CliStateMsg {
  readonly type: 'cli:state'
  readonly view: CliView
  readonly trusted: readonly TrustedCli[]
}
