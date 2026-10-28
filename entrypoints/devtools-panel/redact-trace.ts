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
 * - **Catalogs (payloads on):** an MSF/CMSF catalog object carries its own
 *   secrets in its JSON. Catalogs are found by shape, not by track: an
 *   imported trace has no stream-to-track mapping, and a catalog-shaped
 *   payload on another track is redacted just the same. A catalog's
 *   `trackBaseKey`, a live content key and not a credential, is replaced
 *   whatever the auth toggle says; with auth off, so are its `token`s, its
 *   `authInfo` values and the query and fragment of its `connectionUri` and
 *   DRM system URLs (`redactCatalogText` in @moqtap/media). A payload that
 *   may be a catalog but cannot be redacted (gzip, which MSF_COMPRESSION
 *   allows; JSON that does not parse but names catalog fields; text that is
 *   not UTF-8; a JSON object without a catalog's shape that still has a
 *   member the redactor would replace) loses its payload event and keeps its
 *   header. Re-sending it decompressed would falsify its compression
 *   property, and shipping it as is could ship the key. Neither is any other
 *   payload that names such a member anywhere in its bytes, which is what a
 *   catalog behind framing bytes looks like (a stream exported unframed,
 *   without object headers, also loses its payload when it holds gzip).
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
import { redactCatalogText } from '@moqtap/media/catalog'
import { fitDetail } from '@/src/trace/detail'
import type { SupportedDraft } from '@/src/types/common'
import type {
  ObjectHeaderEvent,
  ObjectPayloadEvent,
  Trace,
  TraceEvent,
} from '@moqtap/trace'

/** Keyed by `SupportedDraft`, so a new draft fails to compile until it is listed. */
const REDACTORS: Record<SupportedDraft, (bytes: Uint8Array) => AuthRedaction> =
  {
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

export const DEFAULT_SHARE_CONTENT: ShareContent = {
  payloads: false,
  auth: false,
}

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
export function scrubMessage(
  value: unknown,
  seen: { query: boolean } = { query: false },
): unknown {
  if (Array.isArray(value)) return value.map((v) => scrubMessage(v, seen))
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value))
    return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'token_value') {
      if (v instanceof Uint8Array) out[k] = new Uint8Array(v.length)
      else if (typeof v === 'string') out[k] = '0'.repeat(v.length)
    } else if (k === 'authorization_info' && typeof v === 'string')
      out[k] = REDACTED_TEXT
    else if (k === 'path' && typeof v === 'string' && v.includes('?')) {
      out[k] = v.slice(0, v.indexOf('?'))
      seen.query = true
    } else out[k] = scrubMessage(v, seen)
  }
  return out
}

function redactRaw(
  raw: Uint8Array | undefined,
  draft: SupportedDraft | null,
): Uint8Array | undefined {
  if (raw === undefined || raw.length === 0) return raw
  if (draft === null) return undefined
  const r = REDACTORS[draft](raw)
  // "Nothing found" in a frame that did not decode is not "nothing there".
  if (r.incomplete || !r.decoded) return undefined
  return new Uint8Array(r.bytes)
}

/**
 * A pattern for `"name":` in text that may be UTF-16 (MSF requires UTF-8, but
 * a producer that ignores it still ships the key): a NUL may sit beside each
 * character. Bytes read as Latin-1, one character each, so the pattern runs
 * on any payload without decoding it as UTF-8 first.
 */
function fieldPattern(names: readonly string[]): RegExp {
  const nul = '\\x00*'
  const spelled = names.map((n) => Array.from(n).join(nul))
  return new RegExp(`"${nul}(?:${spelled.join('|')})${nul}"[\\s\\x00]*:`)
}

/**
 * Field names that only a catalog (or its secrets) would carry. Matched on
 * the text of a payload that does not parse, so a catalog cut short or
 * written loosely is still recognised.
 */
const CATALOG_FIELD = fieldPattern([
  'tracks',
  'publishTracks',
  'deltaUpdate',
  'addTracks',
  'removeTracks',
  'cloneTracks',
  'trackBaseKey',
  'token',
  'authInfo',
  'connectionUri',
])

/**
 * The fields whose values `redactCatalogText` replaces: the content key
 * always, the credentials with `credentials`. `drmSystem` stands for the DRM
 * system URLs inside it.
 */
const KEY_FIELDS = ['trackBaseKey']
const CREDENTIAL_FIELDS = ['token', 'authInfo', 'connectionUri', 'drmSystem']
const SECRET_FIELD = fieldPattern(KEY_FIELDS)
const SECRET_OR_CREDENTIAL_FIELD = fieldPattern([
  ...KEY_FIELDS,
  ...CREDENTIAL_FIELDS,
])

/** gzip's magic and its one compression method, deflate. */
const GZIP = [0x1f, 0x8b, 0x08]

/**
 * Whether a payload could be a catalog at all: gzip (an MSF_COMPRESSION
 * catalog), or text whose first character, past a byte-order mark and white
 * space, opens a JSON object. Media and other binary data stop here.
 */
function catalogCandidate(bytes: Uint8Array): 'gzip' | 'json' | null {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip'
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  while (i < bytes.length && ' \t\n\r'.includes(String.fromCharCode(bytes[i]!)))
    i++
  return bytes[i] === 0x7b ? 'json' : null
}

