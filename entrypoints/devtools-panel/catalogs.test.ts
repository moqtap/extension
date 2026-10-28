/**
 * Reading a session's catalogs out of its recorded streams. Streams are
 * draft-22 wire bytes from the codec's encoders; sessions are shaped as the
 * panel builds them.
 */

import * as media from '@moqtap/media/catalog'
import { encodeFetchStream, encodeSubgroupStream } from '@moqtap/codec/draft22'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  locateCatalogStreams,
  packagingIndex,
  registryTrackKey,
  SessionCatalogs,
  trackKey,
} from './catalogs'
import type { SessionEntry, StreamEntry, TrackEntry } from './use-inspector'

vi.mock('@moqtap/media/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moqtap/media/catalog')>()
  return { ...actual, parseCatalog: vi.fn(actual.parseCatalog) }
})
const parseSpy = vi.mocked(media.parseCatalog)

// The codec's per-draft stream types are nominal and this file builds fixtures
// for them rather than consuming them.
// biome-ignore lint/suspicious/noExplicitAny: see above
type AnyStream = any

const text = new TextEncoder()

function payload(value: unknown): Uint8Array {
  return value instanceof Uint8Array
    ? value
    : text.encode(typeof value === 'string' ? value : JSON.stringify(value))
}

/**
 * The alias each encoded subgroup stream carries, by its buffer, so a cut-short
 * copy of the bytes still says which track it is on: the background reads the
 * alias from the first chunk, before the stream frames whole.
 */
const aliasOf = new WeakMap<ArrayBufferLike, number>()

/** A draft-22 subgroup stream of one group, objects numbered from `first`. */
function subgroup(
  alias: number,
  groupId: number,
  objects: unknown[],
  first = 0,
): Uint8Array {
  const bytes = encodeSubgroupStream({
    type: 'subgroup',
    headerType: 0x10,
    trackAlias: BigInt(alias),
    groupId: BigInt(groupId),
    subgroupId: 0n,
    publisherPriority: 0,
    objects: objects.map((o, i) => {
      const p = payload(o)
      return {
        type: 'object',
        byteOffset: 0,
        payloadByteOffset: 0,
        objectId: BigInt(first + i),
        payloadLength: p.length,
        payload: p,
        extensionData: new Uint8Array(0),
      }
    }),
  } as AnyStream)
  aliasOf.set(bytes.buffer, alias)
  return bytes
}

/**
 * A draft-22 fetch stream. An object that opens a group carries a Group ID
 * Delta (0x08), and with it an absolute Object ID; one that stays in the group
 * carries only an Object ID Delta from the one before (transport-22 11.4.1.1).
 */
function fetch(
  requestId: number,
  objects: { group: number; object: number; body: unknown }[],
): Uint8Array {
  return encodeFetchStream({
    type: 'fetch',
    requestId: BigInt(requestId),
    objects: objects.map(({ group, object, body }, i) => {
      const p = payload(body)
      const newGroup = i === 0 || objects[i - 1].group !== group
      return {
        type: 'object',
        byteOffset: 0,
        payloadByteOffset: 0,
        // Object ID and Priority present, and the Group ID when it changes.
        serializationFlags: newGroup ? 0x1c : 0x14,
        groupId: BigInt(group),
        subgroupId: 0n,
        objectId: BigInt(object),
        publisherPriority: 0,
        payloadLength: p.length,
        payload: p,
        extensionData: new Uint8Array(0),
      }
    }),
  } as AnyStream)
}

let nextColour = 0

function track(
  subscribeId: string,
  namespace: string[],
  name: string,
  extra: Partial<TrackEntry> = {},
): TrackEntry {
  return {
    subscribeId,
    trackNamespace: namespace,
    trackName: name,
    fullName: `${namespace.join('/')} / ${name}`,
    direction: 'tx',
    via: 'subscribe',
    status: 'active',
    colorIndex: nextColour++,
    ...extra,
  }
}

function stream(
  streamId: number,
  bytes: Uint8Array,
  extra: Partial<StreamEntry> = {},
): StreamEntry {
  return {
    streamId,
    direction: 'rx',
    closed: false,
    byteCount: bytes.length,
    chunkCount: 1,
    contentType: 'json',
    ...(aliasOf.has(bytes.buffer)
      ? { trackAlias: aliasOf.get(bytes.buffer) }
      : {}),
    ...extra,
  }
}

