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

import type { DraftParser, ParsedStreamFraming } from './types';

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
