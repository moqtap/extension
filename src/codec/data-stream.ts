/**
 * Data stream decoders — delegates to @moqtap/codec/draft14 streaming APIs.
 *
 * Data streams (subgroup, fetch, datagram) are draft-14 concepts.
 * Draft-07 uses different framing (StreamHeaderTrack/StreamHeaderGroup).
 */

import type { DecodeResult } from '@moqtap/codec';
import type {
  DatagramObject,
  DataStreamEvent,
  Draft14Message,
  SubgroupStream,
  FetchStream,
} from '@moqtap/codec/draft14';
import type { MoqtMessage } from '@moqtap/codec';
import type { SupportedDraft } from '../types/common';
import { getCodec } from './control-message';

/** Create a TransformStream decoder for control stream messages */
export function createControlStreamDecoder(
  draft: SupportedDraft,
): TransformStream<Uint8Array, MoqtMessage | Draft14Message> {
  return getCodec(draft).createStreamDecoder() as TransformStream<
    Uint8Array,
    MoqtMessage | Draft14Message
  >;
}

// ─── Draft-14 specific data stream decoders ────────────────────────

/** Create a TransformStream decoder for subgroup data streams (draft-14) */
export function createSubgroupStreamDecoder(): TransformStream<Uint8Array, DataStreamEvent> {
  return getCodec('14').createSubgroupStreamDecoder();
}

/** Create a TransformStream decoder for fetch data streams (draft-14) */
export function createFetchStreamDecoder(): TransformStream<Uint8Array, DataStreamEvent> {
  return getCodec('14').createFetchStreamDecoder();
}

/** Create a TransformStream decoder for any data stream type (draft-14) */
export function createDataStreamDecoder(): TransformStream<Uint8Array, DataStreamEvent> {
  return getCodec('14').createDataStreamDecoder();
}

/** Decode a single datagram (draft-14) */
export function decodeDatagram(buf: Uint8Array): DecodeResult<DatagramObject> {
  return getCodec('14').decodeDatagram(buf);
}

/** Decode a complete subgroup stream from bytes (draft-14) */
export function decodeSubgroupStream(buf: Uint8Array): DecodeResult<SubgroupStream> {
  return getCodec('14').decodeSubgroupStream(buf);
}

/** Decode a complete fetch stream from bytes (draft-14) */
export function decodeFetchStream(buf: Uint8Array): DecodeResult<FetchStream> {
  return getCodec('14').decodeFetchStream(buf);
}
