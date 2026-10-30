/**
 * An exported trace read back has to frame as the session it came from. Each
 * case goes through buildTrace, writeMoqtrace, readMoqtrace and
 * sessionFromTrace, and compares what the framing parser reads before and
 * after.
 */

import { createCodec } from '@moqtap/codec'
import {
  encodeDatagram,
  encodeFetchStream,
  encodeSubgroupStream,
} from '@moqtap/codec/draft22'
import { readMoqtrace, type Trace, writeMoqtrace } from '@moqtap/trace'
import { describe, expect, it } from 'vitest'
import { buildTrace } from './build-trace'
import { locateCatalogStreams, SessionCatalogs } from './catalogs'
import { type ImportedSession, sessionFromTrace } from './import-trace'
import {
  messageEvents,
  requestTimes,
  sessionDraft,
  trackRoundTrip,
} from './requests'
import {
  type ParsedStreamFraming,
  parseDatagramGroupFraming,
  parseStreamFraming,
} from './stream-framing'
import type { SessionEntry } from './use-inspector'

// The codec's per-draft stream types are nominal and this file builds fixtures
// for them rather than consuming them; SessionEntry carries far more than
// buildTrace reads.
// biome-ignore lint/suspicious/noExplicitAny: see above
type Any = any

const text = new TextEncoder()
const EMPTY = new Uint8Array(0)

interface Obj {
  id: number
  body?: unknown
  properties?: Uint8Array
  status?: bigint
}

function bytesOf(body: unknown): Uint8Array {
  if (body === undefined) return EMPTY
  if (body instanceof Uint8Array) return body
  return text.encode(typeof body === 'string' ? body : JSON.stringify(body))
}

function object(o: Obj) {
  const p = bytesOf(o.body)
  return {
    type: 'object',
    byteOffset: 0,
    payloadByteOffset: 0,
    objectId: BigInt(o.id),
    payloadLength: p.length,
    payload: p,
    ...(o.status !== undefined ? { status: o.status } : {}),
    extensionData: o.properties ?? EMPTY,
  }
}

/** A draft-22 subgroup stream; `type` is the SUBGROUP_HEADER Type Flags. */
function subgroup(
  type: number,
  alias: number,
  groupId: number,
  objects: Obj[],
): Uint8Array {
  return encodeSubgroupStream({
    type: 'subgroup',
    headerType: type,
    trackAlias: BigInt(alias),
    groupId: BigInt(groupId),
    subgroupId: 2n,
    publisherPriority: 0x80,
    objects: objects.map(object),
  } as Any)
}

/** A draft-22 fetch stream: the Group ID when it changes, Object ID always. */
function fetch(
  requestId: number,
  objects: (Obj & { group: number })[],
): Uint8Array {
  return encodeFetchStream({
    type: 'fetch',
    requestId: BigInt(requestId),
    objects: objects.map((o, i) => {
      const newGroup = i === 0 || objects[i - 1].group !== o.group
      return {
        ...object(o),
        serializationFlags: newGroup ? 0x1c : 0x14,
        groupId: BigInt(o.group),
        subgroupId: 0n,
        publisherPriority: 5,
      }
    }),
  } as Any)
}

/** A datagram group buffer as the heap store keeps it. */
function datagramGroup(alias: number, groupId: number, objects: Obj[]) {
  const datagrams = objects.map((o) => {
    const p = bytesOf(o.body)
    return encodeDatagram({
      type: 'datagram',
      datagramType: o.properties ? 0x01 : 0x00,
      trackAlias: BigInt(alias),
      groupId: BigInt(groupId),
      objectId: BigInt(o.id),
      publisherPriority: 7,
      ...(o.properties ? { extensionData: o.properties } : {}),
      payloadLength: p.length,
      payload: p,
    } as Any)
  })
  const out = new Uint8Array(datagrams.reduce((n, d) => n + 4 + d.length, 0))
  const view = new DataView(out.buffer)
  let offset = 0
  for (const d of datagrams) {
    view.setUint32(offset, d.length, true)
    out.set(d, offset + 4)
    offset += 4 + d.length
  }
  return out
}

