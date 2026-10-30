/**
 * CMAF tracks and timeline tracks, read in the panel. A track is CMAF when
 * the session's catalogs agree on packaging "cmaf" (cmsf 3.5.1). Its CMAF
 * header comes from the catalogs, in the field their draft defines: cmsf-00 3.1 initData, cmsf-01 3.1
 * initDataList and initRef.
 * Timeline tracks are read as timelines.ts says; a SAP type timeline is
 * compared with the CMAF track it describes (cmsf 3.6.1).
 */

import { type InitSegment, parseInitSegment } from '@moqtap/media/bmff'
import type { CatalogDraft } from '@moqtap/media/catalog'
import {
  type CmafFinding,
  type CmafFindingCode,
  type CmafObject,
  type CmafTiming,
  type CmsfDraft,
  checkCmafObject,
  type FirstSample,
  parseCmafObject,
  type SapReading,
} from '@moqtap/media/cmaf'
import {
  type SapTimelineEntry,
  severityOf,
  timelineProblemExpected,
  timelineProblemFound,
  timelineProblemRemedy,
  timelineProblemTitle,
} from '@moqtap/media/timeline'
import {
  computed,
  type ComputedRef,
  onBeforeUnmount,
  shallowRef,
  toRaw,
  watch,
} from 'vue'
import {
  agreedValue,
  registryTrackKey,
  type TrackKey,
  type TrackPackaging,
  trackKey,
} from './catalogs'
import {
  frameSource,
  type LocSource,
  type LocSourceRef,
  listSources,
  trackForSource,
} from './loc'
import { type ObjectFrames, objectFrames } from './frames'
import { mediaPackaging } from './packaging'
import {
  makeProblem,
  mediaSpec,
  moqtSpec,
  objectLabel,
  type PanelProblem,
  type PanelSpec,
  type ProblemPlace,
  type ProblemSeverity,
  type ProblemSource,
  specsFromSection,
  trackSubject,
} from './problems'
import type { StreamObject } from './stream-framing'
import {
  cmsfDraftOf,
  readTimelineObject,
  SAP_TIMELINE_EVENT_TYPE,
  type TimelineProblem,
  TIMELINE_LABELS,
  type TimelineObjectView,
  type TimelineState,
  timelineSignature,
  timelineStateOf,
} from './timelines'
import type { SessionEntry, TrackEntry } from './use-inspector'

export { cmsfDraftOf, SAP_TIMELINE_EVENT_TYPE }
export type { TimelineObjectView, TimelineState }

// ─── What the catalogs say ────────────────────────────────────────

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * A track's CMAF header as the catalogs give it.
 *
 * - `known`: every catalog describing the track gives these bytes, and they parse
 * - `none`: no catalog gives a header it can read;
 *   `other-draft-field` when one gives it in a field its draft does not define
 * - `conflict`: the catalogs give different headers, or some give none; none is used
 * - `ambiguous`: a catalog whose draft is open gives it in a field only some of
 *   its possible drafts define; none is used
 * - `unparsed`: the header the catalogs give does not parse as an init segment
 */
export type CmafInit =
  | { status: 'known'; segment: InitSegment; size: number; signature: string }
  | { status: 'none'; reason: 'not-given' }
  | {
      status: 'none'
      reason: 'other-draft-field'
      catalogName: string
      field: InitField
      drafts: CatalogDraft[]
    }
  | { status: 'conflict'; values: { catalogName: string; size: number | null }[] }
  | {
      status: 'ambiguous'
      values: { catalogName: string; field: InitField; drafts: CatalogDraft[] }[]
    }
  | { status: 'unparsed'; size: number }

/** The catalog field a CMAF header is given in */
export type InitField = 'initData' | 'initRef'

/** msf-00 5.1.20 and cmsf-00 3.1 give it in initData; msf-01 5.2.13 and cmsf-01 3.1 by initRef. */
function initFieldOf(draft: CatalogDraft): InitField {
  return draft.endsWith('00') ? 'initData' : 'initRef'
}

type ClaimInit =
  | { bytes: Uint8Array | null }
  | { otherField: InitField; drafts: CatalogDraft[] }
  | { ambiguous: InitField; drafts: CatalogDraft[] }

/** What one catalog gives as a track's header, read by the field its draft defines. */
function claimInit(c: TrackPackaging['claims'][number]): ClaimInit {
  // The catalog reader resolves initRef when given, and the track's initData otherwise.
  const field: InitField | null =
    c.track.initRef !== null ? 'initRef' : c.track.initData !== null ? 'initData' : null
  if (field === null) return { bytes: null }
  const drafts = [...c.drafts]
  const defining = drafts.filter((d) => initFieldOf(d) === field)
  if (defining.length === 0) return { otherField: field, drafts }
  if (defining.length < drafts.length) return { ambiguous: field, drafts }
  return { bytes: c.track.initData }
}

function initSignature(init: CmafInit): string {
  return init.status === 'known' ? init.signature : init.status
}

// ─── Track state ──────────────────────────────────────────────────

export interface CmafTrackState {
  key: TrackKey
  /** The CMSF draft of its catalogs; null when not one */
  draft: CmsfDraft | null
  init: CmafInit
  /** cmsf 3.5.2.1 and 3.5.2.2, when the catalogs agree on a number */
  maxGrpSapStartingType: number | null
  maxObjSapStartingType: number | null
  /** Objects read so far */
  objectCount: number
}

