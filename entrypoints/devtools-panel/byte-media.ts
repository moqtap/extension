/**
 * Media read from what a stream's bytes prove, for a track with no catalog
 * packaging or pin: ISO BMFF boxes, and Annex-B NAL units.
 */

import { detectMediaInfo, type InitSegment, parseInitSegment } from '@moqtap/media/bmff'

// ─── ISO BMFF ─────────────────────────────────────────────────────

/** The init segment (ftyp + moov) a payload is or starts with, or null. */
export function payloadInit(payload: Uint8Array): InitSegment | null {
  const boxes = detectMediaInfo(payload)?.boxes
  if (!boxes?.includes('ftyp') || !boxes.includes('moov')) return null
  return parseInitSegment(payload)
}

/** An init segment's tracks in a few words. */
export function initTracksText(segment: InitSegment): string {
  return segment.tracks
    .map((t) => `track_ID ${t.trackId ?? '?'} ${t.codec ?? t.handler ?? ''}`.trim())
    .join(', ')
}

// ─── Annex-B ──────────────────────────────────────────────────────

/** nal_unit_type names, H.264 Table 7-1 */
const H264_NAMES: Record<number, string> = {
  1: 'non-IDR slice',
  2: 'slice data partition A',
  3: 'slice data partition B',
  4: 'slice data partition C',
  5: 'IDR slice',
  6: 'SEI',
  7: 'SPS',
  8: 'PPS',
  9: 'AUD',
  10: 'end of sequence',
  11: 'end of stream',
  12: 'filler data',
  13: 'SPS extension',
  14: 'prefix NAL unit',
  15: 'subset SPS',
  16: 'DPS',
  19: 'auxiliary slice',
  20: 'slice extension',
  21: 'depth view slice extension',
}

/** nal_unit_type names, H.265 Table 7-1 */
const H265_NAMES: Record<number, string> = {
  0: 'TRAIL_N',
  1: 'TRAIL_R',
  2: 'TSA_N',
  3: 'TSA_R',
  4: 'STSA_N',
  5: 'STSA_R',
  6: 'RADL_N',
  7: 'RADL_R',
  8: 'RASL_N',
  9: 'RASL_R',
  16: 'BLA_W_LP',
  17: 'BLA_W_RADL',
  18: 'BLA_N_LP',
  19: 'IDR_W_RADL',
  20: 'IDR_N_LP',
  21: 'CRA_NUT',
  32: 'VPS_NUT',
  33: 'SPS_NUT',
  34: 'PPS_NUT',
  35: 'AUD_NUT',
  36: 'EOS_NUT',
  37: 'EOB_NUT',
  38: 'FD_NUT',
  39: 'PREFIX_SEI_NUT',
  40: 'SUFFIX_SEI_NUT',
}

export interface NalUnit {
  /** Offset of the NAL unit header in the payload */
  offset: number
  /** Bytes from the header to the next start code or trailing zeros */
  size: number
  startCode: 3 | 4
  type: number
  name: string
  /** H.264 IDR, or H.265 IRAP (16 to 21) */
  keyframe: boolean
}

export interface AnnexBView {
  /** Bytes before the first start code */
  prefix: number
  units: NalUnit[]
}

/** The furthest offset the first start code is looked for at, as in capture */
const PREFIX_LIMIT = 64

function nalType(d: Uint8Array, at: number, end: number, codec: 'h264' | 'h265'): number | null {
  if (codec === 'h264') {
    if (end - at < 1 || (d[at]! & 0x80) !== 0) return null
    const type = d[at]! & 0x1f
    return type in H264_NAMES ? type : null
  }
  if (end - at < 2 || (d[at]! & 0x80) !== 0 || (d[at + 1]! & 0x07) === 0) return null
  const type = (d[at]! >> 1) & 0x3f
  return type in H265_NAMES ? type : null
}

/**
 * A payload's NAL units as an Annex-B byte stream (H.264 and H.265 Annex B).
 * A unit ends where 00 00 00, 00 00 01 or 00 00 02 begins. Null when the
 * first start code is not within 64 bytes, or a unit's header is not valid
 * for `codec`.
 */
export function annexBUnits(payload: Uint8Array, codec: 'h264' | 'h265'): AnnexBView | null {
  const d = payload
  let first = -1
  for (let i = 0; i <= PREFIX_LIMIT && i + 2 < d.length; i++) {
    if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1) {
      first = i > 0 && d[i - 1] === 0 ? i - 1 : i
      break
    }
  }
  if (first < 0) return null
  const units: NalUnit[] = []
  let i = first
  while (i < d.length) {
    let zeros = 0
    while (i + zeros < d.length && d[i + zeros] === 0) zeros++
    if (i + zeros === d.length && units.length > 0) break
    if (zeros < 2 || d[i + zeros] !== 1) return null
    const start = i + zeros + 1
    let end = start
    while (end + 2 < d.length && !(d[end] === 0 && d[end + 1] === 0 && d[end + 2]! <= 2)) end++
    if (end + 2 >= d.length) end = d.length
    const type = nalType(d, start, end, codec)
    if (type === null) return null
    units.push({
      offset: start,
      size: end - start,
      startCode: zeros === 2 ? 3 : 4,
      type,
      name: (codec === 'h264' ? H264_NAMES : H265_NAMES)[type]!,
      keyframe: codec === 'h264' ? type === 5 : type >= 16 && type <= 21,
    })
    i = end
  }
  return { prefix: first, units }
}
