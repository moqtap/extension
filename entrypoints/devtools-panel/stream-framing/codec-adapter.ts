/**
 * Adapter that wraps @moqtap/codec's per-draft data stream decoders
 * into the extension's DraftParser format.
 *
 * Each draft gets its own codec instance via createCodec({ draft }).
 * The codec handles all draft-specific wire format differences internally,
 * including per-object byte offsets for the hex viewer.
 */

import type { SupportedDraft } from '@/src/types/common'
import {
  createCodec,
  type DecodeResult,
  type ObjectProperty,
} from '@moqtap/codec'
import type {
  DraftParser,
  HeaderTag,
  ParsedStreamFraming,
  StreamObject,
} from './types'

/** Codec with data stream decoders (all drafts) */
interface DataStreamCodec {
  decodeSubgroupStream(bytes: Uint8Array): DecodeResult<SubgroupResult>
  decodeFetchStream(bytes: Uint8Array): DecodeResult<FetchResult>
  decodeDatagram(bytes: Uint8Array): DecodeResult<DatagramResult>
  /** Draft-08 to -10, where a status datagram is a type of its own */
  decodeDatagramStatus?(bytes: Uint8Array): DecodeResult<DatagramStatusResult>
  decodeObjectProperties(bytes: Uint8Array): DecodeResult<ObjectProperty[]>
}

/** Minimal shape of SubgroupStream result from the codec */
interface SubgroupResult {
  readonly type: 'subgroup'
  /** The stream type: `streamTypeId` up to draft-13, `headerType` from draft-14. */
  readonly streamTypeId?: number
  readonly headerType?: number
  readonly trackAlias: bigint
  readonly groupId: bigint
  readonly subgroupId: bigint
  readonly publisherPriority: number
  readonly objects: ObjectResult[]
}

/** Minimal shape of FetchStream result from the codec */
interface FetchResult {
  readonly type: 'fetch'
  readonly requestId?: bigint
  readonly subscribeId?: bigint
  readonly objects: FetchObjectResult[]
}

/** Minimal shape of DatagramObject from the codec */
interface DatagramResult {
  readonly type: 'datagram'
  /** The datagram type: `streamTypeId` up to draft-13, `datagramType` from draft-14. */
  readonly streamTypeId?: number
  readonly datagramType?: number
  readonly trackAlias: bigint
  readonly groupId: bigint
  readonly objectId: bigint
  readonly publisherPriority: number
  readonly payloadLength?: number
  /** `objectStatus` from draft-08; draft-07's datagram has no status at all. */
  readonly objectStatus?: bigint
  readonly payload: Uint8Array
  readonly extensionData?: Uint8Array
  readonly extensionDataByteOffset?: number
}

/** Minimal shape of DatagramStatusObject from the codec (draft-08 to -10) */
interface DatagramStatusResult {
  readonly type: 'datagram_status'
  readonly streamTypeId: number
  readonly trackAlias: bigint
  readonly groupId: bigint
  readonly objectId: bigint
  readonly publisherPriority: number
  readonly objectStatus: bigint
  readonly extensionData?: Uint8Array
  readonly extensionDataByteOffset?: number
}

/** Minimal shape of ObjectPayload from the codec */
interface ObjectResult {
  readonly objectId: bigint
  readonly payloadLength: number
  readonly status?: bigint
  readonly payload: Uint8Array
  readonly byteOffset: number
  readonly payloadByteOffset: number
  readonly extensionData?: Uint8Array
  readonly extensionDataByteOffset?: number
}

/** Minimal shape of FetchObjectPayload from the codec */
interface FetchObjectResult extends ObjectResult {
  /** From draft-15; 128 and above is an End of Range marker */
  readonly serializationFlags?: number
  readonly groupId?: bigint
  readonly subgroupId?: bigint
  readonly publisherPriority?: number
}

/**
 * Create a DraftParser that delegates to the codec's per-draft decoders.
 * Works for every draft `SUPPORTED_DRAFTS` names.
 */
export function createCodecDraftParser(draft: SupportedDraft): DraftParser {
  const codec = createCodec({ draft }) as unknown as DataStreamCodec

  return (data: Uint8Array): ParsedStreamFraming | null => {
    if (data.length < 3) return null

    // Try subgroup first, then fetch, then datagram
    return (
      tryDecodeSubgroup(codec, data) ??
      tryDecodeFetch(codec, data) ??
      tryDecodeDatagram(codec, data)
    )
  }
}

/**
 * A parser for the longest prefix of a stream that frames whole as `kind`
 * under this draft alone, for a stream that ends inside an object. Each try
 * cuts the bytes back to the codec's error offset, or by one byte.
 */
