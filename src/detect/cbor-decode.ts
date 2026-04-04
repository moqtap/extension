/**
 * Minimal CBOR decoder — enough to convert payloads to JSON-friendly values.
 *
 * Supports: unsigned/negative ints, byte/text strings, arrays, maps, booleans,
 * null, undefined, float16/32/64, tagged values (tag is discarded, inner value kept).
 *
 * Does NOT support: indefinite-length containers, BigInt (returns number approximation).
 * This is intentional — we only need "good enough" for display purposes.
 */

export interface CborDecodeResult {
  value: unknown;
  /** Number of bytes consumed */
  bytesRead: number;
}

/**
 * Try to decode a CBOR value from the start of `data`.
 * Returns null if the data doesn't look like valid CBOR.
 */
export function decodeCbor(data: Uint8Array): CborDecodeResult | null {
  try {
    const [value, offset] = decode(data, 0);
    if (offset < 1) return null;
    return { value, bytesRead: offset };
  } catch {
    return null;
  }
}

/**
 * Heuristic check: does this look like CBOR?
 * Checks if the first byte is a valid CBOR major type and the data
 * decodes fully without errors, consuming a reasonable portion of bytes.
 */
export function looksLikeCbor(data: Uint8Array): boolean {
  if (data.length < 2) return false;
  const major = data[0] >> 5;
  // Major types 0-7 are valid; most useful payloads start with map (5) or array (4)
  if (major > 7) return false;
  // For detection, require it starts with a map or array (otherwise too many false positives)
  if (major !== 4 && major !== 5) return false;
  const result = decodeCbor(data);
  if (!result) return false;
  // Must consume at least 50% of the data to be plausible
  return result.bytesRead >= data.length * 0.5;
}

// ── Internal decoder ────────────────────────────────────────────

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

function decode(data: Uint8Array, offset: number): [unknown, number] {
  if (offset >= data.length) throw new Error('unexpected end');

  const initial = data[offset];
  const major = initial >> 5;
  const info = initial & 0x1f;
  offset++;

  // Read argument value
  let argVal: number;
  if (info < 24) {
    argVal = info;
  } else if (info === 24) {
    argVal = data[offset++];
  } else if (info === 25) {
    argVal = (data[offset] << 8) | data[offset + 1];
    offset += 2;
  } else if (info === 26) {
    argVal = ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
    offset += 4;
  } else if (info === 27) {
    // 64-bit — read as Number (loses precision above 2^53)
    const view = new DataView(data.buffer, data.byteOffset + offset, 8);
    argVal = Number(view.getBigUint64(0));
    offset += 8;
  } else if (info >= 28 && info <= 30) {
    throw new Error('reserved info value');
  } else {
    // info === 31: indefinite length — not supported
    argVal = -1;
  }

  switch (major) {
    case 0: // unsigned integer
      return [argVal, offset];

    case 1: // negative integer
      return [-(argVal + 1), offset];

    case 2: { // byte string
      if (argVal < 0) throw new Error('indefinite byte string');
      const bytes = data.slice(offset, offset + argVal);
      offset += argVal;
      // Represent as hex string for JSON display
      return [Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''), offset];
    }

    case 3: { // text string
      if (argVal < 0) throw new Error('indefinite text string');
      const textBytes = data.subarray(offset, offset + argVal);
      offset += argVal;
      return [TEXT_DECODER.decode(textBytes), offset];
    }

    case 4: { // array
      if (argVal < 0) throw new Error('indefinite array');
      const arr: unknown[] = [];
      for (let i = 0; i < argVal; i++) {
        const [item, newOff] = decode(data, offset);
        arr.push(item);
        offset = newOff;
      }
      return [arr, offset];
    }

    case 5: { // map
      if (argVal < 0) throw new Error('indefinite map');
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < argVal; i++) {
        const [key, keyOff] = decode(data, offset);
        const [val, valOff] = decode(data, keyOff);
        obj[String(key)] = val;
        offset = valOff;
      }
      return [obj, offset];
    }

    case 6: // tagged value — decode inner, discard tag
      return decode(data, offset);

    case 7: { // simple values and floats
      if (info === 20) return [false, offset];
      if (info === 21) return [true, offset];
      if (info === 22) return [null, offset];
      if (info === 23) return [null, offset]; // undefined → null for JSON
      if (info === 25) {
        // float16
        const half = (data[offset - 2] << 8) | data[offset - 1];
        return [decodeFloat16(half), offset];
      }
      if (info === 26) {
        // float32
        const view = new DataView(data.buffer, data.byteOffset + offset - 4, 4);
        return [view.getFloat32(0), offset];
      }
      if (info === 27) {
        // float64
        const view = new DataView(data.buffer, data.byteOffset + offset - 8, 8);
        return [view.getFloat64(0), offset];
      }
      return [argVal, offset]; // simple value
    }

    default:
      throw new Error(`unknown major type ${major}`);
  }
}

function decodeFloat16(half: number): number {
  const exp = (half >> 10) & 0x1f;
  const mant = half & 0x3ff;
  const sign = half & 0x8000 ? -1 : 1;
  if (exp === 0) return sign * (mant / 1024) * (1 / 16384); // subnormal
  if (exp === 31) return mant ? NaN : sign * Infinity;
  return sign * Math.pow(2, exp - 15) * (1 + mant / 1024);
}
