/**
 * A session's problems as one list: the control messages', the catalogs',
 * and those of its LOC, CMAF and timeline tracks.
 *
 * - `error`: the data breaks a MUST, MUST NOT, a Required field or the type
 *   the draft gives a value
 * - `warning`: the data breaks a SHOULD, or contradicts itself or its catalog
 *   where the draft gives no keyword
 * - `info`: the catalogs disagree on a track, a LOC track's profile is open,
 *   or a LOC group starts unlike the drafts' example
 *
 * Control message problems keep the severity `@moqtap/inspect` gives them.
 */

import { messageTypeName } from './format'
import type { CatalogView, TrackKey, TrackPackaging } from './catalogs'
import { packagingConflicts, registryTrackKey } from './catalogs'
import type { LocSource } from './loc'
import type { SessionProblem } from './requests'
import type { MessageEntry, TrackEntry } from './use-inspector'

export type ProblemSeverity = 'error' | 'warning' | 'info'

export type ProblemSource = 'protocol' | 'catalog' | 'loc' | 'cmaf' | 'timeline'

/** What a problem's link opens. */
export type ProblemTarget =
  /** An object of a stream or datagram group, by its byte offset there */
  | { kind: 'object'; source: LocSource; offset: number }
  /** A catalog object, by the stream it was first read from */
  | { kind: 'catalog-object'; streamId: number; groupId: number; objectId: number }
  | { kind: 'message'; message: MessageEntry }

/** One place a problem was seen. */
export interface ProblemPlace {
  /** What the link says: `group 3, object 0`, or a message's name */
  label: string
  /** What the problem says about this place, when that differs between places */
  note: string | null
  target: ProblemTarget
}

export interface PanelProblem {
  source: ProblemSource
  severity: ProblemSeverity
  title: string
  detail: string | null
  /** The draft and section that state the rule */
  section: string | null
  /** Where it was seen, first seen first; empty when it is about a track as a whole */
  places: ProblemPlace[]
  /** When it was first seen */
  atMs: number | null
}

export const SEVERITIES: readonly ProblemSeverity[] = ['error', 'warning', 'info']

const RANK: Record<ProblemSeverity, number> = { error: 0, warning: 1, info: 2 }

/** `group 3, object 0` */
export function objectLabel(groupId: number, objectId: number): string {
  return `group ${groupId}, object ${objectId}`
}

function targetKey(t: ProblemTarget): unknown {
  switch (t.kind) {
    case 'object':
      return `o|${t.source}|${t.offset}`
    case 'catalog-object':
      return `c|${t.streamId}|${t.groupId}|${t.objectId}`
    case 'message':
      return t.message
  }
}

/**
 * Severity first, then the time a problem was first seen; a problem with no
 * time after those with one. Problems that say the same thing are one, with
 * the places of each.
 */
export function consolidateProblems(lists: readonly (readonly PanelProblem[])[]): PanelProblem[] {
  const merged = new Map<string, PanelProblem>()
  const order: PanelProblem[] = []
  for (const list of lists) {
    for (const p of list) {
      const key = JSON.stringify([p.source, p.severity, p.title, p.detail, p.section])
      const known = merged.get(key)
      if (!known) {
        const copy = { ...p, places: [...p.places] }
        merged.set(key, copy)
        order.push(copy)
        continue
      }
      const seen = new Set(known.places.map((place) => targetKey(place.target)))
      for (const place of p.places) {
        if (!seen.has(targetKey(place.target))) known.places.push(place)
      }
      if (p.atMs !== null && (known.atMs === null || p.atMs < known.atMs)) known.atMs = p.atMs
    }
  }
  return order
    .map((p, i) => ({ p, i }))
    .sort(
      (a, b) =>
        RANK[a.p.severity] - RANK[b.p.severity] ||
        (a.p.atMs ?? Number.POSITIVE_INFINITY) - (b.p.atMs ?? Number.POSITIVE_INFINITY) ||
        a.i - b.i,
    )
    .map(({ p }) => p)
}