/** One object of a CMAF track, as far as the track's problems need it. */
export interface CmafObjectRecord {
  source: LocSource
  offset: number
  groupId: number
  objectId: number
  payloadLength: number
  trackIds: number[]
  findings: CmafFinding[]
  sap: SapReading
  sync: boolean | null
  eptMs: number[] | null
  /** The samples whose sync flag their frame contradicts; null when none do */
  frameMismatch: string | null
  /** Another copy of the object, from another source, reads differently */
  conflicting: boolean
}

/** One object of a timeline track. */
export interface TimelineObjectRecord {
  source: LocSource
  offset: number
  groupId: number
  objectId: number
  payloadLength: number
  kind: TimelineObjectView['kind']
  /** A SAP timeline's records, read */
  entries: SapTimelineEntry[]
  problems: TimelineProblem[]
  /** Another copy of the object, from another source, reads differently */
  conflicting: boolean
}

/** A source due for a read, and what its track is read as. */
export type CmafSourceRef = LocSourceRef &
  (
    | { target: 'cmaf'; state: CmafTrackState }
    | { target: 'timeline'; state: TimelineState }
  )

export interface CmafObjectView {
  object: CmafObject
  findings: CmafFinding[]
  /** The header's track_IDs; null when the header is not known */
  headerTrackIds: number[] | null
  /** The header's timescale for each track_ID it has */
  timescales: Map<number, number | null>
  frames: ObjectFrames
}

interface SourceProgress {
  key: TrackKey
  /** The init and draft the source's objects were read under */
  signature: string
  readBytes: number
  closed: boolean
  done: boolean
  firstDataAt?: number
}

interface CmafLog {
  signature: string
  objectCount: number
  /** By `group:object`; a subscription and its joining FETCH carry the same objects */
  byLocation: Map<string, CmafObjectRecord>
  /** What each Location's first copy reads as, to compare later copies with */
  readings: Map<string, string>
}

interface TimelineLog {
  objectCount: number
  /** By `group:object`, the first copy read */
  byLocation: Map<string, TimelineObjectRecord>
  readings: Map<string, string>
}

function recordKey(source: LocSource, offset: number): string {
  return `${source}@${offset}`
}

function location(groupId: number, objectId: number): string {
  return `${groupId}:${objectId}`
}

function place(
  record: { source: LocSource; offset: number; groupId: number; objectId: number },
  note: string | null = null,
): ProblemPlace {
  return {
    label: objectLabel(record.groupId, record.objectId),
    note,
    target: { kind: 'object', source: record.source, offset: record.offset },
  }
}

/** An Object is the same bytes however it is retrieved. */
const COPIES_WORDS = {
  found: 'Copies from different streams or fetches read differently',
  expected: 'The same bytes however an object is retrieved',
  remedy: 'Send each object with the same bytes on every stream and fetch',
}

/** Drafts 07 to 22 all state it in 2.1, Objects, in these words. */
const COPIES_QUOTE =
  'An object is uniquely identified by its track namespace, track name, group ID, and object ID, and must be an identical sequence of bytes regardless of how or where it is retrieved.'

/** The rule {@link COPIES_WORDS} states, in the session's MoQT draft. */
export function copiesSpec(draft: string | undefined): PanelSpec | null {
  const n = Number(draft)
  if (!Number.isInteger(n) || n < 7 || n > 22) return null
  return moqtSpec({ revision: String(n).padStart(2, '0'), section: '2.1', quote: COPIES_QUOTE })
}

/** What a CMAF or timeline check gives, its rule as section text. */
interface TrackFinding {
  id: string
  title: string
  severity: ProblemSeverity
  section?: string | null
  /** A MoQT rule's section, which a section text cannot name */
  spec?: PanelSpec | null
  found?: string | null
  expected?: string | null
  remedy?: string | null
  places?: ProblemPlace[]
  atMs?: number | null
  examined?: number | null
}

function trackProblem(source: ProblemSource, track: TrackEntry, f: TrackFinding): PanelProblem {
  const specs = specsFromSection(f.section ?? null)
  const { section: _s, spec, ...rest } = f
  return makeProblem({
    ...rest,
    source,
    subject: trackSubject(track),
    spec: spec ?? specs[0] ?? null,
    also: specs.slice(1),
  })
}

/** The codes {@link violations} can return */
type ViolationCode = Exclude<
  CmafFindingCode,
  'track-id-unchecked' | 'group-start-sap-not-signalled'
>

const FINDING_WORDS: Record<ViolationCode, { title: string; remedy: string }> = {
  'malformed-box': {
    title: 'Objects have malformed boxes',
    remedy: 'Give each box a size that fits its container',
  },
  'no-moof-mdat': {
    title: 'Objects have no moof followed by an mdat',
    remedy: 'Carry a moof followed by its mdat in each object',
  },
  'no-mfhd': { title: 'Objects have a moof with no mfhd', remedy: 'Give each moof an mfhd' },
  'no-traf': {
    title: 'Objects have a moof that names no track_ID',
    remedy: 'Give each moof a traf with a tfhd',
  },
  'no-tfhd': {
    title: 'Objects have a moof that names no track_ID',
    remedy: 'Give each moof a traf with a tfhd',
  },
  'multiple-tracks': {
    title: 'Objects carry more than one track_ID',
    remedy: 'Carry the samples of one track_ID in each object',
  },
  'track-id-not-in-init': {
    title: 'Objects name a track_ID the CMAF header does not have',
    remedy: "Use the track_ID of the CMAF header's trak",
  },
  'group-start-sap-type': {
    title: 'Groups start with a SAP type other than 1 or 2',
    remedy: 'Start each group with a SAP type 1 or 2 sample',
  },
}

