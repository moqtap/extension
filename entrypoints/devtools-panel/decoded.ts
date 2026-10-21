/**
 * Decoded control messages as the background sends them.
 *
 * A decoded message holds `bigint`s and `Uint8Array`s, which JSON cannot
 * carry, so the background tags them (`{ __t: 'n' }` for a bigint in decimal,
 * `{ __t: 'b' }` for bytes in hex) before posting. The panel reads the tagged
 * form two ways: restored to the codec's own values, which is what the shared
 * display and setup readers in `@moqtap/inspect` take, and flattened to plain
 * JSON values for filtering and trace export.
 */

interface TaggedBigInt {
  __t: 'n'
  v: string
}

interface TaggedBytes {
  __t: 'b'
  v: string
}

function isTaggedBigInt(v: unknown): v is TaggedBigInt {
  return (
    v != null &&
    typeof v === 'object' &&
    (v as Record<string, unknown>).__t === 'n' &&
    typeof (v as Record<string, unknown>).v === 'string'
  )
}

function isTaggedBytes(v: unknown): v is TaggedBytes {
  return (
    v != null &&
    typeof v === 'object' &&
    (v as Record<string, unknown>).__t === 'b' &&
    typeof (v as Record<string, unknown>).v === 'string'
  )
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(Math.floor(hex.length / 2))
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
  }
  return out
}

/** The tagged form with its bigints and byte strings restored. */
export function reviveTagged(obj: unknown): unknown {
  if (isTaggedBigInt(obj)) return BigInt(obj.v)
  if (isTaggedBytes(obj)) return hexToBytes(obj.v)
  if (Array.isArray(obj)) return obj.map(reviveTagged)
  if (obj != null && typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) result[k] = reviveTagged(v)
    return result
  }
  return obj
}

/**
 * The tagged form as plain JSON values: a bigint as a number when it is safe
 * and its decimal string when not, bytes as their hex string.
 */
export function untagDecoded(obj: unknown): unknown {
  if (isTaggedBigInt(obj)) {
    const n = Number(obj.v)
    return Number.isSafeInteger(n) ? n : obj.v
  }
  if (isTaggedBytes(obj)) return obj.v
  if (Array.isArray(obj)) return obj.map(untagDecoded)
  if (obj != null && typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) result[k] = untagDecoded(v)
    return result
  }
  return obj
}
