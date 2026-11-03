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
import { parseStreamFraming, parseStreamPrefix } from './index'

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
