import { encodeSubgroupStream } from '@moqtap/codec/draft22'
import { describe, expect, it } from 'vitest'
import { parseStreamPrefix } from './stream-framing'
import { sourcesText, undecodableNotice } from './undecodable-stream'

// biome-ignore lint/suspicious/noExplicitAny: the encoder's stream type is nominal
type AnyStream = any

/** Objects 0 and 2 Normal; object 1 End of Group with a property, which draft-22 refuses. */
function refused(): Uint8Array {
  const object = (id: bigint, payload: number[], extra: object = {}) => ({
    type: 'object',
    byteOffset: 0,
    payloadByteOffset: 0,
    objectId: id,
    payloadLength: payload.length,
    payload: new Uint8Array(payload),
    extensionData: new Uint8Array(0),
    ...extra,
  })
  return encodeSubgroupStream({
    type: 'subgroup',
    headerType: 0x11,
    trackAlias: 5n,
    groupId: 0n,
    subgroupId: 0n,
    publisherPriority: 0,
    objects: [
      object(0n, [1, 2]),
      object(1n, [], { status: 3n, extensionData: new Uint8Array([0x02, 0x05]) }),
      object(2n, [3]),
    ],
  } as AnyStream)
}

describe("a stream's bytes that do not decode", () => {
  it('are named by offset and length, with the reason, on a live stream', () => {
    const bytes = refused()
    const end = parseStreamPrefix(bytes, '22', 'subgroup')!.end
    const { framing, undecodable } = undecodableNotice(bytes, '22', { complete: false })
    expect(framing?.objects.map((o) => o.objectId)).toEqual([0])
    expect(undecodable).toEqual({
      offset: end,
      title: `${bytes.length - end} bytes at offset 0x${end.toString(16)} don't decode`,
      reason: 'Only a Normal (0x0) Object may carry Properties, got status 0x3.',
    })
  })

  it('are what the trace recorded on an imported stream', () => {
    const bytes = refused()
    const end = parseStreamPrefix(bytes, '22', 'subgroup')!.end
    const { framing, undecodable } = undecodableNotice(bytes, '22', {
      complete: true,
      importedFraming: 'recorded',
      recorded: { reason: 'refused', length: 5000, offset: end },
    })
    expect(framing?.objects.map((o) => o.objectId)).toEqual([0])
    expect(undecodable).toEqual({
      offset: end,
      title: `5,000 bytes at offset 0x${end.toString(16)} don't decode; the trace kept ${bytes.length - end} bytes`,
      reason: 'Refused.',
    })
  })

  it('are named by length alone when the trace kept none of them', () => {
    const { undecodable } = undecodableNotice(new Uint8Array([1, 2]), '22', {
      complete: true,
      importedFraming: 'unavailable',
      recorded: { reason: 'refused', length: 40, offset: null },
    })
    expect(undecodable).toEqual({
      offset: null,
      title: "The trace records 40 bytes on this stream that didn't decode",
      reason: 'Refused.',
    })
  })

  it("are named per stream on a track's reading", () => {
    expect(
      sourcesText([
        { source: 's:7', offset: 0x2a, length: 1, reason: 'the stream ended inside an object' },
      ]),
    ).toBe("Stream 7: 1 byte at offset 0x2a doesn't decode. The stream ended inside an object.")
    expect(sourcesText([])).toBe('')
  })
})
