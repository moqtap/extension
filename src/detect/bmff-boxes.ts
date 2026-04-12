/**
 * ISO BMFF (ISO 14496-12) box parser for WebTransport media payloads.
 *
 * Parses top-level boxes from raw payload bytes (after MoQT framing is stripped).
 * Also classifies the container variant: plain fMP4, CMAF, or LOC.
 *
 * Box structure: [4-byte size (big-endian uint32)][4-byte ASCII type][payload...]
 *   - size includes the 8-byte header
 *   - size 0 = box extends to end of data
 *   - size 1 = 64-bit extended size follows in next 8 bytes
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface BmffBox {
  /** 4-char box type, e.g. 'ftyp', 'moof', 'mdat' */
  type: string
  /** Byte offset within the payload */
  offset: number
  /** Total box size in bytes (including header). 0 = extends to end of data. */
  size: number
}

export type MediaVariant = 'cmaf' | 'loc' | 'fmp4'

export interface PayloadMediaInfo {
  /** Container variant */
  variant: MediaVariant
  /** Top-level box types found, in order (e.g. ['styp', 'moof', 'mdat']) */
  boxes: string[]
}

// ─── Known box types ─────────────────────────────────────────────────

/**
 * Known ISO BMFF box types. This set is used for validation — any 4-byte
 * ASCII sequence that matches is accepted as a box type during scanning.
 * Comprehensive enough to cover fMP4, CMAF, and LOC containers.
 */
const KNOWN_BOX_TYPES = new Set([
  // File/segment type
  'ftyp',
  'styp',
  // Movie structure
  'moov',
  'mvhd',
  'mvex',
  'trex',
  // Track structure
  'trak',
  'tkhd',
  'mdia',
  'mdhd',
  'hdlr',
  'minf',
  'dinf',
  'stbl',
  // Sample table (init segment)
  'stsd',
  'stts',
  'stsc',
  'stsz',
  'stco',
  'co64',
  'ctts',
  'stss',
  // Fragment structure
  'moof',
  'mfhd',
  'traf',
  'tfhd',
  'tfdt',
  'trun',
  // Media data
  'mdat',
  // Segment index & metadata
  'sidx',
  'emsg',
  'prft',
  // LOC (Low Overhead Container, ISO 14496-15 Annex E)
  'loch',
  'loct',
  'locs',
  // Common extensions
  'uuid',
  'edts',
  'elst',
  'udta',
  'meta',
  'iloc',
  'iinf',
  // Skip/free space
  'free',
  'skip',
])

// ─── Box parser ──────────────────────────────────────────────────────

/**
 * Parse top-level ISO BMFF boxes from a payload buffer.
 *
 * Walks the data sequentially, reading [size][type] headers.
 * Stops at the first invalid box or when data is exhausted.
 *
 * @param data  Raw payload bytes (MoQT framing already stripped)
 * @param limit Maximum number of boxes to parse (default 32)
 */
export function parseBoxes(data: Uint8Array, limit = 32): BmffBox[] {
  const boxes: BmffBox[] = []
  let offset = 0
  const len = data.length

  while (offset + 8 <= len && boxes.length < limit) {
    // Read 4-byte big-endian size
    const rawSize =
      ((data[offset] << 24) |
        (data[offset + 1] << 16) |
        (data[offset + 2] << 8) |
        data[offset + 3]) >>>
      0

    // Read 4-byte ASCII type
    const t0 = data[offset + 4]
    const t1 = data[offset + 5]
    const t2 = data[offset + 6]
    const t3 = data[offset + 7]

    // Validate type bytes are printable ASCII
    if (
      t0 < 0x20 ||
      t0 > 0x7e ||
      t1 < 0x20 ||
      t1 > 0x7e ||
      t2 < 0x20 ||
      t2 > 0x7e ||
      t3 < 0x20 ||
      t3 > 0x7e
    ) {
      break
    }

    const type = String.fromCharCode(t0, t1, t2, t3)

    // Validate against known types
    if (!KNOWN_BOX_TYPES.has(type)) break

    let boxSize: number

    if (rawSize === 0) {
      // Box extends to end of data
      boxSize = len - offset
    } else if (rawSize === 1) {
      // 64-bit extended size
      if (offset + 16 > len) break
      // Read upper 32 bits — for practical purposes in a browser, if > 2^32 we just
      // treat the box as extending to end of data
      const hi =
        ((data[offset + 8] << 24) |
          (data[offset + 9] << 16) |
          (data[offset + 10] << 8) |
          data[offset + 11]) >>>
        0
      if (hi > 0) {
        // Box larger than 4GB — accept it but don't try to skip past it
        boxSize = len - offset
      } else {
        boxSize =
          ((data[offset + 12] << 24) |
            (data[offset + 13] << 16) |
            (data[offset + 14] << 8) |
            data[offset + 15]) >>>
          0
      }
    } else if (rawSize >= 8) {
      boxSize = rawSize
    } else {
      // Invalid size (2-7)
      break
    }

    boxes.push({ type, offset, size: boxSize })

    // Advance to next box
    if (rawSize === 0) break // last box — extends to EOF
    offset += boxSize
  }

  return boxes
}

