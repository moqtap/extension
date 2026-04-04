/**
 * Control message decode/encode facade — multi-draft aware.
 *
 * Delegates to @moqtap/codec, lazily caching one codec instance per draft.
 * The codec supports all drafts 07-17 natively.
 */

import { createCodec, type BaseCodec, type DecodeResult } from '@moqtap/codec';
import type { SupportedDraft } from '../types/common';

const codecs = new Map<SupportedDraft, BaseCodec>();

/** Get (or lazily create) the codec for a given draft */
export function getCodec(draft: SupportedDraft): BaseCodec {
  if (!codecs.has(draft)) {
    codecs.set(draft, createCodec({ draft }));
  }
  return codecs.get(draft)!;
}

/** Decode a control message from raw bytes using the specified draft codec */
export function decodeControlMessage(
  buf: Uint8Array,
  draft: SupportedDraft,
): DecodeResult<Record<string, unknown>> {
  return getCodec(draft).decodeMessage(buf) as DecodeResult<Record<string, unknown>>;
}

/** Encode a control message to bytes using the specified draft codec */
export function encodeControlMessage(
  msg: Record<string, unknown>,
  draft: SupportedDraft,
): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getCodec(draft).encodeMessage(msg as any);
}
