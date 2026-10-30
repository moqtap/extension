/**
 * The Problems tab's one list: how each source's problems join it, and how
 * the list is merged, grouped, ordered, counted and copied.
 */

import { type CatalogProblem, checkCatalogObjectPlacement, parseCatalog } from '@moqtap/media/catalog'
import { describe, expect, it } from 'vitest'
import {
  type CatalogObjectRecord,
  type CatalogView,
  registryTrackKey,
  type TrackKey,
  type TrackPackaging,
  trackKey,
} from './catalogs'
import {
  catalogConflictProblems,
  catalogProblems,
  consolidateProblems,
  copyIncludes,
  countText,
  groupBySubject,
  joinInitProblems,
  levelsLabel,
  makeProblem,
  type PanelProblem,
  problemJson,
  problemText,
  protocolProblems,
  SESSION_SUBJECT,
  severityCounts,
  sinceText,
  specsFromSection,
} from './problems'
import type { MessageEntry, TrackEntry } from './use-inspector'

const TRACK = { kind: 'track', key: 'live\u0000video', label: 'live / video' } as const

function problem(p: Partial<PanelProblem> & Pick<PanelProblem, 'title'>): PanelProblem {
  return makeProblem({ source: 'cmaf', severity: 'error', subject: TRACK, ...p })
}

function at(source: string, offset: number, atMs: number | null = null): PanelProblem['places'][number] {
  return { label: `object at ${offset}`, note: null, target: { kind: 'object', source, offset }, atMs }
}

describe('the list', () => {
  it('puts errors first, then warnings, then notes, each by when it was first seen', () => {
    const list = consolidateProblems([
      [
        problem({ title: 'note', severity: 'info', atMs: 1 }),
        problem({ title: 'late error', atMs: 50 }),
        problem({ title: 'warning', severity: 'warning', atMs: 2 }),
      ],
      [problem({ title: 'error with no time' }), problem({ title: 'early error', atMs: 10 })],
    ])
    expect(list.map((p) => p.title)).toEqual([
      'early error',
      'late error',
      'error with no time',
      'warning',
      'note',
    ])
  })

  it('merges problems of one subject, family and severity, keeping every place once', () => {
    const list = consolidateProblems([
      [problem({ title: 'same', id: 'cmaf.x', places: [at('s:1', 0)], atMs: 20 })],
      [problem({ title: 'same', id: 'cmaf.x', places: [at('s:1', 0), at('s:2', 8)], atMs: 5 })],
      [problem({ title: 'same', id: 'cmaf.x', subject: { ...TRACK, key: 'other' } })],
    ])
    expect(list).toHaveLength(2)
    expect(list[0]!.places.map((p) => p.target)).toEqual([
      { kind: 'object', source: 's:1', offset: 0 },
      { kind: 'object', source: 's:2', offset: 8 },
    ])
    expect(list[0]!.atMs).toBe(5)
  })

  it('counts rows by severity', () => {
    expect(
      severityCounts([problem({ title: 'a' }), problem({ title: 'b', severity: 'info' }), problem({ title: 'c' })]),
    ).toEqual({ error: 2, warning: 0, info: 1 })
  })

  it('groups by subject: the session, then catalogs, then tracks in the given order', () => {
    const catalog = { kind: 'catalog', key: 'live\u0000catalog', label: 'live / catalog' } as const
    const audio = { kind: 'track', key: 'live\u0000audio', label: 'live / audio' } as const
    const groups = groupBySubject(
      [
        problem({ title: 'v' }),
        problem({ title: 'a', subject: audio }),
        problem({ title: 'c', subject: catalog }),
        problem({ title: 's', subject: SESSION_SUBJECT }),
      ],
      [audio.key, TRACK.key],
    )
    expect(groups.map((g) => g.subject.label)).toEqual(['Session', 'live / catalog', 'live / audio', 'live / video'])
  })
})

