/**
 * Messages that carry a tab's CLI route between the background and the page
 * hook. The bridge content script relays them unchanged.
 */

import { IMPAIR_FAILURES, type ImpairFailure } from '@/src/cli/messages'

/** Where the tab's sessions connect at the CLI. */
export interface TabRoute {
  readonly port: number
  /** The tab's token; the CLI refuses a session without it. */
  readonly token: string
  /** base64url SHA-256 of the certificate the tab port serves. */
  readonly certHash: string
}

/** The tab's answer: whether new sessions go through the CLI, and where. */
export interface TabAnswer {
  readonly on: boolean
  /** Null while the tab has a profile but no CLI tab port. */
  readonly route: TabRoute | null
}

/** Background → page, whenever the tab's answer changes and when a frame connects. */
export interface TabAnswerMsg {
  readonly type: 'impair:tab'
  readonly answer: TabAnswer
}

/**
 * What the hook decides by.
 *
 * - `any`: some tab had a profile when this document started
 * - `answer`: null until the frame hears its tab's answer, `unanswered` once
 *   the wait for it ran out
 */
export interface RouteState {
  readonly any: boolean
  readonly answer: TabAnswer | 'unanswered' | null
}

/** Page → background. */
export type ImpairPageMsg = {
  readonly type: 'impair:failed'
  readonly failure: ImpairFailure
  readonly url: string
}

/** Main world → worker hook. */
export interface WorkerImpairMsg extends RouteState {
  readonly source: 'moqtap-impair-worker'
}

const isRoute = (v: unknown): v is TabRoute => {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    Number.isInteger(r.port) &&
    (r.port as number) > 0 &&
    (r.port as number) <= 0xffff &&
    typeof r.token === 'string' &&
    /^[A-Za-z0-9_-]{22}$/.test(r.token) &&
    typeof r.certHash === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(r.certHash)
  )
}

export function isTabAnswer(v: unknown): v is TabAnswer {
  if (typeof v !== 'object' || v === null) return false
  const a = v as Record<string, unknown>
  return typeof a.on === 'boolean' && (a.route === null || isRoute(a.route))
}

export function isTabAnswerMsg(v: unknown): v is TabAnswerMsg {
  return typeof v === 'object' && v !== null && (v as TabAnswerMsg).type === 'impair:tab' && isTabAnswer((v as TabAnswerMsg).answer)
}

export function isImpairPageMsg(v: unknown): v is ImpairPageMsg {
  if (typeof v !== 'object' || v === null) return false
  const m = v as Record<string, unknown>
  return (
    m.type === 'impair:failed' &&
    typeof m.failure === 'string' &&
    (IMPAIR_FAILURES as readonly string[]).includes(m.failure) &&
    typeof m.url === 'string'
  )
}
