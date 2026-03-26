/**
 * Adapter that wraps @moqtap/codec's per-draft data stream decoders
 * into the extension's DraftParser format.
 *
 * Each draft gets its own codec instance via createCodec({ draft }).
 * The codec handles all draft-specific wire format differences internally,
 * including per-object byte offsets for the hex viewer.
 */

import { createCodec, type DecodeResult } from '@moqtap/codec';
import type { SupportedDraft } from '@/src/types/common';
import type { DraftParser, ParsedStreamFraming, StreamObject, HeaderTag } from './types';

/** Codec with data stream decoders (all drafts) */
interface DataStreamCodec {
  decodeSubgroupStream(bytes: Uint8Array): DecodeResult<SubgroupResult>;
  decodeFetchStream(bytes: Uint8Array): DecodeResult<FetchResult>;
  decodeDatagram(bytes: Uint8Array): DecodeResult<DatagramResult>;
}

/** Minimal shape of SubgroupStream result from the codec */
interface SubgroupResult {
  readonly type: 'subgroup';
  readonly streamTypeId?: number;
  readonly trackAlias: bigint;
  readonly groupId: bigint;
  readonly subgroupId: bigint;
  readonly publisherPriority: number;
  readonly objects: ObjectResult[];
}

/** Minimal shape of FetchStream result from the codec */
interface FetchResult {
  readonly type: 'fetch';
  readonly requestId?: bigint;
  readonly subscribeId?: bigint;
  readonly objects: FetchObjectResult[];
}

/** Minimal shape of DatagramObject from the codec */
interface DatagramResult {
  readonly type: 'datagram';
  readonly streamTypeId?: number;
  readonly trackAlias: bigint;
  readonly groupId: bigint;
  readonly objectId: bigint;
  readonly publisherPriority: number;
  readonly payloadLength: number;
  readonly status?: bigint;
  readonly payload: Uint8Array;
}

/** Minimal shape of ObjectPayload from the codec */
interface ObjectResult {
  readonly objectId: bigint;
  readonly payloadLength: number;
  readonly status?: bigint;
  readonly payload: Uint8Array;
  readonly byteOffset: number;
  readonly payloadByteOffset: number;
}

/** Minimal shape of FetchObjectPayload from the codec */
interface FetchObjectResult extends ObjectResult {
  readonly groupId?: bigint;
  readonly subgroupId?: bigint;
  readonly publisherPriority?: number;
}

/**
 * Create a DraftParser that delegates to the codec's per-draft decoders.
 * Works for all drafts (07-17).
 */
export function createCodecDraftParser(draft: SupportedDraft): DraftParser {
  const codec = createCodec({ draft }) as unknown as DataStreamCodec;

  return (data: Uint8Array): ParsedStreamFraming | null => {
    if (data.length < 3) return null;

    // Try subgroup first, then fetch, then datagram
    return tryDecodeSubgroup(codec, data)
      ?? tryDecodeFetch(codec, data)
      ?? tryDecodeDatagram(codec, data);
  };
}

function tryDecodeSubgroup(
  codec: DataStreamCodec,
  data: Uint8Array,
): ParsedStreamFraming | null {
  try {
    const result = codec.decodeSubgroupStream(data);
    if (!result.ok) return null;

    const stream = result.value;
    const headerFields: Record<string, number> = {};
    const tags: HeaderTag[] = [];

    if (stream.streamTypeId !== undefined) {
      headerFields.streamType = stream.streamTypeId;
    }
    headerFields.trackAlias = Number(stream.trackAlias);
    headerFields.groupId = Number(stream.groupId);
    tags.push({ label: 'group', value: String(stream.groupId), kind: 'group' });

    headerFields.subgroupId = Number(stream.subgroupId);
    if (stream.subgroupId !== 0n) {
      tags.push({ label: 'subgroup', value: String(stream.subgroupId), kind: 'info' });
    }

    if (stream.publisherPriority !== undefined) {
      headerFields.publisherPriority = stream.publisherPriority;
      tags.push({ label: 'pri', value: String(stream.publisherPriority), kind: 'priority' });
    }

    const objects = mapObjects(stream.objects);
    const headerEnd = objects.length > 0 ? objects[0].offset : data.length;

    return { streamType: 'subgroup', headerEnd, headerFields, objects, tags };
  } catch {
    return null;
  }
}

function tryDecodeFetch(
  codec: DataStreamCodec,
  data: Uint8Array,
): ParsedStreamFraming | null {
  try {
    const result = codec.decodeFetchStream(data);
    if (!result.ok) return null;

    const stream = result.value;
    const headerFields: Record<string, number> = { streamType: 0x05 };
    const tags: HeaderTag[] = [];

    const requestId = stream.requestId ?? stream.subscribeId;
    if (requestId !== undefined) {
      headerFields.requestId = Number(requestId);
      tags.push({ label: 'request', value: String(requestId), kind: 'track' });
    }

    const objects = mapObjects(stream.objects);
    const headerEnd = objects.length > 0 ? objects[0].offset : data.length;

    return { streamType: 'fetch', headerEnd, headerFields, objects, tags };
  } catch {
    return null;
  }
}

function tryDecodeDatagram(
  codec: DataStreamCodec,
  data: Uint8Array,
): ParsedStreamFraming | null {
  try {
    const result = codec.decodeDatagram(data);
    if (!result.ok) return null;

    const dg = result.value;
    const headerFields: Record<string, number> = {
      trackAlias: Number(dg.trackAlias),
      groupId: Number(dg.groupId),
      objectId: Number(dg.objectId),
      publisherPriority: dg.publisherPriority,
    };
    if (dg.streamTypeId !== undefined) {
      headerFields.streamType = dg.streamTypeId;
    }

    const tags: HeaderTag[] = [
      { label: 'group', value: String(dg.groupId), kind: 'group' },
      { label: 'pri', value: String(dg.publisherPriority), kind: 'priority' },
    ];

    if (dg.status !== undefined && dg.status !== 0n) {
      headerFields.objectStatus = Number(dg.status);
      tags.push({ label: 'status', value: String(dg.status), kind: 'info' });
    }

    // Datagram payload offset: total size minus payload length
    const payloadOffset = data.length - dg.payload.length;
    const objects: StreamObject[] = [{
      offset: payloadOffset,
      payloadOffset,
      payloadLength: dg.payloadLength,
      objectId: Number(dg.objectId),
    }];

    return { streamType: 'datagram', headerEnd: payloadOffset, headerFields, objects, tags };
  } catch {
    return null;
  }
}

/** Map codec objects (with byte offsets) to our StreamObject format. */
function mapObjects(codecObjects: ObjectResult[]): StreamObject[] {
  return codecObjects.map((obj) => ({
    offset: obj.byteOffset,
    payloadOffset: obj.payloadByteOffset,
    payloadLength: obj.payloadLength,
    objectId: Number(obj.objectId),
  }));
}
