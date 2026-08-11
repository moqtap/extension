/**
 * Variable-length integers, in both encodings the draft series has used.
 *
 * Drafts 07–16 use the QUIC integer of RFC 9000 §16:
 *   - 1-byte (6-bit value):  0b00xxxxxx                    (0 to 63)
 *   - 2-byte (14-bit value): 0b01xxxxxx xxxxxxxx           (0 to 16383)
 *   - 4-byte (30-bit value): 0b10xxxxxx xxxxxxxx * 3       (0 to 1073741823)
 *   - 8-byte (62-bit value): 0b11xxxxxx xxxxxxxx * 7       (0 to 4611686018427387903)
 *
 * The two most-significant bits of the first byte encode the length prefix.
 *
 * Draft-17 §1.4.1 replaced it with MoQT's own, whose length is the number of
 * leading 1 bits in the first byte plus one:
 *   - 1 byte:   0b0xxxxxxx                                 (0 to 127)
 *   - 2 bytes:  0b10xxxxxx xxxxxxxx                        (0 to 2^14 - 1)
 *   - n bytes:  n-1 leading 1 bits, a 0, then the value    (0 to 2^7n - 1)
 *   - 9 bytes:  0b11111111 then a big-endian u64           (0 to 2^64 - 1)
 *
 * The two disagree on the same bytes, so reading with the wrong one does not
 * fail loudly — it returns a plausible wrong number. SETUP (0x2F00) is `af 00`
 * under MoQT and `6f 00` under RFC 9000, and each decodes as something under
 * the other.
 *
 * Values are returned as `number`, exact to 2^53. Every field these decoders
 * are aimed at — message types, stream types, draft versions — is far below.
 */

import type { SupportedDraft } from '../types/common'

export class VarintError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VarintError'
  }
}

/** Maximum value representable by a QUIC varint: 2^62 - 1 */
export const VARINT_MAX = 2 ** 62 - 1

/** Decode an RFC 9000 varint at the given offset. Returns [value, bytesConsumed]. */
export function decodeVarint(buf: Uint8Array, offset = 0): [number, number] {
  if (offset >= buf.length) {
    throw new VarintError('Buffer too short for varint')
  }

  const first = buf[offset]
  const prefix = first >> 6
  const length = 1 << prefix // 1, 2, 4, or 8

  if (offset + length > buf.length) {
    throw new VarintError(
      `Buffer too short: need ${length} bytes, have ${buf.length - offset}`,
    )
  }

  let value = first & 0x3f
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[offset + i]
  }

  return [value, length]
}

/** Encode a value as an RFC 9000 varint. Returns the encoded bytes. */
export function encodeVarint(value: number): Uint8Array {
  if (value < 0 || value > VARINT_MAX) {
    throw new VarintError(`Value ${value} out of varint range [0, 2^62-1]`)
  }

  const length = varintEncodedLength(value)
  const buf = new Uint8Array(length)

  let v = value
  for (let i = length - 1; i >= 0; i--) {
    buf[i] = v & 0xff
    v = Math.floor(v / 256)
  }

  const prefix = { 1: 0x00, 2: 0x40, 4: 0x80, 8: 0xc0 }[length]!
  buf[0] = (buf[0] & 0x3f) | prefix

  return buf
}

/** Return the minimum number of bytes needed to encode this value as a varint. */
export function varintEncodedLength(value: number): number {
  if (value <= 63) return 1
  if (value <= 16383) return 2
  if (value <= 1073741823) return 4
  return 8
}

/**
 * Which variable-length integer a draft's wire format uses. The MoQT variants
 * are named for the draft that introduced them, not the range that uses them.
 */
export type VarintEncoding = 'rfc9000' | 'moqt17' | 'moqt18'

/** The MoQT encodings, which differ only in whether 7 bytes is a legal length. */
export type MoqtVarintEncoding = Exclude<VarintEncoding, 'rfc9000'>

/**
 * Which encoding each draft uses.
 *
 * A table rather than a `Number(draft) >= 17` test: the encoding is a property
 * of each draft, not a threshold. A draft that returns to RFC 9000, or revises
 * the format a third time, shows up here as a missing key — a type error —
 * instead of a silent misread on the wire.
 */
