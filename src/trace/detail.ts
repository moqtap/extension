/**
 * The detail level a trace's events support, and the events that level
 * admits (moqtrace SPEC.md, "Detail Levels").
 *
 * The level is derived from what the events carry rather than declared:
 * payload bytes make `headers+data`, payload sizes `headers+sizes`, an object
 * header `headers`, and anything less is `control`. A level that claims bytes
 * or objects the trace does not hold would tell a reader the session carried
 * none.
 *
 * SPEC.md "Detail Levels" gives `full` as "Everything above + raw wire bytes
 * for every *control* message (pre-decode), and the bytes behind an error
 * event". A trace is `full` only when it holds all of that on top of
 * `headers+data`. Otherwise every Event 0 and Event 6 `"raw"` goes, since
 * SPEC.md gates both at `full` only, and below `headers+sizes` so does every
 * Event 6 `"rawlen"`.
 *
 * A trace is `full` only when its events show stream bytes (a payload, or a
 * data stream error holding its bytes).
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

function rawOf(e: TraceEvent): Uint8Array | undefined {
  return (e as { raw?: Uint8Array }).raw
}

/**
 * The flow an error's `"raw"` is latched on. SPEC.md Event 6, "One raw per
 * flow": "per stream where the error names one, per peer where it does not,
 * and once for the whole recording where it writes no peer identifier
 * either."
 */
export function rawFlow(e: TraceEvent): string {
  const { streamId, peer } = e as { streamId?: bigint; peer?: string }
  if (streamId !== undefined) return `${peer ?? ''}/${streamId}`
  return peer !== undefined ? `${peer}/` : '/'
}

/**
 * Whether the trace holds every byte `full` adds: at least one `"raw"`, one
 * on every control message, and one on each flow whose errors had bytes
 * behind them (a `"rawlen"` above zero).
 */
function holdsFull(events: readonly TraceEvent[]): boolean {
  let any = false
  const owed = new Set<string>()
  const paid = new Set<string>()
  for (const e of events) {
    const raw = rawOf(e)
    const held = raw !== undefined && raw.length > 0
    if (e.type === 'control') {
      if (!held) return false
      any = true
    } else if (e.type === 'error') {
      const flow = rawFlow(e)
      const length = (e as { rawLength?: number }).rawLength
      if (held) {
        any = true
        paid.add(flow)
      } else if (length !== undefined && length > 0) owed.add(flow)
    }
  }
  for (const flow of owed) if (!paid.has(flow)) return false
  return any
}

function without(e: TraceEvent, key: 'raw' | 'rawLength'): TraceEvent {
  if ((e as unknown as Record<string, unknown>)[key] === undefined) return e
  const { [key]: _gone, ...rest } = e as unknown as Record<string, unknown>
  return rest as unknown as TraceEvent
}

/**
 * `events` keep their `seq`; a caller that drops any renumbers.
 *
 * `onDataStream` names the error events about a data stream's bytes; one
 * that holds them counts toward `full`. `options.full: false` marks a trace
 * whose `full` bytes were dropped in a way its events do not show.
 */
export function fitDetail(
  events: readonly TraceEvent[],
  onDataStream: (e: TraceEvent) => boolean = () => false,
  options: { full?: boolean } = {},
): {
  detail: DetailLevel
  events: readonly TraceEvent[]
} {
  const payload = events.some(
    (e) => e.type === 'object-payload' && (e as { payload?: unknown }).payload !== undefined,
  )
  const streamBytes =
    payload || events.some((e) => e.type === 'error' && rawOf(e) !== undefined && onDataStream(e))
  if (streamBytes && options.full !== false && holdsFull(events))
    return { detail: 'full', events }

  let out = events.map((e) =>
    e.type === 'control' || e.type === 'error' ? without(e, 'raw') : e,
  )
  if (payload) return { detail: 'headers+data', events: out }
  if (events.some((e) => e.type === 'object-payload'))
    return { detail: 'headers+sizes', events: out }
  out = out.map((e) => (e.type === 'error' ? without(e, 'rawLength') : e))
  if (events.some((e) => e.type === 'object-header')) return { detail: 'headers', events: out }
  return { detail: 'control', events: out.filter((e) => !DATA_STREAM_EVENTS.has(e.type)) }
}
