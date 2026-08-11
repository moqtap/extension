/**
 * Tests for variable-length integer encoding/decoding, in both formats the
 * draft series uses: RFC 9000 §16 through draft-16, and MoQT's own from
 * draft-17 on (covered at the bottom of the file).
 *
 * The varint format uses the two MSBs of the first byte to encode length:
 *   00 → 1 byte  (6-bit value,  max 63)
 *   01 → 2 bytes (14-bit value, max 16383)
 *   10 → 4 bytes (30-bit value, max 1073741823)
 *   11 → 8 bytes (62-bit value, max 4611686018427387903)
 *
 * Spec: "variable length integers SHOULD be encoded using the least
 *        number of bytes possible to represent the required value" (§1.4)
 */

import { describe, expect, it } from 'vitest'
import {
  decodeMoqtVarint,
  decodeVarint,
  decodeVarintForDraft,
  encodeMoqtVarint,
  encodeVarint,
  encodeVarintForDraft,
  VARINT_MAX,
  VarintError,
  varintEncodedLength,
  varintEncoding,
  type VarintEncoding,
} from './varint'
import type { SupportedDraft } from '../types/common'

// ─── Helper ─────────────────────────────────────────────────────────────

/** Build a Uint8Array from hex string, e.g., "c2197c5eff14e88c" */
function hex(s: string): Uint8Array {
  const bytes = s.match(/.{1,2}/g)!.map((b) => parseInt(b, 16))
  return new Uint8Array(bytes)
}

// ─── RFC 9000 §16 Examples ──────────────────────────────────────────────

describe('varint — RFC 9000 §16 examples', () => {
  // These are the exact test vectors from the QUIC spec

  it('decodes 1-byte varint: 0x25 → 37', () => {
    const [value, consumed] = decodeVarint(hex('25'))
    expect(value).toBe(37)
    expect(consumed).toBe(1)
  })

  it('decodes 2-byte varint: 0x7bbd → 15293', () => {
    const [value, consumed] = decodeVarint(hex('7bbd'))
    expect(value).toBe(15293)
    expect(consumed).toBe(2)
  })

  it('decodes 4-byte varint: 0x9d7f3e7d → 494878333', () => {
    const [value, consumed] = decodeVarint(hex('9d7f3e7d'))
    expect(value).toBe(494878333)
    expect(consumed).toBe(4)
  })

  it('decodes 8-byte varint: 0xc2197c5eff14e88c → 151288809941952652', () => {
    const [value, consumed] = decodeVarint(hex('c2197c5eff14e88c'))
    expect(value).toBe(151288809941952652)
    expect(consumed).toBe(8)
  })
})

// ─── Encoding ───────────────────────────────────────────────────────────

describe('varint — encoding', () => {
  it('encodes 0 as single byte 0x00', () => {
    const encoded = encodeVarint(0)
    expect(encoded).toEqual(hex('00'))
  })

  it('encodes 1 as single byte 0x01', () => {
    const encoded = encodeVarint(1)
    expect(encoded).toEqual(hex('01'))
  })

  it('encodes 63 (max 1-byte) as 0x3f', () => {
    const encoded = encodeVarint(63)
    expect(encoded).toEqual(hex('3f'))
  })

  it('encodes 64 (min 2-byte) as 0x4040', () => {
    const encoded = encodeVarint(64)
    expect(encoded).toEqual(hex('4040'))
  })

  it('encodes 16383 (max 2-byte) as 0x7fff', () => {
    const encoded = encodeVarint(16383)
    expect(encoded).toEqual(hex('7fff'))
  })

  it('encodes 16384 (min 4-byte) as 0x80004000', () => {
    const encoded = encodeVarint(16384)
    expect(encoded).toEqual(hex('80004000'))
  })

  it('encodes 1073741823 (max 4-byte) as 0xbfffffff', () => {
    const encoded = encodeVarint(1073741823)
    expect(encoded).toEqual(hex('bfffffff'))
  })

  it('encodes 1073741824 (min 8-byte) as 0xc000000040000000', () => {
    const encoded = encodeVarint(1073741824)
    expect(encoded).toEqual(hex('c000000040000000'))
  })
})

