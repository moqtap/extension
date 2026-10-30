/**
 * LOC tracks in the panel: which tracks are LOC, the profile their property
 * IDs allow, per-object decoding and the problems reported. Streams are
 * draft-22 wire bytes from the codec's encoders.
 */

import {
  encodeObjectProperties,
  encodeSubgroupStream,
} from '@moqtap/codec/draft22'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registryTrackKey, type TrackKey, type TrackPackaging } from './catalogs'
import {
  decodedLines,
  type LocTrackState,
  payloadText,
  readObjectRecord,
  SessionLoc,
  streamSource,
  trackForSource,
} from './loc'
import { catalogConflictProblems } from './problems'
import * as framing from './stream-framing'
import type { TrackPropertyList } from './track-properties'
import type { SessionEntry, StreamEntry, TrackEntry } from './use-inspector'

vi.mock('./stream-framing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./stream-framing')>()
  return {
    ...actual,
    decodeObjectProperties: vi.fn(actual.decodeObjectProperties),
  }
})
const decodeSpy = vi.mocked(framing.decodeObjectProperties)

// The codec's per-draft stream types are nominal and this file builds fixtures
// for them rather than consuming them.
// biome-ignore lint/suspicious/noExplicitAny: see above
type AnyStream = any

interface Prop {
  type: bigint
  value?: bigint
  bytes?: Uint8Array
}

interface Obj {
  props: Prop[]
  payload?: Uint8Array
}

/** A draft-22 subgroup stream of one group, objects numbered from 0. */
function subgroup(alias: number, groupId: number, objects: Obj[]): Uint8Array {
  return encodeSubgroupStream({
    type: 'subgroup',
    // PROPERTIES set: every object carries a property block.
    headerType: 0x11,
    trackAlias: BigInt(alias),
    groupId: BigInt(groupId),
    subgroupId: 0n,
    publisherPriority: 0,
    objects: objects.map((o, i) => {
      const payload = o.payload ?? new Uint8Array([0xaa, 0xbb])
      return {
        type: 'object',
        byteOffset: 0,
        payloadByteOffset: 0,
        objectId: BigInt(i),
        payloadLength: payload.length,
        payload,
        extensionData: encodeObjectProperties(o.props),
      }
    }),
  } as AnyStream)
}

let nextColour = 0

function track(
  subscribeId: string,
  name: string,
  alias: number,
  extra: Partial<TrackEntry> = {},
): TrackEntry {
  return {
    subscribeId,
    trackAlias: String(alias),
    trackNamespace: ['live'],
    trackName: name,
    fullName: `live / ${name}`,
    direction: 'tx',
    via: 'subscribe',
    status: 'active',
    colorIndex: nextColour++,
    ...extra,
  }
}

/** One catalog's description of a track, as the join keeps it. */
function claim(t: TrackEntry, packaging: string, codec?: string, catalog = 'catalog') {
  return {
    catalog: `live\u0000${catalog}`,
    catalogName: `live / ${catalog}`,
    publish: false,
    track: {
      namespace: 'live',
      name: t.trackName,
      packaging,
      codec: codec ?? null,
    },
  } as unknown as TrackPackaging
}

/** What a catalog saying packaging "loc" (or something else) gives the join. */
function described(
  tracks: TrackEntry[],
  packaging: string,
  codec?: string,
): Map<TrackKey, TrackPackaging> {
  return new Map(
    tracks.map((t) => {
      const c = claim(t, packaging, codec)
      return [registryTrackKey(t), { ...c, claims: [c] }]
    }),
  )
}

/** Two catalogs describing each track, in that order. */
function describedTwice(
  t: TrackEntry,
  first: [string, string?],
  second: [string, string?],
): Map<TrackKey, TrackPackaging> {
  const a = claim(t, first[0], first[1], 'catalog-a')
  const b = claim(t, second[0], second[1], 'catalog-b')
  return new Map([[registryTrackKey(t), { ...a, claims: [a, b] }]])
}

