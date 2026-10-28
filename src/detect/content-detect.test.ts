/**
 * Which content type the background reports for a stream's first chunk.
 *
 * The detectors themselves (ISO BMFF boxes, Annex-B) live in @moqtap/media
 * and are tested there. What is tested here is the order this module asks
 * them in, which is the extension's own: a raw codec frame must not be
 * claimed by the looser checks after it, and a catalog must not be claimed
 * by the media checks before it.
 */

import { describe, expect, it } from 'vitest'
import { detectContentType } from './content-detect'

/** Build a Uint8Array from a hex string like "00 00 00 01 67" */
function bytes(hex: string): Uint8Array {
  return new Uint8Array(
    hex
      .trim()
      .split(/\s+/)
      .map((b) => parseInt(b, 16)),
  )
}

/** An ISO BMFF box: 32-bit size, four-character type, body. */
function box(type: string, body: number[] = []): number[] {
  const size = 8 + body.length
  return [
    (size >>> 24) & 0xff,
    (size >>> 16) & 0xff,
    (size >>> 8) & 0xff,
    size & 0xff,
    ...Array.from(type, (c) => c.charCodeAt(0)),
    ...body,
  ]
}

// Real captures from a hang broadcast (quicly.live → draft-14 relay).
// Each object is an 8-byte QUIC varint microsecond timestamp followed by an
// H.264 Annex-B access unit.
const KEYFRAME = bytes(`
  c0 00 00 00 87 d0 6d d3
  00 00 00 01 09 10
  00 00 00 01 67 64 00 1f ac 2b 40 28 02 dd 80 88 00 00 1f 40 00 07 53 00 78 e1
`)
const DELTA_FRAME = bytes(`
  c0 00 00 00 87 d0 e5 04
  00 00 00 01 09 30
  00 00 00 01 61 e0 22 6f 00 00 41 ac 1e 80 00 00 03 00 00 03 00 00 03 00 a2 9d
`)

describe('content type routing', () => {
  it('reports h264 for a hang video frame', () => {
    expect(detectContentType(KEYFRAME)).toBe('h264')
    expect(detectContentType(DELTA_FRAME)).toBe('h264')
  })

  it('still reports json for a catalog payload', () => {
    const hang = new TextEncoder().encode(
      '{"video":{"renditions":{"video":{"codec":"avc1.64001f"}}}}',
    )
    expect(detectContentType(hang)).toBe('json')
    const msf = new TextEncoder().encode(
      '{"version":1,"tracks":[{"name":"video","packaging":"cmaf"}]}',
    )
    expect(detectContentType(msf)).toBe('json')
  })

  it('reports fmp4 for a CMAF segment with no ftyp', () => {
    // A segment as a CMSF track sends it: styp, moof, mdat.
    const segment = new Uint8Array([
      ...box('styp', [
        ...Array.from('msdh', (c) => c.charCodeAt(0)),
        0,
        0,
        0,
        0,
      ]),
      ...box('moof', box('mfhd', [0, 0, 0, 0, 0, 0, 0, 1])),
      ...box('mdat', [1, 2, 3, 4]),
    ])
    expect(detectContentType(segment)).toBe('fmp4')
  })
})
