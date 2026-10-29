/**
 * MSF media and event timeline tracks, and the CMSF SAP type timeline, read
 * in the panel. A track is a timeline when the session's catalogs agree on
 * packaging "mediatimeline" (msf 7) or "eventtimeline" (msf 8); an event
 * timeline is a SAP type timeline when they also agree on
 * eventType "org.ietf.moq.cmsf.sap" (cmsf 3.6.1). A media timeline template
 * is read from the catalog entry of a track of any packaging (msf-01 5.2.15).
 */

import type { CatalogDraft } from '@moqtap/media/catalog'
import type { CmsfDraft } from '@moqtap/media/cmaf'
import type { LocProfile } from '@moqtap/media/loc'
import {
  type EventRecord,
  type MediaTimelineRecord,
  type ParsedMediaTimelineTemplate,
  parseEventTimeline,
  parseMediaTimeline,
  parseMediaTimelineTemplate,
  readSapTimeline,
  SAP_TIMELINE_EVENT_TYPE,
  type SapTimelineEntry,
  type TimelineDraft,
  type TimelineProblem,
} from '@moqtap/media/timeline'
import {
  agreedValue,
  catalogDrafts,
  namespaceText,
  registryTrackKey,
  type TrackKey,
  type TrackPackaging,
} from './catalogs'
import { timelinePackaging } from './packaging'
import type { PanelProblem } from './problems'
import type { TrackEntry } from './use-inspector'

export { SAP_TIMELINE_EVENT_TYPE }

export type TimelineKind = 'media' | 'event' | 'sap'

/** The CMSF draft of the catalogs describing a track, when they are all one. */
export function cmsfDraftOf(described: TrackPackaging | undefined): CmsfDraft | null {
  const drafts = [...catalogDrafts(described)]
  if (drafts.length !== 1) return null
  const d = drafts[0]
  return d === 'cmsf-00' || d === 'cmsf-01' ? d : null
}

/**
 * The timeline rules each catalog draft builds on. cmsf-00's [MSF],
 * draft-ietf-moq-warp-01, defines no event timeline, so a SAP timeline under
 * it cites cmsf-00 3.6.1 only.
 */
const TIMELINE_BASIS: Record<CatalogDraft, { draft: TimelineDraft | null; section: string }> = {
  'msf-00': { draft: 'msf-00', section: 'MSF-00 8.1' },
  'msf-01': { draft: 'msf-01', section: 'MSF-01 8.1' },
  'cmsf-00': { draft: null, section: 'CMSF-00 3.6.1' },
  'cmsf-01': { draft: 'msf-01', section: 'MSF-01 8.1' },
}

/** The MSF draft whose timeline rules the catalogs follow, when one. */
function timelineDraftOf(described: TrackPackaging | undefined): TimelineDraft | null {
  const bases = new Set([...catalogDrafts(described)].map((d) => TIMELINE_BASIS[d].draft))
  return bases.size === 1 ? [...bases][0]! : null
}

/** Where the event timeline rules the catalogs follow are. */
function timelineSectionOf(described: TrackPackaging | undefined): string {
  const sections = new Set([...catalogDrafts(described)].map((d) => TIMELINE_BASIS[d].section))
  return sections.size > 0 ? [...sections].join('; ') : 'MSF-00 8.1, MSF-01 8.1'
}

/** Only msf-01 5.2.15 defines `template`, and cmsf-01 builds on msf-01. */
const TEMPLATE_DRAFTS = new Set<CatalogDraft>(['msf-01', 'cmsf-01'])

/** The media timeline template the catalogs agree on for a track of any packaging, read; null when none. */
export function templateOf(
  described: TrackPackaging | undefined,
): ParsedMediaTimelineTemplate | null {
  const drafts = catalogDrafts(described)
  if (drafts.size === 0 || ![...drafts].every((d) => TEMPLATE_DRAFTS.has(d))) return null
  const text = agreedValue(described, (t) =>
    t.raw.template === undefined ? null : JSON.stringify(t.raw.template),
  )
  if (typeof text !== 'string') return null
  return parseMediaTimelineTemplate(JSON.parse(text))
}

export interface TimelineState {
  key: TrackKey
  kind: TimelineKind
  /** The CMSF draft of its catalogs, for a SAP timeline */
  draft: CmsfDraft | null
  timelineDraft: TimelineDraft | null
  /** Where the event timeline rules its catalogs follow are */
  timelineSection: string
  /** The timeline's namespace, which its dependencies share (msf 5.1.21, 5.2.14) */
  namespace: string
  /** The tracks it describes (msf 7.2, 8.2) */
  depends: string[]
  /** The eventType the catalogs agree on */
  eventType: string | null
  /** Objects read so far */
  objectCount: number
}

/** A track's timeline state, without its object count; null for a track that is not a timeline. */
export function timelineStateOf(
  track: TrackEntry,
  key: TrackKey,
  described: TrackPackaging | undefined,
  pin: LocProfile | undefined,
): Omit<TimelineState, 'objectCount'> | null {
  const packaging = timelinePackaging(described, pin)
  if (!packaging) return null
  const eventType = agreedValue(described, (t) => t.eventType) ?? null
  const kind: TimelineKind =
    packaging === 'mediatimeline'
      ? 'media'
      : eventType === SAP_TIMELINE_EVENT_TYPE
        ? 'sap'
        : 'event'
  const depends = new Set(described?.claims.map((c) => c.track.depends.join('\u0000')))
  return {
    key,
    kind,
    draft: kind === 'sap' ? cmsfDraftOf(described) : null,
    timelineDraft: timelineDraftOf(described),
    timelineSection: timelineSectionOf(described),
    namespace: namespaceText(track.trackNamespace),
    // Catalogs that disagree on depends leave the described track open.
    depends: depends.size === 1 ? (described?.track.depends ?? []) : [],
    eventType,
  }
}