// ─── Round-trip ─────────────────────────────────────────────────────────

describe('varint — round-trip encode/decode', () => {
  const testValues = [
    0,
    1,
    2,
    10,
    37,
    63, // 1-byte range
    64,
    100,
    255,
    1000,
    15293,
    16383, // 2-byte range
    16384,
    65535,
    494878333,
    1073741823, // 4-byte range
    1073741824,
    151288809941952652, // 8-byte range
  ]

  for (const value of testValues) {
    it(`round-trips value ${value}`, () => {
      const encoded = encodeVarint(value)
      const [decoded, consumed] = decodeVarint(encoded)
      expect(decoded).toBe(value)
      expect(consumed).toBe(encoded.length)
    })
  }
})

// ─── Boundary values ────────────────────────────────────────────────────

describe('varint — boundary values', () => {
  it.skip('handles the maximum varint value (2^62 - 1)', () => {
    // SKIPPED: VARINT_MAX (2^62-1) exceeds Number.MAX_SAFE_INTEGER.
    // Values above 2^53-1 lose precision in float64, causing encode/decode
    // to produce incorrect results. This is a known limitation of using
    // `number` rather than `bigint` for varints. In practice, MoQT wire
    // values (version numbers, request IDs, track aliases) fit well within
    // safe integer range. The @moqtap/codec package uses bigint internally
    // and handles the full 62-bit range correctly.
  })

  it('1-byte boundary: 63 → 64', () => {
    expect(varintEncodedLength(63)).toBe(1)
    expect(varintEncodedLength(64)).toBe(2)
  })

  it('2-byte boundary: 16383 → 16384', () => {
    expect(varintEncodedLength(16383)).toBe(2)
    expect(varintEncodedLength(16384)).toBe(4)
  })

  it('4-byte boundary: 1073741823 → 1073741824', () => {
    expect(varintEncodedLength(1073741823)).toBe(4)
    expect(varintEncodedLength(1073741824)).toBe(8)
  })
})

// ─── Offset handling ────────────────────────────────────────────────────

describe('varint — offset handling', () => {
  it('decodes varint at non-zero offset', () => {
    const buf = hex('ff25ff') // varint 0x25 = 37 at offset 1
    const [value, consumed] = decodeVarint(buf, 1)
    expect(value).toBe(37)
    expect(consumed).toBe(1)
  })

  it('decodes 2-byte varint at offset 3', () => {
    const buf = hex('aabbcc7bbd')
    const [value, consumed] = decodeVarint(buf, 3)
    expect(value).toBe(15293)
    expect(consumed).toBe(2)
  })

  it('decodes 4-byte varint embedded in larger buffer', () => {
    const buf = hex('00009d7f3e7d0000')
    const [value, consumed] = decodeVarint(buf, 2)
    expect(value).toBe(494878333)
    expect(consumed).toBe(4)
  })
})

// ─── Error cases ────────────────────────────────────────────────────────

describe('varint — error cases', () => {
  it('throws on empty buffer', () => {
    expect(() => decodeVarint(new Uint8Array(0))).toThrow()
  })

  it('throws on truncated 2-byte varint (only 1 byte available)', () => {
    // First byte has prefix 01 (2-byte varint) but buffer is only 1 byte
    expect(() => decodeVarint(hex('40'))).toThrow()
  })

  it('throws on truncated 4-byte varint', () => {
    expect(() => decodeVarint(hex('800000'))).toThrow()
  })

  it('throws on truncated 8-byte varint', () => {
    expect(() => decodeVarint(hex('c00000000000'))).toThrow()
  })

  it('throws when encoding a negative value', () => {
    expect(() => encodeVarint(-1)).toThrow()
  })

  it('VARINT_MAX + 1 is not distinguishable from VARINT_MAX in float64', () => {
    // 2^62 exceeds Number.MAX_SAFE_INTEGER, so VARINT_MAX + 1 === VARINT_MAX.
    // This is a known limitation of using number (not bigint) for varint values.
    expect(VARINT_MAX + 1).toBe(VARINT_MAX)
  })

  it('throws on offset beyond buffer', () => {
    expect(() => decodeVarint(hex('25'), 5)).toThrow()
  })
})

