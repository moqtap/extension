/**
 * CMAF and SAP timeline tracks in the panel: which tracks are CMAF, the CMAF
 * header the catalogs give them, per-object parsing and the problems
 * reported. Streams are draft-22 wire bytes from the codec's encoders; the
 * CMAF header and object payloads are those of the CMSF-01 object vectors
 * in @moqtap/test-vectors.
 */

import { encodeSubgroupStream } from '@moqtap/codec/draft22'
import * as cmafLib from '@moqtap/media/cmaf'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  packagingIndex,
  registryTrackKey,
  SessionCatalogs,
  type TrackKey,
  type TrackPackaging,
} from './catalogs'
import {
  copiesSpec,
  decodeTimeText,
  eptText,
  initText,
  SAP_TIMELINE_EVENT_TYPE,
  sapText,
  SessionCmaf,
  syncText,
} from './cmaf'
import { SessionLoc } from './loc'
import type { PanelProblem } from './problems'
import { templateOf, templateProblems } from './timelines'
import type { SessionEntry, StreamEntry, TrackEntry } from './use-inspector'

vi.mock('@moqtap/media/cmaf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moqtap/media/cmaf')>()
  return { ...actual, parseCmafObject: vi.fn(actual.parseCmafObject) }
})
const parseSpy = vi.mocked(cmafLib.parseCmafObject)

// The codec's per-draft stream types are nominal and this file builds fixtures
// for them rather than consuming them.
// biome-ignore lint/suspicious/noExplicitAny: see above
type AnyStream = any

function hex(text: string): Uint8Array {
  return new Uint8Array(text.match(/../g)!.map((b) => Number.parseInt(b, 16)))
}

// cmsf/draft01/objects: one trak, track_ID 1, timescale 90000, a trex whose
// default_sample_flags are not sync.
const HEADER = hex(
  '0000001866747970636d663200000000636d663269736f36000001e56d6f6f760000006c6d766864000000000000000000000000000003e8000000000001000001000000000000000000000000010000000000000000000000000000000100000000000000000000000000004000000000000000000000000000000000000000000000000000000000000002000001497472616b0000005c746b6864000000030000000000000000000000010000000000000000000000000000000000000000000000000001000000000000000000000000000000010000000000000000000000000000400000000000000000000000000000e56d646961000000206d64686400000000000000000000000000015f900000000055c400000000002168646c72000000000000000076696465000000000000000000000000000000009c6d696e6600000014766d68640000000100000000000000000000002464696e660000001c6472656600000000000000010000000c75726c20000000010000005c7374626c000000107374736400000000000000000000001073747473000000000000000000000010737473630000000000000000000000147374737a000000000000000000000000000000107374636f0000000000000000000000286d766578000000207472657800000000000000010000000100000bb80000000001010000',
)
const HEADER_B64 = btoa(String.fromCharCode(...HEADER))