export function createCodecPrefixParser(
  draft: SupportedDraft,
): (data: Uint8Array, kind: 'subgroup' | 'fetch') => ParsedPrefix | null {
  const codec = createCodec({ draft }) as unknown as DataStreamCodec

  return (data, kind) => {
    let end = data.length
    for (let tries = 0; tries < MAX_PREFIX_TRIES && end > 0; tries++) {
      const bytes = data.subarray(0, end)
      let next: number
      try {
        if (kind === 'subgroup') {
          const result = codec.decodeSubgroupStream(bytes)
          if (result.ok)
            return { framing: subgroupFraming(result.value, end), end }
          next = result.error.offset
        } else {
          const result = codec.decodeFetchStream(bytes)
          if (result.ok)
            return { framing: fetchFraming(result.value, end), end }
          next = result.error.offset
        }
      } catch {
        return null
      }
      end = Math.min(end - 1, next)
    }
    return null
  }
}

/** The longest prefix of a stream that frames, and where it ends. */
export interface ParsedPrefix {
  framing: ParsedStreamFraming
  /** Bytes the framing covers; past it is an object cut short */
  end: number
}

/** Decode attempts {@link createCodecPrefixParser} makes before giving up. */
const MAX_PREFIX_TRIES = 64

function tryDecodeSubgroup(
  codec: DataStreamCodec,
  data: Uint8Array,
): ParsedStreamFraming | null {
  try {
    const result = codec.decodeSubgroupStream(data)
    if (!result.ok) return null
    return subgroupFraming(result.value, data.length)
  } catch {
    return null
  }
}

/** A decoded subgroup stream of `length` bytes, as the panel frames it. */
function subgroupFraming(
  stream: SubgroupResult,
  length: number,
): ParsedStreamFraming {
  const headerFields: Record<string, number> = {}
  const tags: HeaderTag[] = []

  const streamType = stream.headerType ?? stream.streamTypeId
  if (streamType !== undefined) {
    headerFields.streamType = streamType
  }
  headerFields.trackAlias = Number(stream.trackAlias)
  headerFields.groupId = Number(stream.groupId)
  tags.push({ label: 'group', value: String(stream.groupId), kind: 'group' })

  headerFields.subgroupId = Number(stream.subgroupId)
  if (stream.subgroupId !== 0n) {
    tags.push({
      label: 'subgroup',
      value: String(stream.subgroupId),
      kind: 'info',
    })
  }

  if (stream.publisherPriority !== undefined) {
    headerFields.publisherPriority = stream.publisherPriority
    tags.push({
      label: 'pri',
      value: String(stream.publisherPriority),
      kind: 'priority',
    })
  }

  const objects = mapObjects(stream.objects)
  const headerEnd = objects.length > 0 ? objects[0].offset : length

  return { streamType: 'subgroup', headerEnd, headerFields, objects, tags }
}

function tryDecodeFetch(
  codec: DataStreamCodec,
  data: Uint8Array,
): ParsedStreamFraming | null {
  try {
    const result = codec.decodeFetchStream(data)
    if (!result.ok) return null
    return fetchFraming(result.value, data.length)
  } catch {
    return null
  }
}

/** A decoded fetch stream of `length` bytes, as the panel frames it. */
function fetchFraming(
  stream: FetchResult,
  length: number,
): ParsedStreamFraming {
  const headerFields: Record<string, number> = { streamType: 0x05 }
  const tags: HeaderTag[] = []

  const requestId = stream.requestId ?? stream.subscribeId
  if (requestId !== undefined) {
    headerFields.requestId = Number(requestId)
    tags.push({ label: 'request', value: String(requestId), kind: 'track' })
  }

  const objects = mapFetchObjects(stream.objects)
  const headerEnd = objects.length > 0 ? objects[0].offset : length

  return { streamType: 'fetch', headerEnd, headerFields, objects, tags }
}

function tryDecodeDatagram(
  codec: DataStreamCodec,
  data: Uint8Array,
): ParsedStreamFraming | null {
  try {
    const result = codec.decodeDatagram(data)
    if (!result.ok) return tryDecodeDatagramStatus(codec, data)

    const dg = result.value
    const headerFields: Record<string, number> = {
      trackAlias: Number(dg.trackAlias),
      groupId: Number(dg.groupId),
      objectId: Number(dg.objectId),
      publisherPriority: dg.publisherPriority,
    }
    const datagramType = dg.datagramType ?? dg.streamTypeId
    if (datagramType !== undefined) {
      headerFields.streamType = datagramType
    }

    const tags: HeaderTag[] = [
      { label: 'group', value: String(dg.groupId), kind: 'group' },
      { label: 'pri', value: String(dg.publisherPriority), kind: 'priority' },
    ]

    const status = dg.objectStatus
    if (status !== undefined && status !== 0n) {
      headerFields.objectStatus = Number(status)
      tags.push({ label: 'status', value: String(status), kind: 'info' })
    }

    // Datagram payload offset: total size minus payload length
    const payloadOffset = data.length - dg.payload.length
    const objects: StreamObject[] = [
      {
        offset: payloadOffset,
        payloadOffset,
        payloadLength: dg.payloadLength ?? dg.payload.length,
        objectId: Number(dg.objectId),
        groupId: Number(dg.groupId),
        publisherPriority: dg.publisherPriority,
        ...(status !== undefined ? { status: Number(status) } : {}),
        ...propertiesSpan(dg),
      },
    ]

    return {
      streamType: 'datagram',
      headerEnd: payloadOffset,
      headerFields,
      objects,
      tags,
    }
  } catch {
    return null
  }
}