function session(tracks: TrackEntry[]) {
  const s = {
    sessionId: 's',
    draft: '22',
    streams: new Map<number, StreamEntry>(),
    tracks: new Map(tracks.map((t) => [t.subscribeId, t])),
    datagramGroups: new Map(),
  } as unknown as SessionEntry
  const bytes = new Map<number, Uint8Array>()
  return {
    s,
    bytes,
    put(streamId: number, data: Uint8Array, alias: number, closed = true) {
      bytes.set(streamId, data)
      s.streams.set(streamId, {
        streamId,
        direction: 'rx',
        closed,
        byteCount: data.length,
        chunkCount: 1,
        contentType: 'binary',
        trackAlias: alias,
        firstDataAt: 1000 + streamId,
      })
    },
  }
}

function pump(
  reader: SessionLoc,
  t: ReturnType<typeof session>,
  packaging: Map<TrackKey, TrackPackaging>,
): number {
  const refs = reader.sync(t.s, packaging)
  for (const ref of refs) {
    reader.ingest(ref, t.bytes.get(ref.streamId!) ?? null, '22')
  }
  return refs.length
}

// Frame Marking, one octet (ietf-03/04, odd 0x09): S I set, or S alone.
const KEY = { type: 0x09n, bytes: new Uint8Array([0xa0]) }
const DELTA = { type: 0x09n, bytes: new Uint8Array([0x80]) }
// ietf-04 Timestamp (even 0x10), which only ietf-04 and mzanaty-05 define.
const TS = (v: bigint) => ({ type: 0x10n, value: v })

beforeEach(() => {
  decodeSpy.mockClear()
})

describe('which tracks are LOC', () => {
  it('reads none without a catalog saying loc', () => {
    const video = track('1', 'video', 1)
    const t = session([video])
    t.put(10, subgroup(1, 0, [{ props: [KEY] }]), 1)
    const reader = new SessionLoc()
    expect(reader.sync(t.s, new Map())).toEqual([])
    expect(reader.trackState(video, new Map(), '22')).toBeNull()
  })

  it('does not read a track whose catalog packaging is something else', () => {
    const video = track('1', 'video', 1)
    const t = session([video])
    t.put(10, subgroup(1, 0, [{ props: [KEY] }]), 1)
    const reader = new SessionLoc()
    expect(reader.sync(t.s, described([video], 'cmaf'))).toEqual([])
  })

  it('reads a track the catalog gives packaging loc', () => {
    const video = track('1', 'video', 1)
    const t = session([video])
    t.put(10, subgroup(1, 0, [{ props: [KEY] }]), 1)
    const reader = new SessionLoc()
    const packaging = described([video], 'loc')
    expect(pump(reader, t, packaging)).toBe(1)
    expect(reader.trackState(video, packaging, '22')).toMatchObject({
      via: 'catalog',
      objectCount: 1,
    })
  })


  it('does not read a track whose catalogs disagree on packaging, which the catalogs report', () => {
    const video = track('1', 'video', 1)
    const t = session([video])
    t.put(10, subgroup(1, 0, [{ props: [KEY] }]), 1)
    const reader = new SessionLoc()
    for (const packaging of [
      describedTwice(video, ['loc'], ['cmaf']),
      describedTwice(video, ['cmaf'], ['loc']),
    ]) {
      expect(reader.sync(t.s, packaging)).toEqual([])
      expect(reader.trackState(video, packaging, '22')).toBeNull()
      expect(reader.problems([video], packaging, '22')).toEqual([])
      const problems = catalogConflictProblems([video], packaging)
      expect(problems).toHaveLength(1)
      expect(problems[0]).toMatchObject({
        title: 'Catalogs disagree on the packaging of this track',
        severity: 'info',
      })
      expect(problems[0]!.found).toContain('live / catalog-a: ')
      expect(problems[0]!.found).toContain('live / catalog-b: ')
    }
  })

  it('takes the codec as unknown when the catalogs disagree on it', () => {
    const video = track('1', 'video', 1)
    const packaging = describedTwice(video, ['loc', 'avc1.64001f'], ['loc', 'hvc1.1.6.L93.B0'])
    const state = new SessionLoc().trackState(video, packaging, '22')
    expect(state?.via).toBe('catalog')
    expect(state?.codec).toBeUndefined()
    expect(state?.conflicts?.map((c) => c.field)).toEqual(['codec'])
    const agreeing = describedTwice(video, ['loc', 'avc1.64001f'], ['loc'])
    expect(new SessionLoc().trackState(video, agreeing, '22')?.codec).toBe('avc1.64001f')
  })

  it('finds the track of a stream by its alias', () => {
    const video = track('1', 'video', 1)
    const t = session([video])
    t.put(10, subgroup(1, 0, [{ props: [KEY] }]), 1)
    expect(trackForSource(t.s, streamSource(10))).toBe(video)
    expect(trackForSource(t.s, streamSource(11))).toBeNull()
  })
})

