/**
 * The Details tab's one Problems list: how each source's problems join it,
 * and how the list is ordered, merged and counted.
 */

import { describe, expect, it } from 'vitest'
import {
  type CatalogObjectRecord,
  type CatalogView,
  registryTrackKey,
  type TrackKey,
  type TrackPackaging,
} from './catalogs'
import {
  catalogConflictProblems,
  catalogProblems,
  consolidateProblems,
  groupProblems,
  type PanelProblem,
  protocolProblems,
  severityCounts,
} from './problems'
import type { MessageEntry, TrackEntry } from './use-inspector'

function problem(p: Partial<PanelProblem> & Pick<PanelProblem, 'title'>): PanelProblem {
  return {
    source: 'cmaf',
    severity: 'error',
    detail: null,
    section: null,
    places: [],
    atMs: null,
    ...p,
  }
}

function at(source: string, offset: number): PanelProblem['places'][number] {
  return { label: `object at ${offset}`, note: null, target: { kind: 'object', source, offset } }
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

  it('merges problems that say the same thing, keeping every place once', () => {
    const list = consolidateProblems([
      [problem({ title: 'same', places: [at('s:1', 0)], atMs: 20 })],
      [problem({ title: 'same', places: [at('s:1', 0), at('s:2', 8)], atMs: 5 })],
      [problem({ title: 'same', source: 'loc' })],
    ])
    expect(list).toHaveLength(2)
    expect(list[0]!.places.map((p) => p.target)).toEqual([
      { kind: 'object', source: 's:1', offset: 0 },
      { kind: 'object', source: 's:2', offset: 8 },
    ])
    expect(list[0]!.atMs).toBe(5)
  })

  it('counts each severity', () => {
    expect(
      severityCounts([
        problem({ title: 'a' }),
        problem({ title: 'b', severity: 'info' }),
        problem({ title: 'c' }),
      ]),
    ).toEqual({ error: 2, warning: 0, info: 1 })
  })
})

describe('control message problems', () => {
  it('keep their wording and severity, and link the message', () => {
    const message: MessageEntry = {
      timestamp: 12,
      direction: 'rx',
      messageType: 'request_error',
      decoded: null,
      decodedPretty: null,
      raw: new Uint8Array(),
    }
    expect(
      protocolProblems([
        { title: 'REQUEST_ERROR', detail: 'SUBSCRIBE #4', severity: 'error', atMs: 12, message },
      ]),
    ).toEqual([
      {
        source: 'protocol',
        severity: 'error',
        title: 'REQUEST_ERROR',
        detail: 'SUBSCRIBE #4',
        section: null,
        places: [{ label: 'REQUEST_ERROR', note: null, target: { kind: 'message', message } }],
        atMs: 12,
      },
    ])
  })
})

describe('catalog problems', () => {
  function object(
    groupId: number,
    objectId: number,
    streamId: number,
    problems: CatalogObjectRecord['problems'],
  ): CatalogObjectRecord {
    return {
      groupId,
      subgroupId: 0,
      objectId,
      streamId,
      size: 10,
      kind: 'independent',
      draft: 'msf-01',
      outcome: 'applied',
      problems,
    }
  }

  const MISSING = {
    severity: 'error',
    category: 'missing_field',
    path: 'tracks[0].isLive',
    section: 'MSF-01 5.2.7',
    message: 'isLive is Required: Yes',
  } as const

  it('are one for each rule a catalog breaks, linked to every object that breaks it', () => {
    const view = {
      namespace: 'live',
      name: 'catalog',
      objects: [object(0, 0, 3, [MISSING]), object(1, 0, 7, [MISSING])],
    } as unknown as CatalogView
    const times = new Map([
      [3, 400],
      [7, 900],
    ])
    expect(catalogProblems([view], (id) => times.get(id) ?? null)).toEqual([
      {
        source: 'catalog',
        severity: 'error',
        title: 'isLive is Required: Yes',
        detail: 'live / catalog · tracks[0].isLive',
        section: 'MSF-01 5.2.7',
        places: [
          {
            label: 'group 0, object 0',
            note: null,
            target: { kind: 'catalog-object', streamId: 3, groupId: 0, objectId: 0 },
          },
          {
            label: 'group 1, object 0',
            note: null,
            target: { kind: 'catalog-object', streamId: 7, groupId: 1, objectId: 0 },
          },
        ],
        atMs: 400,
      },
    ])
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
        title: 'Catalogs disagree on the packaging of live / times',
        detail: 'live / a: mediatimeline; live / b: eventtimeline.',
      }),
      expect.objectContaining({ title: 'Catalogs disagree on the codec of live / times' }),
    ])
  })
})

describe('kinds', () => {
  it('makes one row per source, severity and title, counting every place', () => {
    const kinds = groupProblems([
      problem({ title: 'bad box', detail: 'track a', places: [at('s:1', 0), at('s:1', 9)], atMs: 20 }),
      problem({ title: 'bad box', detail: 'track b', places: [at('s:5', 0)], atMs: 5 }),
      problem({ title: 'bad box', severity: 'warning' }),
      problem({ title: 'no places' }),
    ])
    expect(kinds.map((k) => [k.title, k.severity, k.problems.length, k.count, k.atMs])).toEqual([
      ['bad box', 'error', 2, 3, 5],
      ['bad box', 'warning', 1, 1, null],
      ['no places', 'error', 1, 1, null],
    ])
  })

  it('keeps the order the problems come in', () => {
    const kinds = groupProblems([problem({ title: 'b' }), problem({ title: 'a' }), problem({ title: 'b' })])
    expect(kinds.map((k) => k.title)).toEqual(['b', 'a'])
  })

  it('counts kinds by severity for the tab and the toolbar', () => {
    const kinds = groupProblems([
      problem({ title: 'x' }),
      problem({ title: 'x', detail: 'other' }),
      problem({ title: 'y', severity: 'warning' }),
    ])
    expect(severityCounts(kinds)).toEqual({ error: 1, warning: 1, info: 0 })
  })
})