/** The object's cmsf 3.3 and 3.4 violations. */
function violations(
  object: CmafObject,
  init: InitSegment | null,
  draft: CmsfDraft | null,
  firstInGroup: boolean,
): CmafFinding[] {
  return checkCmafObject(object, init, { ...(draft ? { draft } : {}), firstInGroup }).filter(
    (f) => f.kind === 'violation',
  )
}

// ─── A session's CMAF and timeline tracks ─────────────────────────

/**
 * Every CMAF and timeline track of one session, read incrementally: call
 * {@link sync} when the session changes, read the sources it returns and pass
 * their bytes to {@link ingest}. An open source is read again once its size
 * has doubled since the last read, and once more when it closes; objects
 * already read are not parsed again until the track's CMAF header or draft
 * changes.
 */
export class SessionCmaf {
  private readonly progress = new Map<LocSource, SourceProgress>()
  private readonly cmafLogs = new Map<TrackKey, CmafLog>()
  private readonly timelineLogs = new Map<TrackKey, TimelineLog>()
  private readonly seen = new Set<string>()
  private readonly inits = new Map<string, InitSegment | null>()
  private readonly cmafViews = new Map<string, { signature: string; view: CmafObjectView }>()
  private readonly timelineViews = new Map<
    string,
    { signature: string; view: TimelineObjectView }
  >()
  /** Bumped whenever what the reader reports may have changed */
  revision = 0


  private initOf(described: TrackPackaging): CmafInit {
    const given = described.claims.map((c) => ({ c, init: claimInit(c) }))
    const ambiguous = given.flatMap(({ c, init }) =>
      'ambiguous' in init
        ? [{ catalogName: c.catalogName, field: init.ambiguous, drafts: init.drafts }]
        : [],
    )
    if (ambiguous.length > 0) return { status: 'ambiguous', values: ambiguous }
    const values = given.map(({ init }) => ('bytes' in init ? init.bytes : null))
    const first = values[0] ?? null
    const alike = values.every((v) =>
      v === null ? first === null : first !== null && sameBytes(v, first),
    )
    if (!alike) {
      return {
        status: 'conflict',
        values: given.map(({ c }, i) => ({
          catalogName: c.catalogName,
          size: values[i]?.length ?? null,
        })),
      }
    }
    if (first === null) {
      for (const { c, init } of given) {
        if (!('otherField' in init)) continue
        return {
          status: 'none',
          reason: 'other-draft-field',
          catalogName: c.catalogName,
          field: init.otherField,
          drafts: init.drafts,
        }
      }
      return { status: 'none', reason: 'not-given' }
    }
    const signature = hexOf(first)
    let segment = this.inits.get(signature)
    if (segment === undefined) {
      segment = parseInitSegment(first)
      this.inits.set(signature, segment)
    }
    return segment === null
      ? { status: 'unparsed', size: first.length }
      : { status: 'known', segment, size: first.length, signature }
  }

  /** A CMAF track's header, draft and objects so far, or null for a track that is not CMAF. */
  trackState(
    track: TrackEntry,
    packaging: ReadonlyMap<TrackKey, TrackPackaging>,
  ): CmafTrackState | null {
    const key = registryTrackKey(track)
    const described = packaging.get(key)
    if (!described || mediaPackaging(described)?.packaging !== 'cmaf') {
      return null
    }
    const maxGrp = agreedValue(described, (t) => t.maxGrpSapStartingType)
    const maxObj = agreedValue(described, (t) => t.maxObjSapStartingType)
    return {
      key,
      draft: cmsfDraftOf(described),
      init: this.initOf(described),
      maxGrpSapStartingType: maxGrp ?? null,
      maxObjSapStartingType: maxObj ?? null,
      objectCount: this.cmafLogs.get(key)?.objectCount ?? 0,
    }
  }

  /** A timeline track's state, or null for a track that is not one. */
  timelineState(
    track: TrackEntry,
    packaging: ReadonlyMap<TrackKey, TrackPackaging>,
  ): TimelineState | null {
    const key = registryTrackKey(track)
    const state = timelineStateOf(track, key, packaging.get(key))
    if (!state) return null
    return { ...state, objectCount: this.timelineLogs.get(key)?.objectCount ?? 0 }
  }

  /**
   * The sources due for a read: new ones with bytes, ones that doubled since
   * the last read, ones that closed, and every source of a track whose CMAF
   * header or draft changed. Changes nothing.
   */
  sync(
    session: Pick<SessionEntry, 'streams' | 'tracks' | 'datagramGroups'>,
    packaging: ReadonlyMap<TrackKey, TrackPackaging>,
  ): CmafSourceRef[] {
    const states = new Map<TrackKey, CmafTrackState | TimelineState>()
    const cmafKeys = new Set<TrackKey>()
    for (const track of session.tracks.values()) {
      const cmaf = this.trackState(track, packaging)
      if (cmaf) {
        states.set(cmaf.key, cmaf)
        cmafKeys.add(cmaf.key)
        continue
      }
      const timeline = this.timelineState(track, packaging)
      if (timeline) states.set(timeline.key, timeline)
    }
    if (states.size === 0) return []

    const refs: CmafSourceRef[] = []
    for (const ref of listSources(session, (t) => states.has(registryTrackKey(t)))) {
      if (ref.byteCount === 0) continue
      const state = states.get(ref.key)!
      const signature = cmafKeys.has(ref.key)
        ? signatureOf(state as CmafTrackState)
        : timelineSignature(state as TimelineState)
      const p = this.progress.get(ref.source)
      if (p) {
        if (p.key !== ref.key) continue
        const due =
          p.signature !== signature ||
          (!p.done && (ref.byteCount >= 2 * p.readBytes || (ref.closed && !p.closed)))
        if (!due) continue
      }
      refs.push(
        cmafKeys.has(ref.key)
          ? { ...ref, target: 'cmaf', state: state as CmafTrackState }
          : { ...ref, target: 'timeline', state: state as TimelineState },
      )
    }
    return refs
  }

