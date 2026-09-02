/**
 * Byte-offset to arrival-time index for a captured stream.
 *
 * A stream is stored as one concatenated buffer, so by the time a trace is
 * exported the chunk boundaries are gone and every object in it looks equally
 * old. Keeping the boundaries as `(cumulative end offset, arrival time)` lets
 * the exporter map an object's payload offset back to when its bytes actually
 * arrived — the difference between a trace whose objects all land at t=0 and
 * one you can draw a delivery timeline from.
 */

/** The arrival time of one run of bytes within a stream. */
export interface ByteArrival {
  /** Cumulative byte offset one past the last byte of this run. */
  end: number
  /**
   * When the chunk carrying it was seen, in epoch ms.
   *
   * This is the page-side `capturedAt` rather than panel-receipt time: a burst
   * of buffered postMessages on tab refocus all arrive at once but carry the
   * spread of times they were really seen at, and an exported trace is only as
   * honest as the timestamps behind it.
   */
  at: number
}

/**
 * Cap on retained entries per stream. Coalescing holds the index to one entry
 * per millisecond of active streaming, which an hour-long capture would still
 * push into the millions; past the cap it is halved rather than truncated, so
 * resolution degrades evenly instead of the recent data being dropped.
 */
export const MAX_ARRIVALS = 2048

/**
 * Append a byte run, coalescing chunks that share a millisecond and halving
 * the index when it outgrows {@link MAX_ARRIVALS}.
 *
 * Halving keeps every second entry, so a byte range that belonged to a dropped
 * run is absorbed by the run after it and reads back as slightly *later* than
 * it arrived. Erring late is deliberate — it never claims an object was
 * delivered before it could have been.
 */
export function recordArrival(
  arrivals: ByteArrival[],
  end: number,
  at: number,
): void {
  const last = arrivals[arrivals.length - 1]
  if (last && last.at === at) {
    last.end = end
    return
  }
  arrivals.push({ end, at })
  if (arrivals.length > MAX_ARRIVALS) {
    // Keep every second entry, anchored so the newest is always among them —
    // on a live capture that is the run still being appended to, and losing it
    // would push every subsequent lookup onto a stale timestamp. Walking
    // forward from that anchor keeps the write index at or behind the read
    // index, so this is safe to do in place.
    let j = 0
    for (let i = (arrivals.length - 1) % 2; i < arrivals.length; i += 2) {
      arrivals[j++] = arrivals[i]
    }
    arrivals.length = j
  }
}

/**
 * Arrival time of the byte at `offset`.
 *
 * Returns undefined when there is no index — an imported trace, or state
 * replayed from IDB after a service worker restart, neither of which saw the
 * chunks arrive. An offset past the last recorded byte resolves to the final
 * run, since that is the most recent time anything is known to have arrived.
 */
export function arrivalAt(
  arrivals: ByteArrival[] | undefined,
  offset: number,
): number | undefined {
  if (!arrivals || arrivals.length === 0) return undefined
  let lo = 0
  let hi = arrivals.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arrivals[mid].end > offset) hi = mid
    else lo = mid + 1
  }
  return arrivals[lo].at
}