describe('words', () => {
  it('counts places against what was examined, with the unit', () => {
    const p = problem({ title: 'x', places: [at('s:1', 0), at('s:1', 9)], examined: 257, unit: 'catalog objects' })
    expect(countText(p)).toBe('2 of 257 objects')
    expect(countText(p, true)).toBe('2/257 objects')
    expect(countText(problem({ title: 'track-level' }))).toBe('')
    expect(countText(problem({ title: 'one', places: [at('s:1', 0)], unit: 'messages' }))).toBe('1 message')
  })

  it('says whether the last place is the latest examined, or how many since show none', () => {
    const place = (seq: number) => ({ ...at('s:1', seq), seq })
    expect(sinceText(problem({ title: 'x', places: [place(0), place(9)], examined: 10 }))).toBe('(the latest object)')
    expect(sinceText(problem({ title: 'x', places: [place(0), place(6)], examined: 10 }))).toBe(
      '; not in the 3 objects since',
    )
  })

  it('links sections written as text, first one first', () => {
    expect(specsFromSection('CMSF-00 3.1, CMSF-01 3.1').map((s) => s.url)).toEqual([
      'https://datatracker.ietf.org/doc/html/draft-ietf-moq-cmsf-00#section-3.1',
      'https://datatracker.ietf.org/doc/html/draft-ietf-moq-cmsf-01#section-3.1',
    ])
    expect(specsFromSection('mzanaty LOC-05 2.1.4')[0]!.url).toBe(
      'https://datatracker.ietf.org/doc/html/draft-mzanaty-moq-loc-05#section-2.1.4',
    )
  })

  it('copies a row as text and as data, with no internals', () => {
    const p = problem({
      title: 'Objects have no moof followed by an mdat',
      remedy: 'Carry a moof followed by its mdat in each object',
      places: [at('s:1', 0, 1_649)],
      examined: 4,
      spec: { label: 'CMSF-01 3.3', url: 'https://example.test/cmsf', quote: 'Each object MUST ...' },
    })
    const text = problemText(p, { startedAt: 1_000, session: 'relay.test, MoQT draft-22, 2026-10-30 02:46:23 UTC' })
    expect(text.split('\n')).toEqual([
      '[error] Objects have no moof followed by an mdat',
      'Track: live / video',
      'Session: relay.test, MoQT draft-22, 2026-10-30 02:46:23 UTC',
      'Seen: 1 of 4 objects, object at 0 at +00:00.649',
      'Fix: Carry a moof followed by its mdat in each object',
      'Spec: CMSF-01 3.3 "Each object MUST ..."',
      'https://example.test/cmsf',
    ])
    expect(problemJson(p, { startedAt: 1_000 })).toMatchObject({
      severity: 'error',
      seen: { count: 1, of: 4, unit: 'objects', first: { label: 'object at 0', atMs: 649 } },
    })
    expect(copyIncludes(p, 'text')).toBe(
      'Copies the title, session, Fix, Affected, Seen and the spec link as plain text',
    )
    expect(copyIncludes(p, 'json')).toBe('Copies the title, Fix, Affected, Seen and the spec link as JSON')
  })

  it('copies the evidence a row has', () => {
    const p = problem({ title: 'T', evidence: '15 00 be 28' })
    const text = problemText(p, { startedAt: 0, session: 's' })
    expect(text.split('\n').slice(-2)).toEqual(['Evidence:', '15 00 be 28'])
    expect(problemJson(p, { startedAt: 0 }).evidence).toBe('15 00 be 28')
  })
})

describe('control message problems', () => {
  it('keep their wording and severity, name the sender and link the message', () => {
    const message: MessageEntry = {
      timestamp: 12,
      direction: 'rx',
      messageType: 'request_error',
      decoded: null,
      decodedPretty: null,
      raw: new Uint8Array(),
    }
    const [p] = protocolProblems([
      {
        id: 'session.error',
        spec: { draft: 'moqt', revision: '22', section: '9.4', keyword: null, quote: 'q' },
        title: 'REQUEST_ERROR',
        detail: 'SUBSCRIBE #4',
        severity: 'error',
        atMs: 12,
        message,
      },
    ])
    expect(p).toMatchObject({
      source: 'protocol',
      id: 'session.error',
      severity: 'error',
      subject: SESSION_SUBJECT,
      title: 'REQUEST_ERROR',
      found: 'SUBSCRIBE #4',
      sender: 'relay',
      spec: {
        label: 'MoQT-22 9.4',
        url: 'https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport-22#section-9.4',
      },
      places: [{ label: 'REQUEST_ERROR', target: { kind: 'message', message } }],
      atMs: 12,
    })
  })
})

