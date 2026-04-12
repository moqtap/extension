/**
 * Minimal MessagePack decoder — enough to convert payloads to JSON-friendly values.
 *
 * Supports: nil, booleans, integers (up to safe integer range), float32/64,
 * str, bin (as hex), arrays, maps, ext (as tagged hex).
 *
 * Does NOT support: BigInt, timestamp extension type.
 */

export interface MsgpackDecodeResult {
  value: unknown
  /** Number of bytes consumed */
  bytesRead: number
}

/**
 * Try to decode a MessagePack value from the start of `data`.
 * Returns null if the data doesn't look like valid MessagePack.
 */
export function decodeMsgpack(data: Uint8Array): MsgpackDecodeResult | null {
  try {
    const [value, offset] = decode(data, 0)
    if (offset < 1) return null
    return { value, bytesRead: offset }
  } catch {
    return null
  }
}

/**
 * Heuristic check: does this look like MessagePack?
 * Requires the data to start with a map or array and decode
 * successfully, consuming a reasonable portion of bytes.
 */
export function looksLikeMsgpack(data: Uint8Array): boolean {
  if (data.length < 2) return false
  const b = data[0]
  // Must start with fixmap (0x80-0x8f), map16 (0xde), map32 (0xdf),
  // fixarray (0x90-0x9f), array16 (0xdc), or array32 (0xdd)
  const isMap = (b >= 0x80 && b <= 0x8f) || b === 0xde || b === 0xdf
  const isArray = (b >= 0x90 && b <= 0x9f) || b === 0xdc || b === 0xdd
  if (!isMap && !isArray) return false
  const result = decodeMsgpack(data)
  if (!result) return false
  return result.bytesRead >= data.length * 0.5
}

// ── Internal decoder ────────────────────────────────────────────

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true })

function readUint16(d: Uint8Array, o: number): number {
  return (d[o] << 8) | d[o + 1]
}

function readUint32(d: Uint8Array, o: number): number {
  return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0
}

