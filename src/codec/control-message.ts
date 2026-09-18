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
import type { SupportedDraft } from '../types/common'

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

/** Decode a control message from raw bytes using the specified draft codec */
export function decodeControlMessage(
  buf: Uint8Array,
  draft: SupportedDraft,
): DecodeResult<Record<string, unknown>> {
  return getCodec(draft).decodeMessage(buf) as DecodeResult<
    Record<string, unknown>
  >
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
