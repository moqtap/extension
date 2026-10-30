/**
 * A session's problems as one list: the control messages', the catalogs',
 * and those of its LOC, CMAF and timeline tracks.
 *
 * Severity comes from the rule's keyword where the draft gives one:
 * - `error`: MUST, MUST NOT, a Required field or the type the draft gives a
 *   value; control message problems as `@moqtap/inspect` rates them
 * - `warning`: SHOULD, SHOULD NOT, or data that contradicts itself or its
 *   catalog where the draft gives no keyword
 * - `info`: the catalogs disagree on a track, a LOC track's profile is open,
 *   or a LOC group starts unlike the drafts' example
 *
 * One row per subject (the session, a catalog track or a media track), family
 * and severity; rows list their places once each.
 */

import {
  type CatalogProblem,
  catalogProblemExpected,
  catalogProblemFound,
  catalogProblemRemedy,
  catalogProblemTitle,
  type SpecRef as MediaSpecRef,
  severityOf,
  specLabel,
  specUrl,
} from '@moqtap/media/catalog'
import { specUrl as moqtSpecUrl } from '@moqtap/inspect'
import type { ComputedRef, InjectionKey } from 'vue'
import { formatOffset, messageTypeName } from './format'
import type { CatalogView, TrackKey, TrackPackaging } from './catalogs'
import { packagingConflicts, registryTrackKey, trackKey } from './catalogs'
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
  /** When it was seen */
  atMs?: number | null
  /** Its position among the things examined, counted from 0 */
  seq?: number
}

/** A rule's section, pinned to its draft revision. */
export interface PanelSpec {
  /** `CMSF-01 3.1` */
  label: string
  url: string
  /** The sentence that states the rule */
  quote: string | null
}

/** What a problem is about: where its fix goes. */
export interface ProblemSubject {
  kind: 'session' | 'catalog' | 'track'
  key: string
  /** `moqtail/ch07_all / catalog` */
  label: string
}

/** A track or entry a problem names, with where it sits in the JSON. */
export interface AffectedItem {
  name: string
  path: string | null
  /** The track it names, when it is one */
  key: TrackKey | null
  /** `subscribed`, `no CMAF header` */
  marks: string[]
}

export interface PanelProblem {
  source: ProblemSource
  severity: ProblemSeverity
  /** A stable check id, e.g. `catalog.init.other-draft-field`, `cmaf.no-moof-mdat` */
  id: string
  /** Problems of one family on one subject are one row */
  family: string
  subject: ProblemSubject
  title: string
  /** What the data holds, in one line */
  found: string | null
  /** What the rule asks for, in one line */
  expected: string | null
  /** What to change, in one imperative line */
  remedy: string | null
  spec: PanelSpec | null
  also: PanelSpec[]
  /** Who sent it, where the data names the sender: control messages only */
  sender: 'relay' | 'page' | null
  /** A catalog object it is in was not applied */
  notApplied: boolean
  items: AffectedItem[]
  /** Where it was seen, first seen first; empty when it is about a track as a whole */
  places: ProblemPlace[]
  /** The places' noun: `objects`, `messages`, `records` */
  unit: string
  /** How many things of `unit` were examined, when known */
  examined: number | null
  /** The data that shows it, as text */
  evidence: string | null
  /** A stream header that shows it, field by field */
  header: HeaderEvidence | null
  /** When it was first seen */
  atMs: number | null
}

/** One field of a stream header, as the session draft's framing reads it. */
export interface HeaderField {
  label: string
  value: string
  /** The field the problem is about */
  marked: boolean
}

export interface HeaderEvidence {
  fields: HeaderField[]
  /** The header's bytes as hex, when the panel has the bytes the stream carried */
  bytes: string | null
  /** The object it is the header of */
  target: ProblemTarget
}

/** The framing's field names in words. */
const HEADER_LABELS: Record<string, string> = {
  streamType: 'type',
  trackAlias: 'track alias',
  groupId: 'group',
  subgroupId: 'subgroup',
  publisherPriority: 'publisher priority',
  requestId: 'request',
}

/** A header's fields in the framing's order, `mark` among them. */
export function headerFields(fields: Record<string, number>, mark: string): HeaderField[] {
  return Object.entries(fields).map(([key, v]) => ({
    label: HEADER_LABELS[key] ?? key,
    value: key === 'streamType' ? `0x${v.toString(16)}` : String(v),
    marked: key === mark,
  }))
}