/** sap.json trun-first-sample-flags: a sync first sample, SAP type 1 or 2 */
const SYNC = hex(
  '000000686d6f6f66000000106d6668640000000000000001000000507472616600000014746668640002002000000001010100000000001474666474010000000000000000000000000000207472756e000002050000000200000070020000000000000400000004000000106d646174a0a0a0a0a1a1a1a1',
)
/** sap.json sample-presented-earlier: SAP type 2 or 3, earliest presentation 33 ms */
const REORDERED = hex(
  '0000006c6d6f6f66000000106d66686400000000000000010000005474726166000000107466686400020000000000010000001474666474010000000000000000000000000000287472756e00000a0500000002000000740200000000000004000017700000000400000000000000106d646174a0a0a0a0a1a1a1a1',
)
/** sap.json leading-decodable: SAP type 2, earliest presentation 33 ms */
const LEADING = hex(
  '000000706d6f6f66000000106d66686400000000000000010000005874726166000000147466686400020020000000010d0100000000001474666474010000000000000000000000000000287472756e00000a0500000002000000780200000000000004000017700000000400000000000000106d646174a0a0a0a0a1a1a1a1',
)
/** sap.json group-start-not-signalled: not a sync sample, in no sample group */
const NON_SYNC = hex(
  '000000606d6f6f66000000106d666864000000000000000100000048747261660000001074666864000200000000000100000014746664740100000000000000000000000000001c7472756e0000020100000002000000680000000400000004000000106d646174a0a0a0a0a1a1a1a1',
)
/** sap.json group-start-sap-type-3: a 'sap ' sample group gives SAP type 3 */
const SAP_3 = hex(
  '000000956d6f6f66000000106d66686400000000000000010000007d747261660000001074666864000200000000000100000014746664740100000000000000000000000000001c7472756e00000201000000020000009d00000004000000040000001c73626770000000007361702000000001000000010001000100000019736770640100000073617020000000010000000103000000106d646174a0a0a0a0a1a1a1a1',
)
/** SAP_3 with the 'sap ' entry's SAP type 4 */
const SAP_4 = hex(
  '000000956d6f6f66000000106d66686400000000000000010000007d747261660000001074666864000200000000000100000014746664740100000000000000000000000000001c7472756e00000201000000020000009d00000004000000040000001c73626770000000007361702000000001000000010001000100000019736770640100000073617020000000010000000104000000106d646174a0a0a0a0a1a1a1a1',
)
/** track-id.json unknown-track-id: tfhd track_ID 2 */
const TRACK_2 = hex(
  '000000646d6f6f66000000106d66686400000000000000010000004c74726166000000107466686400020000000000020000001474666474010000000000000000000000000000207472756e00000205000000020000006c020000000000000400000004000000106d646174a0a0a0a0a1a1a1a1',
)
/** timing.json base-media-decode-time: tfdt 900000 */
const AT_10S = hex(
  '000000646d6f6f66000000106d66686400000000000000010000004c747261660000001074666864000200000000000100000014746664740100000000000000000dbba0000000207472756e00000205000000020000006c020000000000000400000004000000106d646174a0a0a0a0a1a1a1a1',
)
/** structure.json mdat-only */
const MDAT_ONLY = hex('000000106d646174a0a0a0a0a0a0a0a0')

const text = new TextEncoder()

/** A draft-22 subgroup stream of one group, objects numbered from `first`. */
function subgroup(alias: number, groupId: number, payloads: Uint8Array[], first = 0): Uint8Array {
  return encodeSubgroupStream({
    type: 'subgroup',
    headerType: 0x10,
    trackAlias: BigInt(alias),
    groupId: BigInt(groupId),
    subgroupId: 0n,
    publisherPriority: 0,
    objects: payloads.map((payload, i) => ({
      type: 'object',
      byteOffset: 0,
      payloadByteOffset: 0,
      objectId: BigInt(first + i),
      payloadLength: payload.length,
      payload,
      extensionData: new Uint8Array(0),
    })),
  } as AnyStream)
}

let nextColour = 0

function track(subscribeId: string, name: string, alias: number): TrackEntry {
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
  }
}

interface Described {
  packaging?: string | null
  drafts?: string[]
  initRef?: string | null
  /** The header the catalog reader resolved: by initRef, or the track's initData without one */
  initData?: Uint8Array | null
  eventType?: string | null
  depends?: string[]
  maxGrpSapStartingType?: number | null
  maxObjSapStartingType?: number | null
  /** The track's `template` field, as the catalog gives it */
  template?: unknown
  catalog?: string
}

/** One catalog's description of a track, as the join keeps it. */
function claim(t: TrackEntry, d: Described) {
  const catalog = d.catalog ?? 'catalog'
  return {
    catalog: `live\u0000${catalog}`,
    catalogName: `live / ${catalog}`,
    publish: false,
    drafts: d.drafts ?? ['cmsf-01'],
    track: {
      namespace: 'live',
      name: t.trackName,
      packaging: d.packaging ?? null,
      codec: null,
      eventType: d.eventType ?? null,
      depends: d.depends ?? [],
      initRef: d.initRef ?? null,
      initData: d.initData ?? null,
      maxGrpSapStartingType: d.maxGrpSapStartingType ?? null,
      maxObjSapStartingType: d.maxObjSapStartingType ?? null,
      raw: d.template === undefined ? {} : { template: d.template },
    },
  } as unknown as TrackPackaging
}

/** What the session's catalogs say: each track described by one or more catalogs. */
function described(
  entries: [TrackEntry, ...Described[]][],
): Map<TrackKey, TrackPackaging> {
  return new Map(
    entries.map(([t, ...ds]) => {
      const claims = ds.map((d) => claim(t, d))
      return [registryTrackKey(t), { ...claims[0]!, claims }]
    }),
  )
}

const CMAF: Described = { packaging: 'cmaf', initRef: 'v', initData: HEADER }

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
  reader: SessionCmaf,
  t: ReturnType<typeof session>,
  packaging: Map<TrackKey, TrackPackaging>,
): number {
  const refs = reader.sync(t.s, packaging)
  for (const ref of refs) reader.ingest(ref, t.bytes.get(ref.streamId!) ?? null, '22')
  return refs.length
}

