import { describe, expect, it } from 'vitest'
import { framingSummary, streamSummary } from './detail-text'

const T = '\u2009'

describe('streamSummary', () => {
  it('names the track, the kind, the chunks, the size once and the state', () => {
    expect(
      streamSummary({
        trackName: 'live / video/1080p',
        datagramGroup: false,
        bidi: false,
        byteCount: 12_600,
        chunkCount: 18,
        closed: true,
      }),
    ).toBe(`live / video/1080p · unidirectional · 18 chunks · 12.6${T}kB · closed`)
  })

  it('counts datagrams for a datagram group and leaves out what is unknown', () => {
    expect(
      streamSummary({ trackName: null, datagramGroup: true, byteCount: 900, chunkCount: 3, datagramCount: 1, closed: false }),
    ).toBe(`1 datagram · 900${T}B · open`)
    expect(streamSummary({ trackName: null, datagramGroup: false, byteCount: 0, chunkCount: 0, closed: false })).toBe(
      `0${T}B · open`,
    )
  })
})

describe('framingSummary', () => {
  it('writes header fields as plain text', () => {
    expect(
      framingSummary(
        'fMP4',
        [
          { label: 'group', value: '404463' },
          { label: 'subgroup', value: '1' },
          { label: 'pri', value: '1' },
        ],
        13,
      ),
    ).toBe('fMP4 · group 404463 · subgroup 1 · pri 1 · 13 objects')
  })

  it('is empty with nothing to say', () => {
    expect(framingSummary(null, [], null)).toBe('')
  })
})
