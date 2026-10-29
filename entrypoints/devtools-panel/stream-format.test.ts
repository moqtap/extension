/**
 * Whether a stream is read as its track's packaging or as what its bytes
 * prove, and the byte labels the streams list and the Tracks tab show.
 */

import { describe, expect, it } from 'vitest'
import { registryTrackKey, type TrackKey, type TrackPackaging } from './catalogs'
import { tracksWithObjectProperties } from './loc'
import { PackagingPins } from './packaging'
import {
  type ByteFormat,
  byteLabel,
  byteTitle,
  formatOfStream,
  sharedByteLabel,
  type StreamFormat,
  streamFormat,
  trackByteLabels,
} from './stream-format'
import type { SessionEntry, StreamEntry, TrackEntry } from './use-inspector'

const FMP4: ByteFormat = {
  contentType: 'fmp4',
  mediaInfo: { variant: 'fmp4', boxes: ['moof', 'mdat'] },
}
const CMAF: ByteFormat = {
  contentType: 'fmp4',
  mediaInfo: { variant: 'cmaf', boxes: ['ftyp', 'moov'] },
}
const H264: ByteFormat = { contentType: 'h264', codecString: 'avc1.64001F' }

/** What the catalogs say of one track: one claim per packaging given. */
function described(...packagings: (string | null)[]): TrackPackaging {
  const claims = packagings.map((packaging, i) => ({
    catalog: `live\u0000catalog${i}`,
    catalogName: `live / catalog${i}`,
    publish: false,
    drafts: ['msf-01'],
    track: { namespace: 'live', name: 'video', packaging, depends: [], raw: {} },
  }))
  return { ...claims[0]!, claims } as unknown as TrackPackaging
}

function bytes(format: ByteFormat): StreamFormat {
  return { from: 'bytes', ...format }
}

describe('the seam', () => {
  it('reads a track the catalogs agree on as that packaging, whatever its bytes', () => {
    for (const packaging of ['loc', 'cmaf', 'mediatimeline', 'eventtimeline'] as const) {
      expect(streamFormat(described(packaging), undefined, FMP4)).toEqual({
        from: 'packaging',
        packaging,
        via: 'catalog',
      })
    }
  })

  it('reads a track pinned as LOC as LOC, over any catalog packaging', () => {
    for (const packaging of [undefined, described('cmaf'), described('mediatimeline')]) {
      expect(streamFormat(packaging, 'ietf-04', FMP4)).toEqual({
        from: 'packaging',
        packaging: 'loc',
        via: 'pin',
      })
    }
    expect(streamFormat(described('loc'), 'ietf-04', FMP4)).toEqual({
      from: 'packaging',
      packaging: 'loc',
      via: 'catalog',
    })
  })

  it('reads the bytes without a catalog packaging the panel reads', () => {
    expect(streamFormat(undefined, undefined, FMP4)).toEqual(bytes(FMP4))
    expect(streamFormat(described(null), undefined, H264)).toEqual(bytes(H264))
    expect(streamFormat(described('moqlog'), undefined, { contentType: 'json' })).toEqual({
      from: 'bytes',
      contentType: 'json',
    })
    // Catalogs that disagree on the packaging
    expect(streamFormat(described('loc', 'cmaf'), undefined, FMP4)).toEqual(bytes(FMP4))
  })
})