/** How many problems there are of each severity. */
export function severityCounts(problems: readonly { severity: ProblemSeverity }[]): Record<ProblemSeverity, number> {
  const counts = { error: 0, warning: 0, info: 0 }
  for (const p of problems) counts[p.severity]++
  return counts
}

// ─── Sources ──────────────────────────────────────────────────────

/** The control messages' problems, each linked to the message it is about. */
export function protocolProblems(problems: readonly SessionProblem[]): PanelProblem[] {
  return problems.map((p) => ({
    source: 'protocol',
    severity: p.severity,
    title: p.title,
    detail: p.detail,
    section: null,
    places: [
      {
        label: messageTypeName(p.message.messageType),
        note: null,
        target: { kind: 'message', message: p.message },
      },
    ],
    atMs: p.atMs,
  }))
}

/**
 * The rules catalog objects break, one problem for each rule a catalog
 * breaks, linked to every object that breaks it. `streamTime` gives when a
 * stream's first bytes came.
 */
export function catalogProblems(
  views: readonly CatalogView[],
  streamTime: (streamId: number) => number | null,
): PanelProblem[] {
  const out: PanelProblem[] = []
  for (const view of views) {
    const name = `${view.namespace} / ${view.name}`
    const byRule = new Map<string, PanelProblem>()
    for (const obj of view.objects) {
      for (const p of obj.problems) {
        const key = JSON.stringify([p.severity, p.section, p.path, p.message])
        let problem = byRule.get(key)
        if (!problem) {
          problem = {
            source: 'catalog',
            severity: p.severity,
            title: p.message,
            detail: p.path ? `${name} · ${p.path}` : name,
            section: p.section,
            places: [],
            atMs: null,
          }
          byRule.set(key, problem)
          out.push(problem)
        }
        problem.places.push({
          label: objectLabel(obj.groupId, obj.objectId),
          note: null,
          target: {
            kind: 'catalog-object',
            streamId: obj.streamId,
            groupId: obj.groupId,
            objectId: obj.objectId,
          },
        })
        const at = streamTime(obj.streamId)
        if (at !== null && (problem.atMs === null || at < problem.atMs)) problem.atMs = at
      }
    }
  }
  return out
}

/** Where the catalogs describing a session's tracks disagree, once for each track and field. */
export function catalogConflictProblems(
  tracks: Iterable<TrackEntry>,
  packaging: ReadonlyMap<TrackKey, TrackPackaging>,
): PanelProblem[] {
  const out: PanelProblem[] = []
  const seen = new Set<TrackKey>()
  for (const track of tracks) {
    const key = registryTrackKey(track)
    if (seen.has(key)) continue
    seen.add(key)
    const described = packaging.get(key)
    if (!described) continue
    for (const c of packagingConflicts(described)) {
      out.push({
        source: 'catalog',
        severity: 'info',
        title: `Catalogs disagree on the ${c.field} of ${track.fullName}`,
        detail: `${c.values.map((v) => `${v.catalogName}: ${v.value ?? 'none'}`).join('; ')}.`,
        section: null,
        places: [],
        atMs: null,
      })
    }
  }
  return out
}

// ─── Kinds ────────────────────────────────────────────────────────

/** Problems that say the same thing, as one row with a count. */
export interface ProblemKind {
  key: string
  severity: ProblemSeverity
  title: string
  /** In the order given: most severe and first seen first */
  problems: PanelProblem[]
  /** How many places it was seen; a problem with none counts once */
  count: number
  atMs: number | null
}

/** One kind for each source, severity and title, in the order the problems come. */
export function groupProblems(problems: readonly PanelProblem[]): ProblemKind[] {
  const kinds = new Map<string, ProblemKind>()
  for (const p of problems) {
    const key = JSON.stringify([p.source, p.severity, p.title])
    let kind = kinds.get(key)
    if (!kind) {
      kind = { key, severity: p.severity, title: p.title, problems: [], count: 0, atMs: null }
      kinds.set(key, kind)
    }
    kind.problems.push(p)
    kind.count += Math.max(1, p.places.length)
    if (p.atMs !== null && (kind.atMs === null || p.atMs < kind.atMs)) kind.atMs = p.atMs
  }
  return [...kinds.values()]
}
