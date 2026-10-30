/** What a stream or datagram group says about its size. */
export interface Sized {
  byteCount: number
  /** Payload bytes an imported trace records sizes for, when it holds none of them. */
  recordedBytes?: number
  /** An imported trace that records objects but neither their bytes nor their sizes. */
  sizeUnknown?: true
}

/** A stream's bytes: what it holds, else what its trace records; null when the trace records neither. */
export function streamBytes(s: Sized): number | null {
  if (s.byteCount > 0) return s.byteCount
  if (s.sizeUnknown) return null
  return s.recordedBytes ?? 0
}

export interface SizedSession {
  streams: ReadonlyMap<unknown, Sized>
  datagramGroups: ReadonlyMap<unknown, Sized>
  /** Bytes an imported trace records sizes for that no stream or group holds. */
  recordedBytes?: number
  sizeUnknown?: true
}

/** A connection's bytes on its streams and datagrams; null for an import whose trace records no sizes. */
export function sessionBytes(session: SizedSession): number | null {
  if (session.sizeUnknown) return null
  let total = session.recordedBytes ?? 0
  for (const s of session.streams.values()) total += s.byteCount
  for (const g of session.datagramGroups.values()) total += g.byteCount
  return total
}