function titles(problems: PanelProblem[]): string[] {
  return problems.map((p) => p.title)
}

beforeEach(() => {
  parseSpy.mockClear()
})

describe('which tracks are CMAF', () => {
  it('reads none without a catalog saying cmaf', () => {
    const video = track('1', 'video', 1)
    const t = session([video])
    t.put(10, subgroup(1, 0, [SYNC]), 1)
    const reader = new SessionCmaf()
    expect(reader.sync(t.s, new Map())).toEqual([])
    expect(reader.trackState(video, described([[video, { packaging: 'loc' }]]))).toBeNull()
  })

  it('reads a track the catalogs give packaging cmaf', () => {
    const video = track('1', 'video', 1)
    const reader = new SessionCmaf()
    const state = reader.trackState(video, described([[video, CMAF]]))
    expect(state).toMatchObject({ draft: 'cmsf-01' })
    expect(state?.init).toMatchObject({ status: 'known', size: HEADER.length })
  })

})

describe('the CMAF header', () => {
  it('is the one every catalog gives', () => {
    const video = track('1', 'video', 1)
    const state = new SessionCmaf().trackState(
      video,
      described([[video, CMAF, { ...CMAF, initData: HEADER.slice(), catalog: 'other' }]]),
    )
    expect(state?.init.status).toBe('known')
  })

  it('is none when the catalogs disagree, which is reported', () => {
    const video = track('1', 'video', 1)
    const packaging = described([[video, CMAF, { ...CMAF, initData: null, catalog: 'other' }]])
    const reader = new SessionCmaf()
    expect(reader.trackState(video, packaging)?.init).toEqual({
      status: 'conflict',
      values: [
        { catalogName: 'live / catalog', size: HEADER.length },
        { catalogName: 'live / other', size: null },
      ],
    })
    const [problem] = reader.problems([video], packaging)
    expect(problem).toMatchObject({
      title: 'Catalogs give this track different CMAF headers',
      found: `live / catalog: ${HEADER.length} B · live / other: none`,
      severity: 'info',
    })
  })

  it('reports a catalog that gives none, and a header that does not parse', () => {
    const video = track('1', 'video', 1)
    const t = session([video])
    t.put(10, subgroup(1, 0, [SYNC]), 1)
    for (const [initData, title] of [
      [null, 'CMAF track has no header in the catalog'],
      [HEADER.subarray(0, 24), 'CMAF header does not parse'],
    ] as const) {
      const packaging = described([[video, { packaging: 'cmaf', initRef: 'v', initData }]])
      const reader = new SessionCmaf()
      pump(reader, t, packaging)
      const problems = reader.problems([video], packaging)
      expect(titles(problems)).toEqual([title])
      expect(problems[0]).toMatchObject({ severity: 'error', spec: { label: 'CMSF-01 3.1' } })
    }
  })

  it('comes from a CMSF-01 catalog through initDataList and initRef', () => {
    const catalogTrack = { ...track('9', 'catalog', 9) }
    const t = session([catalogTrack])
    const catalog = {
      version: '1',
      tracks: [{ name: 'video', packaging: 'cmaf', isLive: true, initRef: 'v' }],
      initDataList: [{ id: 'v', type: 'inline', data: HEADER_B64 }],
    }
    t.put(3, subgroup(9, 0, [text.encode(JSON.stringify(catalog))]), 9)
    const catalogs = new SessionCatalogs()
    for (const ref of catalogs.sync(t.s)) {
      catalogs.ingest(ref, t.bytes.get(ref.streamId) ?? null, '22')
    }
    const video = track('1', 'video', 1)
    const state = new SessionCmaf().trackState(video, packagingIndex(catalogs.views()))
    expect(state).toMatchObject({ draft: 'cmsf-01', init: { status: 'known' } })
  })

  it('is read only from the field the catalog draft defines', () => {
    const video = track('1', 'video', 1)
    const header = (d: Described) =>
      new SessionCmaf().trackState(video, described([[video, d]]))?.init
    // A track's own initData: cmsf-00 3.1 defines it, cmsf-01 3.1 does not.
    const own: Described = { packaging: 'cmaf', initData: HEADER }
    expect(header({ ...own, drafts: ['cmsf-00'] })?.status).toBe('known')
    expect(header(own)).toEqual({
      status: 'none',
      reason: 'other-draft-field',
      catalogName: 'live / catalog',
      field: 'initData',
      drafts: ['cmsf-01'],
    })
    expect(header({ ...own, drafts: ['cmsf-00', 'cmsf-01'] })).toEqual({
      status: 'ambiguous',
      values: [{ catalogName: 'live / catalog', field: 'initData', drafts: ['cmsf-00', 'cmsf-01'] }],
    })
  })
})

