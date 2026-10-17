/**
 * What leaves the machine when a trace is shared: the share dialog's "payloads" and "auth" toggles, both off by default.
 *
 * - **Payloads off:** every object-payload event is dropped, and `detail`
 *   falls to `headers` (or `control`, which carries no stream events either;
 *   see src/trace/detail.ts). The server refuses a trace that carries an
 *   event its level excludes, so this is all or nothing.
 * - **Auth off:**
 *   - each control message's wire bytes go through the draft's own
 *     `redactAuthTokens`, which zero-fills every Authorization Token value in
 *     place. Bytes the redactor cannot vouch for (no codec for the draft, a
 *     frame that does not fully decode, or an `incomplete` result) are dropped
 *     instead of shipped
 *   - the decoded message map loses the same values: `token_value` is
 *     zero-filled (bytes from a decoder, or the hex string a live capture
 *     holds) or dropped (anything else), draft-07's `authorization_info` is
 *     replaced, and the query of any `path` is removed; a message whose
 *     `path` had a query loses its wire bytes as well, since the query is in
 *     them
 *   - any object event on a control or request stream is dropped. A trace
 *     this build exports has none, but an imported one can, and its bytes
 *     hold every SETUP and SUBSCRIBE in clear; their messages are already in
 *     the control events above
 *   - the session URL loses its query and fragment, where sites put tokens
 *
 * The result is a new trace; the panel's own session is untouched.
 */

import type { AuthRedaction } from '@moqtap/codec/draft20'
import { redactAuthTokens as r07 } from '@moqtap/codec/draft07'
import { redactAuthTokens as r08 } from '@moqtap/codec/draft08'
import { redactAuthTokens as r09 } from '@moqtap/codec/draft09'
import { redactAuthTokens as r10 } from '@moqtap/codec/draft10'
import { redactAuthTokens as r11 } from '@moqtap/codec/draft11'
import { redactAuthTokens as r12 } from '@moqtap/codec/draft12'
import { redactAuthTokens as r13 } from '@moqtap/codec/draft13'
import { redactAuthTokens as r14 } from '@moqtap/codec/draft14'
import { redactAuthTokens as r15 } from '@moqtap/codec/draft15'
import { redactAuthTokens as r16 } from '@moqtap/codec/draft16'
import { redactAuthTokens as r17 } from '@moqtap/codec/draft17'
import { redactAuthTokens as r18 } from '@moqtap/codec/draft18'
import { redactAuthTokens as r19 } from '@moqtap/codec/draft19'
import { redactAuthTokens as r20 } from '@moqtap/codec/draft20'
import { redactAuthTokens as r21 } from '@moqtap/codec/draft21'
import { redactAuthTokens as r22 } from '@moqtap/codec/draft22'
import { fitDetail } from '@/src/trace/detail'
import type { SupportedDraft } from '@/src/types/common'
import type { Trace, TraceEvent } from '@moqtap/trace'

/** Keyed by `SupportedDraft`, so a new draft fails to compile until it is listed. */
const REDACTORS: Record<SupportedDraft, (bytes: Uint8Array) => AuthRedaction> = {
  '07': r07,
  '08': r08,
  '09': r09,
  '10': r10,
  '11': r11,
  '12': r12,
  '13': r13,
  '14': r14,
  '15': r15,
  '16': r16,
  '17': r17,
  '18': r18,
  '19': r19,
  '20': r20,
  '21': r21,
  '22': r22,
}

export interface ShareContent {
  /** Object payloads (media, application data). Default off. */
  readonly payloads: boolean
  /** Authorization tokens and URL queries. Default off. */
  readonly auth: boolean
}

export const DEFAULT_SHARE_CONTENT: ShareContent = { payloads: false, auth: false }

/** Draft-07's free-text authorization parameter. */
const REDACTED_TEXT = '[redacted]'

/** `scheme://host/path`, without query or fragment. Unparseable input is dropped. */
export function stripQuery(url: string): string | undefined {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return undefined
  }
}

/**
 * The decoded message with every token value gone. `seen.query` is set when
 * a `path` carried a query: the wire bytes then hold it too, and the token
 * redactor does not know to remove it.
 */
export function scrubMessage(value: unknown, seen: { query: boolean } = { query: false }): unknown {
  if (Array.isArray(value)) return value.map((v) => scrubMessage(v, seen))
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'token_value') {
      if (v instanceof Uint8Array) out[k] = new Uint8Array(v.length)
      else if (typeof v === 'string') out[k] = '0'.repeat(v.length)
    }
    else if (k === 'authorization_info' && typeof v === 'string') out[k] = REDACTED_TEXT
    else if (k === 'path' && typeof v === 'string' && v.includes('?')) {
      out[k] = v.slice(0, v.indexOf('?'))
      seen.query = true
    } else out[k] = scrubMessage(v, seen)
  }
  return out
}

function redactRaw(raw: Uint8Array | undefined, draft: SupportedDraft | null): Uint8Array | undefined {
  if (raw === undefined || raw.length === 0) return raw
  if (draft === null) return undefined
  const r = REDACTORS[draft](raw)
  // "Nothing found" in a frame that did not decode is not "nothing there".
  if (r.incomplete || !r.decoded) return undefined
  return new Uint8Array(r.bytes)
}

/**
 * `controlStreams` are the ids of the session's control and request streams
 * as the panel knows them. The trace adds the ones it names itself: every
 * stream a control message carries a `streamId` for, which is each draft-17+
 * request stream, including one the panel never marked. An imported trace
 * has no panel markers at all.
 */
export function redactTrace(
  trace: Trace,
  content: ShareContent,
  draft: string | null,
  controlStreams: ReadonlySet<bigint> = new Set(),
): Trace {
  const known =
    draft !== null && Object.prototype.hasOwnProperty.call(REDACTORS, draft)
      ? (draft as SupportedDraft)
      : null
  let events = trace.events
  if (!content.payloads) events = events.filter((e) => e.type !== 'object-payload')
  if (!content.auth) {
    const control = new Set(controlStreams)
    for (const e of events) {
      const id = e.type === 'control' ? (e as { streamId?: bigint }).streamId : undefined
      if (id !== undefined) control.add(BigInt(id))
    }
    events = events.filter(
      (e) =>
        (e.type !== 'object-payload' && e.type !== 'object-header') ||
        !control.has(BigInt((e as { streamId: bigint }).streamId)),
    )
    events = events.map((e) => {
      if (e.type !== 'control') return e
      const c = e as TraceEvent & { message: unknown; raw?: Uint8Array }
      const seen = { query: false }
      const message = scrubMessage(c.message, seen)
      const raw = seen.query ? undefined : redactRaw(c.raw, known)
      return { ...c, message, raw } as TraceEvent
    })
  }
  // With no object left, `control` sheds the stream events too.
  const fitted = fitDetail(events)
  // `seq` stays dense after events are dropped.
  events = fitted.events.map((e, seq) => ({ ...e, seq }) as TraceEvent)

  const header = { ...trace.header, detail: fitted.detail }
  if (!content.auth && header.endpoint !== undefined) {
    const endpoint = stripQuery(header.endpoint)
    if (endpoint === undefined) delete (header as { endpoint?: string }).endpoint
    else (header as { endpoint?: string }).endpoint = endpoint
  }
  return { ...trace, header, events }
}