/** A session with its streams' bytes beside it, as the background holds them. */
function session(tracks: TrackEntry[]) {
  const s = {
    sessionId: 's',
    draft: '22',
    streams: new Map<number, StreamEntry>(),
    tracks: new Map(tracks.map((t) => [t.subscribeId, t])),
  } as unknown as SessionEntry
  const bytes = new Map<number, Uint8Array>()
  return {
    s,
    bytes,
    put(streamId: number, data: Uint8Array, extra: Partial<StreamEntry> = {}) {
      bytes.set(streamId, data)
      const existing = s.streams.get(streamId)
      if (existing) {
        existing.byteCount = data.length
        Object.assign(existing, extra)
      } else {
        s.streams.set(streamId, stream(streamId, data, extra))
      }
    },
  }
}

/** What the composable does on each change: sync, then read what it asks for. */
function pump(
  reader: SessionCatalogs,
  t: ReturnType<typeof session>,
  unavailable = new Set<number>(),
) {
  for (const ref of reader.sync(t.s)) {
    const data = unavailable.has(ref.streamId)
      ? null
      : (t.bytes.get(ref.streamId) ?? null)
    reader.ingest(ref, data, '22')
  }
}

const VIDEO = {
  name: 'video',
  packaging: 'cmaf',
  role: 'video',
  codec: 'avc1.64001f',
  width: 1280,
  height: 720,
  isLive: true,
}
const AUDIO = {
  name: 'audio',
  packaging: 'loc',
  role: 'audio',
  codec: 'opus',
  samplerate: 48000,
  isLive: true,
}
const CATALOG = { version: '1', tracks: [VIDEO] }
const ADD_AUDIO = { deltaUpdate: [{ op: 'add', tracks: [AUDIO] }] }

beforeEach(() => {
  parseSpy.mockClear()
})

describe('finding catalog streams', () => {
  it('finds the streams of a track named "catalog" and no others', () => {
    const t = session([
      track('1', ['live', 'event'], 'catalog', { trackAlias: '5' }),
      track('2', ['live', 'event'], 'video', { trackAlias: '6' }),
    ])
    t.put(3, subgroup(5, 0, [CATALOG]))
    t.put(7, subgroup(6, 0, ['not a catalog']))
    const refs = locateCatalogStreams(t.s)
    expect(refs.map((r) => r.streamId)).toEqual([3])
    expect(refs[0]).toMatchObject({
      namespace: 'live/event',
      name: 'catalog',
      kind: 'subgroup',
      id: 5,
    })
  })

  it('is case-sensitive about the name', () => {
    const t = session([track('1', ['live'], 'Catalog', { trackAlias: '5' })])
    t.put(3, subgroup(5, 0, [CATALOG]))
    expect(locateCatalogStreams(t.s)).toEqual([])
  })

  it('prefers the track whose objects travel the way the stream does', () => {
    // Alias 5 claimed twice: by a catalog the page subscribed to (data in)
    // and by a video track the page publishes (data out).
    const t = session([
      track('1', ['live'], 'catalog', { trackAlias: '5' }),
      track('2', ['mine'], 'video', {
        trackAlias: '5',
        via: 'publish',
        direction: 'tx',
      }),
    ])
    t.put(3, subgroup(5, 0, [CATALOG]), { direction: 'rx' })
    t.put(4, subgroup(5, 0, ['frame']), { direction: 'tx' })
    expect(locateCatalogStreams(t.s).map((r) => r.streamId)).toEqual([3])
  })

  it('finds a stream whose alias arrives after it does', () => {
    const catalog = track('1', ['live'], 'catalog')
    const t = session([catalog])
    t.put(3, subgroup(5, 0, [CATALOG]))
    const reader = new SessionCatalogs()
    expect(reader.sync(t.s)).toEqual([])
    // SUBSCRIBE_OK carries the alias.
    catalog.trackAlias = '5'
    pump(reader, t)
    expect(reader.views()[0].tracks.map((x) => x.name)).toEqual(['video'])
  })
})

