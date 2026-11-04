import { describe, expect, it } from 'vitest'
import { PADDING_DATAGRAM_TYPE, PADDING_STREAM_TYPE, readPadding } from './padding'
import { encodeVarintForDraft } from './varint'

const of = (draft: '17' | '18' | '23', type: number, rest: number[]) =>
  new Uint8Array([...encodeVarintForDraft(draft, type), ...rest])

// draft-23 Section 11.5.2: "The datagram contains the type followed by zero or
// more bytes that MUST all be set to zero."
describe('a padding datagram', () => {
  it('is padding under draft-18 and draft-23', () => {
    for (const draft of ['18', '23'] as const) {
      expect(readPadding(of(draft, PADDING_DATAGRAM_TYPE, [0, 0]), draft, 'datagram')).toEqual({
        nonzeroAt: null,
      })
    }
  })

  it('says where its data stops being zero', () => {
    const bytes = of('23', PADDING_DATAGRAM_TYPE, [0, 1])
    expect(readPadding(bytes, '23', 'datagram')).toEqual({ nonzeroAt: bytes.length - 1 })
  })

  it('is not a padding stream, and a padding stream is not one', () => {
    expect(readPadding(of('23', PADDING_DATAGRAM_TYPE, []), '23', 'stream')).toBeNull()
    expect(readPadding(of('23', PADDING_STREAM_TYPE, []), '23', 'datagram')).toBeNull()
  })

  it('does not exist before draft-18', () => {
    expect(readPadding(of('17', PADDING_DATAGRAM_TYPE, []), '17', 'datagram')).toBeNull()
  })

  it('needs its whole type', () => {
    const bytes = of('23', PADDING_DATAGRAM_TYPE, [])
    expect(readPadding(bytes.subarray(0, bytes.length - 1), '23', 'datagram')).toBeNull()
  })
})