const VARINT_ENCODINGS: Record<SupportedDraft, VarintEncoding> = {
  '07': 'rfc9000',
  '08': 'rfc9000',
  '09': 'rfc9000',
  '10': 'rfc9000',
  '11': 'rfc9000',
  '12': 'rfc9000',
  '13': 'rfc9000',
  '14': 'rfc9000',
  '15': 'rfc9000',
  '16': 'rfc9000',
  '17': 'moqt17',
  '18': 'moqt18',
  '19': 'moqt18',
}

/** The variable-length integer encoding this draft writes on the wire. */
export function varintEncoding(draft: SupportedDraft): VarintEncoding {
  return VARINT_ENCODINGS[draft]
}

/**
 * Decode a MoQT varint (draft-17 §1.4.1) at the given offset.
 * Returns [value, bytesConsumed].
 *
 * Non-minimal encodings decode as their value, which draft-18 §1.4.1 requires:
 * "any encoding length that can represent the value is valid", so 0 may arrive
 * as 0x00, 0x8000 or any longer form.
 */
export function decodeMoqtVarint(
  buf: Uint8Array,
  offset = 0,
  encoding: MoqtVarintEncoding = 'moqt18',
): [number, number] {
  if (offset >= buf.length) {
    throw new VarintError('Buffer too short for varint')
  }

  const first = buf[offset]

  if (first === 0xff) {
    if (offset + 9 > buf.length) {
      throw new VarintError(
        `Buffer too short: need 9 bytes, have ${buf.length - offset}`,
      )
    }
    let value = 0
    for (let i = 1; i <= 8; i++) value = value * 256 + buf[offset + i]
    return [value, 9]
  }

  let leadingOnes = 0
  while (leadingOnes < 8 && (first & (0x80 >> leadingOnes)) !== 0) leadingOnes++
  const length = leadingOnes + 1

  // Draft-17 §1.4.1: "11111100 is an invalid code point. An endpoint that
  // receives this value MUST close the session with a PROTOCOL_VIOLATION."
  // Draft-18 restored the length, so all nine are defined there.
  if (length === 7 && encoding === 'moqt17') {
    throw new VarintError('7-byte varint is not a defined length in draft-17')
  }

  if (offset + length > buf.length) {
    throw new VarintError(
      `Buffer too short: need ${length} bytes, have ${buf.length - offset}`,
    )
  }

  let value = first & ((1 << (8 - length)) - 1)
  for (let i = 1; i < length; i++) value = value * 256 + buf[offset + i]

  return [value, length]
}

/** Encode a value as a MoQT varint (draft-17 §1.4.1) in its shortest form. */
export function encodeMoqtVarint(
  value: number,
  encoding: MoqtVarintEncoding = 'moqt18',
): Uint8Array {
  if (value < 0 || !Number.isSafeInteger(value)) {
    throw new VarintError(`Value ${value} out of range [0, 2^53-1]`)
  }

  let length = 9
  for (let n = 1; n <= 8; n++) {
    // Draft-17 has no 7-byte form, so values that need seven bytes elsewhere
    // take eight there.
    if (n === 7 && encoding === 'moqt17') continue
    if (value < 2 ** (7 * n)) {
      length = n
      break
    }
  }

  const buf = new Uint8Array(length)
  if (length === 9) {
    buf[0] = 0xff
    let v = value
    for (let i = 8; i >= 1; i--) {
      buf[i] = v % 256
      v = Math.floor(v / 256)
    }
    return buf
  }

  let v = value
  for (let i = length - 1; i >= 0; i--) {
    buf[i] = v % 256
    v = Math.floor(v / 256)
  }
  // (length - 1) leading 1 bits, then a 0, in the top `length` bits.
  buf[0] |= (((1 << (length - 1)) - 1) << (9 - length)) & 0xff

  return buf
}

/** Decode a varint using the encoding this draft writes. */
export function decodeVarintForDraft(
  draft: SupportedDraft,
  buf: Uint8Array,
  offset = 0,
): [number, number] {
  const encoding = varintEncoding(draft)
  return encoding === 'rfc9000'
    ? decodeVarint(buf, offset)
    : decodeMoqtVarint(buf, offset, encoding)
}

/** Encode a varint using the encoding this draft writes. */
export function encodeVarintForDraft(
  draft: SupportedDraft,
  value: number,
): Uint8Array {
  const encoding = varintEncoding(draft)
  return encoding === 'rfc9000'
    ? encodeVarint(value)
    : encodeMoqtVarint(value, encoding)
}
