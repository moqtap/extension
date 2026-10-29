/**
 * Media read from bytes alone: init segments, movie fragments, and Annex-B
 * NAL units. The ISO BMFF payloads are the CMSF-01 object vectors of
 * @moqtap/test-vectors, as in cmaf.test.ts.
 */

import { parseCmafObject } from '@moqtap/media/cmaf'
import { describe, expect, it } from 'vitest'
import { annexBUnits, initTracksText, payloadBoxes, payloadInit } from './byte-media'

function hex(text: string): Uint8Array {
  return new Uint8Array(text.replace(/\s/g, '').match(/../g)!.map((b) => Number.parseInt(b, 16)))
}

// cmsf/draft01/objects: one trak, track_ID 1, timescale 90000.
const HEADER = hex(
  '0000001866747970636d663200000000636d663269736f36000001e56d6f6f760000006c6d766864000000000000000000000000000003e8000000000001000001000000000000000000000000010000000000000000000000000000000100000000000000000000000000004000000000000000000000000000000000000000000000000000000000000002000001497472616b0000005c746b6864000000030000000000000000000000010000000000000000000000000000000000000000000000000001000000000000000000000000000000010000000000000000000000000000400000000000000000000000000000e56d646961000000206d64686400000000000000000000000000015f900000000055c400000000002168646c72000000000000000076696465000000000000000000000000000000009c6d696e6600000014766d68640000000100000000000000000000002464696e660000001c6472656600000000000000010000000c75726c20000000010000005c7374626c000000107374736400000000000000000000001073747473000000000000000000000010737473630000000000000000000000147374737a000000000000000000000000000000107374636f0000000000000000000000286d766578000000207472657800000000000000010000000100000bb80000000001010000',
)
/** sap.json trun-first-sample-flags: a sync first sample */
const SYNC = hex(
  '000000686d6f6f66000000106d6668640000000000000001000000507472616600000014746668640002002000000001010100000000001474666474010000000000000000000000000000207472756e000002050000000200000070020000000000000400000004000000106d646174a0a0a0a0a1a1a1a1',
)
/** timing.json base-media-decode-time: tfdt 900000 */
const AT_10S = hex(
  '000000646d6f6f66000000106d66686400000000000000010000004c747261660000001074666864000200000000000100000014746664740100000000000000000dbba0000000207472756e00000205000000020000006c020000000000000400000004000000106d646174a0a0a0a0a1a1a1a1',
)

describe('init segments', () => {
  it('reads one from a payload with ftyp and moov', () => {
    const init = payloadInit(HEADER)
    expect(init?.tracks.map((t) => [t.trackId, t.timescale])).toEqual([[1, 90000]])
    expect(initTracksText(init!)).toBe('track_ID 1 vide')
    expect(payloadInit(SYNC)).toBeNull()
  })
})

describe('top-level boxes', () => {
  it('lists the boxes read, and nothing for bytes that are not boxes', () => {
    expect(payloadBoxes(HEADER)).toEqual(['ftyp', 'moov'])
    expect(payloadBoxes(SYNC)).toEqual(['moof', 'mdat'])
    expect(payloadBoxes(new Uint8Array([0, 0, 0, 1, 0x67, 0x64]))).toEqual([])
  })

  it('stops at the first box that is not one', () => {
    const tail = new Uint8Array([0, 0, 0, 9, 0x78, 0x78, 0x78, 0x78, 0])
    const joined = new Uint8Array([...SYNC, ...tail])
    expect(payloadBoxes(joined)).toEqual(['moof', 'mdat'])
  })
})

describe('fragments on their own', () => {
  it('reads the track_ID, the decode time in ticks and the sample count', () => {
    const traf = parseCmafObject(AT_10S).movieFragments[0]!.trackFragments[0]!
    expect(traf.header?.trackId).toBe(1)
    expect(traf.baseMediaDecodeTime).toBe(900000n)
    expect(traf.sampleCount).toBe(2)
  })

  it('reads the boxes, the moof sequence and first sample flags', () => {
    const object = parseCmafObject(SYNC)
    expect(object.boxes).toEqual(['moof', 'mdat'])
    expect(object.movieFragments[0]!.sequenceNumber).toBe(1)
    expect(object.firstSample.source).toBe('trun-first-sample-flags')
    expect(object.firstSample.sync).toBe(true)
  })
})

describe('Annex-B NAL units', () => {
  it('splits H.264 at 4- and 3-byte start codes', () => {
    const view = annexBUnits(
      hex('00000001 6764001fac | 00000001 68ee3c80 | 000001 65888400ff'.replace(/\|/g, '')),
      'h264',
    )
    expect(view?.prefix).toBe(0)
    expect(view?.units.map((u) => [u.offset, u.size, u.startCode, u.type, u.name, u.keyframe])).toEqual([
      [4, 5, 4, 7, 'SPS', false],
      [13, 4, 4, 8, 'PPS', false],
      [20, 5, 3, 5, 'IDR slice', true],
    ])
  })

  it('counts the bytes before the first start code', () => {
    const view = annexBUnits(hex('c0000000 87d06dd3 00000001 0910 00000001 6764001f'), 'h264')
    expect(view?.prefix).toBe(8)
    expect(view?.units.map((u) => u.name)).toEqual(['AUD', 'SPS'])
  })

  it('names H.265 units by their Table 7-1 mnemonics', () => {
    const view = annexBUnits(hex('00000001 40010c01 00000001 2601af'), 'h265')
    expect(view?.units.map((u) => [u.type, u.name, u.keyframe])).toEqual([
      [32, 'VPS_NUT', false],
      [19, 'IDR_W_RADL', true],
    ])
  })

  it('gives none for an invalid header or no start code', () => {
    expect(annexBUnits(hex('00000001 e7'), 'h264')).toBeNull()
    expect(annexBUnits(hex('00000001 4000'), 'h265')).toBeNull()
    expect(annexBUnits(hex('0102030405060708'), 'h264')).toBeNull()
  })
})
