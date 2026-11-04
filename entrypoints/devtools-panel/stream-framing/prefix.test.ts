/**
 * The longest prefix of a stream that frames, and why the rest does not: an
 * object cut short, or one the draft refuses.
 */

import {
  encodeSubgroupStream as encodeSubgroupStream14,
} from '@moqtap/codec/draft14'
import {
  encodeSubgroupStream as encodeSubgroupStream22,
} from '@moqtap/codec/draft22'
import { describe, expect, it } from 'vitest'
import { NONZERO_PADDING, PADDING_STREAM_TYPE } from '@/src/codec/padding'
import { encodeVarintForDraft } from '@/src/codec/varint'
import {
  CUT_HEADER,
  CUT_OBJECT,
  parseStreamFraming,
  parseStreamPrefix,
  readStream,
} from './index'

// The codec's per-draft stream types are nominal and this file builds fixtures
// for them rather than consuming them.
// biome-ignore lint/suspicious/noExplicitAny: see above
type AnyStream = any

function object(
  id: bigint,
  payload: number[],
  status?: bigint,
  properties: number[] = [],
) {
  return {
    type: 'object',
    byteOffset: 0,
    payloadByteOffset: 0,
    objectId: id,
    payloadLength: payload.length,
    payload: new Uint8Array(payload),
    extensionData: new Uint8Array(properties),
    ...(status !== undefined ? { status } : {}),
  }
}

/** Header type 0x11: the objects carry a properties field. */
function stream(
  encode: (s: AnyStream) => Uint8Array,
  status: bigint,
): Uint8Array {
  return encode({
    type: 'subgroup',
    headerType: 0x11,
    trackAlias: 5n,
    groupId: 0n,
    subgroupId: 0n,
    publisherPriority: 0,
    objects: [
      object(0n, [1, 2]),
      // One property: type 2, value 5.
      object(1n, [], status, [0x02, 0x05]),
      object(2n, [3]),
    ],
  } as AnyStream)
}

describe('a stream prefix', () => {
  // draft-22 Section 11.1.2: "Any Object with status Normal can have
  // properties (Section 8.4). If an endpoint receives properties on an Object
  // with status that is not Normal, it MUST close the session with a
  // PROTOCOL_VIOLATION."
  it('names refused properties on an End of Group object, draft-22', () => {
    const bytes = stream(encodeSubgroupStream22, 3n)
    expect(parseStreamFraming(bytes, '22')).toBeNull()
    const prefix = parseStreamPrefix(bytes, '22', 'subgroup')
    expect(prefix?.framing.objects.map((o) => o.objectId)).toEqual([0])
    expect(prefix?.refused).toBe(
      'only a Normal (0x0) Object may carry Properties, got status 0x3',
    )
  })

  // draft-14 Section 10.2.1.2: "Any Object may have extension headers except
  // those with Object Status 'Object Does Not Exist'. If an endpoint receives
  // a non-existent Object containing extension headers it MUST close the
  // session with a PROTOCOL_VIOLATION."
  it('names refused extension headers on Does Not Exist, draft-14', () => {
    const bytes = stream(encodeSubgroupStream14, 1n)
    expect(parseStreamFraming(bytes, '14')).toBeNull()
    const prefix = parseStreamPrefix(bytes, '14', 'subgroup')
    expect(prefix?.framing.objects.map((o) => o.objectId)).toEqual([0])
    expect(prefix?.refused).toBe(
      'an Object Does Not Exist (0x1) must not carry extension headers',
    )
  })

  it('names no refusal for a stream that ends inside an object', () => {
    const bytes = stream(encodeSubgroupStream22, 0n)
    const prefix = parseStreamPrefix(
      bytes.subarray(0, bytes.length - 1),
      '22',
      'subgroup',
    )
    expect(prefix?.framing.objects.map((o) => o.objectId)).toEqual([0, 1])
    expect(prefix).not.toHaveProperty('refused')
  })
})

