/**
 * Frame badges on object rows: H.264 IDR or slice type, H.265 IRAP only,
 * nothing without a header to read by.
 */

import { readFrameType } from '@moqtap/media/frames'
import { describe, expect, it } from 'vitest'
import { frameBadge, objectFrames } from './frames'

const h264 = (...bytes: number[]) =>
  readFrameType(new Uint8Array([0, 0, 0, bytes.length, ...bytes]), { codec: 'h264', lengthSize: 4 })
const h265 = (...bytes: number[]) =>
  readFrameType(new Uint8Array([0, 0, 0, bytes.length, ...bytes]), { codec: 'h265', lengthSize: 4 })

describe('frame badges', () => {
  it('name an H.264 IDR, else the slice type', () => {
    expect(frameBadge(h264(0x65, 0x88))).toBe('IDR')
    // first_mb_in_slice 0, slice_type 0 (P) / 1 (B)
    expect(frameBadge(h264(0x41, 0xc0))).toBe('P')
    expect(frameBadge(h264(0x41, 0xa0))).toBe('B')
  })

  it('mark an H.265 IRAP picture and nothing else', () => {
    expect(frameBadge(h265(0x26, 0x01, 0xaf))).toBe('IRAP')
    expect(frameBadge(h265(0x02, 0x01, 0xd0))).toBeNull()
  })

  it('are absent without a header to read the samples by', () => {
    expect(objectFrames(new Uint8Array(8), null)).toEqual({ badge: null, mismatches: [] })
  })
})
