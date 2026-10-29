/** The one-line texts over a stream's detail. */

import { formatBytes, formatCount, plural } from './format'

export interface StreamSummaryInput {
  trackName: string | null
  datagramGroup: boolean
  bidi?: boolean
  byteCount: number
  chunkCount: number
  datagramCount?: number
  closed: boolean
}

/** `video/1080p · unidirectional · 18 chunks · 12.6 kB · closed`: the size once. */
export function streamSummary(s: StreamSummaryInput): string {
  const parts: string[] = []
  if (s.trackName) parts.push(s.trackName)
  if (s.datagramGroup) parts.push(plural(s.datagramCount ?? 0, 'datagram'))
  else {
    if (s.bidi !== undefined) parts.push(s.bidi ? 'bidirectional' : 'unidirectional')
    if (s.chunkCount > 0) parts.push(`${formatCount(s.chunkCount)} ${s.chunkCount === 1 ? 'chunk' : 'chunks'}`)
  }
  parts.push(formatBytes(s.byteCount))
  parts.push(s.closed ? 'closed' : 'open')
  return parts.join(' · ')
}

/** `fMP4 · group 404463 · subgroup 1 · pri 1 · 13 objects` */
export function framingSummary(
  media: string | null,
  tags: readonly { label: string; value: string }[],
  objects: number | null,
): string {
  const parts: string[] = []
  if (media) parts.push(media)
  for (const t of tags) parts.push(`${t.label} ${t.value}`)
  if (objects !== null) parts.push(plural(objects, 'object'))
  return parts.join(' · ')
}