function stream(streamId: number, bytes: Uint8Array, extra: object = {}) {
  return {
    streamId,
    direction: 'rx',
    closed: true,
    byteCount: bytes.length,
    chunkCount: 1,
    contentType: 'binary',
    firstDataAt: 1010,
    lastDataAt: 1020,
    ...extra,
  }
}

/** A session and the bytes of its streams and groups, as the panel has them */
interface Fixture {
  session: SessionEntry
  streams: Map<number, Uint8Array>
  groups: Map<string, Uint8Array>
}

function fixture(
  streams: [number, Uint8Array, object?][],
  groups: [number, number, Uint8Array, object?][] = [],
  messages: object[] = [],
): Fixture {
  const session = {
    sessionId: 's1',
    url: 'https://relay.example/moq',
    createdAt: 1000,
    closed: true,
    protocol: 'moqt',
    draft: '22',
    messages,
    streams: new Map(
      streams.map(([id, bytes, extra]) => [id, stream(id, bytes, extra)]),
    ),
    tracks: new Map(),
    datagramGroups: new Map(
      groups.map(([alias, groupId, bytes, extra]) => [
        `${alias}:${groupId}`,
        {
          groupKey: `${alias}:${groupId}`,
          trackAlias: alias,
          groupId,
          direction: 'rx',
          closed: true,
          byteCount: bytes.length,
          datagramCount: 0,
          contentType: 'binary',
          firstDataAt: 1030,
          ...extra,
        },
      ]),
    ),
    bitrateSamples: [],
  } as Any as SessionEntry
  return {
    session,
    streams: new Map(streams.map(([id, bytes]) => [id, bytes])),
    groups: new Map(groups.map(([a, g, bytes]) => [`${a}:${g}`, bytes])),
  }
}

/** Export, write, read back and import, as a user sharing a trace would. */
async function roundTrip(f: Fixture): Promise<ImportedSession> {
  const trace = await buildTrace(
    f.session,
    async (_s, id) => f.streams.get(id) ?? null,
    async (_s, gk) => f.groups.get(gk) ?? null,
  )
  return importTrace(readMoqtrace(writeMoqtrace(trace)))
}

function importTrace(trace: Trace): ImportedSession {
  let colour = 0
  return sessionFromTrace(trace, {
    sessionId: 'imported',
    filename: 'session.moqtrace',
    nextColorIndex: () => colour++,
  })
}

const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** What the framing says about each object, which is what has to survive. */
function objectsOf(data: Uint8Array, framing: ParsedStreamFraming | null) {
  expect(framing).not.toBeNull()
  return framing!.objects.map((o) => ({
    objectId: o.objectId,
    groupId: o.groupId ?? framing!.headerFields.groupId,
    payload: hex(
      data.subarray(o.payloadOffset, o.payloadOffset + o.payloadLength),
    ),
    status: o.payloadLength === 0 ? (o.status ?? 0) : undefined,
    properties:
      o.propertiesOffset === undefined
        ? undefined
        : hex(
            data.subarray(
              o.propertiesOffset,
              o.propertiesOffset + (o.propertiesLength ?? 0),
            ),
          ),
  }))
}

function expectSameStream(f: Fixture, imported: ImportedSession, id: number) {
  const before = f.streams.get(id)!
  const after = imported.streamData.get(id)
  expect(after, `stream ${id} has bytes`).toBeDefined()
  const framedBefore = parseStreamFraming(before, '22')
  const framedAfter = parseStreamFraming(after!, '22')
  expect(framedAfter?.streamType).toBe(framedBefore?.streamType)
  expect(objectsOf(after!, framedAfter)).toEqual(
    objectsOf(before, framedBefore),
  )
  expect(imported.session.streams.get(id)?.importedFraming).toBe(
    'reconstructed',
  )
  return { before: framedBefore!, after: framedAfter! }
}

// A property block: Prior Group ID Gap (0x3c) = 2.
const GAP = new Uint8Array([0x3c, 0x02])

