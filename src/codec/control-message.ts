/**
 * Control message decode/encode facade — multi-draft aware.
 *
 * Delegates to @moqtap/codec, lazily caching one codec instance per draft.
 * The codec supports all drafts 07-17 natively.
 */

import { createCodec, type Codec, type DecodeResult } from '@moqtap/codec';
import type { Draft14Codec, Draft14Message } from '@moqtap/codec/draft14';
import type { MoqtMessage } from '@moqtap/codec';
import type { SupportedDraft } from '../types/common';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const codecs = new Map<SupportedDraft, any>();

/** Get (or lazily create) the codec for a given draft */
export function getCodec(draft: '07'): Codec;
export function getCodec(draft: '14'): Draft14Codec;
export function getCodec(draft: SupportedDraft): Codec | Draft14Codec;
export function getCodec(draft: SupportedDraft): Codec | Draft14Codec {
  if (!codecs.has(draft)) {
    codecs.set(draft, createCodec({ draft }));
  }
  return codecs.get(draft)!;
}

/** Decode a control message from raw bytes using the specified draft codec */
export function decodeControlMessage(
  buf: Uint8Array,
  draft: '07',
): DecodeResult<MoqtMessage>;
export function decodeControlMessage(
  buf: Uint8Array,
  draft: '14',
): DecodeResult<Draft14Message>;
export function decodeControlMessage(
  buf: Uint8Array,
  draft: SupportedDraft,
): DecodeResult<MoqtMessage | Draft14Message>;
export function decodeControlMessage(
  buf: Uint8Array,
  draft: SupportedDraft,
): DecodeResult<MoqtMessage | Draft14Message> {
  return getCodec(draft).decodeMessage(buf) as DecodeResult<MoqtMessage | Draft14Message>;
}

/** Encode a control message to bytes using the specified draft codec */
export function encodeControlMessage(
  msg: MoqtMessage,
  draft: '07',
): Uint8Array;
export function encodeControlMessage(
  msg: Draft14Message,
  draft: '14',
): Uint8Array;
export function encodeControlMessage(
  msg: MoqtMessage | Draft14Message,
  draft: SupportedDraft,
): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getCodec(draft).encodeMessage(msg as any);
}