describe('following a catalog track', () => {
  it('applies an independent catalog and then a delta', () => {
    const t = session([track('1', ['live'], 'catalog', { trackAlias: '5' })])
    t.put(3, subgroup(5, 0, [CATALOG, ADD_AUDIO]), { closed: true })
    const reader = new SessionCatalogs()
    pump(reader, t)
    const [view] = reader.views()
    expect(view.state.draft).toBe('cmsf-01')
    expect(view.tracks.map((x) => x.name)).toEqual(['video', 'audio'])
    expect(view.objects.map((o) => [o.kind, o.outcome])).toEqual([
      ['independent', 'applied'],
      ['delta', 'applied'],
    ])
    expect(view.incomplete).toEqual([])
  })

  it('parses each object once as its stream grows', () => {
    const t = session([track('1', ['live'], 'catalog', { trackAlias: '5' })])
    const reader = new SessionCatalogs()
    t.put(3, subgroup(5, 0, [CATALOG]))
    pump(reader, t)
    expect(parseSpy).toHaveBeenCalledTimes(1)

    t.put(3, subgroup(5, 0, [CATALOG, ADD_AUDIO]))
    pump(reader, t)
    expect(parseSpy).toHaveBeenCalledTimes(2)

    // Nothing new: the stream is not even read again.
    expect(reader.sync(t.s)).toEqual([])
    expect(reader.views()[0].tracks).toHaveLength(2)
  })

  it('waits on an object cut short in an open stream', () => {
    const t = session([track('1', ['live'], 'catalog', { trackAlias: '5' })])
    const reader = new SessionCatalogs()
    const whole = subgroup(5, 0, [CATALOG, ADD_AUDIO])
    t.put(3, whole.subarray(0, whole.length - 4))
    pump(reader, t)
    // The objects before the cut are read already; the cut one is not.
    expect(reader.views()[0].tracks).toHaveLength(1)
    expect(reader.views()[0].incomplete).toEqual([])

    t.put(3, whole)
    pump(reader, t)
    expect(reader.views()[0].tracks).toHaveLength(2)
  })

  it('says so when a closed stream ends inside an object', () => {
    const t = session([track('1', ['live'], 'catalog', { trackAlias: '5' })])
    const reader = new SessionCatalogs()
    const whole = subgroup(5, 0, [CATALOG, ADD_AUDIO])
    t.put(3, whole.subarray(0, whole.length - 4), { closed: true })
    pump(reader, t)
    // Read for the first time after it closed, the stream does not frame
    // whole; its first object is complete, and applies.
    const view = reader.views()[0]
    expect(view.objects.map((o) => o.outcome)).toEqual(['applied'])
    expect(view.tracks.map((tr) => tr.name)).toEqual([VIDEO.name])
    expect(view.incomplete).toEqual(['Stream 3 closed inside an object.'])
  })

  it('says so when a closed stream frames as nothing at all', () => {
    const t = session([track('1', ['live'], 'catalog', { trackAlias: '5' })])
    const reader = new SessionCatalogs()
    t.put(3, text.encode(JSON.stringify(CATALOG)), {
      closed: true,
      trackAlias: 5,
    })
    pump(reader, t)
    const view = reader.views()[0]
    expect(view.objects).toEqual([])
    expect(view.incomplete).toEqual([
      'Stream 3 closed but its bytes do not frame as a subgroup stream.',
    ])
  })

  it('merges a joining FETCH with the subscription, by group and object', () => {
    const t = session([
      track('1', ['live'], 'catalog', { trackAlias: '5' }),
      // A joining FETCH is filed under its own request id with the
      // subscription's name.
      track('9', ['live'], 'catalog', { via: 'fetch' }),
    ])
    const reader = new SessionCatalogs()
    // The subscription joins mid-group: object 1 of group 2, a delta.
    t.put(3, subgroup(5, 2, [ADD_AUDIO], 1))
    pump(reader, t)
    let view = reader.views()[0]
    expect(view.objects[0].outcome).toBe('skipped')
    expect(view.incomplete).toEqual([
      expect.stringContaining('group 2 was not recorded'),
    ])

    // The FETCH brings the group's start, and an older group's objects
    // again, which must not override the newer group.
    t.put(
      11,
      fetch(9, [
        { group: 1, object: 0, body: { version: '1', tracks: [AUDIO] } },
        { group: 2, object: 0, body: CATALOG },
        { group: 2, object: 1, body: ADD_AUDIO },
      ]),
      { fetchRequestId: 9, closed: true },
    )
    pump(reader, t)
    view = reader.views()[0]
    expect(view.objects.map((o) => `${o.groupId}:${o.objectId}`)).toEqual([
      '1:0',
      '2:0',
      '2:1',
    ])
    expect(view.objects.every((o) => o.outcome === 'applied')).toBe(true)
    expect(view.tracks.map((x) => x.name)).toEqual(['video', 'audio'])
    expect(view.streamIds.sort()).toEqual([11, 3])
    expect(view.incomplete).toEqual([])
    // Group 2 object 1 arrived twice and was parsed once.
    expect(parseSpy).toHaveBeenCalledTimes(3)
  })

  it('keeps sent and received catalogs apart by namespace', () => {
    const t = session([
      track('1', ['theirs'], 'catalog', { trackAlias: '5' }),
      track('2', ['mine'], 'catalog', {
        trackAlias: '1',
        via: 'publish',
        direction: 'tx',
      }),
    ])
    t.put(3, subgroup(5, 0, [CATALOG]))
    t.put(4, subgroup(1, 0, [{ version: '1', tracks: [AUDIO] }]), {
      direction: 'tx',
    })
    const reader = new SessionCatalogs()
    pump(reader, t)
    const views = reader.views()
    expect(views.map((v) => [v.namespace, v.tracks[0].name])).toEqual([
      ['theirs', 'video'],
      ['mine', 'audio'],
    ])
    expect(reader.viewForStream(4)?.namespace).toBe('mine')
  })
})

