/**
 * How the panel writes sizes, durations, times and IDs. One place, so every
 * view says `1.4 KiB` and `+00:01.284` the same way.
 */

const THIN = '\u2009'

/** Binary units, one decimal: `812 B`, `1.4 KiB`, `12.0 MiB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n}${THIN}B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)}${THIN}${units[i]}`
}

/** `0.42 ms`, `18 ms`, `1.25 s`, `3 m 12 s`. */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0
  if (ms < 10) return `${Number(ms.toFixed(2))}${THIN}ms`
  if (ms < 1000) return `${Math.round(ms)}${THIN}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(2)}${THIN}s`
  const m = Math.floor(s / 60)
  return `${m}${THIN}m ${Math.floor(s % 60)}${THIN}s`
}

/** Time since the session started, for data panes: `+00:01.284`. */
export function formatOffset(ts: number, start: number): string {
  const d = Math.max(0, ts - start)
  const min = Math.floor(d / 60_000)
  const sec = Math.floor((d % 60_000) / 1000)
  const ms = Math.floor(d % 1000)
  return `+${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

/** Wall-clock time in the reader's locale; pair it with `isoTitle`. */
export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function isoTitle(ts: number): string {
  return new Date(ts).toISOString()
}

/** Thousands separators: `12,480`. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

/** `12,480 objects`, `1 stream`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`
}

/** Bits per second in decimal units, the way link rates are quoted. */
export function formatBitrate(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)}${THIN}Mbps`
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(0)}${THIN}kbps`
  return `${Math.round(bps)}${THIN}bps`
}

/**
 * An ID or hash in a data pane: whole when it is 20 characters or fewer,
 * otherwise its first and last eight around an ellipsis. Pair it with the
 * full value as a tooltip and a copy control.
 */
export function shortId(value: string): string {
  if (value.length <= 20) return value
  return `${value.slice(0, 8)}…${value.slice(-8)}`
}

/**
 * The short ID a connection goes by in the sidebar: the per-page counter of a
 * captured session (`wt-<time>-<n>`), or the random tail of an imported one.
 */
export function shortSessionId(sessionId: string): string {
  const tail = sessionId.slice(sessionId.lastIndexOf('-') + 1)
  return `#${tail.slice(0, 4)}`
}

/**
 * A control message type as the draft writes it: `subscribe_ok` reads
 * `SUBSCRIBE_OK`. Anything else (a raw wire ID) is left as it is.
 */
export function messageTypeName(type: string): string {
  return /^[a-z][a-z0-9_]*$/.test(type) ? type.toUpperCase() : type
}
