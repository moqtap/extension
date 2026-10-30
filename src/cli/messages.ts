/** Messages between the background's CLI bridge and extension pages. */

import type { Profile, Profiles, Refusal } from './protocol'

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
  /** The CLI does not take requests from this build: it must list `extensionId`. */
  | ({ readonly state: 'not-allowed'; readonly extensionId: string } & Found)

export interface TrustedCli {
  readonly identity: string
  readonly fingerprint: string
  /** ms since epoch */
  readonly at: number
}

/**
 * Why a connection in the tab did not go through the CLI.
 *
 * - `no-cli`: the tab has a profile but no CLI tab port, so the connection was refused
 * - `no-answer`: the frame never heard its tab's profile, so the connection was refused
 * - `local-network`: the browser refused the page access to 127.0.0.1
 * - `cli-session`: the connection to the CLI failed for another reason
 * - `blocked-by-page`: the page's CSP does not allow connecting to 127.0.0.1
 * - `worker-uninstrumented`: a worker runs without the hook, so it connects directly
 */
export type ImpairFailure =
  | 'no-cli'
  | 'no-answer'
  | 'local-network'
  | 'cli-session'
  | 'blocked-by-page'
  | 'worker-uninstrumented'

export const IMPAIR_FAILURES: readonly ImpairFailure[] = [
  'no-cli',
  'no-answer',
  'local-network',
  'cli-session',
  'blocked-by-page',
  'worker-uninstrumented',
]

/**
 * Why the tab's sessions may not go through the CLI.
 *
 * - `limit`: the CLI holds as many tabs as it allows
 * - `refused`: the CLI refused to open one
 * - `unreachable`: no allowed CLI answers
 * - `flag`: the browser refused the script that makes new documents wait for
 *   the tab's profile, so they may connect directly
 */
export type TabError = 'limit' | 'refused' | 'not-allowed' | 'protocol' | 'unreachable' | 'flag'

/** A session in the tab with its own profile at the CLI. */
export interface SessionImpairment {
  /** Its id at the CLI. */
  readonly session: string
  readonly profile: Profile
  readonly name: string
}

/** Why the CLI did not take a session's profile: as {@link TabError}. */
export type SessionError = 'refused' | 'not-allowed' | 'protocol' | 'unreachable'

export interface SessionFailure {
  readonly session: string
  readonly error: SessionError
  /** What the CLI said, for `refused`. */
  readonly refusal: Refusal | null
}

export interface TabImpairment {
  readonly tabId: number
  readonly profile: Profile
  /** What the panel calls the profile. */
  readonly name: string
  /** Sessions with their own profile; the rest have the tab's. */
  readonly sessions: readonly SessionImpairment[]
  /** Sessions the CLI lists with a profile that is neither the tab's nor one picked for them. */
  readonly unknown: readonly string[]
  /** Sessions whose last profile change the CLI did not take. */
  readonly sessionErrors: readonly SessionFailure[]
  readonly failure: ImpairFailure | null
  readonly error: TabError | null
  /** What the CLI said, for `refused`. */
  readonly refusal: Refusal | null
  /** The name of the pick the CLI refused, for `refused`; `profile` stays what is in force. */
  readonly refusedName: string | null
}

export type PageCliMsg =
  | { readonly type: 'cli:subscribe' }
  | { readonly type: 'cli:allow'; readonly identity: string }
  | { readonly type: 'cli:decline'; readonly identity: string }
  | { readonly type: 'cli:reconsider' }
  | { readonly type: 'cli:forget'; readonly identity: string }
  | { readonly type: 'cli:watch-tab'; readonly tabId: number }
  | { readonly type: 'cli:set-profile'; readonly tabId: number; readonly profile: Profile; readonly name: string }
  | { readonly type: 'cli:clear-error'; readonly tabId: number }
  /** `profile` and `name` null: the session takes the tab's profile again. */
  | {
      readonly type: 'cli:set-session-profile'
      readonly tabId: number
      readonly session: string
      readonly profile: Profile | null
      readonly name: string | null
    }
  | { readonly type: 'cli:profiles' }

export type CliStateMsg =
  | {
      readonly type: 'cli:state'
      readonly view: CliView
      readonly trusted: readonly TrustedCli[]
    }
  | { readonly type: 'cli:tab'; readonly tab: TabImpairment }
  /** The answer to `cli:profiles`; null when the CLI did not answer. */
  | { readonly type: 'cli:profiles'; readonly profiles: Profiles | null }