describe('what a catalog cannot say', () => {
  it('shows a compressed object as compressed, not as an error', () => {
    const t = session([track('1', ['live'], 'catalog', { trackAlias: '5' })])
    const gzip = new Uint8Array([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3])
    t.put(3, subgroup(5, 0, [gzip, ADD_AUDIO]))
    const reader = new SessionCatalogs()
    pump(reader, t)
    const [view] = reader.views()
    expect(view.compressed).toBe(true)
    expect(view.objects.map((o) => o.outcome)).toEqual([
      'compressed',
      'skipped',
    ])
    expect(
      view.objects
        .flatMap((o) => o.problems)
        .filter((p) => p.severity === 'error'),
    ).toEqual([])
    expect(view.incomplete).toEqual([])
  })

  it('flags a delta sent as the first object of a group, with the rule', () => {
    const t = session([track('1', ['live'], 'catalog', { trackAlias: '5' })])
    t.put(3, subgroup(5, 0, [ADD_AUDIO]))
    const reader = new SessionCatalogs()
    pump(reader, t)
    const [view] = reader.views()
    const problem = view.objects[0].problems.find(
      (p) => p.category === 'object_order',
    )
    expect(problem?.section).toBe('MSF-01 5')
    // The producer broke the rule; nothing was lost in recording.
    expect(view.incomplete).toEqual([])
  })

  it('is incomplete when the bytes are not there', () => {
    const t = session([track('1', ['live'], 'catalog', { trackAlias: '5' })])
    t.put(3, subgroup(5, 0, [CATALOG]))
    const reader = new SessionCatalogs()
    pump(reader, t, new Set([3]))
    expect(reader.views()[0].incomplete).toEqual([
      expect.stringContaining('No bytes'),
    ])
  })

  it('is incomplete once recording has been paused', () => {
    const t = session([track('1', ['live'], 'catalog', { trackAlias: '5' })])
    t.put(3, subgroup(5, 0, [CATALOG]))
    const reader = new SessionCatalogs()
    pump(reader, t)
    t.s.streamRecording = false
    pump(reader, t)
    t.s.streamRecording = true
    pump(reader, t)
    expect(reader.views()[0].incomplete).toEqual([
      expect.stringContaining('paused'),
    ])
  })

  it('is incomplete when an open stream is cleared', () => {
    const t = session([track('1', ['live'], 'catalog', { trackAlias: '5' })])
    t.put(3, subgroup(5, 0, [CATALOG]))
    const reader = new SessionCatalogs()
    pump(reader, t)
    t.s.streams.delete(3)
    pump(reader, t)
    const [view] = reader.views()
    expect(view.incomplete).toEqual([expect.stringContaining('cleared')])
    // What was read stays.
    expect(view.tracks).toHaveLength(1)
  })
})

describe('the packaging join', () => {
  it('joins catalog tracks to registry tracks by namespace text and name', () => {
    const video = track('2', ['live', 'event'], 'video', { trackAlias: '6' })
    const audio = track('3', ['live', 'event'], 'audio', { trackAlias: '7' })
    const other = track('4', ['elsewhere'], 'video', { trackAlias: '8' })
    const t = session([
      track('1', ['live', 'event'], 'catalog', { trackAlias: '5' }),
      video,
      audio,
      other,
    ])
    t.put(3, subgroup(5, 0, [CATALOG, ADD_AUDIO]))
    const reader = new SessionCatalogs()
    pump(reader, t)
    const index = packagingIndex(reader.views())

    expect(index.get(registryTrackKey(video))?.track).toMatchObject({
      packaging: 'cmaf',
      codec: 'avc1.64001f',
      role: 'video',
      width: 1280,
      height: 720,
    })
    expect(index.get(registryTrackKey(audio))?.track).toMatchObject({
      packaging: 'loc',
      samplerate: 48000,
    })
    expect(index.get(registryTrackKey(other))).toBeUndefined()
  })

  it('honours a track namespace the catalog states itself', () => {
    const t = session([track('1', ['live'], 'catalog', { trackAlias: '5' })])
    t.put(
      3,
      subgroup(5, 0, [
        { version: '1', tracks: [{ ...AUDIO, namespace: '/other/ns/' }] },
      ]),
    )
    const reader = new SessionCatalogs()
    pump(reader, t)
    const index = packagingIndex(reader.views())
    expect(index.has(trackKey('other/ns', 'audio'))).toBe(true)
    expect(
      index.has(
        registryTrackKey({ trackNamespace: ['live'], trackName: 'audio' }),
      ),
    ).toBe(false)
  })
})
