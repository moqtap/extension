/**
 * Padding streams and datagrams, which carry no Objects. The codec does not
 * name either type, so they are recognised here before decoding.
 */

import type { SupportedDraft } from '../types/common'
import { decodeVarintForDraft } from './varint'

/**
 * draft-18 Section 11.5.1 to draft-23 Section 11.5.1: "An endpoint MAY open a
 * unidirectional stream with a stream type of 0x132B3E28 to send padding
 * data. The stream begins with the stream type, followed by zero or more
 * bytes that MUST all be set to zero."
 */
export const PADDING_STREAM_TYPE = 0x132b3e28

/**
 * draft-18 Section 11.5.2 to draft-23 Section 11.5.2: "An endpoint MAY send a
 * datagram with a type of 0x132B3E29 to send padding data. The datagram
 * contains the type followed by zero or more bytes that MUST all be set to
 * zero."
 */
export const PADDING_DATAGRAM_TYPE = 0x132b3e29

/** Padding first appears in draft-18 Section 11.5. */
function hasPadding(draft: string): boolean {
  return Number(draft) >= 18
}

/** Padding, and where its data first breaks the all-zero rule. */
export interface PaddingRead {
  /** Offset of the first nonzero byte past the type; null when there is none */
  nonzeroAt: number | null
}

/**
 * The stream's or datagram's bytes read as padding under `draft`, or null
 * when they do not begin with that padding type (or its type has not all
 * arrived yet).
 */
export function readPadding(
  bytes: Uint8Array,
  draft: string | undefined,
  kind: 'stream' | 'datagram',
): PaddingRead | null {
  if (!draft || !hasPadding(draft)) return null
  let type: number
  let length: number
  try {
    ;[type, length] = decodeVarintForDraft(draft as SupportedDraft, bytes, 0)
  } catch {
    return null
  }
  if (type !== (kind === 'stream' ? PADDING_STREAM_TYPE : PADDING_DATAGRAM_TYPE)) return null
  const nonzero = bytes.subarray(length).findIndex((b) => b !== 0)
  return { nonzeroAt: nonzero === -1 ? null : length + nonzero }
}

/** The reason for padding data that is not all zero. */
export const NONZERO_PADDING = 'padding data that is not all zero'
