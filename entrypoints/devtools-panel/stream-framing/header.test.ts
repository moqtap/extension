/**
 * A stream's header is read with the session's draft alone. Read under another
 * draft's varints, a draft-22 header of type 0x55 gives an alias built from the
 * Group ID bytes (0x3E2A0101 for group 15914), naming a track that does not
 * exist.
 */
import { createCodec } from '@moqtap/codec'
import { describe, expect, it } from 'vitest'
import { parseStreamFraming, readStreamHeader } from './index'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const codec: any = createCodec({ draft: '22' })

function subgroup(headerType: number, groupId: bigint): Uint8Array {
  const obj = (id: bigint, payload: Uint8Array, status?: bigint) => ({
    type: 'object',
    byteOffset: 0,
    payloadByteOffset: 0,
    groupId,
    subgroupId: 1n,
    objectId: id,
    publisherPriority: 1,
    payloadLength: payload.length,
    payload,
    ...(status !== undefined ? { status } : {}),
    extensionData: new Uint8Array(0),
    extensionCount: 0,
    extensionHeadersLength: 0,
  })
  return codec.encodeSubgroupStream({
    type: 'subgroup',
    headerType,
    trackAlias: 0n,
    groupId,
    subgroupId: 1n,
    publisherPriority: 1,
    objects: [
      obj(0n, new Uint8Array(12915).fill(0x41)),
      obj(1n, new Uint8Array(0), 3n),
    ],
  })
}

describe('parseStreamFraming', () => {
  it('reads nothing from a stream cut inside an object', () => {
    const data = subgroup(0x55, 15914n)
    expect(parseStreamFraming(data.subarray(0, 12921), '22')).toBeNull()
  })

  it('reads nothing without a draft', () => {
    expect(parseStreamFraming(subgroup(0x55, 15914n))).toBeNull()
  })
})

describe('readStreamHeader', () => {
  for (const group of [15914n, 16393n]) {
    it(`reads alias 0 from a first chunk cut inside an object (group ${group})`, () => {
      const data = subgroup(0x55, group)
      for (const cut of [12921, 5000, 30]) {
        const header = readStreamHeader(data.subarray(0, cut), '22')
        expect(header.state).toBe('done')
        if (header.state !== 'done') continue
        expect(header.framing.streamType).toBe('subgroup')
        expect(header.framing.headerFields.trackAlias).toBe(0)
        expect(header.framing.headerFields.groupId).toBe(Number(group))
      }
    })
  }

  it('asks for more bytes while the header is incomplete', () => {
    const data = subgroup(0x55, 16393n)
    expect(readStreamHeader(data.subarray(0, 3), '22').state).toBe('pending')
  })

  it('gives up on bytes that are no stream header of the draft', () => {
    const control = new Uint8Array(80).fill(0x7f)
    expect(readStreamHeader(control, '22').state).toBe('invalid')
  })
})