  /** Drop what was read of one track, so its sources are read again. */
  private forget(key: TrackKey): void {
    for (const [source, p] of this.progress) {
      if (p.key !== key) continue
      this.progress.delete(source)
      for (const k of this.seen) if (k.startsWith(`${source}@`)) this.seen.delete(k)
    }
    this.cmafLogs.delete(key)
    this.timelineLogs.delete(key)
    this.revision++
  }

  /**
   * Read one source's bytes: frame them by `draft` and read every object not
   * read before. `data` null means the bytes could not be had.
   */
  ingest(ref: CmafSourceRef, data: Uint8Array | null, draft: string | undefined): void {
    const signature =
      ref.target === 'cmaf' ? signatureOf(ref.state) : timelineSignature(ref.state)
    let p = this.progress.get(ref.source)
    if (p && p.key === ref.key && p.signature !== signature) {
      // Read under another header or draft: read the whole track again.
      this.forget(ref.key)
      p = undefined
    }
    if (!p) {
      p = { key: ref.key, signature, readBytes: 0, closed: false, done: false }
      this.progress.set(ref.source, p)
    }
    if (p.key !== ref.key || !data) return
    p.firstDataAt ??= ref.firstDataAt
    p.readBytes = Math.max(data.length, 1)
    p.closed = ref.closed
    p.done = ref.closed

    const framing = frameSource(ref, data, draft)
    if (!framing) return
    let added = false
    for (const obj of framing.objects) {
      if (obj.payloadOffset + obj.payloadLength > data.length) break
      if (obj.endOfRange !== undefined || obj.payloadLength === 0) continue
      const key = recordKey(ref.source, obj.offset)
      if (this.seen.has(key)) continue
      this.seen.add(key)
      added = true
      const groupId = obj.groupId ?? framing.headerFields.groupId ?? 0
      const payload = data.subarray(obj.payloadOffset, obj.payloadOffset + obj.payloadLength)
      if (ref.target === 'cmaf') {
        this.addCmaf(ref.state, ref.source, obj, groupId, payload, signature)
      } else {
        this.addTimeline(ref.state, ref.source, obj, groupId, payload)
      }
    }
    if (added) this.revision++
  }

  private addCmaf(
    state: CmafTrackState,
    source: LocSource,
    obj: StreamObject,
    groupId: number,
    payload: Uint8Array,
    signature: string,
  ): void {
    let log = this.cmafLogs.get(state.key)
    if (!log) {
      log = { signature, objectCount: 0, byLocation: new Map(), readings: new Map() }
      this.cmafLogs.set(state.key, log)
    }
    log.objectCount++
    const at = location(groupId, obj.objectId)
    const init = state.init.status === 'known' ? state.init.segment : null
    const object = parseCmafObject(payload, init)
    const record: CmafObjectRecord = {
      source,
      offset: obj.offset,
      groupId,
      objectId: obj.objectId,
      payloadLength: obj.payloadLength,
      trackIds: object.trackIds,
      // cmsf-00 through draft-ietf-moq-transport-10 9.1.1, cmsf-01 through msf-01 6.2
      findings: violations(object, init, state.draft, obj.objectId === 0),
      sap: object.sap,
      sync: object.firstSample.sync,
      eptMs: object.timing.eptMs,
      frameMismatch: objectFrames(payload, init).mismatches.join('; ') || null,
      conflicting: false,
    }
    const reading = readingOf(record)
    const known = log.byLocation.get(at)
    if (!known) {
      log.byLocation.set(at, record)
      log.readings.set(at, reading)
    } else if (log.readings.get(at) !== reading) {
      known.conflicting = true
    }
  }

  private addTimeline(
    state: TimelineState,
    source: LocSource,
    obj: StreamObject,
    groupId: number,
    payload: Uint8Array,
  ): void {
    let log = this.timelineLogs.get(state.key)
    if (!log) {
      log = { objectCount: 0, byLocation: new Map(), readings: new Map() }
      this.timelineLogs.set(state.key, log)
    }
    log.objectCount++
    const view = readTimelineObject(payload, state)
    const at = location(groupId, obj.objectId)
    const reading = JSON.stringify([obj.payloadLength, view])
    const known = log.byLocation.get(at)
    if (known) {
      if (log.readings.get(at) !== reading) known.conflicting = true
      return
    }
    log.byLocation.set(at, {
      source,
      offset: obj.offset,
      groupId,
      objectId: obj.objectId,
      payloadLength: obj.payloadLength,
      kind: view.kind,
      entries: view.kind === 'sap' ? view.entries : [],
      problems: view.problems,
      conflicting: false,
    })
    log.readings.set(at, reading)
  }

  /** One object of a CMAF track, parsed under the track's header. Kept until that changes. */
  objectView(
    source: LocSource,
    obj: StreamObject,
    data: Uint8Array,
    state: CmafTrackState,
  ): CmafObjectView {
    const key = recordKey(source, obj.offset)
    const signature = signatureOf(state)
    const cached = this.cmafViews.get(key)
    if (cached && cached.signature === signature) return cached.view
    const end = Math.min(obj.payloadOffset + obj.payloadLength, data.length)
    const init = state.init.status === 'known' ? state.init.segment : null
    const payload = data.subarray(obj.payloadOffset, end)
    const object = parseCmafObject(payload, init)
    const view: CmafObjectView = {
      frames: objectFrames(payload, init),
      object,
      findings: violations(object, init, state.draft, obj.objectId === 0),
      headerTrackIds: init
        ? init.tracks.flatMap((t) => (t.trackId === null ? [] : [t.trackId]))
        : null,
      timescales: new Map(
        (init?.tracks ?? []).flatMap((t) =>
          t.trackId === null ? [] : [[t.trackId, t.timescale] as const],
        ),
      ),
    }
    this.cmafViews.set(key, { signature, view })
    return view
  }