describe('a draft-22 subgroup stream comes back framed', () => {
  it('without properties', async () => {
    const f = fixture([
      [
        2,
        subgroup(0x14, 7, 3, [
          { id: 0, body: 'first' },
          { id: 1, body: 'second' },
          { id: 4, body: 'fifth' },
        ]),
      ],
    ])
    const imported = await roundTrip(f)
    const { before, after } = expectSameStream(f, imported, 2)
    expect(after.headerFields).toMatchObject({
      trackAlias: 7,
      groupId: 3,
      subgroupId: 2,
      publisherPriority: 0x80,
    })
    expect(after.headerFields).toEqual(before.headerFields)
    // No PROPERTIES bit: the objects carry no block at all.
    expect(after.objects.every((o) => o.propertiesOffset === undefined)).toBe(
      true,
    )
    expect(imported.session.streams.get(2)).toMatchObject({
      trackAlias: 7,
      closed: true,
      byteCount: imported.streamData.get(2)!.length,
    })
  })

  it('with properties, an empty block and a status object', async () => {
    const f = fixture([
      [
        2,
        subgroup(0x15, 9, 0, [
          { id: 0, body: 'with', properties: GAP },
          { id: 1, body: 'without' },
          // End of Group: no payload, a status in its place.
          { id: 2, status: 3n },
        ]),
      ],
    ])
    const imported = await roundTrip(f)
    const { after } = expectSameStream(f, imported, 2)
    expect(objectsOf(imported.streamData.get(2)!, after)).toEqual([
      expect.objectContaining({ objectId: 0, properties: '3c02' }),
      expect.objectContaining({ objectId: 1, properties: '' }),
      expect.objectContaining({ objectId: 2, payload: '', status: 3 }),
    ])
  })
})

describe('a draft-22 fetch stream comes back framed', () => {
  it('with each object in its own group', async () => {
    const f = fixture([
      [
        6,
        fetch(12, [
          { group: 4, id: 0, body: 'a' },
          { group: 4, id: 1, body: 'b' },
          { group: 6, id: 0, body: 'c' },
        ]),
        { fetchRequestId: 12 },
      ],
    ])
    const imported = await roundTrip(f)
    const { after } = expectSameStream(f, imported, 6)
    expect(after.headerFields.requestId).toBe(12)
    expect(after.objects.map((o) => o.publisherPriority)).toEqual([5, 5, 5])
    expect(imported.session.streams.get(6)).toMatchObject({
      fetchRequestId: 12,
    })
    expect(imported.session.streams.get(6)).not.toHaveProperty('trackAlias')
  })
})