describe('catalog problems', () => {
  const initData = 'AAAAGGZ0eXBjbWZjAAAAAGNtZmNpc282'
  // A draft-01 catalog giving CMSF-00's initData: a reader of -01 has no header.
  const DOC = {
    version: 'draft-01',
    generatedAt: 1,
    tracks: [
      { name: 'video', packaging: 'cmaf', isLive: true, role: 'video', codec: 'avc1.64001f', bitrate: 1, width: 1, height: 1, framerate: 30, timescale: 90000, initData },
      { name: 'audio', packaging: 'cmaf', isLive: true, role: 'audio', codec: 'mp4a.40.2', bitrate: 1, samplerate: 48000, channelConfig: '2', timescale: 48000, initData },
    ],
  }

  function view(objects: number): CatalogView {
    const parsed = parseCatalog(JSON.stringify(DOC))
    if (parsed.kind === 'invalid') throw new Error('catalog')
    const record = (groupId: number): CatalogObjectRecord => ({
      groupId,
      subgroupId: 0,
      objectId: 0,
      streamId: 3 + groupId * 4,
      size: 10,
      kind: 'independent',
      draft: parsed.draft,
      outcome: 'applied',
      problems: parsed.problems as CatalogProblem[],
      document: parsed.document,
      changes: null,
    })
    return {
      key: trackKey('live', 'catalog'),
      namespace: 'live',
      name: 'catalog',
      objects: Array.from({ length: objects }, (_, g) => record(g)),
    } as unknown as CatalogView
  }

  it('make one error row per catalog for the other draft init field, naming the tracks', () => {
    const rows = catalogProblems([view(3)], (id) => id * 100).filter(
      (r) => r.family === 'catalog.init.other-draft-field',
    )
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row).toMatchObject({
      severity: 'error',
      subject: { kind: 'catalog', label: 'live / catalog' },
      examined: 3,
      atMs: 300,
      spec: { label: 'CMSF-01 3.1' },
    })
    expect(row!.title).toMatch(/initData/)
    expect(row!.items.map((i) => [i.name, i.path])).toEqual([
      ['video', 'tracks[0]'],
      ['audio', 'tracks[1]'],
    ])
    expect(countText(row!)).toBe('3 of 3 objects')
    expect(row!.evidence).toContain('"name": "video"')
  })

  it('take in the CMAF tracks with no header the catalog row explains, marking them', () => {
    const rows = catalogProblems([view(1)], () => null)
    const none = problem({ title: 'none', id: 'cmaf.init.none', subject: { ...TRACK, key: registryTrackKey({ trackNamespace: ['live'], trackName: 'video' }) } })
    const joined = joinInitProblems([...rows, none])
    expect(joined.some((p) => p.id === 'cmaf.init.none')).toBe(false)
    const row = joined.find((p) => p.family === 'catalog.init.other-draft-field')!
    expect(row.items[0]!.marks).toEqual(['subscribed', 'no CMAF header'])
    expect(row.items[1]!.marks).toEqual([])
  })

  it('show a catalog object off subgroup 0 by its stream header, the subgroup marked', () => {
    const v = view(1)
    const placement = checkCatalogObjectPlacement({ groupId: 0, subgroupId: 1, objectId: 0, independent: true }, 'msf-01')
    v.objects[0]!.problems = placement
    v.objects[0]!.subgroupId = 1
    const header = {
      fields: { streamType: 0x15, trackAlias: 0, groupId: 0, subgroupId: 1, publisherPriority: 1 },
      bytes: Uint8Array.of(0x15, 0, 0, 1, 1),
    }
    ;(v as { headers: Map<number, typeof header> }).headers = new Map([[3, header]])
    const live = catalogProblems([v], () => null, true).find((r) => r.id === 'catalog.object.subgroup')!
    expect(live.header).toEqual({
      fields: [
        { label: 'type', value: '0x15', marked: false },
        { label: 'track alias', value: '0', marked: false },
        { label: 'group', value: '0', marked: false },
        { label: 'subgroup', value: '1', marked: true },
        { label: 'publisher priority', value: '1', marked: false },
      ],
      bytes: '15 00 00 01 01',
      target: { kind: 'catalog-object', streamId: 3, groupId: 0, objectId: 0 },
    })
    expect(live.evidence!.split('\n')).toEqual([
      '15 00 00 01 01',
      'type 0x15',
      'track alias 0',
      'group 0',
      'subgroup 1  <-',
      'publisher priority 1',
    ])
    const imported = catalogProblems([v], () => null).find((r) => r.id === 'catalog.object.subgroup')!
    expect(imported.header!.bytes).toBeNull()
  })
})

describe('catalogs that disagree on a track', () => {
  const track = {
    subscribeId: '1',
    trackNamespace: ['live'],
    trackName: 'times',
    fullName: 'live / times',
  } as TrackEntry

  function claim(catalog: string, packaging: string, codec: string | null = null) {
    return {
      catalog: `live\u0000${catalog}`,
      catalogName: `live / ${catalog}`,
      publish: false,
      drafts: ['msf-01'],
      track: { namespace: 'live', name: 'times', packaging, codec },
    }
  }

  it('are noted once for each track and field, whatever the packaging', () => {
    const claims = [claim('a', 'mediatimeline', 'x'), claim('b', 'eventtimeline', 'y')]
    const packaging = new Map<TrackKey, TrackPackaging>([
      [registryTrackKey(track), { ...claims[0]!, claims } as unknown as TrackPackaging],
    ])
    const problems = catalogConflictProblems([track, { ...track, subscribeId: '2' }], packaging)
    expect(problems).toEqual([
      expect.objectContaining({
        source: 'catalog',
        severity: 'info',
        subject: expect.objectContaining({ label: 'live / times' }),
        title: 'Catalogs disagree on the packaging of this track',
        found: 'live / a: mediatimeline · live / b: eventtimeline',
      }),
      expect.objectContaining({ title: 'Catalogs disagree on the codec of this track' }),
    ])
  })
})

describe('levelsLabel', () => {
  it('sums up the shown levels as the Console does', () => {
    expect(levelsLabel(new Set())).toBe('All levels')
    expect(levelsLabel(new Set(['warning', 'info']))).toBe('Errors only')
    expect(levelsLabel(new Set(['error']))).toBe('Custom levels')
    expect(levelsLabel(new Set(['error', 'warning', 'info']))).toBe('Hide all')
  })
})
