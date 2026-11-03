/**
 * Control message decode/encode facade — multi-draft aware.
 *
 * Delegates to @moqtap/codec, lazily caching one codec instance per draft.
 * The codec has a native implementation for every draft `SUPPORTED_DRAFTS`
 * names, so nothing here has to fall back to a neighbouring draft's reading.
 */

import {
  createCodec,
  type BaseCodec,
  type DecodeError,
  type DecodeErrorCode,
  type DecodeResult,
} from '@moqtap/codec'
import {
  DEFAULT_MAX_CONTROL_MESSAGE_SIZE,
  type Draft23Codec,
} from '@moqtap/codec/draft23'
import type { SupportedDraft } from '../types/common'
import { decodeVarintForDraft, VarintError } from './varint'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCodec = BaseCodec<any>

const codecs = new Map<SupportedDraft, AnyCodec>()

/** Get (or lazily create) the codec for a given draft */
export function getCodec(draft: SupportedDraft): AnyCodec {
  if (!codecs.has(draft)) {
    codecs.set(draft, createCodec({ draft }))
  }
  return codecs.get(draft)!
}

/**
 * Decode a control message from raw bytes using the specified draft codec.
 * `limit` is the receiver's limit from `receiveLimit`: a Length over it fails
 * as soon as the Type and Length have arrived.
 */
export function decodeControlMessage(
  buf: Uint8Array,
  draft: SupportedDraft,
  limit?: bigint,
): DecodeResult<Record<string, unknown>> {
  const codec = getCodec(draft)
  const result =
    draft === '23' && limit !== undefined
      ? (codec as Draft23Codec).decodeMessage(buf, {
          maxControlMessageSize: limit,
        })
      : codec.decodeMessage(buf)
  return result as DecodeResult<Record<string, unknown>>
}

/**
 * The largest control message Length an endpoint accepts, on the drafts that
 * limit it, from the MAX_CONTROL_MESSAGE_SIZE its own SETUP advertised
 * (`undefined` until that SETUP is seen, or when it carried none).
 *
 * draft-23 Section 9: "If an endpoint receives a control message with a
 * length larger than its MAX_CONTROL_MESSAGE_SIZE, it MUST close the session
 * with FIELD_LENGTH_EXCEEDED."
 *
 * draft-23 Section 9.1.8: "If not present, the default value is 65535. Until
 * an endpoint receives the peer's SETUP, it uses the default value, including
 * for SETUP itself." The codec holds SETUP to 65535 whatever is passed.
 */
export function receiveLimit(
  draft: SupportedDraft,
  advertised: bigint | undefined,
): bigint | undefined {
  if (draft !== '23') return undefined
  return advertised ?? DEFAULT_MAX_CONTROL_MESSAGE_SIZE
}

/**
 * Whether a failed decode is one that more bytes can still turn into a
 * message.
 *
 * A control message declares its length before its payload, so a message that
 * is still arriving is the single failure that runs out of bytes. Every other
 * code names bytes that are already whole and still wrong — a varint the draft
 * leaves undefined, a message type it does not have, a parameter outside the
 * messages its own definition allows — and a reader that holds those waiting
 * for the rest of them waits forever, never reading the messages behind them.
 *
 * The mapping is written out per code rather than as a default, so a code
 * added to the codec fails to compile here instead of silently becoming one or
 * the other.
 */
const RESOLVES_WITH_MORE_BYTES: Record<DecodeErrorCode, boolean> = {
  UNEXPECTED_END: true,
  INVALID_VARINT: false,
  UNKNOWN_MESSAGE_TYPE: false,
  INVALID_PARAMETER: false,
  CONSTRAINT_VIOLATION: false,
}

export function isIncomplete(error: DecodeError): boolean {
  return RESOLVES_WITH_MORE_BYTES[error.code] ?? false
}

/** Encode a control message to bytes using the specified draft codec */
export function encodeControlMessage(
  msg: Record<string, unknown>,
  draft: SupportedDraft,
): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getCodec(draft).encodeMessage(msg as any)
}

/**
 * How each draft writes a control message's Length: a varint through draft-10,
 * 16 bits from draft-11 to draft-22, and a varint again from draft-23.
 *
 * draft-22 Section 9, Figure 5: "Message Length (16)".
 * draft-23 Section 9, Figure 6: "Message Length (vi64)".
 *
 * The two readings cannot be told apart from the bytes: draft-22's `00 01` for
 * a one-byte body is, under draft-23, a zero-length message followed by a
 * byte. So the width is the draft's, never a guess.
 */
const LENGTH_FIELD: Record<SupportedDraft, 'varint' | 'u16'> = {
  '07': 'varint',
  '08': 'varint',
  '09': 'varint',
  '10': 'varint',
  '11': 'u16',
  '12': 'u16',
  '13': 'u16',
  '14': 'u16',
  '15': 'u16',
  '16': 'u16',
  '17': 'u16',
  '18': 'u16',
  '19': 'u16',
  '20': 'u16',
  '21': 'u16',
  '22': 'u16',
  '23': 'varint',
}

/**
 * Bytes the control message at the start of `buf` occupies, read from its
 * Type and Length alone, in the draft's Length width (see `LENGTH_FIELD`).
 * `incomplete` while those are still arriving; `invalid` when the Type or a
 * varint Length is no varint of this draft.
 */
export function controlMessageLength(
  buf: Uint8Array,
  draft: SupportedDraft,
): number | 'incomplete' | 'invalid' {
  try {
    const [, typeLen] = decodeVarintForDraft(draft, buf, 0)
    if (LENGTH_FIELD[draft] === 'varint') {
      const [length, lengthLen] = decodeVarintForDraft(draft, buf, typeLen)
      return typeLen + lengthLen + length
    }
    if (buf.length < typeLen + 2) return 'incomplete'
    return typeLen + 2 + ((buf[typeLen] << 8) | buf[typeLen + 1])
  } catch (e) {
    if (e instanceof VarintError && /too short/.test(e.message))
      return 'incomplete'
    return 'invalid'
  }
}