  /** One object of a timeline track, read. */
  timelineView(
    source: LocSource,
    obj: StreamObject,
    data: Uint8Array,
    state: TimelineState,
  ): TimelineObjectView {
    const key = recordKey(source, obj.offset)
    const signature = timelineSignature(state)
    const cached = this.timelineViews.get(key)
    if (cached && cached.signature === signature) return cached.view
    const end = Math.min(obj.payloadOffset + obj.payloadLength, data.length)
    const view = readTimelineObject(data.subarray(obj.payloadOffset, end), state)
    this.timelineViews.set(key, { signature, view })
    return view
  }

  /**
   * What the session's CMAF and timeline tracks break: a CMAF header the
   * catalogs do not give or give in a form that does not parse, objects that
   * break cmsf 3.3 or 3.4, SAP types above what the catalog declares, timeline
   * records that do not read, and SAP timeline records the
   * media they describe contradicts. Catalogs that disagree on the header, or
   * give it in a field only some of their possible drafts define, are noted.
   */
  problems(
    tracks: Iterable<TrackEntry>,
    packaging: ReadonlyMap<TrackKey, TrackPackaging>,
    draft?: string,
  ): PanelProblem[] {
    this.copiesRule = copiesSpec(draft)
    const out: PanelProblem[] = []
    const done = new Set<TrackKey>()
    const list = [...tracks]
    for (const track of list) {
      const key = registryTrackKey(track)
      if (done.has(key)) continue
      done.add(key)
      const state = this.trackState(track, packaging)
      if (state) {
        this.cmafProblems(track, state, out)
        continue
      }
      const timeline = this.timelineState(track, packaging)
      if (timeline) this.timelineProblems(track, timeline, list, packaging, out)
    }
    return out
  }

  /** The session draft's rule that copies of an object are the same bytes */
  private copiesRule: PanelSpec | null = null

  private atMs(source: LocSource): number | null {
    return this.progress.get(source)?.firstDataAt ?? null
  }