describe('the profile of a track', () => {
  it('is the one profile that defines every property ID', () => {
    const video = track('1', 'video', 1)
    const t = session([video])
    t.put(10, subgroup(1, 0, [{ props: [KEY, TS(1000n)] }]), 1)
    const reader = new SessionLoc()
    const packaging = described([video], 'loc')
    pump(reader, t, packaging)
    const state = reader.trackState(video, packaging, '22')
    expect(state?.types).toEqual([
      { type: 0x09n, immutable: false },
      { type: 0x10n, immutable: false },
    ])
    expect(state?.resolution).toEqual({ profile: 'ietf-04' })
  })

  it('lists the candidates when several profiles define the IDs', () => {
    const video = track('1', 'video', 1)
    const t = session([video])
    t.put(10, subgroup(1, 0, [{ props: [KEY] }]), 1)
    const reader = new SessionLoc()
    const packaging = described([video], 'loc')
    pump(reader, t, packaging)
    expect(reader.trackState(video, packaging, '22')?.resolution).toEqual({
      candidates: ['ietf-03', 'ietf-04'],
    })
  })

  it('settles once a later object carries an ID only one candidate defines', () => {
    const video = track('1', 'video', 1)
    const t = session([video])
    const reader = new SessionLoc()
    const packaging = described([video], 'loc')
    t.put(10, subgroup(1, 0, [{ props: [KEY] }]), 1)
    pump(reader, t, packaging)
    t.put(11, subgroup(1, 1, [{ props: [KEY, TS(5n)] }]), 1)
    pump(reader, t, packaging)
    expect(reader.trackState(video, packaging, '22')?.resolution).toEqual({
      profile: 'ietf-04',
    })
  })

  it('leaves out IDs the transport draft defines at Object scope', () => {
    const video = track('1', 'video', 1)
    const t = session([video])
    // 0x02 is OBJECT_DELIVERY_TIMEOUT from transport-19 on.
    t.put(10, subgroup(1, 0, [{ props: [{ type: 0x02n, value: 7n }, KEY] }]), 1)
    const reader = new SessionLoc()
    const packaging = described([video], 'loc')
    pump(reader, t, packaging)
    expect(reader.trackState(video, packaging, '22')?.types).toEqual([
      { type: 0x09n, immutable: false },
    ])
  })

  it('has no candidates when no profile defines every ID', () => {
    const video = track('1', 'video', 1)
    const t = session([video])
    // 0x09 odd only in ietf-03/04, 0x04 only in the others.
    t.put(10, subgroup(1, 0, [{ props: [{ type: 0x04n, value: 1n }, KEY] }]), 1)
    const reader = new SessionLoc()
    const packaging = described([video], 'loc')
    pump(reader, t, packaging)
    expect(reader.trackState(video, packaging, '22')?.resolution).toEqual({
      candidates: [],
    })
  })

})