describe('one object', () => {
  const video = track('1', 'video', 1)
  const packaging = described([[video, CMAF]])

  function view(payload: Uint8Array, reader = new SessionCmaf(), objectId = 0) {
    const data = subgroup(1, 0, [payload], objectId)
    const state = reader.trackState(video, packaging)!
    const obj = { offset: 0, payloadOffset: data.length - payload.length, payloadLength: payload.length, objectId }
    return reader.objectView('s:10', obj, data, state)
  }

  it('says a SAP type 2 that decodable leading samples decide', () => {
    expect(sapText(view(LEADING).object.sap)).toBe(
      'SAP type 2 (sync sample; the later samples presented before it are signalled decodable)',
    )
    expect(sapText(view(REORDERED).object.sap)).toBe('SAP type 2 or 3')
  })

  it('gives the track_IDs against the header, the sync status and the SAP', () => {
    const v = view(SYNC)
    expect(v.object.trackIds).toEqual([1])
    expect(v.headerTrackIds).toEqual([1])
    expect(syncText(v.object.firstSample)).toBe('sync sample (trun first_sample_flags)')
    expect(sapText(v.object.sap)).toBe('SAP type 1 or 2')
    expect(v.findings).toEqual([])
  })

  it("reads baseMediaDecodeTime at the header's timescale", () => {
    const v = view(AT_10S)
    const traf = v.object.movieFragments[0]!.trackFragments[0]!
    expect(decodeTimeText(traf.baseMediaDecodeTime, v.timescales.get(1))).toBe(
      '900000 at 90000/s (10.000 s)',
    )
    expect(v.object.timing.eptMs).toEqual([10000])
  })

  it('leaves out what the object does not give', () => {
    expect(decodeTimeText(900000n, null)).toBe('900000')
    expect(eptText({ earliestPresentationTime: null, eptMs: null, unknown: 'no-tfdt' })).toBeNull()
    expect(eptText({ earliestPresentationTime: 900n, eptMs: null, unknown: 'no-timescale' })).toBe(
      '900 in timescale units',
    )
  })

  it('says a track_ID the header lacks', () => {
    const v = view(TRACK_2)
    expect(v.headerTrackIds).toEqual([1])
    expect(v.findings.map((f) => [f.code, f.section])).toEqual([
      ['track-id-not-in-init', 'CMSF-01 3.3'],
    ])
  })

  it('is parsed once while the header stays', () => {
    const reader = new SessionCmaf()
    view(SYNC, reader)
    view(SYNC, reader)
    expect(parseSpy).toHaveBeenCalledTimes(1)
  })
})

