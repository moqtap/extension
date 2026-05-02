/**
 * Lightweight content type detection from raw bytes.
 *
 * MoQT data streams have framing headers (varints for trackAlias, groupId, etc.)
 * before the actual payload, so signatures like fMP4 box types or JSON delimiters
 * may not appear at byte 0. We scan within the first N bytes for known patterns.
 *
 * Runs synchronously before IndexedDB write — must be fast.
 */

import type { PayloadMediaInfo } from './bmff-boxes'
import { detectMediaInfo, scanAndDetectMedia } from './bmff-boxes'
import { looksLikeCbor } from './cbor-decode'
import { looksLikeMsgpack } from './msgpack-decode'

export type { PayloadMediaInfo }

/** Detected content type for a stream's payload data */
export type StreamContentType = 'json' | 'fmp4' | 'cbor' | 'msgpack' | 'binary'

/** How far into the buffer to scan for signatures */
const SCAN_LIMIT = 256

/**
 * Detect content type from the first chunk of a stream.
 *
 * Only called once per stream (on the first chunk).
 * Scans within the first SCAN_LIMIT bytes for known signatures.
 */
export function detectContentType(data: Uint8Array): StreamContentType {
  if (data.length < 4) return 'binary'

  const limit = Math.min(data.length, SCAN_LIMIT)

  // Scan for ISO BMFF box signatures within the first N bytes.
  if (scanAndDetectMedia(data, limit)) return 'fmp4'

  // Scan for JSON: look for { or [ that's preceded by whitespace or is at a
  // plausible payload boundary (after MoQT varint framing)
  if (scanForJson(data, limit)) return 'json'

  // Try structured binary formats (CBOR, MessagePack)
  // These require the full payload since they can't be reliably detected
  // from partial scans — call on the raw bytes.
  if (looksLikeCbor(data)) return 'cbor'
  if (looksLikeMsgpack(data)) return 'msgpack'

  return 'binary'
}

/**
 * Detect media info from a known object payload (framing already stripped).
 *
 * This is the precise path — called when MoQT framing has been parsed and
 * we know exactly where the payload starts. No scanning needed.
 */
export function detectPayloadMedia(
  payload: Uint8Array,
): PayloadMediaInfo | null {
  return detectMediaInfo(payload)
}

/**
 * Detect media info by scanning raw stream bytes (framing boundaries unknown).
 *
 * Fallback path when MoQT framing isn't available. Scans within the first
 * SCAN_LIMIT bytes for a valid BMFF box sequence.
 */
export function detectStreamMedia(data: Uint8Array): PayloadMediaInfo | null {
  return scanAndDetectMedia(data, SCAN_LIMIT)
}

function scanForJson(data: Uint8Array, limit: number): boolean {
  // Look for a JSON object or array start that's followed by a quote or another bracket.
  // This reduces false positives from stray 0x7b/0x5b bytes in binary data.
  // In MoQT streams, varint framing bytes may coincidentally equal { or [,
  // so we must keep scanning past false candidates rather than returning early.
  for (let i = 0; i < limit - 1; i++) {
    const b = data[i]
    if (b === 0x7b || b === 0x5b) {
      // { or [
      // Check next non-whitespace byte is plausible JSON continuation
      let matched = false
      for (let j = i + 1; j < Math.min(i + 16, limit); j++) {
        const next = data[j]
        if (next === 0x20 || next === 0x09 || next === 0x0a || next === 0x0d)
          continue
        // After {: expect " (key) or } (empty object)
        // After [: expect " { [ digit - or ] (empty array)
        if (b === 0x7b) {
          matched = next === 0x22 || next === 0x7d // " or }
        } else {
          matched =
            next === 0x22 ||
            next === 0x7b ||
            next === 0x5b ||
            next === 0x5d ||
            (next >= 0x30 && next <= 0x39) ||
            next === 0x2d || // digit or -
            next === 0x74 ||
            next === 0x66 ||
            next === 0x6e // true/false/null
        }
        break
      }
      if (matched) return true
      // Not JSON from this offset — keep scanning
    }
  }
  return false
}
