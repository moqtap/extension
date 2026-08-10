/**
 * Annex-B elementary stream detection (H.264 / H.265).
 *
 * MoQ payloads frequently carry raw codec frames rather than a container. The
 * hang format, for one, prefixes each frame with a QUIC varint microsecond
 * timestamp and then emits Annex-B NAL units:
 *
 *   c0 00 00 00 87 d0 6d d3 | 00 00 00 01 09 10 | 00 00 00 01 67 64 00 1f ...
 *   └── 8-byte varint ─────┘ └─ AUD (NAL 9) ──┘ └─ SPS (NAL 7), High@3.1 ─
 *
 * So the start code is usually *not* at offset 0 and we scan a short prefix
 * for it. Matching is deliberately strict — a bare `00 00 01` appears often
 * enough in arbitrary binary that a start code alone is not evidence.
 */

/** How far into the payload to look for the first start code */
const SCAN_LIMIT = 64

/** Maximum NAL units to walk — enough to classify without scanning whole frames */
const MAX_NALS = 16

export interface AnnexBInfo {
  codec: 'h264' | 'h265'
  /** RFC 6381 codec string, e.g. "avc1.64001F". H.264 only — needs the SPS. */
  codecString?: string
  /** True when a keyframe NAL is present (H.264 IDR, H.265 IRAP) */
  keyframe: boolean
  /** NAL unit type numbers, in order of first appearance */
  nalTypes: number[]
  /** Offset of the first start code — anything before it is container framing */
  offset: number
}

/** Length of the start code at `i`, or 0 if there isn't one */
function startCodeLength(d: Uint8Array, i: number): 0 | 3 | 4 {
  if (
    i + 3 < d.length &&
    d[i] === 0 &&
    d[i + 1] === 0 &&
    d[i + 2] === 0 &&
    d[i + 3] === 1
  ) {
    return 4
  }
  if (i + 2 < d.length && d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1) {
    return 3
  }
  return 0
}

interface RawNal {
  /** Offset of the NAL header byte (after the start code) */
  offset: number
}

/** Walk start codes from `start`, collecting NAL header offsets */
function collectNals(data: Uint8Array, start: number): RawNal[] {
  const nals: RawNal[] = []
  let i = start
  while (i < data.length && nals.length < MAX_NALS) {
    const sc = startCodeLength(data, i)
    if (sc === 0) {
      i++
      continue
    }
    const headerOffset = i + sc
    if (headerOffset >= data.length) break
    nals.push({ offset: headerOffset })
    i = headerOffset + 1
  }
  return nals
}

// ─── H.264 ───────────────────────────────────────────────────────────

/** Slice, param-set and delimiter types — the ones that carry real signal */
const H264_STRONG = new Set([1, 5, 7, 8, 9])
/** Types defined by the spec; anything else means this isn't H.264 */
const H264_KNOWN = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 19, 20])

function classifyH264(
  data: Uint8Array,
  nals: RawNal[],
): { types: number[]; keyframe: boolean; sps?: number } | null {
  const types: number[] = []
  let keyframe = false
  let sps: number | undefined

  for (const nal of nals) {
    const b = data[nal.offset]
    // forbidden_zero_bit must be 0
    if ((b & 0x80) !== 0) return null
    const type = b & 0x1f
    if (!H264_KNOWN.has(type)) return null
    if (!types.includes(type)) types.push(type)
    if (type === 5) keyframe = true
    if (type === 7 && sps === undefined) sps = nal.offset + 1
  }

  if (!types.some((t) => H264_STRONG.has(t))) return null
  return { types, keyframe, sps }
}

/**
 * Build the RFC 6381 codec string from the first three SPS bytes
 * (profile_idc, constraint flags, level_idc) — e.g. 64 00 1f → "avc1.64001F".
 *
 * Those three bytes precede any emulation-prevention sequence, so the raw
 * bytes can be read directly without un-escaping the RBSP.
 */
function h264CodecString(
  data: Uint8Array,
  spsOffset: number,
): string | undefined {
  if (spsOffset + 2 >= data.length) return undefined
  let hex = ''
  for (let i = 0; i < 3; i++) {
    hex += data[spsOffset + i].toString(16).padStart(2, '0')
  }
  return `avc1.${hex.toUpperCase()}`
}

// ─── H.265 ───────────────────────────────────────────────────────────

/** VPS, SPS, PPS, AUD — the strong structural types */
const H265_STRONG = new Set([32, 33, 34, 35])
/** IRAP range: BLA_W_LP (16) through CRA_NUT (21) */
const H265_IRAP_MIN = 16
const H265_IRAP_MAX = 21

function classifyH265(
  data: Uint8Array,
  nals: RawNal[],
): { types: number[]; keyframe: boolean } | null {
  const types: number[] = []
  let keyframe = false
  let strong = false

  for (const nal of nals) {
    if (nal.offset + 1 >= data.length) return null
    const b0 = data[nal.offset]
    const b1 = data[nal.offset + 1]
    // forbidden_zero_bit must be 0
    if ((b0 & 0x80) !== 0) return null
    const type = (b0 >> 1) & 0x3f
    const layerId = ((b0 & 0x01) << 5) | (b1 >> 3)
    const tidPlus1 = b1 & 0x07
    // nuh_temporal_id_plus1 == 0 is forbidden; reserved types mean not H.265
    if (tidPlus1 === 0 || layerId !== 0 || type > 40) return null
    if (!types.includes(type)) types.push(type)
    if (type >= H265_IRAP_MIN && type <= H265_IRAP_MAX) keyframe = true
    if (H265_STRONG.has(type) || type <= 9) strong = true
  }

  if (!strong) return null
  return { types, keyframe }
}

// ─── Entry point ─────────────────────────────────────────────────────

/**
 * Detect an Annex-B elementary stream in `data`, tolerating a short container
 * prefix before the first start code. Returns null when the payload doesn't
 * look like H.264 or H.265.
 */
export function detectAnnexB(data: Uint8Array): AnnexBInfo | null {
  if (data.length < 8) return null

  const limit = Math.min(data.length, SCAN_LIMIT)
  for (let i = 0; i < limit; i++) {
    const sc = startCodeLength(data, i)
    if (sc === 0) continue

    const nals = collectNals(data, i)
    if (nals.length === 0) continue

    // H.264 first: its 1-byte header is the stricter test, so an H.265 stream
    // is unlikely to satisfy it, while the reverse can happen.
    const h264 = classifyH264(data, nals)
    if (h264) {
      return {
        codec: 'h264',
        codecString:
          h264.sps !== undefined ? h264CodecString(data, h264.sps) : undefined,
        keyframe: h264.keyframe,
        nalTypes: h264.types,
        offset: i,
      }
    }

    const h265 = classifyH265(data, nals)
    if (h265) {
      return {
        codec: 'h265',
        keyframe: h265.keyframe,
        nalTypes: h265.types,
        offset: i,
      }
    }

    // A start code that leads nowhere — keep scanning, it was coincidence.
  }

  return null
}
