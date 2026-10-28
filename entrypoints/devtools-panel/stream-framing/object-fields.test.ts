/**
 * The per-object fields an exported trace has to carry.
 *
 * A `.moqtrace` is read long after the session it describes, by someone asking
 * what happened. Three fields decide whether it can answer:
 *
 *  - **Object Status.** Only a zero-length object has one, and it is the whole
 *    difference between an object that carried no bytes and an object that
 *    marked the end of a group. It was hardcoded to 0 at export, so the two
 *    were indistinguishable in every trace this extension has ever written.
 *  - **A fetch object's Group ID and Priority.** A fetch stream has no group in
 *    its header — Section 11.4.4 puts one on every object — so taking the value
 *    from the header gave every object group 0, on the one stream type whose
 *    point is that it spans groups.
 *  - **Object ID**, which is covered here too because a capture from 0.1.0 was
 *    found with `objectId: 0` on all 2081 of its objects, and nothing in the
 *    suite would have caught that.
 *
 * The assertions are on values read back out of the parser, against bytes this
 * test encoded, so a regression shows up as a wrong number rather than as an
 * absent field.
 */

import { encodeFetchStream, encodeSubgroupStream } from '@moqtap/codec/draft14'
import {
  encodeObjectProperties as encodeObjectProperties22,
  encodeSubgroupStream as encodeSubgroupStream22,
} from '@moqtap/codec/draft22'
import { describe, expect, it } from 'vitest'
import { decodeObjectProperties, parseStreamFraming } from './index'

// The codec's per-draft stream types are nominal and this file builds fixtures
// for them rather than consuming them.
// biome-ignore lint/suspicious/noExplicitAny: see above
type AnyStream = any

function subgroupWithStatusObject(): Uint8Array {
  return encodeSubgroupStream({
    type: 'subgroup',
    headerType: 0x10,
    trackAlias: 1n,
    groupId: 7n,
    subgroupId: 0n,
    publisherPriority: 200,
    objects: [
      {
        type: 'object',
        byteOffset: 0,
        payloadByteOffset: 0,
        objectId: 0n,
        payloadLength: 2,
        payload: new Uint8Array([0xde, 0xad]),
        extensionData: new Uint8Array(0),
      },
      {
        // Zero length, so this one carries a status — 3 is End of Group.
        type: 'object',
        byteOffset: 0,
        payloadByteOffset: 0,
        objectId: 1n,
        payloadLength: 0,
        status: 3n,
        payload: new Uint8Array(0),
        extensionData: new Uint8Array(0),
      },
    ],
  } as AnyStream)
}

describe('an exported object keeps its own identity', () => {
  it('numbers objects in order rather than reporting them all as zero', () => {
    const framing = parseStreamFraming(subgroupWithStatusObject(), '14')
    expect(framing?.streamType).toBe('subgroup')
    expect(framing?.objects.map((o) => o.objectId)).toEqual([0, 1])
  })

  it('records the Object Status of a zero-length object', () => {
    const framing = parseStreamFraming(subgroupWithStatusObject(), '14')
    const [normal, endOfGroup] = framing?.objects ?? []
    expect(normal?.payloadLength).toBe(2)
    // A normal object has no status to record, and inventing 0 for it would be
    // the same mistake in the other direction.
    expect(normal?.status).toBeUndefined()
    expect(endOfGroup?.payloadLength).toBe(0)
    expect(endOfGroup?.status).toBe(3)
  })

  it('distinguishes an empty object from one that ended the group', () => {
    // The property the status exists for, stated as the question a reader asks.
    const framing = parseStreamFraming(subgroupWithStatusObject(), '14')
    const zeroLength = (framing?.objects ?? []).filter(
      (o) => o.payloadLength === 0,
    )
    expect(zeroLength).toHaveLength(1)
    // `not.toBe(0)` alone would pass when the field is absent -- undefined is
    // not 0 either. The status has to be *there*.
    expect(zeroLength[0]?.status).toBeTypeOf('number')
    expect(zeroLength[0]?.status).not.toBe(0)
  })
})

