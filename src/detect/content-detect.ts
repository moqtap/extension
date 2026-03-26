/**
 * Lightweight content type detection from raw bytes.
 *
 * MoQT data streams have framing headers (varints for trackAlias, groupId, etc.)
 * before the actual payload, so signatures like fMP4 box types or JSON delimiters
 * may not appear at byte 0. We scan within the first N bytes for known patterns.
 *
 * Runs synchronously before IndexedDB write — must be fast.
 */

/** Detected content type for a stream's payload data */
export type StreamContentType = 'json' | 'fmp4' | 'binary';

/** Known ISO BMFF (fMP4) box types — 4-byte ASCII tags */
const BMFF_BOX_TYPES = new Set([
  'ftyp', 'styp', 'moov', 'moof', 'mdat', 'mvhd',
  'trak', 'mfhd', 'traf', 'sidx', 'emsg', 'mvex',
  'trex', 'tfhd', 'tfdt', 'trun', 'mdia', 'minf',
  'stbl', 'dinf', 'hdlr', 'free', 'skip',
]);

/** How far into the buffer to scan for signatures */
const SCAN_LIMIT = 256;

/**
 * Detect content type from the first chunk of a stream.
 *
 * Only called once per stream (on the first chunk).
 * Scans within the first SCAN_LIMIT bytes for known signatures.
 */
export function detectContentType(data: Uint8Array): StreamContentType {
  if (data.length < 4) return 'binary';

  const limit = Math.min(data.length, SCAN_LIMIT);

  // Scan for ISO BMFF box signatures within the first N bytes.
  // A box is [4-byte size BE][4-byte ASCII type]. We look for known type tags
  // preceded by a plausible size value.
  if (scanForBmff(data, limit)) return 'fmp4';

  // Scan for JSON: look for { or [ that's preceded by whitespace or is at a
  // plausible payload boundary (after MoQT varint framing)
  if (scanForJson(data, limit)) return 'json';

  return 'binary';
}

function scanForBmff(data: Uint8Array, limit: number): boolean {
  // Look for any 4-byte sequence at offset i+4 that matches a known box type,
  // where bytes at i..i+3 form a plausible box size (big-endian uint32 >= 8)
  for (let i = 0; i <= limit - 8; i++) {
    // Check if bytes i+4..i+7 are a known box type (all printable ASCII lowercase/digits)
    const t0 = data[i + 4];
    const t1 = data[i + 5];
    const t2 = data[i + 6];
    const t3 = data[i + 7];

    // Quick filter: box types are lowercase ASCII letters (0x61-0x7a) or digits
    if (t0 < 0x20 || t0 > 0x7e) continue;
    if (t1 < 0x20 || t1 > 0x7e) continue;
    if (t2 < 0x20 || t2 > 0x7e) continue;
    if (t3 < 0x20 || t3 > 0x7e) continue;

    const type = String.fromCharCode(t0, t1, t2, t3);
    if (!BMFF_BOX_TYPES.has(type)) continue;

    // Validate box size
    const size = ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0;
    // size 0 = "to end of file", size 1 = 64-bit extended, otherwise >= 8
    if (size === 0 || size === 1 || size >= 8) return true;
  }
  return false;
}

function scanForJson(data: Uint8Array, limit: number): boolean {
  // Look for a JSON object or array start that's followed by a quote or another bracket.
  // This reduces false positives from stray 0x7b/0x5b bytes in binary data.
  // In MoQT streams, varint framing bytes may coincidentally equal { or [,
  // so we must keep scanning past false candidates rather than returning early.
  for (let i = 0; i < limit - 1; i++) {
    const b = data[i];
    if (b === 0x7b || b === 0x5b) { // { or [
      // Check next non-whitespace byte is plausible JSON continuation
      let matched = false;
      for (let j = i + 1; j < Math.min(i + 16, limit); j++) {
        const next = data[j];
        if (next === 0x20 || next === 0x09 || next === 0x0a || next === 0x0d) continue;
        // After {: expect " (key) or } (empty object)
        // After [: expect " { [ digit - or ] (empty array)
        if (b === 0x7b) {
          matched = next === 0x22 || next === 0x7d; // " or }
        } else {
          matched = next === 0x22 || next === 0x7b || next === 0x5b || next === 0x5d
            || (next >= 0x30 && next <= 0x39) || next === 0x2d // digit or -
            || next === 0x74 || next === 0x66 || next === 0x6e; // true/false/null
        }
        break;
      }
      if (matched) return true;
      // Not JSON from this offset — keep scanning
    }
  }
  return false;
}