function decode(data: Uint8Array, offset: number): [unknown, number] {
  if (offset >= data.length) throw new Error('unexpected end')

  const b = data[offset++]

  // ── Positive fixint (0x00 - 0x7f) ──
  if (b <= 0x7f) return [b, offset]

  // ── Fixmap (0x80 - 0x8f) ──
  if (b >= 0x80 && b <= 0x8f) return decodeMap(data, offset, b & 0x0f)

  // ── Fixarray (0x90 - 0x9f) ──
  if (b >= 0x90 && b <= 0x9f) return decodeArray(data, offset, b & 0x0f)

  // ── Fixstr (0xa0 - 0xbf) ──
  if (b >= 0xa0 && b <= 0xbf) return decodeStr(data, offset, b & 0x1f)

  // ── Negative fixint (0xe0 - 0xff) ──
  if (b >= 0xe0) return [b - 256, offset]

  switch (b) {
    case 0xc0:
      return [null, offset] // nil
    case 0xc1:
      throw new Error('never used') // never used
    case 0xc2:
      return [false, offset] // false
    case 0xc3:
      return [true, offset] // true

    // bin 8/16/32
    case 0xc4:
      return decodeBin(data, offset, data[offset++])
    case 0xc5: {
      const n = readUint16(data, offset)
      return decodeBin(data, offset + 2, n)
    }
    case 0xc6: {
      const n = readUint32(data, offset)
      return decodeBin(data, offset + 4, n)
    }

    // ext 8/16/32
    case 0xc7: {
      const n = data[offset++]
      return decodeExt(data, offset, n)
    }
    case 0xc8: {
      const n = readUint16(data, offset)
      return decodeExt(data, offset + 2, n)
    }
    case 0xc9: {
      const n = readUint32(data, offset)
      return decodeExt(data, offset + 4, n)
    }

    // float 32/64
    case 0xca: {
      const view = new DataView(data.buffer, data.byteOffset + offset, 4)
      return [view.getFloat32(0), offset + 4]
    }
    case 0xcb: {
      const view = new DataView(data.buffer, data.byteOffset + offset, 8)
      return [view.getFloat64(0), offset + 8]
    }

    // uint 8/16/32/64
    case 0xcc:
      return [data[offset++], offset]
    case 0xcd:
      return [readUint16(data, offset), offset + 2]
    case 0xce:
      return [readUint32(data, offset), offset + 4]
    case 0xcf: {
      const view = new DataView(data.buffer, data.byteOffset + offset, 8)
      return [Number(view.getBigUint64(0)), offset + 8]
    }

    // int 8/16/32/64
    case 0xd0:
      return [
        data[offset] > 127 ? data[offset++] - 256 : data[offset++],
        offset,
      ]
    case 0xd1: {
      const v = readUint16(data, offset)
      return [v > 0x7fff ? v - 0x10000 : v, offset + 2]
    }
    case 0xd2: {
      const v = readUint32(data, offset)
      return [v > 0x7fffffff ? v - 0x100000000 : v, offset + 4]
    }
    case 0xd3: {
      const view = new DataView(data.buffer, data.byteOffset + offset, 8)
      return [Number(view.getBigInt64(0)), offset + 8]
    }

    // fixext 1/2/4/8/16
    case 0xd4:
      return decodeExt(data, offset, 1)
    case 0xd5:
      return decodeExt(data, offset, 2)
    case 0xd6:
      return decodeExt(data, offset, 4)
    case 0xd7:
      return decodeExt(data, offset, 8)
    case 0xd8:
      return decodeExt(data, offset, 16)

    // str 8/16/32
    case 0xd9:
      return decodeStr(data, offset + 1, data[offset])
    case 0xda: {
      const n = readUint16(data, offset)
      return decodeStr(data, offset + 2, n)
    }
    case 0xdb: {
      const n = readUint32(data, offset)
      return decodeStr(data, offset + 4, n)
    }

    // array 16/32
    case 0xdc:
      return decodeArray(data, offset + 2, readUint16(data, offset))
    case 0xdd:
      return decodeArray(data, offset + 4, readUint32(data, offset))

    // map 16/32
    case 0xde:
      return decodeMap(data, offset + 2, readUint16(data, offset))
    case 0xdf:
      return decodeMap(data, offset + 4, readUint32(data, offset))

    default:
      throw new Error(`unknown byte 0x${b.toString(16)}`)
  }
}

function decodeStr(
  data: Uint8Array,
  offset: number,
  len: number,
): [string, number] {
  const s = TEXT_DECODER.decode(data.subarray(offset, offset + len))
  return [s, offset + len]
}

function decodeBin(
  data: Uint8Array,
  offset: number,
  len: number,
): [string, number] {
  const bytes = data.slice(offset, offset + len)
  return [
    Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''),
    offset + len,
  ]
}

function decodeExt(
  data: Uint8Array,
  offset: number,
  len: number,
): [unknown, number] {
  const type = data[offset] > 127 ? data[offset] - 256 : data[offset]
  offset++
  const bytes = data.slice(offset, offset + len)
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return [{ __ext: type, data: hex }, offset + len]
}

function decodeArray(
  data: Uint8Array,
  offset: number,
  count: number,
): [unknown[], number] {
  const arr: unknown[] = []
  for (let i = 0; i < count; i++) {
    const [val, newOff] = decode(data, offset)
    arr.push(val)
    offset = newOff
  }
  return [arr, offset]
}

function decodeMap(
  data: Uint8Array,
  offset: number,
  count: number,
): [Record<string, unknown>, number] {
  const obj: Record<string, unknown> = {}
  for (let i = 0; i < count; i++) {
    const [key, keyOff] = decode(data, offset)
    const [val, valOff] = decode(data, keyOff)
    obj[String(key)] = val
    offset = valOff
  }
  return [obj, offset]
}
