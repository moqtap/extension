import { createCodec } from '@moqtap/codec'
import { describe, expect, it } from 'vitest'
import { readDatagram } from './datagram'

// biome-ignore lint/suspicious/noExplicitAny: the codec's per-draft methods are not on its base type
const codec = (draft: string) => createCodec({ draft } as any) as any

describe('a datagram', () => {
  // draft-09 Section 8.3: "An OBJECT_DATAGRAM_STATUS is similar to
  // OBEJCT_DATAGRAM except it conveys an Object Status and has no payload."
  it('reads a draft-09 OBJECT_DATAGRAM_STATUS as an object with no payload', () => {
    const c = codec('09')
    const bytes = c.encodeDatagramStatus({
      type: 'datagram_status',
      streamTypeId: 0x02,
      trackAlias: 1n,
      groupId: 2n,
      objectId: 3n,
      publisherPriority: 0,
      objectStatus: 3n,
      extensionHeadersLength: 0n,
      extensionData: new Uint8Array(0),
    })
    const read = readDatagram(c, bytes)
    expect(read).toMatchObject({
      ok: true,
      value: { trackAlias: 1n, groupId: 2n, objectId: 3n, payloadLength: 0 },
    })
  })

  it("gives the decoder's code and reason for bytes that are no datagram", () => {
    const read = readDatagram(codec('22'), new Uint8Array([0x3f, 0xff, 0xff]))
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.code).not.toBe('')
    expect(read.reason).not.toBe('')
  })
})