describe('datagram groups come back framed, on their own aliases', () => {
  it('keeps two tracks with the same group apart', async () => {
    const f = fixture(
      [],
      [
        [
          9,
          3,
          datagramGroup(9, 3, [
            { id: 0, body: 'nine-0' },
            { id: 1, body: 'nine-1', properties: GAP },
          ]),
        ],
        [11, 3, datagramGroup(11, 3, [{ id: 0, body: 'eleven-0' }])],
      ],
    )
    const imported = await roundTrip(f)

    expect([...imported.session.datagramGroups.keys()].sort()).toEqual([
      '11:3',
      '9:3',
    ])
    // Datagrams are not a stream; no stream 0 appears for them.
    expect(imported.session.streams.size).toBe(0)
    for (const [gk, before] of f.groups) {
      const after = imported.datagramData.get(gk)!
      const framedAfter = parseDatagramGroupFraming(after, '22')
      expect(objectsOf(after, framedAfter)).toEqual(
        objectsOf(before, parseDatagramGroupFraming(before, '22')),
      )
      expect(framedAfter!.headerFields.trackAlias).toBe(
        Number(gk.split(':')[0]),
      )
      expect(imported.session.datagramGroups.get(gk)).toMatchObject({
        trackAlias: Number(gk.split(':')[0]),
        groupId: 3,
        importedFraming: 'reconstructed',
      })
    }
    expect(imported.session.datagramGroups.get('9:3')?.datagramCount).toBe(2)
  })

  /** Two tracks' datagrams of group 3, arriving in turn: 9, 11, 9, 11 */
  function interleaved(): Fixture {
    return fixture(
      [],
      [
        [
          9,
          3,
          datagramGroup(9, 3, [
            { id: 0, body: 'nine-0' },
            { id: 1, body: 'nine-1' },
          ]),
          {
            arrivals: new Map([
              [0, 1030],
              [1, 1050],
            ]),
          },
        ],
        [
          11,
          3,
          datagramGroup(11, 3, [
            { id: 0, body: 'eleven-0' },
            { id: 1, body: 'eleven-1' },
          ]),
          {
            firstDataAt: 1040,
            arrivals: new Map([
              [0, 1040],
              [1, 1060],
            ]),
          },
        ],
      ],
    )
  }

  it('keeps them apart when their datagrams arrive in turn', async () => {
    const f = interleaved()
    const imported = await roundTrip(f)
    for (const [gk, before] of f.groups) {
      const after = imported.datagramData.get(gk)!
      const framedAfter = parseDatagramGroupFraming(after, '22')
      expect(objectsOf(after, framedAfter)).toEqual(
        objectsOf(before, parseDatagramGroupFraming(before, '22')),
      )
      expect(framedAfter!.headerFields.trackAlias).toBe(
        Number(gk.split(':')[0]),
      )
      expect(imported.session.datagramGroups.get(gk)?.importedFraming).toBe(
        'reconstructed',
      )
    }
  })

  it('frames neither when a trace opened each group only once', async () => {
    const f = interleaved()
    const trace = await buildTrace(
      f.session,
      async () => null,
      async (_s, gk) => f.groups.get(gk) ?? null,
    )
    // As a writer that opens a group once and sends all its datagrams after.
    const seen = new Set<bigint>()
    const once = {
      ...trace,
      events: trace.events.filter((e) => {
        if (e.type !== 'stream-opened' || e.streamType !== 1) return true
        if (seen.has(e.trackAlias!)) return false
        seen.add(e.trackAlias!)
        return true
      }),
    } as Trace
    const { session, datagramData } = importTrace(once)
    for (const gk of ['9:3', '11:3']) {
      expect(session.datagramGroups.get(gk)?.importedFraming).toBe(
        'unavailable',
      )
    }
    // Nothing framed on another track's alias: the payloads are all there is.
    const all = [...datagramData.values()].flatMap(
      (d) => parseDatagramGroupFraming(d, '22')?.objects ?? [],
    )
    expect(all).toHaveLength(4)
  })

  it('frames a draft-10 status datagram as one', async () => {
    const codec = createCodec({ draft: '10' }) as Any
    const base = {
      trackAlias: 4n,
      groupId: 2n,
      publisherPriority: 7,
      extensionHeadersLength: 0n,
      extensionData: EMPTY,
    }
    const datagrams = [
      codec.encodeDatagram({
        ...base,
        type: 'datagram',
        streamTypeId: 1,
        objectId: 0n,
        payloadLength: 1,
        payload: text.encode('x'),
      }),
      codec.encodeDatagramStatus({
        ...base,
        type: 'datagram_status',
        streamTypeId: 2,
        objectId: 1n,
        objectStatus: 3n,
      }),
    ]
    const bytes = new Uint8Array(
      datagrams.reduce((n: number, d: Uint8Array) => n + 4 + d.length, 0),
    )
    let offset = 0
    for (const d of datagrams) {
      new DataView(bytes.buffer).setUint32(offset, d.length, true)
      bytes.set(d, offset + 4)
      offset += 4 + d.length
    }
    const f = fixture([], [[4, 2, bytes]])
    f.session.draft = '10'
    const imported = await roundTrip(f)

    const after = imported.datagramData.get('4:2')!
    const before = parseDatagramGroupFraming(bytes, '10')
    expect(objectsOf(bytes, before)).toEqual([
      expect.objectContaining({ objectId: 0, payload: '78' }),
      expect.objectContaining({ objectId: 1, payload: '', status: 3 }),
    ])
    expect(objectsOf(after, parseDatagramGroupFraming(after, '10'))).toEqual(
      objectsOf(bytes, before),
    )
    expect(imported.session.datagramGroups.get('4:2')?.importedFraming).toBe(
      'reconstructed',
    )
  })
})

