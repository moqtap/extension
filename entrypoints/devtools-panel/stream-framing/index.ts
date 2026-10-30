/**
 * MoQT data stream framing — registry and public API.
 *
 * Draft-agnostic design: each draft version has its own parser,
 * delegating to the @moqtap/codec's per-draft decoder.
 * The UI receives generic key-value header tags and object boundaries —
 * it doesn't need to know draft-specific field names.
 */

export type {
  DraftParser,
  HeaderTag,
  ParsedStreamFraming,
  StreamObject,
} from './types'

// ─── Registry ──────────────────────────────────────────────────────

import type {
  DraftParser,
  HeaderTag,
  ParsedStreamFraming,
  StreamObject,
} from './types'

const draftParsers = new Map<string, DraftParser>()
const datagramParsers = new Map<string, DraftParser>()

export function registerDraftParser(
  draft: string,
  parser: DraftParser,
  datagram: DraftParser,
): void {
  draftParsers.set(draft, parser)
  datagramParsers.set(draft, datagram)
}

/**
 * Parse a subgroup or fetch stream by the rules of the session's draft.
 * Null when the draft is unknown or the bytes do not frame under it: another
 * draft's reading of the same bytes would be a guess.
 */
export function parseStreamFraming(
  data: Uint8Array,
  draft?: string,
): ParsedStreamFraming | null {
  if (data.length < 3 || !draft) return null
  return draftParsers.get(draft)?.(data) ?? null
}

/** Parse one datagram by the rules of the session's draft. */
export function parseDatagramFraming(
  data: Uint8Array,
  draft?: string,
): ParsedStreamFraming | null {
  if (!draft) return null
  return datagramParsers.get(draft)?.(data) ?? null
}

/** Longest a subgroup or fetch stream header can be, in any draft. */
const MAX_STREAM_HEADER = 64

/**
 * Read a data stream's header from its first bytes, which may end inside the
 * header or inside the first object. `pending` asks for more bytes;
 * `invalid` means the bytes are no stream header of this draft.
 */
export function readStreamHeader(
  lead: Uint8Array,
  draft: string,
):
  | { state: 'pending' }
  | { state: 'invalid' }
  | { state: 'done'; framing: ParsedStreamFraming } {
  const whole = parseStreamFraming(lead, draft)
  if (whole) return { state: 'done', framing: whole }
  const prefix =
    parseStreamPrefix(lead, draft, 'subgroup') ??
    parseStreamPrefix(lead, draft, 'fetch')
  if (prefix) return { state: 'done', framing: prefix.framing }
  if (!draftParsers.has(draft) || lead.length >= MAX_STREAM_HEADER)
    return { state: 'invalid' }
  return { state: 'pending' }
}

// ─── Payload extraction helpers ────────────────────────────────────

/** Whether an object the framing found carries a non-empty Object Properties block. */
export function carriesObjectProperties(framing: ParsedStreamFraming): boolean {
  return framing.objects.some((obj) => (obj.propertiesLength ?? 0) > 0)
}

/** Extract the first object's payload from a parsed stream. */
export function extractFirstPayload(
  data: Uint8Array,
  framing: ParsedStreamFraming,
): Uint8Array | null {
  if (framing.objects.length === 0) return null
  const obj = framing.objects[0]
  const end = Math.min(obj.payloadOffset + obj.payloadLength, data.length)
  return data.subarray(obj.payloadOffset, end)
}

/** Concatenate all object payloads from a parsed stream. */
export function extractAllPayloads(
  data: Uint8Array,
  framing: ParsedStreamFraming,
): Uint8Array[] {
  return framing.objects.map((obj) => {
    const end = Math.min(obj.payloadOffset + obj.payloadLength, data.length)
    return data.subarray(obj.payloadOffset, end)
  })
}

// ─── Datagram group framing ───────────────────────────────────────

/**
 * Parse datagram group data (length-prefixed concatenated datagrams).
 * Format: [4-byte LE uint32 length][raw datagram bytes] repeated.
 *
 * Returns a ParsedStreamFraming where each "object" corresponds to one
 * datagram's payload, enabling reuse of StreamDataViewer for hex view,
 * payload tagging, and content detection.
 */
