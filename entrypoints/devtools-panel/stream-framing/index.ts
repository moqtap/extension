/**
 * MoQT data stream framing — registry and public API.
 *
 * Draft-agnostic design: each draft version has its own parser,
 * delegating to the @moqtap/codec's per-draft decoder.
 * The UI receives generic key-value header tags and object boundaries —
 * it doesn't need to know draft-specific field names.
 */

export type { StreamObject, ParsedStreamFraming, HeaderTag, DraftParser } from './types';

// ─── Registry ──────────────────────────────────────────────────────

import type { DraftParser, ParsedStreamFraming, StreamObject, HeaderTag } from './types';

const draftParsers = new Map<string, DraftParser>();

export function registerDraftParser(draft: string, parser: DraftParser): void {
  draftParsers.set(draft, parser);
}

/**
 * Try to parse MoQT data stream framing from raw bytes.
 * Tries the specified draft parser first, then falls back to all registered parsers.
 * Returns null if no parser recognizes the data.
 */
export function parseStreamFraming(data: Uint8Array, draft?: string): ParsedStreamFraming | null {
  if (data.length < 3) return null;

  if (draft) {
    const parser = draftParsers.get(draft);
    if (parser) {
      const result = parser(data);
      if (result) return result;
    }
  }

  for (const parser of draftParsers.values()) {
    const result = parser(data);
    if (result) return result;
  }

  return null;
}

// ─── Payload extraction helpers ────────────────────────────────────

/** Extract the first object's payload from a parsed stream. */
export function extractFirstPayload(data: Uint8Array, framing: ParsedStreamFraming): Uint8Array | null {
  if (framing.objects.length === 0) return null;
  const obj = framing.objects[0];
  const end = Math.min(obj.payloadOffset + obj.payloadLength, data.length);
  return data.subarray(obj.payloadOffset, end);
}

/** Concatenate all object payloads from a parsed stream. */
export function extractAllPayloads(data: Uint8Array, framing: ParsedStreamFraming): Uint8Array[] {
  return framing.objects.map((obj) => {
    const end = Math.min(obj.payloadOffset + obj.payloadLength, data.length);
    return data.subarray(obj.payloadOffset, end);
  });
}

// ─── Datagram group framing ───────────────────────────────────────

/**
 * Parse datagram group data (length-prefixed concatenated datagrams).
 * Format: [4-byte LE uint32 length][raw datagram bytes] repeated.
 *
 * Returns a ParsedStreamFraming where each "object" corresponds to one
 * datagram's payload, enabling reuse of StreamDataViewer for hex view,
 * payload tagging, and content detection.
 */
export function parseDatagramGroupFraming(data: Uint8Array, draft?: string): ParsedStreamFraming | null {
  if (data.length < 4) return null;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const objects: StreamObject[] = [];
  const tags: HeaderTag[] = [{ label: 'datagram-group', value: '', kind: 'info' }];
  let headerFields: Record<string, number> = {};
  let offset = 0;
  let dgIndex = 0;

  while (offset + 4 <= data.length) {
    const rawLen = view.getUint32(offset, true); // little-endian
    if (rawLen === 0 || offset + 4 + rawLen > data.length) break;

    const dgBytes = data.subarray(offset + 4, offset + 4 + rawLen);

    // Try to parse individual datagram framing to extract objectId
    const framing = parseStreamFraming(dgBytes, draft);
    if (framing && framing.objects.length > 0) {
      // Use the first datagram's header fields for the group
      if (dgIndex === 0) {
        headerFields = { ...framing.headerFields };
      }

      for (const obj of framing.objects) {
        objects.push({
          // Offset relative to the group buffer
          offset: offset + 4 + obj.offset,
          payloadOffset: offset + 4 + obj.payloadOffset,
          payloadLength: obj.payloadLength,
          objectId: obj.objectId,
        });
      }
    } else {
      // Fallback: treat entire raw datagram as a single object
      objects.push({
        offset: offset + 4,
        payloadOffset: offset + 4,
        payloadLength: rawLen,
        objectId: dgIndex,
      });
    }

    offset += 4 + rawLen;
    dgIndex++;
  }

  if (objects.length === 0) return null;

  return {
    streamType: 'datagram',
    headerEnd: 0,
    headerFields,
    objects,
    tags,
  };
}

// ─── Register all draft parsers ────────────────────────────────────

import { createCodecDraftParser } from './codec-adapter';

// All drafts use the codec adapter — each gets its own codec instance
registerDraftParser('07', createCodecDraftParser('07'));
registerDraftParser('08', createCodecDraftParser('08'));
registerDraftParser('09', createCodecDraftParser('09'));
registerDraftParser('10', createCodecDraftParser('10'));
registerDraftParser('11', createCodecDraftParser('11'));
registerDraftParser('12', createCodecDraftParser('12'));
registerDraftParser('13', createCodecDraftParser('13'));
registerDraftParser('14', createCodecDraftParser('14'));
registerDraftParser('15', createCodecDraftParser('15'));
registerDraftParser('16', createCodecDraftParser('16'));
registerDraftParser('17', createCodecDraftParser('17'));
