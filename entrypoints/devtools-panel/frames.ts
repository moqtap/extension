/**
 * Frame types read from a CMAF object's samples (`@moqtap/media/frames`),
 * as the object rows badge them: H.264 IDR or slice type, H.265 IRAP only,
 * AV1 frame type. Audio gets none.
 */

import type { InitSegment } from '@moqtap/media/bmff'
import { type FrameTypeReading, readSampleFrames, type SampleFrame } from '@moqtap/media/frames'

/** A frame reading in a word: `IDR`, `P`, `IRAP`, `KEY`; null when it says nothing to badge. */
export function frameBadge(r: FrameTypeReading | null): string | null {
  if (!r) return null
  switch (r.codec) {
    case 'h264':
      if (r.idr) return 'IDR'
      return r.sliceType === null || r.sliceType === 'mixed' ? null : r.sliceType
    case 'h265':
      return r.irap ? 'IRAP' : null
    case 'av1': {
      const shown = r.frameHeaders.find((h) => h.frameType !== null)
      return shown?.frameType ?? null
    }
  }
}

/** What a reading says about random access, for a finding: `P`, `non-IRAP`, `INTER`. */
function frameWord(r: FrameTypeReading | null): string {
  const badge = frameBadge(r)
  if (badge) return badge
  if (r?.codec === 'h265') return 'not IRAP'
  return 'not a key frame'
}

export interface ObjectFrames {
  /** The first sample's frame type */
  badge: string | null
  /** The samples whose sync flag the bitstream contradicts: `sample 3: flagged sync, frame P` */
  mismatches: string[]
}

/** An object's frame badge and the samples whose sync flag disagrees with their frame. */
export function objectFrames(payload: Uint8Array, init: InitSegment | null): ObjectFrames {
  if (!init) return { badge: null, mismatches: [] }
  const { samples } = readSampleFrames(payload, init)
  return {
    badge: frameBadge(samples[0]?.frames ?? null),
    mismatches: samples.flatMap((s, i) => (s.agrees === false ? [mismatchText(s, i)] : [])),
  }
}

/** Samples counted from 1 across the object, in decode order. */
function mismatchText(s: SampleFrame, index: number): string {
  return `sample ${index + 1}: flagged ${s.sync ? 'sync' : 'not sync'}, frame ${frameWord(s.frames)}`
}