  private cmafProblems(track: TrackEntry, state: CmafTrackState, out: PanelProblem[]): void {
    const section = (s: string) =>
      state.draft ? `${state.draft.toUpperCase()} ${s}` : `CMSF-00 ${s}, CMSF-01 ${s}`
    const push = (f: TrackFinding) => out.push(trackProblem('cmaf', track, f))
    const { init } = state
    if (init.status === 'conflict') {
      push({
        id: 'cmaf.init.conflict',
        title: 'Catalogs give this track different CMAF headers',
        found: init.values
          .map((v) => `${v.catalogName}: ${v.size === null ? 'none' : `${v.size} B`}`)
          .join(' · '),
        expected: 'One CMAF header in every catalog that describes the track',
        remedy: 'Give the track the same CMAF header in every catalog',
        severity: 'info',
      })
    }
    if (init.status === 'ambiguous') {
      push({
        id: 'cmaf.init.ambiguous',
        title: "CMAF header is in a field only some of the catalog's drafts define",
        found: init.values
          .map(
            (v) =>
              `${v.catalogName}: ${v.field}, read as ${v.drafts.map((d) => d.toUpperCase()).join(' or ')}`,
          )
          .join(' · '),
        expected: 'CMSF-00: initData on the track · CMSF-01: initRef to an initDataList entry',
        remedy: "Set the catalog's version to the draft its header field belongs to",
        severity: 'info',
        section: 'CMSF-00 3.1; CMSF-01 3.1',
      })
    }
    const log = this.cmafLogs.get(state.key)
    if (!log || log.objectCount === 0) return
    const examined = log.byLocation.size
    if (init.status === 'none') {
      const other = init.reason === 'other-draft-field'
      push({
        id: 'cmaf.init.none',
        title: other
          ? `CMAF header is in ${init.field}, which the catalog's draft does not define`
          : 'CMAF track has no header in the catalog',
        found: other
          ? `${init.catalogName} (${init.drafts.map((d) => d.toUpperCase()).join(' or ')}): ${init.field}`
          : 'No initData, initRef or initDataList entry for the track',
        expected:
          state.draft === 'cmsf-00'
            ? 'initData on the track'
            : state.draft === 'cmsf-01'
              ? 'initRef to an initDataList entry'
              : "The CMAF header in the field the catalog's draft defines",
        remedy: "Give the track's CMAF header in the field the catalog's draft defines",
        severity: 'error',
        section: section('3.1'),
      })
    } else if (init.status === 'unparsed') {
      push({
        id: 'cmaf.init.unparsed',
        title: 'CMAF header does not parse',
        found: `${init.size} B header with no moov`,
        expected: 'An init segment: ftyp and moov',
        remedy: 'Give a CMAF header with an ftyp and a moov',
        severity: 'error',
        section: section('3.1'),
      })
    }

    const byCode = new Map<ViolationCode, { section: string; places: ProblemPlace[]; atMs: number | null }>()
    const aboveGrp: ProblemPlace[] = []
    const aboveObj: ProblemPlace[] = []
    let aboveAt: number | null = null
    const conflicting: ProblemPlace[] = []
    let conflictingAt: number | null = null
    const frames: ProblemPlace[] = []
    let framesAt: number | null = null
    for (const record of log.byLocation.values()) {
      if (record.conflicting) {
        conflicting.push(place(record))
        conflictingAt ??= this.atMs(record.source)
        continue
      }
      if (record.frameMismatch) {
        frames.push(place(record, record.frameMismatch))
        framesAt ??= this.atMs(record.source)
      }
      for (const f of record.findings) {
        const code = f.code as ViolationCode
        let entry = byCode.get(code)
        if (!entry) {
          entry = { section: f.section, places: [], atMs: this.atMs(record.source) }
          byCode.set(code, entry)
        }
        entry.places.push(place(record, f.path ? `${f.path}: ${f.message}` : f.message))
      }
      const sapType = record.sap.sapType
      if (sapType === null) continue
      const max = state.maxGrpSapStartingType
      if (record.objectId === 0 && max !== null && sapType > max) {
        aboveGrp.push(place(record, `starts with SAP type ${sapType}`))
        aboveAt ??= this.atMs(record.source)
      }
      const maxObj = state.maxObjSapStartingType
      if (maxObj !== null && sapType > maxObj) {
        aboveObj.push(place(record, `starts with SAP type ${sapType}`))
        aboveAt ??= this.atMs(record.source)
      }
    }
    if (conflicting.length > 0) {
      push({
        id: 'cmaf.copies.differ',
        title: 'Copies of an object read differently',
        ...COPIES_WORDS,
        spec: this.copiesRule,
        severity: 'error',
        places: conflicting,
        atMs: conflictingAt,
        examined,
      })
    }
    for (const [code, { section: s, places, atMs }] of byCode) {
      push({
        id: `cmaf.${code}`,
        title: FINDING_WORDS[code].title,
        remedy: FINDING_WORDS[code].remedy,
        severity: 'error',
        section: s,
        places,
        atMs,
        examined,
      })
    }
    if (aboveGrp.length > 0) {
      push({
        id: 'cmaf.sap.above-max-grp',
        title: "Groups start above the catalog's maxGrpSapStartingType",
        found: `maxGrpSapStartingType ${state.maxGrpSapStartingType}`,
        expected: 'Each group starts at or below maxGrpSapStartingType',
        remedy: 'Start groups at a lower SAP type, or raise maxGrpSapStartingType',
        severity: 'warning',
        section: section('3.5.2.1'),
        places: aboveGrp,
        atMs: aboveAt,
        examined,
      })
    }
    if (aboveObj.length > 0) {
      push({
        id: 'cmaf.sap.above-max-obj',
        title: "Objects start above the catalog's maxObjSapStartingType",
        found: `maxObjSapStartingType ${state.maxObjSapStartingType}`,
        expected: 'Each object starts at or below maxObjSapStartingType',
        remedy: 'Start objects at a lower SAP type, or raise maxObjSapStartingType',
        severity: 'warning',
        section: section('3.5.2.2'),
        places: aboveObj,
        atMs: aboveAt,
        examined,
      })
    }
    if (frames.length > 0) {
      push({
        id: 'cmaf.frames.sync-mismatch',
        title: 'Sample flags disagree with the frames on random access',
        expected:
          'Sync samples are exactly the IDR (H.264), IRAP (H.265) or shown key frames (AV1)',
        remedy: "Set each sample's sync flag to match its frame",
        severity: 'warning',
        places: frames,
        atMs: framesAt,
        examined,
      })
    }
  }