describe('a draft-22 fetch End of Range marker is no object', () => {
  it('is left out of the trace, and the objects come back framed', async () => {
    const stream = encodeFetchStream({
      type: 'fetch',
      requestId: 12n,
      objects: [
        {
          ...object({ id: 0, body: 'a' }),
          serializationFlags: 0x1c,
          groupId: 5n,
          subgroupId: 0n,
          publisherPriority: 5,
        },
        // End of Non-Existent Range: group 6 up to object 3 does not exist.
        {
          ...object({ id: 3 }),
          serializationFlags: 0x8c,
          groupId: 6n,
          subgroupId: 0n,
          publisherPriority: 5,
        },
      ],
    } as Any)
    expect(parseStreamFraming(stream, '22')!.objects[1].endOfRange).toBe(0x8c)

    const f = fixture([[6, stream, { fetchRequestId: 12 }]])
    const trace = await buildTrace(f.session, async (_s, id) =>
      f.streams.get(id) ?? null,
    )
    expect(
      trace.events
        .filter((e) => e.type === 'object-header')
        .map((e) => [e.groupId, e.objectId]),
    ).toEqual([[5n, 0n]])

    const imported = importTrace(readMoqtrace(writeMoqtrace(trace)))
    const after = imported.streamData.get(6)!
    expect(objectsOf(after, parseStreamFraming(after, '22'))).toEqual([
      expect.objectContaining({ objectId: 0, groupId: 5, payload: '61' }),
    ])
    expect(imported.session.streams.get(6)?.importedFraming).toBe(
      'reconstructed',
    )
  })

  it('keeps the payloads of a fetch stream holding an empty Normal object', async () => {
    const f = fixture([
      [
        6,
        fetch(12, [
          { group: 5, id: 0, body: 'a' },
          { group: 6, id: 3, status: 0n },
        ]),
        { fetchRequestId: 12 },
      ],
    ])
    const imported = await roundTrip(f)
    expect(imported.session.streams.get(6)?.importedFraming).toBe(
      'unavailable',
    )
    expect(new TextDecoder().decode(imported.streamData.get(6))).toBe('a')
  })
})

describe('payloads pair with their headers in any order', () => {
  it('frames a stream whose payloads come in reverse', async () => {
    const f = fixture([
      [
        2,
        subgroup(0x14, 7, 3, [
          { id: 0, body: 'first' },
          { id: 1, body: 'second' },
        ]),
      ],
    ])
    const trace = await buildTrace(f.session, async (_s, id) =>
      f.streams.get(id) ?? null,
    )
    // Both headers, then the payloads last to first.
    const headers = trace.events.filter((e) => e.type === 'object-header')
    const payloads = trace.events.filter((e) => e.type === 'object-payload')
    const rest = trace.events.filter(
      (e) => e.type !== 'object-header' && e.type !== 'object-payload',
    )
    const reordered = {
      ...trace,
      events: [
        rest[0],
        ...headers,
        ...payloads.reverse(),
        ...rest.slice(1),
      ].map((e, seq) => ({ ...e, seq })),
    } as Trace
    expect(reordered.events.map((e) => e.type)).toEqual([
      'stream-opened',
      'object-header',
      'object-header',
      'object-payload',
      'object-payload',
      'stream-closed',
    ])
    expectSameStream(f, importTrace(reordered), 2)
  })
})