export function timelineSignature(state: TimelineState): string {
  return `timeline|${state.kind}|${state.draft ?? ''}|${state.timelineDraft ?? ''}|${state.timelineSection}`
}

export type { TimelineProblem }

/** One timeline object, read. */
export type TimelineObjectView =
  | { kind: 'invalid'; problems: TimelineProblem[] }
  | { kind: 'media'; records: MediaTimelineRecord[]; problems: TimelineProblem[] }
  | { kind: 'event'; records: EventRecord[]; problems: TimelineProblem[] }
  | {
      kind: 'sap'
      records: EventRecord[]
      entries: SapTimelineEntry[]
      problems: TimelineProblem[]
    }

/** Read one timeline object's payload as its track's kind of timeline. */
export function readTimelineObject(payload: Uint8Array, state: TimelineState): TimelineObjectView {
  const options = state.timelineDraft ? { draft: state.timelineDraft } : {}
  if (state.kind === 'media') {
    const parsed = parseMediaTimeline(payload, options)
    return parsed.kind === 'records'
      ? { kind: 'media', records: parsed.records, problems: parsed.problems }
      : { kind: 'invalid', problems: parsed.problems }
  }
  const parsed = parseEventTimeline(payload, options)
  if (state.kind === 'event') {
    return parsed.kind === 'records'
      ? { kind: 'event', records: parsed.records, problems: parsed.problems }
      : { kind: 'invalid', problems: parsed.problems }
  }
  // Without one MSF draft, cite the rules the catalogs' drafts build on.
  const problems = state.timelineDraft
    ? parsed.problems
    : parsed.problems.map((p) => ({ ...p, section: state.timelineSection }))
  if (parsed.kind !== 'records') return { kind: 'invalid', problems }
  const sap = readSapTimeline(parsed.records, state.draft ? { draft: state.draft } : {})
  return {
    kind: 'sap',
    records: parsed.records,
    entries: sap.entries,
    problems: [...problems, ...sap.problems],
  }
}

/** A timeline kind as the panel names it. */
export const TIMELINE_LABELS: Record<TimelineKind, string> = {
  media: 'Media timeline',
  event: 'Event timeline',
  sap: 'SAP timeline',
}

/** How the Problems list titles a timeline problem, by its category. */
export function timelineProblemTitle(
  kind: TimelineKind,
  category: TimelineProblem['category'],
): string {
  const label = TIMELINE_LABELS[kind]
  switch (category) {
    case 'invalid_json':
      return `${label} objects that are not JSON`
    case 'missing_field':
      return kind === 'media'
        ? `${label} records with items missing`
        : `${label} records without data`
    case 'invalid_index':
      return kind === 'sap'
        ? `${label} records not indexed by Location`
        : `${label} records without one index reference`
    case 'invalid_value':
      return `${label} records with invalid values`
    case 'mixed_index':
      return `${label} objects mixing index types`
    case 'conflicting_records':
      return `${label} records that disagree`
  }
}

/** How the Problems list titles a problem with a media timeline template. */
export function templateProblemTitle(category: TimelineProblem['category']): string {
  return category === 'missing_field'
    ? 'Media timeline template with values missing'
    : 'Media timeline template with invalid values'
}

/** The templates that do not read, once for each track and kind of problem (msf-01 7.4.1). */
export function templateProblems(
  tracks: Iterable<TrackEntry>,
  packaging: ReadonlyMap<TrackKey, TrackPackaging>,
): PanelProblem[] {
  const out: PanelProblem[] = []
  const seen = new Set<TrackKey>()
  for (const track of tracks) {
    const key = registryTrackKey(track)
    if (seen.has(key)) continue
    seen.add(key)
    const template = templateOf(packaging.get(key))
    if (!template) continue
    const byCategory = new Map<string, TimelineProblem[]>()
    for (const p of template.problems) {
      const k = `${p.severity}:${p.category}:${p.section}`
      byCategory.set(k, [...(byCategory.get(k) ?? []), p])
    }
    for (const problems of byCategory.values()) {
      const first = problems[0]!
      out.push({
        source: 'catalog',
        severity: first.severity,
        title: `${templateProblemTitle(first.category)}: ${track.fullName}`,
        detail: `${problems.map((p) => (p.path ? `${p.path}: ${p.message}` : p.message)).join('; ')}.`,
        section: first.section,
        places: [],
        atMs: null,
      })
    }
  }
  return out
}

/** A template's six values, read. */
export type MediaTimelineTemplate = NonNullable<ParsedMediaTimelineTemplate['template']>

/** A template's six values as the panel writes them. */
export function templateText(template: MediaTimelineTemplate): string {
  const t = template
  return `media time ${t.startMediaTime} ms + ${t.deltaMediaTime} ms · Location [${t.startGroup}, ${t.startObject}] + [${t.deltaGroup}, ${t.deltaObject}] · wallclock ${t.startWallclock} ms + ${t.deltaWallclock} ms`
}