describe('problems', () => {
  const video = track('1', 'video', 1)

  function read(payloads: Uint8Array[], d: Described = CMAF, first = 0) {
    const t = session([video])
    t.put(10, subgroup(1, 0, payloads, first), 1)
    const packaging = described([[video, d]])
    const reader = new SessionCmaf()
    pump(reader, t, packaging)
    return reader.problems([video], packaging)
  }

  it('says nothing about objects that keep the rules', () => {
    expect(read([SYNC, AT_10S])).toEqual([])
  })

  it('reports track_IDs the header lacks, once for the track, as an error', () => {
    const [problem, ...rest] = read([TRACK_2, TRACK_2, TRACK_2, TRACK_2])
    expect(rest).toEqual([])
    expect(problem).toMatchObject({
      title: 'Objects name a track_ID the CMAF header does not have',
      severity: 'error',
      spec: { label: 'CMSF-01 3.3' },
      atMs: 1010,
    })
    expect(problem!.places.map((p) => [p.label, p.note])).toEqual(
      [0, 1, 2, 3].map((o) => [
        `group 0, object ${o}`,
        'The track_ID 2 matches no trak of the CMAF header',
      ]),
    )
    expect(problem!.places[0]!.target).toMatchObject({ kind: 'object', source: 's:10' })
  })

  it('reports an object with no moof followed by an mdat', () => {
    expect(read([MDAT_ONLY], CMAF, 1)).toMatchObject([
      { title: 'Objects have no moof followed by an mdat', severity: 'error' },
    ])
  })

  it('reports a group that starts with a signalled SAP type other than 1 or 2', () => {
    expect(read([SAP_3])).toMatchObject([
      {
        title: 'Groups start with a SAP type other than 1 or 2',
        severity: 'error',
      },
    ])
    // Not the first object of its group.
    expect(read([SAP_3], CMAF, 1)).toEqual([])
  })

  it('reports nothing for a group start whose SAP type is not signalled', () => {
    expect(read([NON_SYNC])).toEqual([])
  })

  it('reports a group start above maxGrpSapStartingType when the SAP type is signalled', () => {
    expect(read([LEADING], { ...CMAF, maxGrpSapStartingType: 1 })).toMatchObject([
      {
        title: "Groups start above the catalog's maxGrpSapStartingType",
        found: 'maxGrpSapStartingType 1',
        spec: { label: 'CMSF-01 3.5.2.1' },
        places: [{ label: 'group 0, object 0', note: 'starts with SAP type 2' }],
        severity: 'warning',
      },
    ])
    // A sync sample alone is SAP type 1 or 2: not signalled, nothing to compare.
    expect(read([SYNC], { ...CMAF, maxGrpSapStartingType: 1 })).toEqual([])
  })

  it('counts an object a subscription and a fetch both carry once', () => {
    const t = session([video])
    t.put(10, subgroup(1, 0, [TRACK_2]), 1)
    t.put(14, subgroup(1, 0, [TRACK_2]), 1)
    const packaging = described([[video, CMAF]])
    const reader = new SessionCmaf()
    pump(reader, t, packaging)
    expect(reader.problems([video], packaging)[0]!.places).toMatchObject([
      { label: 'group 0, object 0', note: 'The track_ID 2 matches no trak of the CMAF header' },
    ])
  })
})

describe('copies of one object', () => {
  const video = track('1', 'video', 1)

  it('reports copies that read differently, whichever arrives first, and checks neither', () => {
    for (const [a, b] of [
      [SYNC, SAP_3],
      [SAP_3, SYNC],
    ]) {
      const t = session([video])
      t.put(10, subgroup(1, 0, [a!]), 1)
      t.put(14, subgroup(1, 0, [b!]), 1)
      const packaging = described([[video, CMAF]])
      const reader = new SessionCmaf()
      pump(reader, t, packaging)
      const problems = reader.problems([video], packaging, '22')
      expect(problems).toMatchObject([
        {
          title: 'Copies of an object read differently',
          severity: 'error',
          spec: {
            label: 'MoQT-22 2.1',
            url: 'https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport-22#section-2.1',
            quote: expect.stringContaining('must be an identical sequence of bytes regardless of how or where it is retrieved'),
          },
          places: [{ label: 'group 0, object 0', target: { source: 's:10' } }],
        },
      ])
    }
  })

  it('cites the rule in the session draft, and nothing without one', () => {
    expect(copiesSpec('07')!.url).toBe('https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport-07#section-2.1')
    expect(copiesSpec(undefined)).toBeNull()
    expect(copiesSpec('23')).toBeNull()
  })
})

describe('reading sources', () => {
  const video = track('1', 'video', 1)

  it('parses each object once as the stream grows, and again when the header changes', () => {
    const t = session([video])
    const full = subgroup(1, 0, [SYNC, AT_10S, SYNC, AT_10S])
    t.put(10, full.subarray(0, 140), 1, false)
    const packaging = described([[video, CMAF]])
    const reader = new SessionCmaf()
    expect(pump(reader, t, packaging)).toBe(1)
    expect(parseSpy).toHaveBeenCalledTimes(1)

    // Below twice the bytes read: not due.
    t.put(10, full.subarray(0, 200), 1, false)
    expect(pump(reader, t, packaging)).toBe(0)

    t.put(10, full, 1, true)
    expect(pump(reader, t, packaging)).toBe(1)
    expect(parseSpy).toHaveBeenCalledTimes(4)
    expect(pump(reader, t, packaging)).toBe(0)

    // Another header: every object is read again under it.
    const changed = described([[video, { ...CMAF, initData: null }]])
    expect(pump(reader, t, changed)).toBe(1)
    expect(parseSpy).toHaveBeenCalledTimes(8)
    expect(reader.trackState(video, changed)?.objectCount).toBe(4)
  })
})