describe('a catalog track comes back as a catalog', () => {
  it('is found and read from the imported stream', async () => {
    const catalog = {
      version: 1,
      tracks: [
        {
          name: 'video',
          packaging: 'cmaf',
          role: 'video',
          codec: 'avc1.64001f',
          width: 1280,
          height: 720,
          isLive: true,
        },
      ],
    }
    const f = fixture(
      [[3, subgroup(0x14, 5, 0, [{ id: 0, body: catalog }])]],
      [],
      [
        {
          messageType: 'subscribe',
          direction: 'tx',
          timestamp: 1001,
          streamId: 4,
          decoded: {
            type: 'subscribe',
            request_id: 4,
            track_namespace: ['live', 'event'],
            track_name: 'catalog',
            parameters: {},
          },
          raw: EMPTY,
        },
        {
          messageType: 'subscribe_ok',
          direction: 'rx',
          timestamp: 1002,
          streamId: 4,
          decoded: {
            type: 'subscribe_ok',
            track_alias: 5,
            parameters: {},
            track_properties: {},
          },
          raw: EMPTY,
        },
      ],
    )
    const { session, streamData } = await roundTrip(f)

    const refs = locateCatalogStreams(session)
    expect(refs).toEqual([
      expect.objectContaining({
        streamId: 3,
        namespace: 'live/event',
        name: 'catalog',
        kind: 'subgroup',
        id: 5,
      }),
    ])

    const reader = new SessionCatalogs()
    for (const ref of reader.sync(session)) {
      reader.ingest(ref, streamData.get(ref.streamId) ?? null, session.draft)
    }
    const [view] = reader.views()
    expect(view.tracks.map((t) => t.name)).toEqual(['video'])
    expect(view.objects.map((o) => o.outcome)).toEqual(['applied'])
  })
})

describe('a trace that does not say enough keeps its payloads', () => {
  /** A trace whose stream-opened names no track and whose objects have no headers */
  function bareTrace(protocol: string): Trace {
    const payload = (seq: number, streamId: bigint, body: string) => ({
      type: 'object-payload' as const,
      seq,
      timestamp: seq,
      streamId,
      groupId: 5n,
      objectId: BigInt(seq),
      size: body.length,
      payload: text.encode(body),
    })
    return {
      header: {
        protocol,
        perspective: 'observer',
        detail: 'headers+data',
        startTime: 1000,
      },
      events: [
        {
          type: 'stream-opened',
          seq: 0,
          timestamp: 0,
          streamId: 2n,
          direction: 1,
          streamType: 0,
        },
        payload(1, 2n, 'ab'),
        payload(2, 2n, 'cd'),
        payload(3, 0n, 'dg'),
        {
          type: 'stream-closed',
          seq: 4,
          timestamp: 4,
          streamId: 2n,
          errorCode: 0,
        },
      ],
    } as Any as Trace
  }

  for (const protocol of ['moq-transport-14', 'unknown']) {
    it(`runs the payloads together and says so (${protocol})`, () => {
      const { session, streamData, datagramData } = importTrace(
        bareTrace(protocol),
      )
      expect(new TextDecoder().decode(streamData.get(2))).toBe('abcd')
      expect(session.streams.get(2)).toMatchObject({
        importedFraming: 'unavailable',
        closed: true,
        byteCount: 4,
      })
      expect(session.streams.get(2)).not.toHaveProperty('trackAlias')

      // A datagram with no alias anywhere is filed under alias 0.
      expect([...session.datagramGroups.keys()]).toEqual(['0:5'])
      expect(session.datagramGroups.get('0:5')?.importedFraming).toBe(
        'unavailable',
      )
      expect(Array.from(datagramData.get('0:5')!)).toEqual([
        2, 0, 0, 0, ...text.encode('dg'),
      ])
    })
  }

  it('keeps the payloads of a stream whose header names no alias', async () => {
    const f = fixture([[2, subgroup(0x14, 7, 0, [{ id: 0, body: 'x' }])]])
    const trace = await buildTrace(
      f.session,
      async (_s, id) => f.streams.get(id) ?? null,
    )
    const stripped = {
      ...trace,
      events: trace.events.map((e) => {
        if (e.type !== 'stream-opened') return e
        const { trackAlias: _a, subgroupId: _s, ...rest } = e
        return rest
      }),
    } as Trace
    const { session, streamData } = importTrace(stripped)
    expect(new TextDecoder().decode(streamData.get(2))).toBe('x')
    expect(session.streams.get(2)?.importedFraming).toBe('unavailable')
  })
})