/** A header as text, for the clipboard: the bytes, then a field a line, the marked one flagged. */
export function headerText(h: HeaderEvidence): string {
  const lines = h.fields.map((f) => `${f.label} ${f.value}${f.marked ? '  <-' : ''}`)
  return (h.bytes ? [h.bytes, ...lines] : lines).join('\n')
}

/** Problems about a stream header field, by check id: the field the framing names. */
const HEADER_CHECKS: Record<string, string> = {
  'catalog.object.subgroup': 'subgroupId',
}

/** What a producer gives; the rest defaults. */
export type ProblemInit = Pick<PanelProblem, 'source' | 'severity' | 'title' | 'subject'> &
  Partial<PanelProblem>

export function makeProblem(p: ProblemInit): PanelProblem {
  const id = p.id ?? `${p.source}.${p.title}`
  return {
    id,
    family: p.family ?? id,
    found: null,
    expected: null,
    remedy: null,
    spec: null,
    also: [],
    sender: null,
    notApplied: false,
    items: [],
    places: [],
    unit: 'objects',
    examined: null,
    evidence: null,
    header: null,
    atMs: null,
    ...p,
  }
}

export const SEVERITIES: readonly ProblemSeverity[] = ['error', 'warning', 'info']

/** The levels menu's button, as the Console words its own: what the shown levels add up to. */
export function levelsLabel(hidden: ReadonlySet<ProblemSeverity>): string {
  const shown = SEVERITIES.filter((s) => !hidden.has(s))
  if (shown.length === SEVERITIES.length) return 'All levels'
  if (shown.length === 0) return 'Hide all'
  if (shown.length === 1) return `${SEVERITY_PLURALS[shown[0]!]} only`
  return 'Custom levels'
}

export const SEVERITY_PLURALS: Record<ProblemSeverity, string> = { error: 'Errors', warning: 'Warnings', info: 'Notes' }

export const SEVERITY_NAMES: Record<ProblemSeverity, string> = {
  error: 'Error',
  warning: 'Warning',
  info: 'Note',
}

const RANK: Record<ProblemSeverity, number> = { error: 0, warning: 1, info: 2 }

/** `group 3, object 0` */
export function objectLabel(groupId: number, objectId: number): string {
  return `group ${groupId}, object ${objectId}`
}

export const SESSION_SUBJECT: ProblemSubject = { kind: 'session', key: 'session', label: 'Session' }

export function trackSubject(track: Pick<TrackEntry, 'trackNamespace' | 'trackName' | 'fullName'>): ProblemSubject {
  return { kind: 'track', key: registryTrackKey(track), label: track.fullName }
}

// ─── Spec references ──────────────────────────────────────────────

export function mediaSpec(ref: MediaSpecRef): PanelSpec {
  return { label: specLabel(ref), url: specUrl(ref), quote: ref.quote || null }
}

/** A MoQT section, as `@moqtap/inspect` gives it. */
export function moqtSpec(ref: { revision: string; section: string; quote: string }): PanelSpec {
  return {
    label: `MoQT-${ref.revision} ${ref.section}`,
    url: moqtSpecUrl(ref),
    quote: ref.quote || null,
  }
}

const DRAFT_NAMES: Record<string, string> = {
  MSF: 'draft-ietf-moq-msf',
  CMSF: 'draft-ietf-moq-cmsf',
  LOC: 'draft-ietf-moq-loc',
  'mzanaty LOC': 'draft-mzanaty-moq-loc',
}

/**
 * Sections written as text (`CMSF-01 3.3`, `LOC-00 2.1.4, LOC-01 2.1.4`,
 * `mzanaty LOC-05 2.1.4`) as links, the first one first.
 */
