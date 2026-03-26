/**
 * Shared test helpers for building MoQT wire-format byte sequences.
 */

import { encodeVarint } from './varint';
export { encodeVarint } from './varint';

/** Build a Uint8Array from hex string, e.g., "c2197c5eff14e88c" */
export function hex(s: string): Uint8Array {
  const cleaned = s.replace(/\s/g, '');
  const bytes = cleaned.match(/.{1,2}/g)!.map((b) => parseInt(b, 16));
  return new Uint8Array(bytes);
}

/** Concatenate multiple Uint8Arrays */
export function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

/** Encode a UTF-8 string as bytes */
export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Build a length-prefixed byte field: varint(length) + bytes */
export function lengthPrefixed(data: Uint8Array): Uint8Array {
  return concat(encodeVarint(data.length), data);
}

/** Build a tuple: varint(count) + count * (varint(len) + bytes) */
export function buildTuple(elements: Uint8Array[]): Uint8Array {
  return concat(
    encodeVarint(elements.length),
    ...elements.map((e) => lengthPrefixed(e)),
  );
}

/** Build a Reason Phrase: varint(length) + UTF-8 bytes */
export function buildReasonPhrase(text: string): Uint8Array {
  const encoded = utf8(text);
  return concat(encodeVarint(encoded.length), encoded);
}

/** Build a Location: varint(group) + varint(object) */
export function buildLocation(group: number, object: number): Uint8Array {
  return concat(encodeVarint(group), encodeVarint(object));
}

/**
 * Build a complete control message frame:
 *   Message Type (varint) + Message Length (16-bit) + Message Payload
 */
export function buildControlMessage(
  messageType: number,
  payload: Uint8Array,
): Uint8Array {
  const typeBuf = encodeVarint(messageType);
  // Length is a 16-bit unsigned integer (2 bytes big-endian)
  const lengthBuf = new Uint8Array(2);
  new DataView(lengthBuf.buffer).setUint16(0, payload.length, false);
  return concat(typeBuf, lengthBuf, payload);
}

/** Build an even-type Key-Value-Pair: varint(type) + varint(value) */
export function buildKvpVarint(type: number, value: number): Uint8Array {
  return concat(encodeVarint(type), encodeVarint(value));
}

/** Build an odd-type Key-Value-Pair: varint(type) + varint(length) + bytes */
export function buildKvpBytes(type: number, data: Uint8Array): Uint8Array {
  return concat(encodeVarint(type), encodeVarint(data.length), data);
}

/** Encode a single byte */
export function byte(v: number): Uint8Array {
  return new Uint8Array([v]);
}