/**
 * A draft-08 to -10 status datagram, which the datagram decoder refuses. It
 * must end where the status does.
 */
function tryDecodeDatagramStatus(
  codec: DataStreamCodec,
  data: Uint8Array,
): ParsedStreamFraming | null {
  const result = codec.decodeDatagramStatus?.(data)
  if (!result?.ok || result.bytesRead !== data.length) return null
  const dg = result.value
  const status = Number(dg.objectStatus)
  return {
    streamType: 'datagram',
    headerEnd: data.length,
    headerFields: {
      trackAlias: Number(dg.trackAlias),
      groupId: Number(dg.groupId),
      objectId: Number(dg.objectId),
      publisherPriority: dg.publisherPriority,
      streamType: dg.streamTypeId,
      objectStatus: status,
    },
    objects: [
      {
        offset: data.length,
        payloadOffset: data.length,
        payloadLength: 0,
        objectId: Number(dg.objectId),
        groupId: Number(dg.groupId),
        publisherPriority: dg.publisherPriority,
        status,
        ...propertiesSpan(dg),
      },
    ],
    tags: [
      { label: 'group', value: String(dg.groupId), kind: 'group' },
      { label: 'pri', value: String(dg.publisherPriority), kind: 'priority' },
      { label: 'status', value: String(dg.objectStatus), kind: 'info' },
    ],
  }
}

/**
 * Map codec objects (with byte offsets) to our StreamObject format.
 *
 * `status` is carried through because only a zero-length object has one, and it
 * is what separates an object that carried no bytes from one that marked the
 * end of a group. Dropping it here would not surface as a gap: `build-trace.ts`
 * exports `obj.status ?? 0`, so an absent status silently becomes a real 0.
 */
function mapObjects(codecObjects: ObjectResult[]): StreamObject[] {
  return codecObjects.map((obj) => ({
    offset: obj.byteOffset,
    payloadOffset: obj.payloadByteOffset,
    payloadLength: obj.payloadLength,
    objectId: Number(obj.objectId),
    ...(obj.status !== undefined ? { status: Number(obj.status) } : {}),
    ...propertiesSpan(obj),
  }))
}

/** Where an Object's property block sits in the stream. */
function propertiesSpan(obj: {
  readonly extensionData?: Uint8Array
  readonly extensionDataByteOffset?: number
}): Pick<StreamObject, 'propertiesOffset' | 'propertiesLength'> {
  if (obj.extensionDataByteOffset === undefined) return {}
  return {
    propertiesOffset: obj.extensionDataByteOffset,
    propertiesLength: obj.extensionData?.length ?? 0,
  }
}

/**
 * The draft's decoder for an Object's property block, the bytes at
 * `propertiesOffset` for `propertiesLength`.
 */
export function createPropertiesDecoder(
  draft: SupportedDraft,
): (bytes: Uint8Array) => DecodeResult<ObjectProperty[]> {
  const codec = createCodec({ draft }) as unknown as DataStreamCodec
  return (bytes) => codec.decodeObjectProperties(bytes)
}

/**
 * The same, for fetch objects. Fetch objects carry their own Group ID,
 * Subgroup ID and Priority (Section 11.4.4); a fetch stream header has none.
 */
function mapFetchObjects(codecObjects: FetchObjectResult[]): StreamObject[] {
  return mapObjects(codecObjects).map((mapped, i) => {
    const obj = codecObjects[i] as FetchObjectResult
    return {
      ...mapped,
      ...(obj.groupId !== undefined ? { groupId: Number(obj.groupId) } : {}),
      ...(obj.subgroupId !== undefined
        ? { subgroupId: Number(obj.subgroupId) }
        : {}),
      ...(obj.publisherPriority !== undefined
        ? { publisherPriority: obj.publisherPriority }
        : {}),
      ...(obj.serializationFlags !== undefined && obj.serializationFlags >= 128
        ? { endOfRange: obj.serializationFlags }
        : {}),
    }
  })
}