export function specsFromSection(text: string | null): PanelSpec[] {
  if (!text) return []
  const out: PanelSpec[] = []
  for (const part of text.split(/[;,]\s*/)) {
    const m = /^(mzanaty LOC|CMSF|MSF|LOC)-(\d\d) ([\d.]+)$/.exec(part.trim())
    if (!m) continue
    const [, draft, revision, section] = m
    out.push({
      label: part.trim(),
      url: `https://datatracker.ietf.org/doc/html/${DRAFT_NAMES[draft!]}-${revision}#section-${section}`,
      quote: null,
    })
  }
  return out
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

/** The key two problems share when they are one row. */
export function rowKey(p: PanelProblem): string {
  return JSON.stringify([p.subject.key, p.source, p.family, p.severity, p.title])
}

/**
 * Problems that are one row merged, with the places and items of each; then
 * severity first, the time a problem was first seen next (a problem with no
 * time after those with one), and the order they came in last.
 */
export function consolidateProblems(lists: readonly (readonly PanelProblem[])[]): PanelProblem[] {
  const merged = new Map<string, PanelProblem>()
  const order: PanelProblem[] = []
  for (const list of lists) {
    for (const p of list) {
      const key = rowKey(p)
      const known = merged.get(key)
      if (!known) {
        const copy = { ...p, places: [...p.places], items: p.items.map((i) => ({ ...i })) }
        merged.set(key, copy)
        order.push(copy)
        continue
      }
      const seen = new Set(known.places.map((place) => targetKey(place.target)))
      for (const place of p.places) {
        if (!seen.has(targetKey(place.target))) known.places.push(place)
      }
      for (const item of p.items) {
        if (!known.items.some((i) => i.name === item.name && i.path === item.path)) {
          known.items.push({ ...item })
        }
      }
      known.notApplied ||= p.notApplied
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

/** How many rows there are of each severity. */
export function severityCounts(problems: readonly { severity: ProblemSeverity }[]): Record<ProblemSeverity, number> {
  const counts = { error: 0, warning: 0, info: 0 }
  for (const p of problems) counts[p.severity]++
  return counts
}

/** A session's rows, for views that show some of them (the Catalog view's Problems). */
export interface SessionProblemsContext {
  problems: ComputedRef<PanelProblem[]>
  startedAt: () => number
  session: ComputedRef<string>
  stateKey: () => string
  open: (target: ProblemTarget) => void
}

export const SESSION_PROBLEMS: InjectionKey<SessionProblemsContext> = Symbol('session problems')

// ─── Groups ───────────────────────────────────────────────────────

/** One subject's rows. */
export interface ProblemGroup {
  subject: ProblemSubject
  problems: PanelProblem[]
}

/**
 * Rows by subject: the session first, then catalogs, then media tracks in
 * `trackOrder` (the rest as they come). Rows keep the order given.
 */
export function groupBySubject(
  problems: readonly PanelProblem[],
  trackOrder: readonly string[] = [],
): ProblemGroup[] {
  const groups = new Map<string, ProblemGroup>()
  for (const p of problems) {
    let g = groups.get(p.subject.key)
    if (!g) {
      g = { subject: p.subject, problems: [] }
      groups.set(p.subject.key, g)
    }
    g.problems.push(p)
  }
  const kindRank = { session: 0, catalog: 1, track: 2 }
  const position = new Map(trackOrder.map((k, i) => [k, i]))
  return [...groups.values()]
    .map((g, i) => ({ g, i }))
    .sort(
      (a, b) =>
        kindRank[a.g.subject.kind] - kindRank[b.g.subject.kind] ||
        (position.get(a.g.subject.key) ?? Number.POSITIVE_INFINITY) -
          (position.get(b.g.subject.key) ?? Number.POSITIVE_INFINITY) ||
        a.i - b.i,
    )
    .map(({ g }) => g)
}

// ─── Sources ──────────────────────────────────────────────────────

/** The control messages' problems, each linked to the message it is about. */
export function protocolProblems(
  problems: readonly SessionProblem[],
  /** The panel's own wording for a problem, where it has one */
  reword: (p: SessionProblem) => Partial<PanelProblem> | null = () => null,
): PanelProblem[] {
  return problems.map((p) =>
    makeProblem({
      source: 'protocol',
      id: p.id,
      family: p.id,
      severity: p.severity,
      subject: SESSION_SUBJECT,
      title: p.title,
      found: p.detail,
      spec: p.spec ? moqtSpec(p.spec) : null,
      sender:
        p.message.direction === 'tx' ? 'page' : p.message.direction === 'rx' ? 'relay' : null,
      unit: 'messages',
      places: [
        {
          label: messageTypeName(p.message.messageType),
          note: null,
          target: { kind: 'message', message: p.message },
          atMs: p.atMs,
        },
      ],
      atMs: p.atMs,
      ...reword(p),
    }),
  )
}

function hexBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ')
}

/** Long strings in evidence shortened: `"AAADIm1v…" (1,072 characters)`. */
const LONG_STRING = 48

function shortenStrings(value: unknown): unknown {
  if (typeof value === 'string' && value.length > LONG_STRING) {
    return `${value.slice(0, 12)}… (${value.length.toLocaleString('en-US')} characters)`
  }
  if (Array.isArray(value)) return value.map(shortenStrings)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shortenStrings(v)]))
  }
  return value
}