describe('reading sources', () => {
  it('reads an open stream again only once it has doubled, then on close', () => {
    const video = track('1', 'video', 1)
    const t = session([video])
    const full = subgroup(1, 0, [
      { props: [KEY], payload: new Uint8Array(40) },
      { props: [DELTA], payload: new Uint8Array(40) },
      { props: [DELTA], payload: new Uint8Array(40) },
    ])
    const reader = new SessionLoc()
    const packaging = described([video], 'loc')

    const first = full.subarray(0, 60)
    t.put(10, first, 1, false)
    expect(pump(reader, t, packaging)).toBe(1)
    const objects = reader.trackState(video, packaging, '22')?.objectCount ?? 0
    expect(objects).toBe(1)

    t.put(10, full.subarray(0, 100), 1, false)
    expect(reader.sync(t.s, packaging)).toEqual([])

    t.put(10, full, 1, true)
    expect(pump(reader, t, packaging)).toBe(1)
    expect(reader.trackState(video, packaging, '22')?.objectCount).toBe(3)
    // Each object's block was decoded once, though the stream was read twice.
    expect(decodeSpy).toHaveBeenCalledTimes(3)
    expect(reader.sync(t.s, packaging)).toEqual([])
  })
})

describe('one object', () => {
  it('decodes the properties and says where their bytes are', () => {
    const video = track('1', 'video', 1)
    const t = session([video])
    const bytes = subgroup(1, 0, [{ props: [KEY, TS(1000n)] }])
    t.put(10, bytes, 1)
    const reader = new SessionLoc()
    const packaging = described([video], 'loc')
    pump(reader, t, packaging)
    const state = reader.trackState(video, packaging, '22')!
    const obj = framing.parseStreamFraming(bytes, '22')!.objects[0]!
    const view = reader.objectView(streamSource(10), obj, 0, bytes, state, '22')

    expect(view.properties.map((r) => r.result.name)).toEqual([
      'Video Frame Marking',
      'Timestamp',
    ])
    const [mark, ts] = view.properties
    expect(Array.from(bytes.subarray(mark!.offset, mark!.offset + mark!.length))).toEqual(
      [0x09, 0x01, 0xa0],
    )
    expect(decodedLines(mark!.result)).toEqual(['S I · TID 0 (1-octet form)'])
    expect(ts!.result.decoded).toMatchObject({ kind: 'timestamp', value: 1000n })
    expect(view.payload).toBeUndefined()
    // Asked again under the same resolution, it is the same view.
    expect(reader.objectView(streamSource(10), obj, 0, bytes, state, '22')).toBe(view)
  })

  it('leaves a property block undecoded, without an error, when the session draft is not known', () => {
    const bytes = subgroup(1, 0, [{ props: [KEY] }])
    const obj = framing.parseStreamFraming(bytes, '22')!.objects[0]!
    const record = readObjectRecord(streamSource(10), obj, 0, bytes, undefined)
    expect(record.propertiesLength).toBeGreaterThan(0)
    expect(record.properties).toEqual([])
    expect(record.propertiesError).toBeUndefined()
  })

  it('decodes where the candidates agree and leaves the rest raw', () => {
    const video = track('1', 'video', 1)
    const t = session([video])
    // 0x0A: Timestamp in ietf-03, undefined in ietf-04.
    const bytes = subgroup(1, 0, [
      { props: [KEY, { type: 0x0an, value: 9n }] },
    ])
    t.put(10, bytes, 1)
    const reader = new SessionLoc()
    const packaging = described([video], 'loc')
    pump(reader, t, packaging)
    const state: LocTrackState = {
      ...reader.trackState(video, packaging, '22')!,
      resolution: { candidates: ['ietf-03', 'ietf-04'] },
    }
    const obj = framing.parseStreamFraming(bytes, '22')!.objects[0]!
    const view = reader.objectView(streamSource(10), obj, 0, bytes, state, '22')
    expect(view.properties[0]!.result.decoded?.kind).toBe('video-frame-marking')
    expect(view.properties[1]!.result.decoded).toBeUndefined()
    expect(view.properties[1]!.result.ambiguous?.map((a) => a.profile)).toEqual([
      'ietf-03',
      'ietf-04',
    ])
  })

  it('gives a Timestamp without a Timescale as microseconds since the Unix epoch', () => {
    const video = track('1', 'video', 1)
    const t = session([video])
    const bytes = subgroup(1, 0, [{ props: [KEY, TS(1000n)] }])
    t.put(10, bytes, 1)
    const reader = new SessionLoc()
    const packaging = described([video], 'loc')
    pump(reader, t, packaging)
    const state = reader.trackState(video, packaging, '22')!
    const obj = framing.parseStreamFraming(bytes, '22')!.objects[0]!
    const view = reader.objectView(streamSource(10), obj, 0, bytes, state, '22')
    expect(decodedLines(view.properties[1]!.result)).toEqual([
      '1000 µs since the Unix epoch (1970-01-01T00:00:00.001Z)',
    ])
  })

  it('reads a Timestamp with the Timescale of the Track Properties', () => {
    const video = track('1', 'video', 1)
    const t = session([video])
    const bytes = subgroup(1, 0, [
      { props: [KEY, TS(1000n)] },
      { props: [{ type: 0x08n, value: 1000n }, DELTA, TS(2000n)] },
    ])
    t.put(10, bytes, 1)
    const reader = new SessionLoc()
    const packaging = described([video], 'loc')
    pump(reader, t, packaging)
    const lists: TrackPropertyList[] = [
      {
        message: { messageType: 'subscribe_ok' } as TrackPropertyList['message'],
        properties: [{ type: 0x08n, value: 90000n }],
      },
    ]
    const state = reader.trackState(video, packaging, '22', lists)!
    expect(state.trackTimescales).toEqual([{ value: 90000n, messages: ['SUBSCRIBE_OK'] }])
    const objects = framing.parseStreamFraming(bytes, '22')!.objects
    const [first, second] = objects.map((obj) =>
      reader.objectView(streamSource(10), obj, 0, bytes, state, '22'),
    )
    const timestamp = (view: typeof first) =>
      view!.properties.find((p) => p.result.meaning === 'timestamp')!.result
    expect(first!.timescaleFromTrack).toBe(true)
    expect(decodedLines(timestamp(first), first!.timescaleFromTrack)).toEqual([
      '1000 at 90000 units/s (track Timescale)',
    ])
    expect(second!.timescaleFromTrack).toBeUndefined()
    expect(decodedLines(timestamp(second))).toEqual([
      '2000 (Timescales disagree: 90000, 1000)',
    ])
  })

  it('reads an H.264 payload framing when the catalog gives the codec', () => {
    const video = track('1', 'video', 1)
    const t = session([video])
    // One IDR NAL unit (header 0x65) behind a 4-byte length.
    const payload = new Uint8Array([0, 0, 0, 3, 0x65, 0x88, 0x84])
    const bytes = subgroup(1, 0, [{ props: [KEY, TS(1n)], payload }])
    t.put(10, bytes, 1)
    const reader = new SessionLoc()
    const packaging = described([video], 'loc', 'avc1.64001f')
    pump(reader, t, packaging)
    const state = reader.trackState(video, packaging, '22')!
    const obj = framing.parseStreamFraming(bytes, '22')!.objects[0]!
    const view = reader.objectView(streamSource(10), obj, 0, bytes, state, '22')
    expect(view.payload).toMatchObject({
      framing: 'length-prefixed',
      nalTypes: [5],
      keyframe: true,
    })
  })
})

