/**
 * Messages that move a tab's impaired CLI sessions between the background
 * and the page hook. The bridge content script relays them unchanged.
 */

import type { ImpairFailure } from '@/src/cli/messages'

/** An idle CLI session listener, ready for one connection. */
export interface PoolEntry {
  readonly id: string
  readonly port: number
  /** Goes first in the CONNECT path; the CLI refuses a connection without it. */
  readonly secret: string
}

/** Background → page: everything the frame needs, replacing what it had. */
export interface PoolMsg {
  readonly type: 'impair:pool'
  /** The tab has a profile, so every new session goes through the CLI. */
  readonly on: boolean
  /** base64url SHA-256 of the CLI's certificate, null when no CLI is in use. */
  readonly certHash: string | null
  readonly entries: readonly PoolEntry[]
  /** How many idle sessions the background keeps for this frame. */
  readonly want: number
}

/** Page → background. */
export type ImpairPageMsg =
  | { readonly type: 'impair:took'; readonly id: string }
  | { readonly type: 'impair:release'; readonly id: string }
  | { readonly type: 'impair:want'; readonly count: number }
  | { readonly type: 'impair:failed'; readonly failure: ImpairFailure; readonly url: string }

/** Main world → worker hook. */
export interface WorkerImpairMsg {
  readonly source: 'moqtap-impair-worker'
  readonly on: boolean
  /** False until the frame has heard from the background. */
  readonly known: boolean
  readonly certHash: string | null
  readonly entry: PoolEntry | null
}

const FAILURES: readonly string[] = [
  'no-session',
  'local-network',
  'cli-session',
  'protocols',
  'blocked-by-page',
  'opened-early',
  'worker-uninstrumented',
]

const isEntry = (v: unknown): v is PoolEntry =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as PoolEntry).id === 'string' &&
  typeof (v as PoolEntry).secret === 'string' &&
  /^[A-Za-z0-9_-]{22}$/.test((v as PoolEntry).secret) &&
  Number.isInteger((v as PoolEntry).port) &&
  (v as PoolEntry).port > 0 &&
  (v as PoolEntry).port <= 0xffff

export function isPoolMsg(v: unknown): v is PoolMsg {
  if (typeof v !== 'object' || v === null) return false
  const m = v as Record<string, unknown>
  return (
    m.type === 'impair:pool' &&
    typeof m.on === 'boolean' &&
    (m.certHash === null || typeof m.certHash === 'string') &&
    Array.isArray(m.entries) &&
    m.entries.every(isEntry) &&
    Number.isInteger(m.want)
  )
}

export function isImpairPageMsg(v: unknown): v is ImpairPageMsg {
  if (typeof v !== 'object' || v === null) return false
  const m = v as Record<string, unknown>
  switch (m.type) {
    case 'impair:took':
    case 'impair:release':
      return typeof m.id === 'string'
    case 'impair:want':
      return Number.isInteger(m.count)
    case 'impair:failed':
      return typeof m.failure === 'string' && FAILURES.includes(m.failure) && typeof m.url === 'string'
    default:
      return false
  }
}