/** The part of a catalog object a problem is about, pretty-printed. */
function catalogEvidence(document: Record<string, unknown> | null, p: CatalogProblem): string | null {
  if (!document) return null
  let part: unknown
  const s = p.subject
  if (s.kind === 'track') part = (document.tracks as unknown[] | undefined)?.[s.index]
  else if (s.kind === 'entry') part = (document[s.list] as unknown[] | undefined)?.[s.index]
  else if (s.kind === 'root' && p.field) part = { [p.field]: document[p.field] ?? null }
  if (part === undefined) return null
  return JSON.stringify(shortenStrings(part), null, 2)
}

function catalogItem(view: CatalogView, document: Record<string, unknown> | null, p: CatalogProblem): AffectedItem | null {
  const s = p.subject
  if (s.kind === 'track') {
    const raw = (document?.tracks as Record<string, unknown>[] | undefined)?.[s.index]
    const ns = typeof raw?.namespace === 'string' ? raw.namespace : view.namespace
    const name = s.name ?? `tracks[${s.index}]`
    return { name, path: `tracks[${s.index}]`, key: s.name === null ? null : trackKey(ns, s.name), marks: [] }
  }
  if (s.kind === 'delta') {
    const path = p.path.replace(/\.[^.[\]]+$/, '')
    return { name: s.name ?? path, path, key: s.name === null ? null : trackKey(view.namespace, s.name), marks: [] }
  }
  if (s.kind === 'entry') return { name: `${s.list}[${s.index}]`, path: null, key: null, marks: [] }
  return null
}

/**
 * The rules catalog objects break: one row for each catalog, family and
 * severity, naming the tracks, linked to every object that breaks it.
 * `streamTime` gives when a stream's first bytes came.
 */
export function catalogProblems(
  views: readonly CatalogView[],
  streamTime: (streamId: number) => number | null,
  /** Whether a stream holds the header bytes it carried */
  headerBytes: (streamId: number) => boolean = () => false,
): PanelProblem[] {
  const out: PanelProblem[] = []
  for (const view of views) {
    const subject: ProblemSubject = {
      kind: 'catalog',
      key: view.key,
      label: view.namespace ? `${view.namespace} / ${view.name}` : view.name,
    }
    const rows = new Map<
      string,
      { all: CatalogProblem[]; seen: Set<string>; problem: PanelProblem; evidence: boolean }
    >()
    view.objects.forEach((obj, seq) => {
      const at = streamTime(obj.streamId)
      for (const p of obj.problems) {
        // The draft badge says which drafts the catalog may be.
        if (p.category === 'ambiguous_draft') continue
        const severity = severityOf(p)
        const key = JSON.stringify([p.family, severity])
        let row = rows.get(key)
        if (!row) {
          row = {
            all: [],
            seen: new Set(),
            evidence: false,
            problem: makeProblem({
              source: 'catalog',
              id: p.id,
              family: p.family,
              severity,
              subject,
              title: '',
              spec: mediaSpec(p.spec),
              also: p.also.map(mediaSpec),
              examined: view.objects.length,
              unit: 'catalog objects',
            }),
          }
          rows.set(key, row)
          out.push(row.problem)
        }
        const problem = row.problem
        const id = JSON.stringify([p.id, p.path])
        if (!row.seen.has(id)) {
          row.seen.add(id)
          row.all.push(p)
          const item = catalogItem(view, obj.document, p)
          if (item && !problem.items.some((i) => i.name === item.name && i.path === item.path)) {
            problem.items.push(item)
          }
        }
        const mark = HEADER_CHECKS[p.id]
        const header = mark ? view.headers.get(obj.streamId) : undefined
        if (!row.evidence && header) {
          problem.header = {
            fields: headerFields(header.fields, mark!),
            bytes: headerBytes(obj.streamId) ? hexBytes(header.bytes) : null,
            target: { kind: 'catalog-object', streamId: obj.streamId, groupId: obj.groupId, objectId: obj.objectId },
          }
          problem.evidence = headerText(problem.header)
          row.evidence = true
        } else if (!row.evidence && !mark) {
          const evidence = catalogEvidence(obj.document, p)
          if (evidence) {
            problem.evidence = evidence
            row.evidence = true
          }
        }
        const last = problem.places[problem.places.length - 1]
        if (last?.seq !== seq) {
          problem.places.push({
            label: objectLabel(obj.groupId, obj.objectId),
            note: null,
            target: {
              kind: 'catalog-object',
              streamId: obj.streamId,
              groupId: obj.groupId,
              objectId: obj.objectId,
            },
            atMs: at,
            seq,
          })
        }
        if (obj.outcome === 'refused') problem.notApplied = true
        if (at !== null && (problem.atMs === null || at < problem.atMs)) problem.atMs = at
      }
    })
    for (const { all, problem } of rows.values()) {
      problem.title = catalogProblemTitle(all)
      problem.remedy = catalogProblemRemedy(all) || null
      problem.found = catalogProblemFound(all) || null
      problem.expected = catalogProblemExpected(all) || null
    }
  }
  return out
}