describe('a fetch object keeps the group and priority it carries itself', () => {
  /**
   * Three objects across two groups with two priorities. Serialization Flags
   * 0x1C sets Group ID present, Object ID Delta present and Priority present,
   * which is what makes those fields per-object rather than per-stream.
   */
  function fetchStream(): Uint8Array {
    const obj = (
      groupId: bigint,
      objectId: bigint,
      priority: number,
    ): AnyStream => ({
      type: 'object',
      byteOffset: 0,
      payloadByteOffset: 0,
      serializationFlags: 0x1c,
      groupId,
      subgroupId: 0n,
      objectId,
      publisherPriority: priority,
      payloadLength: 2,
      payload: new Uint8Array([1, 2]),
      extensionData: new Uint8Array(0),
    })
    return encodeFetchStream({
      type: 'fetch',
      requestId: 9n,
      objects: [obj(4n, 0n, 10), obj(4n, 1n, 10), obj(9n, 0n, 200)],
    } as AnyStream)
  }

  it('parses as a fetch stream at all', () => {
    // Guards the two tests below: if this stopped being recognised they would
    // pass vacuously against an empty object list.
    const framing = parseStreamFraming(fetchStream(), '14')
    expect(framing?.streamType).toBe('fetch')
    expect(framing?.objects).toHaveLength(3)
  })

  it("gives each object its own Group ID, not the stream header's", () => {
    const framing = parseStreamFraming(fetchStream(), '14')
    // A fetch stream header has no Group ID at all, so reading the group off
    // the header would make every one of these 0 and lose the group boundary.
    expect(framing?.objects.map((o) => o.groupId)).toEqual([4, 4, 9])
  })

  it('gives each object its own Publisher Priority', () => {
    const framing = parseStreamFraming(fetchStream(), '14')
    expect(framing?.objects.map((o) => o.publisherPriority)).toEqual([
      10, 10, 200,
    ])
  })
})

describe('object properties', () => {
  // draft-22 subgroup stream, PROPERTIES set: one object whose property block is
  // 0x0D (odd, bytes cafe) then 0x3C = 2, written as the delta 0x2F.
  const stream = encodeSubgroupStream22({
    type: 'subgroup',
    headerType: 0x11,
    trackAlias: 1n,
    groupId: 0n,
    subgroupId: 0n,
    publisherPriority: 128,
    objects: [
      {
        type: 'object',
        byteOffset: 0,
        payloadByteOffset: 0,
        objectId: 0n,
        payloadLength: 2,
        payload: new Uint8Array([0xbe, 0xef]),
        extensionData: encodeObjectProperties22([
          { type: 0x0dn, bytes: new Uint8Array([0xca, 0xfe]) },
          { type: 0x3cn, value: 2n },
        ]),
      },
    ],
  } as AnyStream)

  it('locates the property block in the stream', () => {
    const framing = parseStreamFraming(stream, '22')
    const obj = framing?.objects[0]
    expect(obj?.propertiesLength).toBe(6)
    const block = stream.subarray(
      obj!.propertiesOffset!,
      obj!.propertiesOffset! + 6,
    )
    expect(Array.from(block)).toEqual([0x0d, 0x02, 0xca, 0xfe, 0x2f, 0x02])
  })

  it('decodes the block with the draft that framed it', () => {
    const obj = parseStreamFraming(stream, '22')!.objects[0]!
    const block = stream.subarray(
      obj.propertiesOffset!,
      obj.propertiesOffset! + obj.propertiesLength!,
    )
    const result = decodeObjectProperties(block, '22')
    expect(result?.ok).toBe(true)
    if (!result?.ok) return
    expect(result.value.map((p) => p.type)).toEqual([0x0dn, 0x3cn])
    expect(result.value[1]?.value).toBe(2n)
  })

  it('leaves both fields off an object that has no properties field', () => {
    const framing = parseStreamFraming(subgroupWithStatusObject(), '14')
    expect(framing?.objects[0]).not.toHaveProperty('propertiesOffset')
  })
})

describe('datagram status and type', () => {
  // draft-22 OBJECT_DATAGRAM, STATUS set (0x20): alias 1, group 0, object 5,
  // priority 0x80, status 3 (End of Group).
  const bytes = new Uint8Array([0x20, 0x01, 0x00, 0x05, 0x80, 0x03])

  it('reports the datagram type', () => {
    expect(parseStreamFraming(bytes, '22')?.headerFields.streamType).toBe(0x20)
  })

  it('reports the object status', () => {
    const framing = parseStreamFraming(bytes, '22')
    expect(framing?.headerFields.objectStatus).toBe(3)
    expect(framing?.objects[0]?.status).toBe(3)
  })
})