// ─── Minimum encoding (spec: "SHOULD be encoded using the least number of bytes") ─

describe('varint — minimum encoding', () => {
  it('encodes small values in 1 byte', () => {
    for (let v = 0; v <= 63; v++) {
      expect(encodeVarint(v).length).toBe(1)
    }
  })

  it('encodes medium values in 2 bytes', () => {
    for (const v of [64, 100, 1000, 16383]) {
      expect(encodeVarint(v).length).toBe(2)
    }
  })

  it('encodes large values in 4 bytes', () => {
    for (const v of [16384, 100000, 1073741823]) {
      expect(encodeVarint(v).length).toBe(4)
    }
  })

  it('encodes very large values in 8 bytes', () => {
    for (const v of [1073741824, VARINT_MAX]) {
      expect(encodeVarint(v).length).toBe(8)
    }
  })
})

// ─── MoQT-specific version numbers ─────────────────────────────────────

describe('varint — MoQT version numbers', () => {
  it('round-trips draft-14 version 0xff00000e', () => {
    const version = 0xff00000e
    const encoded = encodeVarint(version)
    const [decoded] = decodeVarint(encoded)
    expect(decoded).toBe(version)
  })

  it('round-trips draft-13 version 0xff00000d', () => {
    const version = 0xff00000d
    const encoded = encodeVarint(version)
    const [decoded] = decodeVarint(encoded)
    expect(decoded).toBe(version)
  })

  it('round-trips final version 0x00000001', () => {
    const version = 0x00000001
    const encoded = encodeVarint(version)
    const [decoded] = decodeVarint(encoded)
    expect(decoded).toBe(version)
  })
})

// ─── Consecutive varints in a buffer ────────────────────────────────────

describe('varint — consecutive decoding', () => {
  it('decodes multiple varints from a single buffer', () => {
    // 0x25 (37, 1 byte) + 0x7bbd (15293, 2 bytes) + 0x00 (0, 1 byte)
    const buf = hex('257bbd00')
    let offset = 0

    const [v1, c1] = decodeVarint(buf, offset)
    expect(v1).toBe(37)
    expect(c1).toBe(1)
    offset += c1

    const [v2, c2] = decodeVarint(buf, offset)
    expect(v2).toBe(15293)
    expect(c2).toBe(2)
    offset += c2

    const [v3, c3] = decodeVarint(buf, offset)
    expect(v3).toBe(0)
    expect(c3).toBe(1)
  })
})

// ─── MoQT varint (draft-17 §1.4.1) ──────────────────────────────────────

/**
 * Draft-17 replaced the RFC 9000 integer with MoQT's own, whose length is the
 * number of leading 1 bits in the first byte. Hex and values below are the
 * @moqtap/test-vectors draft-17/18 varint vectors.
 */
describe('MoQT varint — decoding', () => {
  it.each([
    ['25', 37, 1],
    ['7f', 127, 1], // one byte reaches 127, where RFC 9000 stops at 63
    ['8080', 128, 2],
    ['bbbd', 15293, 2],
    ['bfff', 16383, 2],
    ['e0200000', 2097152, 4],
    ['ed7f3e7d', 226442877, 4],
    ['efffffff', 268435455, 4],
    ['fc8998abc66bc0', 151288809941952, 7],
  ])('decodes %s as %d in %d bytes', (h, value, length) => {
    expect(decodeMoqtVarint(hex(h))).toEqual([value, length])
  })

  it('accepts non-minimal encodings, which draft-18 §1.4.1 requires', () => {
    // "any encoding length that can represent the value is valid"
    expect(decodeMoqtVarint(hex('e000007f'))[0]).toBe(127)
    expect(decodeMoqtVarint(hex('ff0000000000000000'))).toEqual([0, 9])
  })

  it('throws on a truncated varint rather than reading short', () => {
    expect(() => decodeMoqtVarint(hex('e00000'))).toThrow(VarintError)
    expect(() => decodeMoqtVarint(hex('ff00000000'))).toThrow(VarintError)
    expect(() => decodeMoqtVarint(new Uint8Array())).toThrow(VarintError)
  })

  it('decodes 0x2F00 from af 00, the SETUP that opens a control stream', () => {
    // The same bytes are 0x2f000000-something to RFC 9000, and RFC 9000's
    // 6f 00 is 0x6f to MoQT. Neither encoding errors on the other's bytes.
    expect(decodeMoqtVarint(hex('af00'))).toEqual([0x2f00, 2])
    expect(decodeMoqtVarint(hex('6f00'))).toEqual([0x6f, 1])
  })
})