describe('SAP type timelines', () => {
  const video = track('1', 'video', 1)
  const sap = track('2', 'sap', 2)
  const TIMELINE: Described = {
    packaging: 'eventtimeline',
    eventType: SAP_TIMELINE_EVENT_TYPE,
    depends: ['video'],
  }

  function json(value: unknown): Uint8Array {
    return text.encode(JSON.stringify(value))
  }

  function read(
    timeline: Uint8Array[],
    media: Uint8Array[] = [],
    d: Described = TIMELINE,
  ) {
    const t = session([video, sap])
    if (media.length > 0) t.put(10, subgroup(1, 0, media), 1)
    t.put(20, subgroup(2, 0, timeline), 2)
    const packaging = described([
      [video, CMAF],
      [sap, d],
    ])
    const reader = new SessionCmaf()
    pump(reader, t, packaging)
    return { reader, packaging, problems: reader.problems([video, sap], packaging) }
  }

  it('reads a track the catalogs give the SAP event type, and only that', () => {
    const reader = new SessionCmaf()
    expect(reader.timelineState(sap, described([[sap, TIMELINE]]))).toMatchObject({
      kind: 'sap',
      draft: 'cmsf-01',
      timelineDraft: 'msf-01',
      depends: ['video'],
    })
    expect(
      reader.timelineState(sap, described([[sap, { ...TIMELINE, eventType: 'other' }]]))?.kind,
    ).toBe('event')
  })

  it('reads the records of an object', () => {
    const { reader, packaging } = read([json([{ l: [0, 0], data: [2, 0] }])])
    const state = reader.timelineState(sap, packaging)!
    const payload = json([{ l: [0, 0], data: [2, 0] }, { l: [0, 60], data: [3, 2100] }])
    const data = subgroup(2, 0, [payload])
    const v = reader.timelineView(
      's:20',
      { offset: 0, payloadOffset: data.length - payload.length, payloadLength: payload.length, objectId: 0 },
      data,
      state,
    )
    expect(v.kind).toBe('sap')
    if (v.kind !== 'sap') return
    expect(v.entries.map((e) => [e.group, e.object, e.sapType, e.ept])).toEqual([
      [0, 0, 2, 0],
      [0, 60, 3, 2100],
    ])
    expect(v.problems).toEqual([])
  })

  it('reports records that do not read', () => {
    const { problems } = read([json([{ l: [0, 1], data: [4, 0] }])])
    expect(problems).toMatchObject([
      { title: 'SAP timeline record 0 has SAP type 4, not 0 to 3', id: 'timeline.sap.type.value' },
    ])
  })

  it('agrees with media that says the same', () => {
    const { problems } = read([json([{ l: [0, 0], data: [2, 33] }])], [LEADING])
    expect(problems).toEqual([])
  })

  it('reports a record the media contradicts where both are signalled', () => {
    const { problems } = read([json([{ l: [0, 0], data: [1, 40] }])], [LEADING])
    expect(problems).toMatchObject([
      {
        title: 'SAP timeline disagrees with the media of video',
        spec: { label: 'CMSF-01 3.6.1' },
        places: [
          {
            label: 'group 0, object 0',
            note: 'the timeline says SAP type 1, the media 2; earliest presentation time 40 ms, the media 33 ms',
            target: { kind: 'object', source: 's:10' },
          },
        ],
        severity: 'warning',
      },
    ])
  })

  it('reports a SAP type outside those the media leaves open', () => {
    const { problems } = read([json([{ l: [0, 1], data: [1, 33] }])], [SYNC, REORDERED])
    expect(problems).toMatchObject([
      {
        title: 'SAP timeline disagrees with the media of video',
        places: [
          { label: 'group 0, object 1', note: 'the timeline says SAP type 1, the media 2 or 3' },
        ],
      },
    ])
  })

  it('does not compare the time of a SAP type 3 record, which the drafts define two ways', () => {
    const { problems } = read([json([{ l: [0, 1], data: [3, 50] }])], [SYNC, SAP_3])
    expect(problems).toEqual([])
  })

  it('does not compare a media SAP type the timeline cannot give', () => {
    const { problems } = read([json([{ l: [0, 1], data: [0, 0] }])], [SYNC, SAP_4])
    expect(problems).toEqual([])
  })

  it('holds a CMSF-00 Object 0 to SAP type 1 or 2, and cites CMSF-00 alone', () => {
    const cmsf00: Described = { ...TIMELINE, drafts: ['cmsf-00'] }
    const first = read([json([{ l: [0, 0], data: [0, 0] }])], [], cmsf00).problems
    expect(first).toMatchObject([
      { title: 'Group 0 starts with SAP type 0, not 1 or 2', severity: 'error' },
    ])
    expect(first[0]!.spec?.label).toBe('CMSF-00 3.6.1')
    const shape = read([json({ l: [0, 0] })], [], cmsf00).problems
    expect(shape).toHaveLength(1)
    expect(shape[0]!.spec?.label).toBe('CMSF-00 3.6.1')
  })

  it('reports gzip bytes as an object that is not JSON', () => {
    const { problems } = read([new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00])])
    expect(problems).toMatchObject([
      { title: 'Timeline payload is not UTF-8', severity: 'error' },
    ])
  })

  it('does not compare a SAP type the media leaves open', () => {
    // A sync sample is SAP type 1 or 2; the timeline's 1 is not checked.
    const { problems } = read([json([{ l: [0, 0], data: [1, 0] }])], [SYNC])
    expect(problems).toEqual([])
  })

  it('does not compare records when depends names several tracks', () => {
    const { problems } = read(
      [json([{ l: [0, 0], data: [1, 40] }])],
      [LEADING],
      { ...TIMELINE, depends: ['video', 'audio'] },
    )
    expect(problems).toEqual([])
  })

  it('reports timeline objects that disagree on a Location, and compares neither', () => {
    const { problems } = read(
      [json([{ l: [0, 0], data: [2, 33] }]), json([{ l: [0, 0], data: [1, 40] }])],
      [LEADING],
    )
    expect(problems).toMatchObject([
      {
        title: 'SAP timeline objects disagree on a record',
        severity: 'warning',
      },
    ])
  })
})

