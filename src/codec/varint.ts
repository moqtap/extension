/**
 * QUIC variable-length integer encoding/decoding per RFC 9000 §16.
 *
 * Format:
 *   - 1-byte (6-bit value):  0b00xxxxxx                    (0 to 63)
 *   - 2-byte (14-bit value): 0b01xxxxxx xxxxxxxx           (0 to 16383)
 *   - 4-byte (30-bit value): 0b10xxxxxx xxxxxxxx * 3       (0 to 1073741823)
 *   - 8-byte (62-bit value): 0b11xxxxxx xxxxxxxx * 7       (0 to 4611686018427387903)
 *
 * The two most-significant bits of the first byte encode the length prefix.
 */

export class VarintError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VarintError'
  }
}

/** Maximum value representable by a QUIC varint: 2^62 - 1 */
export const VARINT_MAX = 2 ** 62 - 1

/** Decode a varint from the buffer at the given offset. Returns [value, bytesConsumed]. */
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

/** Encode a value as a varint. Returns the encoded bytes. */
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