  private timelineProblems(
    track: TrackEntry,
    state: TimelineState,
    tracks: TrackEntry[],
    packaging: ReadonlyMap<TrackKey, TrackPackaging>,
    out: PanelProblem[],
  ): void {
    const push = (f: TrackFinding) => out.push(trackProblem('timeline', track, f))

    const log = this.timelineLogs.get(state.key)
    if (!log || log.objectCount === 0) return
    const label = TIMELINE_LABELS[state.kind]
    const examined = log.byLocation.size

    const conflicting = [...log.byLocation.values()].filter((o) => o.conflicting)
    if (conflicting.length > 0) {
      push({
        id: 'timeline.copies.differ',
        title: `Copies of a ${label.toLowerCase()} object read differently`,
        ...COPIES_WORDS,
        spec: this.copiesRule,
        severity: 'error',
        places: conflicting.map((o) => place(o)),
        atMs: this.atMs(conflicting[0]!.source),
        examined,
      })
    }

    const byFamily = new Map<
      string,
      { all: TimelineProblem[]; places: ProblemPlace[]; atMs: number | null }
    >()
    for (const object of log.byLocation.values()) {
      if (object.conflicting) continue
      for (const p of object.problems) {
        const k = JSON.stringify([p.family, severityOf(p)])
        let entry = byFamily.get(k)
        if (!entry) {
          entry = { all: [], places: [], atMs: this.atMs(object.source) }
          byFamily.set(k, entry)
        }
        entry.all.push(p)
        const last = entry.places[entry.places.length - 1]?.target
        if (last?.kind === 'object' && last.source === object.source && last.offset === object.offset) {
          continue
        }
        entry.places.push(place(object))
      }
    }
    for (const { all, places, atMs } of byFamily.values()) {
      const first = all[0]!
      out.push(
        makeProblem({
          source: 'timeline',
          subject: trackSubject(track),
          id: first.id,
          family: first.family,
          severity: severityOf(first),
          title: timelineProblemTitle(all),
          found: timelineProblemFound(all) || null,
          expected: timelineProblemExpected(all) || null,
          remedy: timelineProblemRemedy(all) || null,
          spec: mediaSpec(first.spec),
          also: first.also.map(mediaSpec),
          places,
          atMs,
          examined,
        }),
      )
    }
    if (state.kind !== 'sap') return

    const section = (s: string) =>
      state.draft ? `${state.draft.toUpperCase()} ${s}` : `CMSF-00 ${s}, CMSF-01 ${s}`

    // The same Location in several timeline objects, with different values.
    const byLocation = new Map<
      string,
      { entry: SapTimelineEntry; values: Map<string, TimelineObjectRecord[]> }
    >()
    for (const object of log.byLocation.values()) {
      if (object.conflicting) continue
      for (const entry of object.entries) {
        const at = location(entry.group, entry.object)
        const value = `${entry.sapType}:${entry.ept}`
        let known = byLocation.get(at)
        if (!known) {
          known = { entry, values: new Map() }
          byLocation.set(at, known)
        }
        known.values.set(value, [...(known.values.get(value) ?? []), object])
      }
    }
    const disagree = [...byLocation.values()].filter((l) => l.values.size > 1)
    if (disagree.length > 0) {
      const places: ProblemPlace[] = []
      let disagreeAt: number | null = null
      for (const { entry, values } of disagree) {
        for (const [value, objects] of values) {
          const [sap, ept] = value.split(':')
          for (const object of objects) {
            disagreeAt ??= this.atMs(object.source)
            places.push(
              place(object, `${objectLabel(entry.group, entry.object)}: SAP type ${sap} at ${ept} ms`),
            )
          }
        }
      }
      push({
        id: 'timeline.sap.objects-disagree',
        title: 'SAP timeline objects disagree on a record',
        expected: 'One SAP record for a Location in every timeline object',
        remedy: 'Give each Location the same SAP record in every timeline object',
        severity: 'warning',
        section: section('3.6.1'),
        places,
        atMs: disagreeAt,
      })
    }

    if (state.depends.length !== 1) return
    const describedKey = trackKey(state.namespace, state.depends[0]!)
    const media = tracks.find((t) => registryTrackKey(t) === describedKey)
    const mediaState = media ? this.trackState(media, packaging) : null
    const mediaLog = mediaState ? this.cmafLogs.get(describedKey) : undefined
    if (!media || !mediaState || !mediaLog) return

    const mismatches: ProblemPlace[] = []
    let mismatchAt: number | null = null
    for (const l of byLocation.values()) {
      if (l.values.size > 1) continue
      const record = mediaLog.byLocation.get(location(l.entry.group, l.entry.object))
      if (!record || record.conflicting) continue
      const said: string[] = []
      const { sap } = record
      // The timeline's SAP types are 0 to 3 (cmsf 3.6.1).
      if (sap.sapType !== null && sap.sapType > 3) continue
      if (sap.sapType !== null && sap.sapType !== l.entry.sapType) {
        said.push(`SAP type ${l.entry.sapType}, the media ${sap.sapType}`)
      } else if (
        sap.sapType === null &&
        sap.candidates.length > 0 &&
        !sap.candidates.includes(l.entry.sapType)
      ) {
        said.push(`SAP type ${l.entry.sapType}, the media ${sap.candidates.join(' or ')}`)
      }
      // cmsf 3.6.1 and the 3.6.2 example define a SAP type 3 time differently.
      const sap3 = l.entry.sapType === 3 || sap.sapType === 3
      if (!sap3 && record.eptMs !== null && !record.eptMs.includes(l.entry.ept)) {
        said.push(
          `earliest presentation time ${l.entry.ept} ms, the media ${record.eptMs.join(' or ')} ms`,
        )
      }
      if (said.length === 0) continue
      mismatches.push(place(record, `the timeline says ${said.join('; ')}`))
      mismatchAt ??= this.atMs([...l.values.values()][0]![0]!.source)
    }
    if (mismatches.length > 0) {
      push({
        id: 'timeline.sap.media-mismatch',
        title: `SAP timeline disagrees with the media of ${media.trackName}`,
        expected: 'The SAP type and earliest presentation time the media carries',
        remedy: 'Write the SAP type and time the media carries into the timeline',
        severity: 'warning',
        section: section('3.6.1'),
        places: mismatches,
        atMs: mismatchAt,
      })
    }
  }
}

function signatureOf(state: CmafTrackState): string {
  return `cmaf|${initSignature(state.init)}|${state.draft ?? ''}`
}

/** What the track's problems take from one copy of an object. */
function readingOf(r: CmafObjectRecord): string {
  return JSON.stringify([r.payloadLength, r.trackIds, r.findings, r.sap, r.sync, r.eptMs, r.frameMismatch])
}

const hexes = new WeakMap<Uint8Array, string>()

/** The bytes as hex, kept per array: the catalogs hand out the same one until they change. */
function hexOf(bytes: Uint8Array): string {
  let hex = hexes.get(bytes)
  if (hex === undefined) {
    hex = ''
    for (const b of bytes) hex += b.toString(16).padStart(2, '0')
    hexes.set(bytes, hex)
  }
  return hex
}

// ─── Display ──────────────────────────────────────────────────────

/** A SAP reading as the panel writes it; null when the object gives none. */
export function sapText(sap: SapReading): string | null {
  if (sap.sapType !== null) {
    return sap.source === 'sap-sample-group'
      ? `SAP type ${sap.sapType} ('sap ' sample group)`
      : `SAP type ${sap.sapType} (sync sample; the later samples presented before it are signalled decodable)`
  }
  return sap.candidates.length > 0 ? `SAP type ${sap.candidates.join(' or ')}` : null
}

