/**
 * The detail level a trace's events support, and the events that level
 * admits (moqtrace SPEC.md, "Detail Levels").
 *
 * The level is derived from what the events carry rather than declared:
 * payload bytes make `headers+data`, an object header makes `headers`, and
 * anything less is `control`. A level that claims bytes or objects the trace
 * does not hold would tell a reader the session carried none.
 *
 * `control` carries no data stream events at all, so when no object is left
 * (stream bytes were not recorded, or a share dropped them) the stream-opened
 * and stream-closed events go too. Keeping them would make a trace that
 * contradicts its own header, which the moqtap server refuses on upload.
 */

import type { DetailLevel, TraceEvent } from '@moqtap/trace'

/** Event types SPEC.md places at `headers` or above. */
const DATA_STREAM_EVENTS: ReadonlySet<TraceEvent['type']> = new Set([
  'stream-opened',
  'stream-closed',
  'object-header',
  'object-payload',
])

/** `events` keep their `seq`; a caller that drops any renumbers. */
export function fitDetail(events: readonly TraceEvent[]): {
  detail: DetailLevel
  events: readonly TraceEvent[]
} {
  const payload = events.some(
    (e) => e.type === 'object-payload' && (e as { payload?: unknown }).payload !== undefined,
  )
  if (payload) return { detail: 'headers+data', events }
  if (events.some((e) => e.type === 'object-header')) return { detail: 'headers', events }
  return { detail: 'control', events: events.filter((e) => !DATA_STREAM_EVENTS.has(e.type)) }
}