export function parseDatagramGroupFraming(
  data: Uint8Array,
  draft?: string,
): ParsedStreamFraming | null {
  if (data.length < 4) return null

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const objects: StreamObject[] = []
  const tags: HeaderTag[] = []
  let headerFields: Record<string, number> = {}
  let offset = 0
  let dgIndex = 0

  while (offset + 4 <= data.length) {
    const rawLen = view.getUint32(offset, true) // little-endian
    if (rawLen === 0 || offset + 4 + rawLen > data.length) break

    const dgBytes = data.subarray(offset + 4, offset + 4 + rawLen)

    const framing = parseDatagramFraming(dgBytes, draft)
    if (framing && framing.objects.length > 0) {
      // Use the first datagram's header fields for the group
      if (dgIndex === 0) {
        headerFields = { ...framing.headerFields }
      }

      for (const obj of framing.objects) {
        objects.push({
          // Offset relative to the group buffer
          offset: offset + 4 + obj.offset,
          payloadOffset: offset + 4 + obj.payloadOffset,
          payloadLength: obj.payloadLength,
          objectId: obj.objectId,
          ...(obj.status !== undefined ? { status: obj.status } : {}),
          ...(obj.propertiesOffset !== undefined
            ? {
                propertiesOffset: offset + 4 + obj.propertiesOffset,
                propertiesLength: obj.propertiesLength ?? 0,
              }
            : {}),
        })
      }
    } else {
      // Fallback: treat entire raw datagram as a single object
      objects.push({
        offset: offset + 4,
        payloadOffset: offset + 4,
        payloadLength: rawLen,
        objectId: dgIndex,
      })
    }

    offset += 4 + rawLen
    dgIndex++
  }

  if (objects.length === 0) return null
  // The group is the store's key: every datagram here carries the same one.
  if (headerFields.groupId !== undefined)
    tags.push({ label: 'group', value: String(headerFields.groupId), kind: 'group' })

  return {
    streamType: 'datagram',
    headerEnd: 0,
    headerFields,
    objects,
    tags,
  }
}

// ─── Register all draft parsers ────────────────────────────────────

import type { SupportedDraft } from '@/src/types/common'
import type { DecodeResult, ObjectProperty } from '@moqtap/codec'
import {
  createCodecDatagramParser,
  createCodecDraftParser,
  createCodecPrefixParser,
  createPropertiesDecoder,
  type ParsedPrefix,
} from './codec-adapter'

export type { ParsedPrefix } from './codec-adapter'

const prefixParsers = new Map<
  string,
  (data: Uint8Array, kind: 'subgroup' | 'fetch') => ParsedPrefix | null
>()

/**
 * The longest prefix of `data` that frames whole as a `kind` stream of
 * `draft`, for a stream that ends inside an object. Null when the draft is
 * unknown here or no prefix frames.
 */
export function parseStreamPrefix(
  data: Uint8Array,
  draft: string,
  kind: 'subgroup' | 'fetch',
): ParsedPrefix | null {
  let parse = prefixParsers.get(draft)
  if (!parse) {
    if (!draftParsers.has(draft)) return null
    parse = createCodecPrefixParser(draft as SupportedDraft)
    prefixParsers.set(draft, parse)
  }
  return parse(data, kind)
}

const propertyDecoders = new Map<
  string,
  (bytes: Uint8Array) => DecodeResult<ObjectProperty[]>
>()

/**
 * Decode one Object's property block — `data.subarray(propertiesOffset,
 * propertiesOffset + propertiesLength)` — by the rules of `draft`. Null when the
 * draft is unknown here; a malformed block is the codec's error result.
 */
export function decodeObjectProperties(
  bytes: Uint8Array,
  draft: string,
): DecodeResult<ObjectProperty[]> | null {
  let decode = propertyDecoders.get(draft)
  if (!decode) {
    if (!draftParsers.has(draft)) return null
    decode = createPropertiesDecoder(draft as SupportedDraft)
    propertyDecoders.set(draft, decode)
  }
  return decode(bytes)
}

// All drafts use the codec adapter — each gets its own codec instance
function registerCodecDraft(draft: SupportedDraft): void {
  registerDraftParser(
    draft,
    createCodecDraftParser(draft),
    createCodecDatagramParser(draft),
  )
}
registerCodecDraft('07')
registerCodecDraft('08')
registerCodecDraft('09')
registerCodecDraft('10')
registerCodecDraft('11')
registerCodecDraft('12')
registerCodecDraft('13')
registerCodecDraft('14')
registerCodecDraft('15')
registerCodecDraft('16')
registerCodecDraft('17')
registerCodecDraft('18')
registerCodecDraft('19')
registerCodecDraft('20')
registerCodecDraft('21')
registerCodecDraft('22')