const FLAG_SOURCES: Record<NonNullable<FirstSample['source']>, string> = {
  'trun-first-sample-flags': 'trun first_sample_flags',
  'trun-sample-flags': 'trun sample_flags',
  'tfhd-default': 'tfhd default_sample_flags',
  'trex-default': 'trex default_sample_flags',
}

/** Whether a first sample is a sync sample, and where its flags come from; null when no flags give it. */
export function syncText(first: FirstSample): string | null {
  if (first.sync === null) return null
  const source = first.source ? ` (${FLAG_SOURCES[first.source]})` : ''
  return `${first.sync ? 'sync sample' : 'not a sync sample'}${source}`
}

/** A tfdt baseMediaDecodeTime with the header's timescale, when there is one. */
export function decodeTimeText(time: bigint | null, timescale: number | null | undefined): string {
  if (time === null) return 'no tfdt'
  if (!timescale) return String(time)
  const seconds = Number(time) / timescale
  return `${time} at ${timescale}/s (${seconds.toFixed(3)} s)`
}

/** An object's earliest presentation time, in timescale units and milliseconds where they apply. */
export function eptText(timing: CmafTiming): string | null {
  if (timing.earliestPresentationTime === null) return null
  const units = `${timing.earliestPresentationTime} in timescale units`
  return timing.eptMs === null ? units : `${units} · ${timing.eptMs.join(' or ')} ms`
}

/** A CMAF header in a few words. */
export function initText(init: CmafInit): string {
  switch (init.status) {
    case 'known': {
      const tracks = init.segment.tracks
        .map((t) => `track_ID ${t.trackId ?? '?'} ${t.codec ?? t.handler ?? ''}`.trim())
        .join(', ')
      return `header ${init.size} bytes${tracks ? ` · ${tracks}` : ''}`
    }
    case 'none':
      return init.reason === 'other-draft-field'
        ? `header given in ${init.field}, which its draft does not define`
        : 'no header in the catalog'
    case 'conflict':
      return 'catalogs disagree on the header'
    case 'ambiguous':
      return 'header field ambiguous across drafts'
    case 'unparsed':
      return 'header does not parse'
  }
}

// ─── Vue ──────────────────────────────────────────────────────────

const readers = new WeakMap<SessionEntry, SessionCmaf>()

function readerFor(session: SessionEntry): SessionCmaf {
  const raw = toRaw(session)
  let reader = readers.get(raw)
  if (!reader) {
    reader = new SessionCmaf()
    readers.set(raw, reader)
  }
  return reader
}

export interface SessionCmafView {
  /** The CMAF state of a registry track, null when it is not CMAF */
  trackState: (track: TrackEntry) => CmafTrackState | null
  /** The timeline state of a registry track, null when it is not a timeline */
  timelineState: (track: TrackEntry) => TimelineState | null
  sourceState: (source: LocSource) => CmafTrackState | null
  sourceTimeline: (source: LocSource) => TimelineState | null
  /** Read when first asked for, and again only once what it rests on changes */
  problems: ComputedRef<PanelProblem[]>
  objectView: (
    source: LocSource,
    obj: StreamObject,
    data: Uint8Array,
    state: CmafTrackState,
  ) => CmafObjectView
  timelineView: (
    source: LocSource,
    obj: StreamObject,
    data: Uint8Array,
    state: TimelineState,
  ) => TimelineObjectView
}

/** A session's CMAF and timeline tracks, kept current while the caller is mounted. */
export function useSessionCmaf(
  session: () => SessionEntry,
  packaging: () => ReadonlyMap<TrackKey, TrackPackaging>,
  getStreamData: (sessionId: string, streamId: number) => Promise<Uint8Array | null>,
  getDatagramGroupData: (sessionId: string, groupKey: string) => Promise<Uint8Array | null>,
): SessionCmafView {
  const revision = shallowRef(0)
  const reader = computed(() => readerFor(session()))

  const due = computed(() => {
    void revision.value
    return reader.value
      .sync(session(), packaging())
      .map((r) => `${r.source}:${r.closed}:${r.target}`)
      .join('|')
  })

  let running = false
  let again = false
  let stopped = false

  async function pump(): Promise<void> {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      do {
        again = false
        const s = session()
        const r = reader.value
        const before = r.revision
        for (const ref of r.sync(s, packaging())) {
          if (stopped) return
          let data: Uint8Array | null = null
          try {
            data =
              ref.groupKey !== undefined
                ? await getDatagramGroupData(s.sessionId, ref.groupKey)
                : await getStreamData(s.sessionId, ref.streamId!)
          } catch {
            data = null
          }
          r.ingest(ref, data, s.draft)
        }
        if (r.revision !== before) revision.value++
      } while (again && !stopped)
    } finally {
      running = false
    }
  }

  watch(due, (list) => {
    if (list) void pump()
  }, { immediate: true })
  onBeforeUnmount(() => {
    stopped = true
  })

  const trackState = (track: TrackEntry) => {
    void revision.value
    return reader.value.trackState(track, packaging())
  }
  const timelineState = (track: TrackEntry) => {
    void revision.value
    return reader.value.timelineState(track, packaging())
  }

  return {
    trackState,
    timelineState,
    sourceState: (source) => {
      const track = trackForSource(session(), source)
      return track ? trackState(track) : null
    },
    sourceTimeline: (source) => {
      const track = trackForSource(session(), source)
      return track ? timelineState(track) : null
    },
    problems: computed(() => {
      void revision.value
        return reader.value.problems(session().tracks.values(), packaging(), session().draft)
    }),
    objectView: (source, obj, data, state) =>
      reader.value.objectView(source, obj, data, state),
    timelineView: (source, obj, data, state) =>
      reader.value.timelineView(source, obj, data, state),
  }
}