const INIT_FAMILIES = new Set(['catalog.init.other-draft-field', 'catalog.init.missing'])

/**
 * One fact, one row: a CMAF track with no header, when a catalog row already
 * says why, is marked on that row's track list instead of being its own row.
 */
export function joinInitProblems(problems: readonly PanelProblem[]): PanelProblem[] {
  const covers = problems.filter((p) => p.source === 'catalog' && INIT_FAMILIES.has(p.family))
  const out: PanelProblem[] = []
  for (const p of problems) {
    if (p.id !== 'cmaf.init.none') {
      out.push(p)
      continue
    }
    let joined = false
    for (const row of covers) {
      for (const item of row.items) {
        if (item.key !== p.subject.key) continue
        joined = true
        for (const mark of ['subscribed', 'no CMAF header']) {
          if (!item.marks.includes(mark)) item.marks.push(mark)
        }
      }
    }
    if (!joined) out.push(p)
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
      out.push(
        makeProblem({
          source: 'catalog',
          id: `catalog.conflict.${c.field}`,
          severity: 'info',
          subject: trackSubject(track),
          title: `Catalogs disagree on the ${c.field} of this track`,
          found: c.values.map((v) => `${v.catalogName}: ${v.value ?? 'none'}`).join(' · '),
          expected: `One ${c.field} in every catalog that describes the track`,
          remedy: `Give the track the same ${c.field} in every catalog`,
        }),
      )
    }
  }
  return out
}

// ─── Words ────────────────────────────────────────────────────────

function counted(n: number, unit: string): string {
  // `catalog objects` → `catalog object`
  return n === 1 ? unit.replace(/s$/, '') : unit
}

/** `257 of 257 objects`, `257/257 objects` when narrow; empty for a track-level problem. */
export function countText(p: PanelProblem, narrow = false): string {
  const n = p.places.length
  if (n === 0) return ''
  const unit = counted(p.examined ?? n, p.unit.replace(/^catalog /, ''))
  if (p.examined === null) return `${n.toLocaleString('en-US')} ${unit}`
  const a = n.toLocaleString('en-US')
  const b = p.examined.toLocaleString('en-US')
  return narrow ? `${a}/${b} ${unit}` : `${a} of ${b} ${unit}`
}

/** `In 257 of 257 catalog objects` */
export function seenText(p: PanelProblem): string {
  const n = p.places.length
  if (n === 0) return ''
  if (p.examined === null) return `In ${n.toLocaleString('en-US')} ${counted(n, p.unit)}`
  return `In ${n.toLocaleString('en-US')} of ${p.examined.toLocaleString('en-US')} ${counted(p.examined, p.unit)}`
}

