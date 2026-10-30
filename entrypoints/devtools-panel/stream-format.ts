/**
 * What a stream is read as. A track whose packaging the catalogs agree on is
 * read as that packaging and its bytes are not classified. Any other stream
 * is read as what its bytes prove.
 */

import type { PayloadMediaInfo } from '@moqtap/media/bmff'
import type { StreamContentType } from '@/src/detect/content-detect'
import { registryTrackKey, type TrackKey, type TrackPackaging } from './catalogs'
import { datagramSource, listSources, streamSource, trackForSource } from './loc'
import { mediaPackaging, timelinePackaging } from './packaging'
import type { SessionEntry, StreamEntry } from './use-inspector'

/** What capture or import classified from a stream's first bytes. */
export interface ByteFormat {
  contentType: StreamContentType
  mediaInfo?: PayloadMediaInfo
  codecString?: string
}

export type StreamFormat =
  | {
      from: 'packaging'
      packaging: 'loc' | 'cmaf' | 'mediatimeline' | 'eventtimeline'
      via: 'catalog'
    }
  | ({ from: 'bytes' } & ByteFormat)

/** The one place that decides whether a stream's bytes are classified. */
export function streamFormat(
  described: TrackPackaging | undefined,
  bytes: ByteFormat,
): StreamFormat {
  const media = mediaPackaging(described)
  if (media) return { from: 'packaging', packaging: media.packaging, via: media.via }
  const timeline = timelinePackaging(described)
  if (timeline) return { from: 'packaging', packaging: timeline, via: 'catalog' }
  return { from: 'bytes', ...byteFormatOf(bytes) }
}

/** A stream's format, from its track's catalog packaging. */
export function formatOfStream(
  session: Pick<SessionEntry, 'streams' | 'tracks' | 'datagramGroups'>,
  stream: Pick<StreamEntry, 'streamId' | 'datagramGroupKey'> & ByteFormat,
  packaging: ReadonlyMap<TrackKey, TrackPackaging>,
): StreamFormat {
  const source = stream.datagramGroupKey
    ? datagramSource(stream.datagramGroupKey)
    : streamSource(stream.streamId)
  const track = trackForSource(session, source)
  const key = track ? registryTrackKey(track) : null
  return streamFormat(key === null ? undefined : packaging.get(key), stream)
}

/** The short label of a byte-classified stream; null for none, or for a packaged one. */
export function byteLabel(format: StreamFormat): string | null {
  if (format.from !== 'bytes') return null
  switch (format.contentType) {
    case 'fmp4':
      return format.mediaInfo?.variant === 'cmaf' ? 'CMAF' : 'fMP4'
    case 'h264':
      return 'H.264'
    case 'h265':
      return 'H.265'
    case 'json':
      return 'JSON'
    case 'cbor':
      return 'CBOR'
    case 'msgpack':
      return 'MsgPack'
    default:
      return null
  }
}

/** The detail behind {@link byteLabel}: the boxes, or the codec string. */
export function byteTitle(format: StreamFormat): string | undefined {
  if (format.from !== 'bytes') return undefined
  if (format.contentType === 'fmp4' && format.mediaInfo) {
    return format.mediaInfo.boxes.join(' · ')
  }
  if (format.contentType === 'h264' || format.contentType === 'h265') {
    return format.codecString ?? byteLabel(format) ?? undefined
  }
  return undefined
}

/**
 * The byte label every stream of a track with bytes shares, or null when they
 * differ. A track whose BMFF streams are not all CMAF-branded is "fMP4".
 */
export function sharedByteLabel(formats: Iterable<StreamFormat>): string | null {
  let shared: string | null | undefined
  for (const format of formats) {
    const label = byteLabel(format)
    if (label === null) return null
    if (shared === undefined || shared === label) shared = label
    else if ((shared === 'CMAF' || shared === 'fMP4') && (label === 'CMAF' || label === 'fMP4')) {
      shared = 'fMP4'
    } else return null
  }
  return shared ?? null
}

/**
 * Each track's {@link sharedByteLabel}, over its streams and datagram groups
 * with bytes; null for a track with catalog packaging.
 */
export function trackByteLabels(
  session: Pick<SessionEntry, 'streams' | 'tracks' | 'datagramGroups'>,
  packaging: ReadonlyMap<TrackKey, TrackPackaging> | undefined,
): Map<TrackKey, string | null> {
  const byTrack = new Map<TrackKey, StreamFormat[]>()
  for (const ref of listSources(session, () => true)) {
    if (ref.byteCount === 0) continue
    const entry =
      ref.streamId !== undefined
        ? session.streams.get(ref.streamId)
        : session.datagramGroups.get(ref.groupKey!)
    if (!entry) continue
    const format = streamFormat(packaging?.get(ref.key), entry)
    const list = byTrack.get(ref.key)
    if (list) list.push(format)
    else byTrack.set(ref.key, [format])
  }
  const labels = new Map<TrackKey, string | null>()
  for (const [key, formats] of byTrack) labels.set(key, sharedByteLabel(formats))
  return labels
}

function byteFormatOf(entry: ByteFormat): ByteFormat {
  return {
    contentType: entry.contentType,
    ...(entry.mediaInfo ? { mediaInfo: entry.mediaInfo } : {}),
    ...(entry.codecString ? { codecString: entry.codecString } : {}),
  }
}
