import { describe, expect, it } from 'vitest'
import { shownTracks, trackDirection, unnamedTracks } from './alias-tracks'
import type { MessageEntry, SessionEntry, StreamEntry, TrackEntry } from './use-inspector'

function stream(streamId: number, trackAlias: number, byteCount = 10): StreamEntry {
  return { streamId, direction: 'rx', closed: true, byteCount, contentType: 'binary', chunkCount: 1, trackAlias }
}

function message(messageType: string, streamId: number, timestamp: number, decoded: unknown, direction?: 'tx' | 'rx'): MessageEntry {
  return { timestamp, messageType, streamId, decoded, decodedPretty: null, raw: new Uint8Array(), ...(direction ? { direction } : {}) }
}

const named: TrackEntry = {
  subscribeId: '2',
  trackAlias: '2',
  trackNamespace: ['live'],
  trackName: 'video',
  fullName: 'live / video',
  direction: 'tx',
  via: 'subscribe',
  status: 'active',
  colorIndex: 3,
}

function session(over: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: 's',
    url: 'u',
    createdAt: 0,
    closed: true,
    protocol: 'moqt',
    draft: '22',
    streams: new Map(),
    messages: [],
    tracks: new Map([['2', named]]),
    datagramGroups: new Map(),
    bitrateSamples: [],
    ...over,
  } as SessionEntry
}

describe('tracks known only by alias', () => {
  it('lists every alias no track claims, with the response and end its request stream carried', () => {
    const s = session({
      streams: new Map([
        [5, stream(5, 2)],
        [6, stream(6, 4)],
        [7, stream(7, 3)],
      ]),
      messages: [
        message('decode_error', 20, 1, { code: 'INVALID_PARAMETER' }),
        message('subscribe_ok', 20, 2, { type: 'subscribe_ok', track_alias: 3 }, 'rx'),
        message('publish_done', 20, 9, { type: 'publish_done', status_code: 2 }, 'rx'),
      ],
    })
    expect(unnamedTracks(s)).toMatchObject([
      {
        fullName: 'Track alias 3',
        trackAlias: '3',
        trackNamespace: [],
        direction: 'tx',
        status: 'done',
        subscribeOkAt: 2,
        subscribeDoneAt: 9,
        colorIndex: 4,
        unnamed: { directionKnown: true },
      },
      // No response named alias 4: its stream came from the relay.
      { fullName: 'Track alias 4', status: 'active', colorIndex: 5, unnamed: { directionKnown: true } },
    ])
    expect(unnamedTracks(s).map(trackDirection)).toEqual(['rx', 'rx'])
    expect([...shownTracks(s).values()].map((t) => t.fullName)).toEqual([
      'live / video',
      'Track alias 3',
      'Track alias 4',
    ])
  })

  it('take their direction from their data over a SUBSCRIBE_OK', () => {
    const sent = { ...stream(5, 3), direction: 'tx' as const }
    const s = session({
      streams: new Map([[5, sent]]),
      messages: [message('subscribe_ok', 20, 2, { type: 'subscribe_ok', track_alias: 3 }, 'rx')],
    })
    expect(unnamedTracks(s).map(trackDirection)).toEqual(['tx'])
  })

  it('fall back to the SUBSCRIBE_OK when their data goes both ways, and know none without one', () => {
    const both = new Map([
      [5, stream(5, 3)],
      [9, { ...stream(9, 3), direction: 'tx' as const }],
    ])
    const ok = message('subscribe_ok', 20, 2, { type: 'subscribe_ok', track_alias: 3 }, 'tx')
    const [answered] = unnamedTracks(session({ streams: both, messages: [ok] }))
    expect(trackDirection(answered)).toBe('tx')
    expect(answered.unnamed).toEqual({ directionKnown: true })
    const [unknown] = unnamedTracks(session({ streams: both }))
    expect(unknown.unnamed).toEqual({ directionKnown: false })
  })

  it('adds nothing when every alias is claimed', () => {
    const s = session({ streams: new Map([[5, stream(5, 2)]]) })
    expect(shownTracks(s)).toBe(s.tracks)
  })
})

describe("a track's direction is the way its objects travel", () => {
  const t = (via: TrackEntry['via'], direction: 'tx' | 'rx') => trackDirection({ via, direction })
  it('received for a track this page subscribed to or fetched', () => {
    expect(t('subscribe', 'tx')).toBe('rx')
    expect(t('fetch', 'tx')).toBe('rx')
  })
  it('sent for a track this page published, or that was subscribed to from it', () => {
    expect(t('publish', 'tx')).toBe('tx')
    expect(t('subscribe', 'rx')).toBe('tx')
  })
  it('received for a track the relay published to this page', () => {
    expect(t('publish', 'rx')).toBe('rx')
  })
})