/** Whether a parsed JSON value has a member the redactor would have replaced, at any depth. */
function namesSecret(value: unknown, credentials: boolean): boolean {
  if (Array.isArray(value))
    return value.some((v) => namesSecret(v, credentials))
  if (value === null || typeof value !== 'object') return false
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (KEY_FIELDS.includes(k)) return true
    if (credentials && CREDENTIAL_FIELDS.includes(k)) return true
    if (namesSecret(v, credentials)) return true
  }
  return false
}

/** Whether `needle` occurs anywhere in `bytes`. */
function contains(bytes: Uint8Array, needle: readonly number[]): boolean {
  let at = bytes.indexOf(needle[0]!)
  while (at >= 0 && at + needle.length <= bytes.length) {
    if (needle.every((b, k) => bytes[at + k] === b)) return true
    at = bytes.indexOf(needle[0]!, at + 1)
  }
  return false
}

/**
 * One object payload, ready to share: the event as it was when it is not a
 * catalog, with the redacted text (and its size) when it is, and `undefined`
 * (drop it) when it may hold a catalog's secrets that cannot be redacted.
 * `credentials` is the auth toggle off; the content key goes either way.
 *
 * `framed` is false for a payload that is a whole stream rather than one
 * object (an object-payload event with no object-header, which is how a
 * stream that frames as nothing is exported): a catalog object may sit
 * anywhere in it, behind framing bytes, so gzip anywhere in it may be one.
 */
export function redactCatalogPayload(
  e: ObjectPayloadEvent,
  credentials: boolean,
  framed = true,
): ObjectPayloadEvent | undefined {
  const bytes = e.payload
  if (bytes === undefined) return e
  const latin1 = (): string => new TextDecoder('latin1').decode(bytes)
  const secret = credentials ? SECRET_OR_CREDENTIAL_FIELD : SECRET_FIELD
  const kind = catalogCandidate(bytes)
  if (kind === null) {
    // Not a catalog by its first byte, but a catalog's secrets can still be
    // in it: behind framing bytes, when a stream is exported unframed or
    // framed wrong. Any payload that names one goes, and an unframed one
    // that holds gzip goes too, since what it compresses cannot be read.
    if (!framed && contains(bytes, GZIP)) return undefined
    return secret.test(latin1()) ? undefined : e
  }
  // Compressed: it cannot be read, so it cannot be vouched for.
  if (kind === 'gzip') return undefined
  const redacted = redactCatalogText(bytes, { credentials })
  if (redacted !== null) {
    const out = new TextEncoder().encode(redacted)
    // Nothing secret in it: the captured bytes go as they are.
    if (out.length === bytes.length && out.every((b, k) => b === bytes[k]))
      return e
    return { ...e, payload: out, size: out.length }
  }
  // Not a catalog after all, or one that could not be read. A JSON object
  // without a catalog's shape is application data, and goes untouched unless
  // it has a member the redactor would have replaced (a catalog written
  // wrong, or one nested in another document, still carries its key); the
  // redactor splices only a catalog, so such a payload goes whole. One that
  // does not parse (or is not UTF-8) goes only if it names no catalog field.
  // Text that is not UTF-8 is never taken as parsed: decoded loosely, it
  // could parse as the very catalog the redactor refused.
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const root: unknown = JSON.parse(text)
    if (root !== null && typeof root === 'object' && !Array.isArray(root)) {
      return namesSecret(root, credentials) ? undefined : e
    }
  } catch {
    // Falls through to the field check
  }
  return CATALOG_FIELD.test(latin1()) ? undefined : e
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
  if (!content.payloads)
    events = events.filter((e) => e.type !== 'object-payload')
  if (!content.auth) {
    const control = new Set(controlStreams)
    for (const e of events) {
      const id =
        e.type === 'control' ? (e as { streamId?: bigint }).streamId : undefined
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
  if (content.payloads) {
    const credentials = !content.auth
    // Objects with a header; a payload without one is a whole stream.
    const objectKey = (e: {
      streamId: bigint
      groupId: bigint
      objectId: bigint
    }) => `${e.streamId}/${e.groupId}/${e.objectId}`
    const headed = new Set<string>()
    for (const e of events) {
      if (e.type === 'object-header')
        headed.add(objectKey(e as ObjectHeaderEvent))
    }
    events = events.flatMap((e) => {
      if (e.type !== 'object-payload') return [e]
      const p = e as ObjectPayloadEvent
      const out = redactCatalogPayload(p, credentials, headed.has(objectKey(p)))
      return out === undefined ? [] : [out as TraceEvent]
    })
  }
  // With no object left, `control` sheds the stream events too.
  const fitted = fitDetail(events)
  // `seq` stays dense after events are dropped.
  events = fitted.events.map((e, seq) => ({ ...e, seq }) as TraceEvent)

  const header = { ...trace.header, detail: fitted.detail }
  if (!content.auth && header.endpoint !== undefined) {
    const endpoint = stripQuery(header.endpoint)
    if (endpoint === undefined)
      delete (header as { endpoint?: string }).endpoint
    else (header as { endpoint?: string }).endpoint = endpoint
  }
  return { ...trace, header, events }
}