describe('the sizes a trace records', () => {
  /** One subgroup stream of two objects and one datagram, at a detail level. */
  function sizedTrace(detail: string, sizes: boolean): Trace {
    const object = (seq: number, streamId: bigint, objectId: bigint, size: number) => [
      { type: 'object-header', seq, timestamp: seq, streamId, groupId: 5n, objectId, publisherPriority: 1, objectStatus: 0 },
      ...(sizes ? [{ type: 'object-payload', seq: seq + 1, timestamp: seq, streamId, groupId: 5n, objectId, size }] : []),
    ]
    return {
      header: { protocol: 'moq-transport-14', perspective: 'observer', detail, startTime: 1000 },
      events: [
        { type: 'stream-opened', seq: 0, timestamp: 0, streamId: 2n, direction: 1, streamType: 0, trackAlias: 1n, subgroupId: 0n },
        ...object(1, 2n, 0n, 1200),
        ...object(3, 2n, 1n, 800),
        ...object(5, 0n, 0n, 50),
        { type: 'stream-closed', seq: 7, timestamp: 7, streamId: 2n, errorCode: 0 },
      ],
    } as Any as Trace
  }

  it('keeps the payload sizes of a trace without payload bytes', () => {
    const { session } = importTrace(sizedTrace('headers+sizes', true))
    expect(session.streams.get(2)).toMatchObject({ byteCount: 0, recordedBytes: 2000 })
    expect(session.recordedBytes).toBe(2050)
    expect(session.sizeUnknown).toBeUndefined()
  })

  it('says it does not know the size of a trace that records only headers', () => {
    const { session } = importTrace(sizedTrace('headers', false))
    expect(session.streams.get(2)).toMatchObject({ byteCount: 0, sizeUnknown: true })
    expect(session.sizeUnknown).toBe(true)
  })

  it('knows no stream size, not even zero, in a trace that records only headers', () => {
    const t = sizedTrace('headers', false)
    const opened = { type: 'stream-opened', seq: 8, timestamp: 8, streamId: 6n, direction: 1, streamType: 0, trackAlias: 1n, subgroupId: 1n }
    const { session } = importTrace({ ...t, events: [...t.events, opened] } as Any as Trace)
    expect(session.streams.get(6)).toMatchObject({ byteCount: 0, sizeUnknown: true })
  })
})