describe('a stream read under its draft', () => {
  it('keeps the bytes from a refused object to the end, with the reason', () => {
    const bytes = stream(encodeSubgroupStream22, 3n)
    const prefix = parseStreamPrefix(bytes, '22', 'subgroup')!
    const read = readStream(bytes, '22', { complete: false })
    expect(read.framing?.objects.map((o) => o.objectId)).toEqual([0])
    expect(read.undecodable).toEqual({
      offset: prefix.end,
      length: bytes.length - prefix.end,
      reason: 'only a Normal (0x0) Object may carry Properties, got status 0x3',
    })
  })

  it('names a cut object only once the stream is complete', () => {
    const whole = stream(encodeSubgroupStream22, 0n)
    const bytes = whole.subarray(0, whole.length - 1)
    expect(readStream(bytes, '22', { complete: false }).undecodable).toBeNull()
    const read = readStream(bytes, '22', { complete: true })
    expect(read.framing?.objects.map((o) => o.objectId)).toEqual([0, 1])
    expect(read.undecodable).toMatchObject({ reason: CUT_OBJECT })
    expect(read.undecodable!.offset + read.undecodable!.length).toBe(bytes.length)
  })

  it('names a cut header only once the stream is complete', () => {
    const bytes = new Uint8Array([0x10, 0x05])
    expect(readStream(bytes, '22', { complete: false })).toEqual({
      framing: null,
      undecodable: null,
    })
    expect(readStream(bytes, '22', { complete: true })).toEqual({
      framing: null,
      undecodable: { offset: 0, length: 2, reason: CUT_HEADER },
    })
  })

  // draft-22 Section 11.3.1: "The following Type Flags values are invalid. If
  // an endpoint receives a stream header with any of these values, it MUST
  // close the session with a PROTOCOL_VIOLATION: Values with SUBGROUP_ID_MODE
  // set to 0b11." Type Flags 0x16 has that mode.
  it('keeps every byte of a stream whose header the draft refuses', () => {
    const bytes = new Uint8Array([0x16, 0x05, 0x00, 0x00, 0x80, 0x00, 0x01, 0xaa])
    const read = readStream(bytes, '22', { complete: false })
    expect(read.framing).toBeNull()
    expect(read.undecodable).toEqual({
      offset: 0,
      length: bytes.length,
      reason: 'SUBGROUP_HEADER Type Flags 0x16 sets SUBGROUP_ID_MODE to the reserved 0b11',
    })
  })

  it('reads a whole stream with nothing left over', () => {
    const bytes = stream(encodeSubgroupStream22, 0n)
    const read = readStream(bytes, '22', { complete: true })
    expect(read.framing?.objects).toHaveLength(3)
    expect(read.undecodable).toBeNull()
  })

  // draft-23 Section 11.3.2: "If a sender closes the stream before delivering
  // all such objects to the QUIC stream, it MUST reset the stream."
  it('names no bytes in a stream reset inside an object', () => {
    const whole = stream(encodeSubgroupStream22, 0n)
    const read = readStream(whole.subarray(0, whole.length - 1), '22', { complete: false })
    expect(read.framing?.objects.map((o) => o.objectId)).toEqual([0, 1])
    expect(read.undecodable).toBeNull()
  })
})

// draft-23 Section 11.5.1: "The stream begins with the stream type, followed
// by zero or more bytes that MUST all be set to zero."
describe('a padding stream', () => {
  const type = encodeVarintForDraft('23', PADDING_STREAM_TYPE)
  const padding = (rest: number[]) => new Uint8Array([...type, ...rest])

  it('is padding, with no objects and nothing undecodable', () => {
    for (const rest of [[], [0, 0, 0, 0]]) {
      expect(readStream(padding(rest), '23', { complete: true })).toEqual({
        framing: null,
        undecodable: null,
        padding: true,
      })
    }
  })

  it('names its bytes from the first one that is not zero', () => {
    const bytes = padding([0, 0, 7, 0])
    expect(readStream(bytes, '23', { complete: true })).toEqual({
      framing: null,
      undecodable: { offset: type.length + 2, length: 2, reason: NONZERO_PADDING },
      padding: true,
    })
  })

  it('is not padding before draft-18', () => {
    const bytes = new Uint8Array([...encodeVarintForDraft('17', PADDING_STREAM_TYPE), 0])
    expect(readStream(bytes, '17', { complete: true }).padding).toBeUndefined()
  })
})