/** `group 15912, object 0 at +00:00.649` */
export function placeText(place: ProblemPlace, startedAt: number): string {
  return place.atMs == null ? place.label : `${place.label} at ${formatOffset(place.atMs, startedAt)}`
}

/** After the last place: `(the latest object)`, or how many examined since show none. */
export function sinceText(p: PanelProblem): string {
  const last = p.places[p.places.length - 1]
  if (!last || last.seq === undefined || p.examined === null) return ''
  const since = p.examined - 1 - last.seq
  if (since <= 0) return `(the latest ${counted(1, p.unit)})`
  return `; not in the ${since.toLocaleString('en-US')} ${counted(since, p.unit)} since`
}

/** What following a place's link does: `Show in Streams`, `Show in Messages`. */
export function showText(target: ProblemTarget): string {
  return target.kind === 'message' ? 'Show in Messages' : 'Show in Streams'
}

export const SENDER_TEXT = { relay: 'Sent by the relay', page: 'Sent by this page' } as const

function itemText(item: AffectedItem): string {
  return item.marks.length > 0 ? `${item.name} (${item.marks.join(', ')})` : item.name
}

/** One row as plain text, for the clipboard. */
export function problemText(p: PanelProblem, ctx: { startedAt: number; session: string }): string {
  const lines = [`[${p.severity === 'info' ? 'note' : p.severity}] ${p.title}`]
  if (p.subject.kind !== 'session') {
    lines.push(`${p.subject.kind === 'catalog' ? 'Catalog' : 'Track'}: ${p.subject.label}`)
  }
  lines.push(`Session: ${ctx.session}`)
  if (p.sender) lines.push(SENDER_TEXT[p.sender])
  const first = p.places[0]
  const last = p.places[p.places.length - 1]
  if (first && last) {
    const range =
      first === last
        ? placeText(first, ctx.startedAt)
        : `${placeText(first, ctx.startedAt)} to ${placeText(last, ctx.startedAt)}`
    lines.push(`Seen: ${seenText(p).replace(/^In /, '')}, ${range}`)
  }
  if (p.items.length > 0) lines.push(`Affected: ${p.items.map(itemText).join(', ')}`)
  if (p.found) lines.push(`Found: ${p.found}`)
  if (p.expected) lines.push(`Expected: ${p.expected}`)
  if (p.remedy) lines.push(`Fix: ${p.remedy}`)
  if (p.notApplied) lines.push('Not applied: a reader keeps the previous catalog.')
  if (p.evidence) lines.push('Evidence:', p.evidence)
  if (p.spec) {
    lines.push(`Spec: ${p.spec.label}${p.spec.quote ? ` "${p.spec.quote}"` : ''}`)
    lines.push(p.spec.url)
  }
  return lines.join('\n')
}

/** One row as data, for the clipboard. */
export function problemJson(p: PanelProblem, ctx: { startedAt: number }) {
  const place = (x: ProblemPlace | undefined) =>
    x ? { label: x.label, atMs: x.atMs == null ? null : x.atMs - ctx.startedAt } : null
  return {
    id: p.id,
    family: p.family,
    severity: p.severity,
    title: p.title,
    remedy: p.remedy,
    found: p.found,
    expected: p.expected,
    spec: p.spec,
    also: p.also,
    subject: { kind: p.subject.kind, name: p.subject.label },
    sender: p.sender,
    items: p.items.map(({ name, path, marks }) => ({ name, path, marks })),
    seen: {
      count: p.places.length,
      of: p.examined,
      unit: p.unit,
      first: place(p.places[0]),
      last: place(p.places[p.places.length - 1]),
    },
    evidence: p.evidence,
  }
}

/** What a row's Copy puts on the clipboard, for its tooltip: the parts this row has. */
export function copyIncludes(p: PanelProblem, as: 'text' | 'json'): string {
  const parts = ['title']
  if (as === 'text') parts.push('session')
  if (p.found) parts.push('Found')
  if (p.expected) parts.push('Expected')
  if (p.remedy) parts.push('Fix')
  if (p.items.length > 0 || p.subject.kind !== 'session') parts.push('Affected')
  if (p.places.length > 0) parts.push('Seen')
  if (p.evidence) parts.push('Evidence')
  if (p.spec) parts.push('the spec link')
  const list = `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `Copies the ${list} as ${as === 'text' ? 'plain text' : 'JSON'}`
}