describe('payload framing across a track', () => {
  // avcC, profile 100, level 31, 2-byte lengths (LOC-04 2.1.3), one SPS, one PPS.
  const avcC = (lengthSize: number) =>
    new Uint8Array([
      1, 100, 0, 31, 0xfc | (lengthSize - 1), 0xe1, 0, 4, 0x67, 100, 0, 31, 1, 0, 2, 0x68, 0xce,
    ])
  const CONFIG = (lengthSize: number) => ({ type: 0x0dn, bytes: avcC(lengthSize) })

  function readTrack(groups: Obj[][], trackProperties: TrackPropertyList[] = []) {
    const video = track('1', 'video', 1)
    const t = session([video])
    const streams = groups.map((g, i) => {
      const bytes = subgroup(1, i, g)
      t.put(10 + i, bytes, 1)
      return bytes
    })
    const reader = new SessionLoc()
    const packaging = described([video], 'loc', 'avc1.64001f')
    pump(reader, t, packaging)
    const state = reader.trackState(video, packaging, '22', trackProperties)!
    const views = streams.flatMap((bytes, i) =>
      framing
        .parseStreamFraming(bytes, '22')!
        .objects.map((obj) =>
          reader.objectView(streamSource(10 + i), obj, i, bytes, state, '22'),
        ),
    )
    const lists = new Map([[registryTrackKey(video), trackProperties]])
    const problems = reader
      .problems([video], packaging, '22', lists)
      .filter((p) => p.id === 'loc.start-code.three-byte')
    return { views, problems }
  }

  const viewsOf = (groups: Obj[][]) => readTrack(groups).views
  const IDR_4 = new Uint8Array([0, 0, 0, 3, 0x65, 0x88, 0x84])
  const P_3BYTE = new Uint8Array([0, 0, 1, 0x41, 0x9a, 0x10])

  it("reads an object without a Video Config under the track's length size", () => {
    const views = viewsOf([
      [
        { props: [KEY, CONFIG(2), TS(1n)], payload: new Uint8Array([0, 3, 0x65, 0x88, 0x84]) },
        { props: [DELTA, TS(2n)], payload: new Uint8Array([0, 3, 0x41, 0x9a, 0x10]) },
      ],
    ])
    expect(views[1]!.payload).toMatchObject({
      framing: 'length-prefixed',
      lengthSize: 2,
      nalTypes: [1],
    })
  })

  it('warns of 3-byte start codes on a track that carries a Video Config', () => {
    const { views, problems } = readTrack([
      [
        { props: [KEY, CONFIG(4), TS(1n)], payload: IDR_4 },
        { props: [DELTA, TS(2n)], payload: P_3BYTE },
      ],
    ])
    expect(views[1]!.payload).toMatchObject({ framing: 'start-code', threeByteStartCodes: true })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({
      severity: 'warning',
      spec: { label: 'LOC-04 2.1.4' },
      places: [
        { label: 'group 0, object 0', note: 'Video Config, length prefixes' },
        { label: 'group 0, object 1', note: '3-byte start codes' },
      ],
    })
    expect(problems[0]!.found).toContain('a track that carries a Video Config and has objects framed with length prefixes')
  })

  it('warns of 3-byte start codes on a track with an object framed by length prefixes', () => {
    const { problems } = readTrack([
      [
        { props: [KEY, TS(1n)], payload: IDR_4 },
        { props: [DELTA, TS(2n)], payload: P_3BYTE },
      ],
    ])
    expect(problems).toHaveLength(1)
    expect(problems[0]!.places.map((p) => p.note)).toEqual(['length prefixes', '3-byte start codes'])
    expect(problems[0]!.found).toContain('a track that has objects framed with length prefixes')
  })

  it('lists an object that carries the Video Config and 3-byte start codes once', () => {
    const { problems } = readTrack([[{ props: [KEY, CONFIG(4), TS(1n)], payload: P_3BYTE }]])
    expect(problems).toHaveLength(1)
    expect(problems[0]!.places).toMatchObject([
      { label: 'group 0, object 0', note: 'Video Config, 3-byte start codes' },
    ])
  })

  it('warns of an object framed with length prefixes, then 3-byte start codes', () => {
    const payload = new Uint8Array([
      0, 0, 0, 3, 0x65, 0x88, 0x84, 0, 0, 0, 1, 0x41, 0x9a, 0, 0, 1, 0x41, 0x9a,
    ])
    const { views, problems } = readTrack([
      [
        { props: [KEY, TS(1n)], payload: new Uint8Array([0, 0, 0, 1, 0x65, 0x88]) },
        { props: [DELTA, TS(2n)], payload },
      ],
    ])
    expect(views[1]!.payload).toMatchObject({ framing: 'mixed', threeByteStartCodes: true })
    expect(payloadText(views[1]!.payload)).toMatch(/^4-byte lengths, then start codes \(3-byte present\)/)
    expect(problems).toHaveLength(1)
    expect(problems[0]!.places).toMatchObject([
      { label: 'group 0, object 1', note: 'length prefixes, then 3-byte start codes' },
    ])
    expect(problems[0]!.found).toContain('a track that has objects framed with length prefixes')
  })

  it('takes a Video Config in the Track Properties into account', () => {
    const { problems } = readTrack(
      [[{ props: [DELTA, TS(2n)], payload: P_3BYTE }]],
      [{ message: {} as never, properties: [CONFIG(4)] }],
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]!.places.map((p) => p.note)).toEqual(['3-byte start codes'])
    expect(problems[0]!.found).toContain('carries a Video Config in its Track Properties')
  })

  it('says nothing of 3-byte start codes on a track without a Video Config or length prefixes', () => {
    const { problems } = readTrack([
      [
        { props: [KEY, TS(1n)], payload: new Uint8Array([0, 0, 0, 1, 0x65, 0x88]) },
        { props: [DELTA, TS(2n)], payload: P_3BYTE },
      ],
    ])
    expect(problems).toEqual([])
  })

  it('says nothing of a payload that also reads as length prefixes', () => {
    // 00 00 01 65: a 3-byte start code before an IDR, or a length of 0x165.
    const body = Array.from({ length: 0x165 }, (_, k) => (k === 0 ? 0x41 : 0x11))
    const { views, problems } = readTrack([
      [
        { props: [KEY, CONFIG(4), TS(1n)], payload: IDR_4 },
        { props: [DELTA, TS(2n)], payload: new Uint8Array([0, 0, 1, 0x65, ...body]) },
      ],
    ])
    expect(views[1]!.payload).toMatchObject({ framing: 'ambiguous' })
    expect(problems).toEqual([])
  })

  it('reads an object under every length size the Video Configs of the track give', () => {
    const views = viewsOf([
      [{ props: [KEY, CONFIG(4), TS(1n)], payload: new Uint8Array([0, 0, 0, 1, 0x65]) }],
      [
        { props: [KEY, CONFIG(2), TS(2n)], payload: new Uint8Array([0, 1, 0x65]) },
        { props: [DELTA, TS(3n)], payload: new Uint8Array([0, 0, 0, 2, 0x41, 0x9a]) },
        { props: [DELTA, TS(4n)], payload: new Uint8Array([0, 2, 0x41, 0x9a]) },
      ],
    ])
    expect(views[2]!.payload).toMatchObject({ framing: 'length-prefixed', lengthSize: 4 })
    expect(views[3]!.payload).toMatchObject({ framing: 'length-prefixed', lengthSize: 2 })
  })

  it('leaves the payload framing out when a Video Config of the track did not decode', () => {
    const views = viewsOf([
      [
        { props: [KEY, { type: 0x0dn, bytes: new Uint8Array([9]) }, TS(1n)] },
        { props: [DELTA, TS(2n)], payload: new Uint8Array([0, 0, 0, 2, 0x41, 0x9a]) },
      ],
    ])
    expect(views[1]!.payload).toBeUndefined()
  })
})