describe('media and event timelines', () => {
  const video = track('1', 'video', 1)
  const times = track('3', 'times', 3)
  const MEDIA: Described = { packaging: 'mediatimeline', drafts: ['msf-01'], depends: ['video'] }
  const EVENTS: Described = { packaging: 'eventtimeline', drafts: ['msf-01'], eventType: 'scores' }

  function json(value: unknown): Uint8Array {
    return text.encode(JSON.stringify(value))
  }

  /** The one object of a single-object stream, as the framing gives it. */
  function only(data: Uint8Array, payload: Uint8Array) {
    return {
      offset: 0,
      payloadOffset: data.length - payload.length,
      payloadLength: payload.length,
      objectId: 0,
    }
  }

  function read(objects: Uint8Array[], d: Described) {
    const t = session([video, times])
    t.put(10, subgroup(1, 0, [SYNC]), 1)
    t.put(30, subgroup(3, 0, objects), 3)
    const packaging = described([
      [video, CMAF],
      [times, d],
    ])
    const reader = new SessionCmaf()
    pump(reader, t, packaging)
    const state = reader.timelineState(times, packaging)!
    const data = t.bytes.get(30)!
    const view = () => reader.timelineView('s:30', only(data, objects[0]!), data, state)
    return { problems: reader.problems([video, times], packaging), view }
  }

  it('reads a track as the catalogs agree it is a media or event timeline', () => {
    const reader = new SessionCmaf()
    expect(reader.timelineState(times, described([[times, MEDIA]]))).toMatchObject({
      kind: 'media',
      timelineDraft: 'msf-01',
      depends: ['video'],
    })
    expect(reader.timelineState(times, described([[times, EVENTS]]))).toMatchObject({
      kind: 'event',
      eventType: 'scores',
    })
    expect(
      reader.timelineState(times, described([[times, MEDIA, { ...EVENTS, catalog: 'other' }]])),
    ).toBeNull()
    expect(reader.timelineState(times, new Map())).toBeNull()
  })


  it('reads the records of a media timeline object', () => {
    const records = [
      [0, [0, 0], 1759924158381],
      [2002, [1, 0], 1759924160383],
    ]
    const { view, problems } = read([json(records)], MEDIA)
    expect(problems).toEqual([])
    expect(view()).toMatchObject({
      kind: 'media',
      records: [
        { mediaTime: 0, group: 0, object: 0, wallclock: 1759924158381 },
        { mediaTime: 2002, group: 1, object: 0, wallclock: 1759924160383 },
      ],
      problems: [],
    })
  })

  it('reports media timeline records that do not read, with the rule and the object', () => {
    const { problems } = read([json([[0, [0, 0], 1], [33.3, [1, 0], 2], { m: 0 }])], MEDIA)
    expect(problems).toMatchObject([
      {
        source: 'timeline',
        title: 'Media timeline record 1 has media time 33.3, not whole milliseconds',
        found: 'mediaTime 33.3',
        severity: 'error',
        spec: { label: 'MSF-01 7.1.1' },
        places: [{ label: 'group 0, object 0', target: { kind: 'object', source: 's:30' } }],
        atMs: 1030,
      },
      {
        title: 'Media timeline record 2 is not an Array of three items',
        severity: 'error',
        spec: { label: 'MSF-01 7.1.1' },
      },
    ])
  })

  it('does not compare a media timeline with the media it describes', () => {
    // The media's first sample is at 0 ms; the record says 500.
    const { problems } = read([json([[500, [0, 0], 0]])], MEDIA)
    expect(problems).toEqual([])
  })

  it('reads the records of an event timeline object by their index reference', () => {
    const records = [
      { t: 1759924158381, data: { score: [1, 0] } },
      { l: [0, 3], data: { score: [1, 1] } },
      { m: 2002, data: { score: [2, 1] } },
    ]
    const { view, problems } = read([json(records)], EVENTS)
    const v = view()
    expect(v.kind).toBe('event')
    if (v.kind !== 'event') return
    expect(v.records.map((r) => r.index)).toEqual(['t', 'l', 'm'])
    expect(problems).toMatchObject([
      {
        title: 'Event records mix index references t, l, m',
        severity: 'warning',
        spec: { label: 'MSF-01 8.1' },
      },
    ])
  })

  it('reports an event timeline object that is not JSON, and reads nothing from it', () => {
    const { view, problems } = read([new Uint8Array([0x1f, 0x8b, 0x08])], EVENTS)
    expect(problems).toMatchObject([
      { title: 'Timeline payload is not UTF-8', severity: 'error' },
    ])
    expect(view().kind).toBe('invalid')
  })

  it('reads the template the catalogs agree on for a media track, from MSF-01 on', () => {
    // msf-01 5.6.10: the template on a LOC track, with no media timeline track.
    const template = [0, 2002, [0, 0], [1, 0], 1759924158381, 2002]
    const video = track('1', '1080p-video', 1)
    const LOC: Described = { packaging: 'loc', drafts: ['msf-01'] }
    const templateFor = (...ds: Described[]) =>
      templateOf(described([[video, ...ds]]).get(registryTrackKey(video)))
    expect(templateFor({ ...LOC, template })).toEqual({
      template: {
        startMediaTime: 0,
        deltaMediaTime: 2002,
        startGroup: 0,
        startObject: 0,
        deltaGroup: 1,
        deltaObject: 0,
        startWallclock: 1759924158381,
        deltaWallclock: 2002,
      },
      problems: [],
    })
    expect(templateFor({ ...CMAF, template })?.template?.deltaMediaTime).toBe(2002)
    // msf-00 defines no template field.
    expect(templateFor({ ...LOC, drafts: ['msf-00'], template })).toBeNull()
    expect(templateFor({ ...LOC, template }, { ...LOC, template: [0], catalog: 'other' })).toBeNull()
  })

  it('reports a template that does not read against its track, whatever its packaging', () => {
    const video = track('1', 'video', 1)
    const packaging = described([[video, { ...CMAF, template: [0, 2002, [0, 0], [1, 0]] }]])
    expect(new SessionCmaf().problems([video], packaging)).toEqual([])
    expect(templateProblems([video], packaging)).toMatchObject([
      {
        source: 'catalog',
        title: 'Media timeline template has fewer than six values',
        severity: 'error',
        spec: { label: 'MSF-01 7.4.1' },
        places: [],
      },
    ])
  })

  it('reads an object a subscription and a fetch both carry once, and reports copies that differ', () => {
    const t = session([times])
    const bad = json([[0.5, [0, 0], 0]])
    t.put(30, subgroup(3, 0, [bad]), 3)
    t.put(34, subgroup(3, 0, [bad]), 3)
    const packaging = described([[times, MEDIA]])
    const reader = new SessionCmaf()
    pump(reader, t, packaging)
    const [problem, ...rest] = reader.problems([times], packaging)
    expect(rest).toEqual([])
    expect(problem!.places).toHaveLength(1)

    t.put(34, subgroup(3, 0, [json([[0, [0, 0], 0]])]), 3)
    const again = new SessionCmaf()
    pump(again, t, packaging)
    expect(again.problems([times], packaging)).toMatchObject([
      {
        title: 'Copies of a media timeline object read differently',
        severity: 'error',
      },
    ])
  })
})