describe('byte labels', () => {
  it('names what the bytes prove', () => {
    expect(byteLabel(bytes(FMP4))).toBe('fMP4')
    expect(byteLabel(bytes({ contentType: 'fmp4' }))).toBe('fMP4')
    expect(byteLabel(bytes(CMAF))).toBe('CMAF')
    expect(byteLabel(bytes(H264))).toBe('H.264')
    expect(byteLabel(bytes({ contentType: 'h265' }))).toBe('H.265')
    expect(byteLabel(bytes({ contentType: 'cbor' }))).toBe('CBOR')
    expect(byteLabel(bytes({ contentType: 'binary' }))).toBeNull()
    expect(byteTitle(bytes(FMP4))).toBe('moof · mdat')
    expect(byteTitle(bytes(H264))).toBe('avc1.64001F')
  })

  it('gives a packaged stream none', () => {
    const packaged = streamFormat(described('cmaf'), undefined, CMAF)
    expect(byteLabel(packaged)).toBeNull()
    expect(byteTitle(packaged)).toBeUndefined()
  })

  it('gives a track the label all its streams share', () => {
    expect(sharedByteLabel([bytes(FMP4), bytes(FMP4)])).toBe('fMP4')
    expect(sharedByteLabel([bytes(CMAF), bytes(CMAF)])).toBe('CMAF')
    expect(sharedByteLabel([bytes(CMAF), bytes(FMP4)])).toBe('fMP4')
    expect(sharedByteLabel([bytes(FMP4), bytes(H264)])).toBeNull()
    expect(sharedByteLabel([bytes(FMP4), bytes({ contentType: 'binary' })])).toBeNull()
    expect(sharedByteLabel([])).toBeNull()
  })
})

describe('streams of a session', () => {
  const video: TrackEntry = {
    subscribeId: '1',
    trackAlias: '7',
    trackNamespace: ['live'],
    trackName: 'video',
    fullName: 'live / video',
    direction: 'tx',
    via: 'subscribe',
    status: 'active',
    colorIndex: 0,
  }
  const audio: TrackEntry = { ...video, subscribeId: '2', trackAlias: '8', trackName: 'audio' }

  function stream(streamId: number, alias: number, format: ByteFormat, byteCount = 100): StreamEntry {
    return { streamId, direction: 'rx', closed: true, byteCount, chunkCount: 1, trackAlias: alias, ...format }
  }

  const session = {
    streams: new Map<number, StreamEntry>([
      [1, stream(1, 7, CMAF)],
      [2, stream(2, 7, FMP4)],
      [3, stream(3, 8, FMP4)],
      [4, stream(4, 8, H264)],
      [5, stream(5, 8, { contentType: 'binary' }, 0)],
      [6, stream(6, 99, FMP4)],
    ]),
    tracks: new Map([
      [video.subscribeId, video],
      [audio.subscribeId, audio],
    ]),
    datagramGroups: new Map(),
  } as unknown as SessionEntry

  it('finds each stream’s track for its catalog packaging and pin', () => {
    const packaging = new Map<TrackKey, TrackPackaging>([[registryTrackKey(video), described('cmaf')]])
    const pins = new PackagingPins()
    expect(formatOfStream(session, session.streams.get(2)!, packaging, pins).from).toBe('packaging')
    expect(formatOfStream(session, session.streams.get(3)!, packaging, pins)).toEqual(bytes(FMP4))
    pins.set(registryTrackKey(audio), 'ietf-04')
    expect(formatOfStream(session, session.streams.get(3)!, packaging, pins)).toEqual({
      from: 'packaging',
      packaging: 'loc',
      via: 'pin',
    })
    // A stream on no known track
    expect(formatOfStream(session, session.streams.get(6)!, packaging, pins)).toEqual(bytes(FMP4))
  })

  it('labels each track by the streams that have bytes', () => {
    const labels = trackByteLabels(session, undefined)
    expect(labels.get(registryTrackKey(video))).toBe('fMP4')
    expect(labels.get(registryTrackKey(audio))).toBeNull()
    const packaging = new Map<TrackKey, TrackPackaging>([[registryTrackKey(video), described('cmaf')]])
    expect(trackByteLabels(session, packaging).get(registryTrackKey(video))).toBeNull()
  })

  it('finds the tracks with a stream seen carrying an Object Properties block', () => {
    expect([...tracksWithObjectProperties(session)]).toEqual([])
    const streams = new Map(session.streams)
    streams.set(4, { ...streams.get(4)!, objectProperties: true })
    expect([...tracksWithObjectProperties({ ...session, streams })]).toEqual([
      registryTrackKey(audio),
    ])
  })
})