describe('problems', () => {
  function problemsFor(objects: Obj[][], packagingOf = 'loc') {
    const video = track('1', 'video', 1)
    const t = session([video])
    objects.forEach((group, g) => {
      t.put(10 + g, subgroup(1, g, group), 1)
    })
    const reader = new SessionLoc()
    const packaging = described([video], packagingOf)
    pump(reader, t, packaging)
    return { reader, video, problems: reader.problems([video], packaging, '22') }
  }

  it('reports an ambiguous track with its candidates', () => {
    const { problems } = problemsFor([[{ props: [KEY] }]])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({
      title: 'LOC properties fit more than one LOC draft',
      severity: 'info',
    })
    expect(problems[0]!.found).toContain('ietf-03 or ietf-04')
  })

  it('reports a track no profile fits', () => {
    const { problems } = problemsFor([
      [{ props: [{ type: 0x04n, value: 1n }, KEY] }],
    ])
    expect(problems[0]).toMatchObject({
      title: 'LOC properties fit no LOC draft',
      severity: 'warning',
    })
  })

  it('says nothing about a track with one profile whose groups start independent', () => {
    const { problems } = problemsFor([
      [{ props: [KEY, TS(1n)] }, { props: [DELTA, TS(2n)] }],
      [{ props: [KEY, TS(3n)] }],
    ])
    expect(problems).toEqual([])
  })

  it('notes object 0 of a group marked not independent', () => {
    const { problems } = problemsFor([
      [{ props: [KEY, TS(1n)] }],
      [{ props: [DELTA, TS(2n)] }, { props: [KEY, TS(3n)] }],
    ])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({
      title: 'Groups start with an object marked not independent',
      severity: 'info',
      spec: { label: 'LOC-04 4.2' },
      places: [{ label: 'group 1, object 0', target: { kind: 'object', source: 's:11' } }],
      atMs: 1011,
    })
  })

  it('checks the group start on an ambiguous track whose candidates agree on Frame Marking', () => {
    const { problems } = problemsFor([[{ props: [DELTA] }]])
    expect(problems.map((p) => p.title)).toEqual([
      'LOC properties fit more than one LOC draft',
      'Groups start with an object marked not independent',
    ])
  })

  it('names one property ID in the singular', () => {
    const { problems } = problemsFor([[{ props: [KEY] }]])
    expect(problems[0]!.found).toMatch(/^Property ID 0x09;/)
  })

  it('does not warn when the Frame Marking reads several ways', () => {
    // ietf-00/01 and ietf-02 carry it in a varint; 0x80 fits three forms.
    const { problems } = problemsFor([
      [{ props: [{ type: 0x04n, value: 0x80n }, { type: 0x0dn, bytes: new Uint8Array([1]) }] }],
    ])
    expect(problems.map((p) => p.title)).toEqual([
      'LOC properties fit more than one LOC draft',
    ])
  })


  it('notes a group start a subscription and a fetch both carry once', () => {
    const video = track('1', 'video', 1)
    const t = session([video])
    t.put(10, subgroup(1, 0, [{ props: [DELTA, TS(1n)] }]), 1)
    t.put(14, subgroup(1, 0, [{ props: [DELTA, TS(1n)] }]), 1)
    const reader = new SessionLoc()
    const packaging = described([video], 'loc')
    pump(reader, t, packaging)
    expect(reader.problems([video], packaging, '22').map((p) => p.title)).toEqual([
      'Groups start with an object marked not independent',
    ])
  })

  it('reports nothing for a track that is not LOC', () => {
    const { problems } = problemsFor([[{ props: [DELTA] }]], 'cmaf')
    expect(problems).toEqual([])
  })
})
