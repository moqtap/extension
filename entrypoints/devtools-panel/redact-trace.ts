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
 *   - any object event on a control or request stream is dropped; its
 *     messages are in the control events
 *   - the session URL loses its query and fragment, where sites put tokens
 * - **Catalogs (payloads on):** MSF/CMSF catalogs are found by shape, on any
 *   track. Their `trackBaseKey` is always replaced; with auth off, so are
 *   their `token`s, `authInfo` values and the query and fragment of their
 *   `connectionUri` and DRM system URLs. Other JSON payloads get the same
 *   fields replaced by name. A gzip payload is decompressed, redacted and
 *   recompressed. A payload that may hold such a field but cannot be
 *   redacted (gzip that does not decompress or exceeds 16 MiB decompressed,
 *   JSON that does not parse, text that is not UTF-8) loses its payload event
 *   and keeps its header, as does an unframed stream that holds gzip.
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
import { redactCatalogText, redactJsonText } from '@moqtap/media/catalog'
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
 * A pattern for `"name":` in bytes read as Latin-1, allowing a NUL beside
 * each character (UTF-16) and any character written as a JSON `\uXXXX` escape.
 */
function fieldPattern(names: readonly string[]): RegExp {
  const nul = '\\x00*'
  const hex = (d: string) => (/[a-f]/.test(d) ? `[${d}${d.toUpperCase()}]` : d)
  const char = (c: string) => {
    const code = c.charCodeAt(0).toString(16).padStart(4, '0')
    const escape = ['\\\\', 'u', ...Array.from(code, hex)].join(nul)
    return `(?:${c}|${escape})`
  }
  const spelled = names.map((n) => Array.from(n, char).join(nul))
  return new RegExp(`"${nul}(?:${spelled.join('|')})${nul}"[\\s\\x00]*:`)
}

/** Field names only a catalog or its secrets carry, for payloads that do not parse. */
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
 * Fields the redactor replaces: the content key always, the credentials with
 * `credentials`. `drmSystem` holds the DRM system URLs.
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
 * Whether a payload could be a catalog: gzip, or text whose first character
 * past byte-order marks and white space opens a JSON object or array.
 */
function catalogCandidate(bytes: Uint8Array): 'gzip' | 'json' | null {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip'
  let i = 0
  for (;;) {
    if (bytes[i] === 0xef && bytes[i + 1] === 0xbb && bytes[i + 2] === 0xbf)
      i += 3
    else if (
      i < bytes.length &&
      ' \t\n\r'.includes(String.fromCharCode(bytes[i]!))
    )
      i++
    else break
  }
  return bytes[i] === 0x7b || bytes[i] === 0x5b ? 'json' : null
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

/** Decompressed size beyond which a gzip payload is dropped unread. */
const MAX_INFLATED = 16 * 1024 * 1024

async function gunzip(bytes: Uint8Array): Promise<Uint8Array | undefined> {
  try {
    const reader = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'))
      .getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > MAX_INFLATED) {
        await reader.cancel().catch(() => {})
        return undefined
      }
      chunks.push(value)
    }
    const out = new Uint8Array(total)
    let at = 0
    for (const c of chunks) {
      out.set(c, at)
      at += c.length
    }
    return out
  } catch {
    return undefined
  }
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * JSON with its secrets replaced: `bytes` itself when nothing changed, null
 * when it does not parse or is not UTF-8.
 */
function redactJson(
  bytes: Uint8Array,
  credentials: boolean,
): Uint8Array | null {
  const redacted =
    redactCatalogText(bytes, { credentials }) ??
    redactJsonText(bytes, { credentials })
  if (redacted === null) return null
  const out = new TextEncoder().encode(redacted)
  if (out.length === bytes.length && out.every((b, k) => b === bytes[k]))
    return bytes
  return out
}

/**
 * Whether a payload that is not JSON may hold a catalog's secrets: it names
 * one, or (`framed` false) it holds gzip, whose content cannot be read.
 */
function mayHoldSecret(
  bytes: Uint8Array,
  credentials: boolean,
  framed: boolean,
): boolean {
  if (!framed && contains(bytes, GZIP)) return true
  const secret = credentials ? SECRET_OR_CREDENTIAL_FIELD : SECRET_FIELD
  return secret.test(new TextDecoder('latin1').decode(bytes))
}

/**
 * A gzip payload redacted and recompressed: `bytes` itself when nothing
 * changed, `undefined` when it cannot be vouched for.
 */
async function redactGzip(
  bytes: Uint8Array,
  credentials: boolean,
): Promise<Uint8Array | undefined> {
  const plain = await gunzip(bytes)
  if (plain === undefined) return undefined
  const kind = catalogCandidate(plain)
  if (kind === null)
    return mayHoldSecret(plain, credentials, false) ? undefined : bytes
  if (kind === 'gzip') return undefined
  const redacted = redactJson(plain, credentials)
  if (redacted === null) return undefined
  return redacted === plain ? bytes : gzip(redacted)
}

/**
 * One object payload, ready to share: unchanged, with the redacted payload
 * and size, or `undefined` (drop it) when it may hold catalog secrets that
 * cannot be redacted. `credentials` is the auth toggle off. `framed` is false
 * for a payload with no object header, which is a whole stream.
 */
export async function redactCatalogPayload(
  e: ObjectPayloadEvent,
  credentials: boolean,
  framed = true,
): Promise<ObjectPayloadEvent | undefined> {
  const bytes = e.payload
  if (bytes === undefined) return e
  const kind = catalogCandidate(bytes)
  if (kind === null)
    return mayHoldSecret(bytes, credentials, framed) ? undefined : e
  const out =
    kind === 'gzip'
      ? await redactGzip(bytes, credentials)
      : redactJson(bytes, credentials)
  if (out === bytes) return e
  if (out !== null && out !== undefined)
    return { ...e, payload: out, size: out.length }
  if (kind === 'gzip') return undefined
  // Not JSON, or not UTF-8: kept only if it names no catalog field.
  return CATALOG_FIELD.test(new TextDecoder('latin1').decode(bytes))
    ? undefined
    : e
}

/**
 * `controlStreams` are the ids of the session's control and request streams
 * as the panel knows them. The trace adds the ones it names itself: every
 * stream a control message carries a `streamId` for, which is each draft-17+
 * request stream, including one the panel never marked. An imported trace
 * has no panel markers at all.
 */
export async function redactTrace(
  trace: Trace,
  content: ShareContent,
  draft: string | null,
  controlStreams: ReadonlySet<bigint> = new Set(),
): Promise<Trace> {
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
    const redacted = await Promise.all(
      events.map(async (e) => {
        if (e.type !== 'object-payload') return e
        const p = e as ObjectPayloadEvent
        const out = await redactCatalogPayload(
          p,
          credentials,
          headed.has(objectKey(p)),
        )
        return out as TraceEvent | undefined
      }),
    )
    events = redacted.filter((e): e is TraceEvent => e !== undefined)
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