describe('times come back on the panel clock', () => {
  const subscribe = (timestamp: number) => ({
    messageType: 'subscribe',
    direction: 'tx',
    timestamp,
    streamId: 4,
    decoded: {
      type: 'subscribe',
      request_id: 4,
      track_namespace: ['live'],
      track_name: 'video',
      parameters: {},
    },
    raw: EMPTY,
  })
  const subscribeOk = (timestamp: number) => ({
    messageType: 'subscribe_ok',
    direction: 'rx',
    timestamp,
    streamId: 4,
    decoded: {
      type: 'subscribe_ok',
      track_alias: 5,
      parameters: {},
      track_properties: {},
    },
    raw: EMPTY,
  })

  it('keeps every time an exported session had', async () => {
    const f = fixture(
      [[3, subgroup(0x14, 5, 0, [{ id: 0, body: 'a' }])]],
      [[6, 9, datagramGroup(6, 9, [{ id: 0, body: 'd' }])]],
      [subscribe(1001), subscribeOk(1043)],
    )
    const { session } = await roundTrip(f)

    expect(session.createdAt).toBe(1000)
    expect(session.messages.map((m) => m.timestamp)).toEqual([1001, 1043])
    const [track] = session.tracks.values()
    expect(track).toMatchObject({ subscribedAt: 1001, subscribeOkAt: 1043 })
    const times = requestTimes(
      messageEvents(session.messages),
      sessionDraft(session),
    )
    expect(trackRoundTrip(track, times)).toBe(42)
    expect(session.streams.get(3)?.firstDataAt).toBe(1010)
    expect(session.datagramGroups.get('6:9')).toMatchObject({
      firstDataAt: 1030,
      lastDataAt: 1030,
    })
  })

  it('reads event timestamps as microseconds from the start', () => {
    const start = 1_793_304_425_105
    const trace = {
      header: {
        protocol: 'moq-transport-14',
        perspective: 'observer',
        detail: 'headers',
        startTime: start,
      },
      events: [
        {
          type: 'control',
          seq: 0,
          timestamp: 820_522,
          direction: 0,
          messageType: 0x3,
          message: {
            type: 'subscribe',
            request_id: 0,
            track_alias: 1,
            track_namespace: ['live'],
            track_name: 'catalog',
            parameters: {},
          },
        },
        {
          type: 'control',
          seq: 1,
          timestamp: 868_765,
          direction: 1,
          messageType: 0x4,
          message: {
            type: 'subscribe_ok',
            request_id: 0,
            expires: 0,
            group_order: 1,
            content_exists: 0,
            parameters: {},
          },
        },
        {
          type: 'stream-opened',
          seq: 2,
          timestamp: 1_053_993,
          streamId: 3n,
          direction: 1,
          streamType: 0,
          trackAlias: 1n,
        },
        {
          type: 'object-header',
          seq: 3,
          timestamp: 1_054_081,
          streamId: 3n,
          groupId: 0n,
          objectId: 0n,
          publisherPriority: 1,
          objectStatus: 0,
        },
        {
          type: 'object-header',
          seq: 4,
          timestamp: 2_557_875,
          streamId: 3n,
          groupId: 0n,
          objectId: 1n,
          publisherPriority: 1,
          objectStatus: 3,
        },
      ],
    } as Any as Trace
    const { session } = importTrace(trace)

    const [track] = session.tracks.values()
    expect(track.subscribedAt).toBeCloseTo(start + 820.522, 3)
    expect(track.subscribeOkAt).toBeCloseTo(start + 868.765, 3)
    const times = requestTimes(
      messageEvents(session.messages),
      sessionDraft(session),
    )
    expect(trackRoundTrip(track, times)).toBeCloseTo(48.243, 3)
    expect(session.streams.get(3)?.firstDataAt).toBeCloseTo(start + 1053.993, 3)
    expect(session.streams.get(3)?.lastDataAt).toBeCloseTo(start + 2557.875, 3)
  })
})

describe('a decode error in a trace', () => {
  const raw = new Uint8Array([0x03, 0x00, 0x02, 0x24, 0x01])
  const trace = (error: Record<string, unknown>) =>
    ({
      header: {
        protocol: 'moq-transport-22',
        perspective: 'observer',
        detail: 'control',
        startTime: 0,
      },
      events: [{ type: 'error', seq: 0, timestamp: 1000, ...error }],
    }) as Any as Trace

  it('is a DECODE_ERROR row with its stream and bytes', () => {
    const { session } = importTrace(
      readMoqtrace(
        writeMoqtrace(
          trace({
            errorCode: 0,
            errorKind: 'decode',
            reason: 'INVALID_PARAMETER: Unknown Message Parameter type 0x24',
            streamId: 21n,
            rawLength: 5,
            raw,
          }),
        ),
      ),
    )
    expect(session.messages).toHaveLength(1)
    const row = session.messages[0]!
    expect(row.messageType).toBe('decode_error')
    expect(row.streamId).toBe(21)
    expect(row.direction).toBeUndefined()
    expect(row.decoded).toEqual({
      code: 'INVALID_PARAMETER',
      reason: 'Unknown Message Parameter type 0x24',
      length: 5,
    })
    expect(Array.from(row.raw)).toEqual(Array.from(raw))
  })

  it('reads one written before errors had a kind', () => {
    const { session } = importTrace(
      trace({ errorCode: 0, reason: 'INVALID_PARAMETER: bad' }),
    )
    expect(session.messages[0]?.messageType).toBe('decode_error')
    expect(session.messages[0]?.raw.length).toBe(0)
  })

  it('leaves a protocol error out of the messages', () => {
    const { session } = importTrace(
      trace({ errorCode: 3, errorKind: 'protocol', reason: 'x' }),
    )
    expect(session.messages).toHaveLength(0)
  })
})