// ─── Variant classification ──────────────────────────────────────────

/** CMAF brand codes (from ISO 23000-19) */
const CMAF_BRANDS = new Set(['cmfc', 'cmfs', 'cmfl', 'cmff'])

/**
 * Classify the ISO BMFF variant based on parsed boxes and raw data.
 *
 * - **CMAF**: `styp` box present with a CMAF-compatible brand, or `styp`+`moof`+`mdat` structure
 * - **LOC**: Any `loch`, `loct`, or `locs` box present
 * - **fMP4**: Default for any valid ISO BMFF fragment structure
 */
export function classifyVariant(
  boxes: BmffBox[],
  data: Uint8Array,
): MediaVariant {
  const typeSet = new Set(boxes.map((b) => b.type))

  // LOC detection — any LOC-specific box
  if (typeSet.has('loch') || typeSet.has('loct') || typeSet.has('locs')) {
    return 'loc'
  }

  // CMAF detection — check for styp box with CMAF brand
  if (typeSet.has('styp')) {
    const stypBox = boxes.find((b) => b.type === 'styp')
    if (stypBox && hasCmafBrand(data, stypBox)) {
      return 'cmaf'
    }
    // styp + moof + mdat is CMAF-like even without explicit brand
    if (typeSet.has('moof') && typeSet.has('mdat')) {
      return 'cmaf'
    }
  }

  return 'fmp4'
}

/**
 * Check if a `styp` box contains a CMAF-compatible brand.
 *
 * styp layout: [size][type='styp'][major_brand(4)][minor_version(4)][compatible_brands(4 each)...]
 */
function hasCmafBrand(data: Uint8Array, box: BmffBox): boolean {
  const headerLen = 8
  const brandStart = box.offset + headerLen
  const boxEnd = box.offset + box.size

  // Check major brand (first 4 bytes after header)
  if (brandStart + 4 <= data.length && brandStart + 4 <= boxEnd) {
    const major = readAscii4(data, brandStart)
    if (CMAF_BRANDS.has(major)) return true
  }

  // Check compatible brands (after major_brand + minor_version = 8 bytes)
  const compatStart = brandStart + 8
  if (compatStart > data.length || compatStart > boxEnd) return false

  const end = Math.min(boxEnd, data.length)
  for (let i = compatStart; i + 4 <= end; i += 4) {
    const brand = readAscii4(data, i)
    if (CMAF_BRANDS.has(brand)) return true
  }

  return false
}

function readAscii4(data: Uint8Array, offset: number): string {
  return String.fromCharCode(
    data[offset],
    data[offset + 1],
    data[offset + 2],
    data[offset + 3],
  )
}

// ─── High-level detection ────────────────────────────────────────────

/**
 * Detect media info from a raw payload buffer.
 *
 * Returns null if the data doesn't contain valid ISO BMFF boxes.
 */
export function detectMediaInfo(payload: Uint8Array): PayloadMediaInfo | null {
  if (payload.length < 8) return null

  const boxes = parseBoxes(payload)
  if (boxes.length === 0) return null

  return {
    variant: classifyVariant(boxes, payload),
    boxes: boxes.map((b) => b.type),
  }
}

/**
 * Scan for BMFF boxes within raw stream data, accounting for unknown
 * MoQT framing offset. Tries offsets 0..scanLimit looking for a valid
 * box sequence.
 *
 * This is the fallback when framing boundaries are unavailable.
 */
export function scanAndDetectMedia(
  data: Uint8Array,
  scanLimit = 256,
): PayloadMediaInfo | null {
  const limit = Math.min(data.length, scanLimit)

  for (let i = 0; i <= limit - 8; i++) {
    const boxes = parseBoxes(data.subarray(i))
    if (boxes.length > 0) {
      return {
        variant: classifyVariant(boxes, data.subarray(i)),
        boxes: boxes.map((b) => b.type),
      }
    }
  }

  return null
}