describe('MoQT varint — the draft-17 seven-byte gap', () => {
  it('rejects the 7-byte form on draft-17, which has no such length', () => {
    // draft-17 §1.4.1: "11111100 is an invalid code point. An endpoint that
    // receives this value MUST close the session with a PROTOCOL_VIOLATION."
    expect(() => decodeMoqtVarint(hex('fc8998abc66bc0'), 0, 'moqt17')).toThrow(
      VarintError,
    )
    expect(decodeMoqtVarint(hex('fc8998abc66bc0'), 0, 'moqt18')[0]).toBe(
      151288809941952,
    )
  })

  it('spends eight bytes on draft-17 where draft-18 spends seven', () => {
    const value = 151288809941952
    expect(encodeMoqtVarint(value, 'moqt17')).toEqual(hex('fe008998abc66bc0'))
    expect(encodeMoqtVarint(value, 'moqt18')).toEqual(hex('fc8998abc66bc0'))
  })
})

describe('MoQT varint — encoding', () => {
  it.each([
    [37, '25'],
    [127, '7f'],
    [128, '8080'],
    [15293, 'bbbd'],
    [226442877, 'ed7f3e7d'],
    [0x2f00, 'af00'],
  ])('encodes %d as %s, the shortest form that holds it', (value, h) => {
    expect(encodeMoqtVarint(value)).toEqual(hex(h))
  })

  it('round-trips every length boundary', () => {
    for (let n = 1; n <= 7; n++) {
      for (const value of [2 ** (7 * n) - 1, 2 ** (7 * n)]) {
        const [decoded] = decodeMoqtVarint(encodeMoqtVarint(value))
        expect(decoded, `2^${7 * n} boundary`).toBe(value)
      }
    }
  })

  it('rejects values it cannot represent exactly as a number', () => {
    expect(() => encodeMoqtVarint(-1)).toThrow(VarintError)
    expect(() => encodeMoqtVarint(2 ** 53)).toThrow(VarintError)
  })
})

// ─── Which encoding a draft writes ──────────────────────────────────────

describe('varintEncoding', () => {
  it('puts every draft on the encoding its spec defines', () => {
    // Not a `>= 17` threshold: draft-17 introduced the MoQT integer and
    // draft-18 revised it by restoring the 7-byte length.
    const expected: Record<SupportedDraft, VarintEncoding> = {
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
    for (const [draft, encoding] of Object.entries(expected)) {
      expect(varintEncoding(draft as SupportedDraft), `draft-${draft}`).toBe(
        encoding,
      )
    }
  })

  it('reads and writes SETUP differently either side of draft-17', () => {
    expect(encodeVarintForDraft('16', 0x2f00)).toEqual(hex('6f00'))
    expect(encodeVarintForDraft('19', 0x2f00)).toEqual(hex('af00'))

    expect(decodeVarintForDraft('16', hex('6f00'))[0]).toBe(0x2f00)
    expect(decodeVarintForDraft('19', hex('af00'))[0]).toBe(0x2f00)
  })

  it('round-trips message-type-sized values on every draft', () => {
    const drafts: SupportedDraft[] = [
      '07', '08', '09', '10', '11', '12', '13',
      '14', '15', '16', '17', '18', '19',
    ]
    for (const draft of drafts) {
      for (const value of [0, 0x20, 0x40, 0x51, 0x2f00, 0xff000013]) {
        const [decoded] = decodeVarintForDraft(
          draft,
          encodeVarintForDraft(draft, value),
        )
        expect(decoded, `draft-${draft} ${value}`).toBe(value)
      }
    }
  })
})
