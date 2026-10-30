/**
 * MSF and CMSF catalogs, read in the panel. A catalog is the JSON on a track
 * named "catalog" (msf-00 5, msf-01 5), one independent catalog or delta per
 * object. One catalog per (namespace, name): a subscription and its joining
 * FETCH are one sequence, merged by Group and Object ID (msf-01 5).
 */

import {
  applyCatalogObject,
  type CatalogDraft,
  type CatalogProblem,
  type CatalogProblemCategory,
  type CatalogState,
  type CatalogTrack,
  catalogTracks,
  createCatalogState,
  isCatalogTrackName,
  type ParsedCatalog,
  parseCatalog,
} from '@moqtap/media/catalog'
import {
  computed,
  type ComputedRef,
  onBeforeUnmount,
  shallowRef,
  toRaw,
  watch,
} from 'vue'
import {
  type ParsedStreamFraming,
  parseStreamFraming,
  parseStreamPrefix,
} from './stream-framing'
import type { SessionEntry, StreamEntry, TrackEntry } from './use-inspector'

// ─── Keys and namespaces ──────────────────────────────────────────

/** A catalog track, or a track a catalog describes: namespace text and name. */
export type TrackKey = string

/** A namespace tuple as text: the fields joined by `/`. */
export function namespaceText(tuple: readonly string[]): string {
  return tuple.join('/')
}

/**
 * The key namespace-and-name pairs are compared by. Leading and trailing
 * slashes in the namespace are ignored.
 */
export function trackKey(namespace: string | null, name: string): TrackKey {
  const ns = (namespace ?? '').replace(/^\/+|\/+$/g, '')
  return `${ns}\u0000${name}`
}

/** The key of a registry track. */
export function registryTrackKey(
  track: Pick<TrackEntry, 'trackNamespace' | 'trackName'>,
): TrackKey {
  return trackKey(namespaceText(track.trackNamespace), track.trackName)
}

// ─── Finding catalog streams ──────────────────────────────────────

/** A data stream the registry places on a catalog track. */
export interface CatalogStreamRef {
  streamId: number
  key: TrackKey
  /** The catalog track's namespace, as text */
  namespace: string
  name: string
  /** How the stream names its track */
  kind: 'subgroup' | 'fetch'
  /** The alias (subgroup) or request id (fetch) the stream's header carries */
  id: number
  direction: 'tx' | 'rx'
  closed: boolean
  byteCount: number
}

/** Which way a track's objects travel, from the request that registered it. */
function dataDirection(track: TrackEntry): 'tx' | 'rx' {
  if (track.via === 'publish') return track.direction
  return track.direction === 'tx' ? 'rx' : 'tx'
}

/**
 * The track an alias names for data travelling `direction`: the one track
 * sending that way that claimed it, or null when none or several did.
 */
export function aliasResolver(
  tracks: Iterable<TrackEntry>,
): (alias: number, direction: 'tx' | 'rx') => TrackEntry | null {
  const byAlias = new Map<string, TrackEntry[]>()
  for (const track of tracks) {
    if (track.trackAlias == null) continue
    const list = byAlias.get(track.trackAlias)
    if (list) list.push(track)
    else byAlias.set(track.trackAlias, [track])
  }
  return (alias, direction) => {
    const claims = byAlias.get(String(alias))
    if (!claims) return null
    const matching = claims.filter((t) => dataDirection(t) === direction)
    return matching.length === 1 ? matching[0] : null
  }
}

/** A data stream and the track it carries. */
export interface TrackStream {
  stream: StreamEntry
  track: TrackEntry
  kind: 'subgroup' | 'fetch'
  /** The alias (subgroup) or request id (fetch) the stream's header carries */
  id: number
}

/**
 * Every data stream of `session` whose track `include` accepts. An alias
 * resolves only as {@link aliasResolver} says; a stream whose alias is
 * ambiguous is left out. A draft-22 fill fetch carries the SUBSCRIBE's request
 * id (transport-22 3.4), so a fetch stream's track may be any request kind.
 */
export function locateTrackStreams(
  session: Pick<SessionEntry, 'streams' | 'tracks'>,
  include: (track: TrackEntry) => boolean,
): TrackStream[] {
  let any = false
  for (const track of session.tracks.values()) {
    if (include(track)) {
      any = true
      break
    }
  }
  if (!any) return []

  const resolve = aliasResolver(session.tracks.values())
  const found: TrackStream[] = []
  for (const stream of session.streams.values()) {
    if (stream.isControl) continue
    let track: TrackEntry | null | undefined
    let kind: 'subgroup' | 'fetch'
    let id: number
    if (stream.fetchRequestId != null) {
      track = session.tracks.get(String(stream.fetchRequestId))
      kind = 'fetch'
      id = stream.fetchRequestId
    } else if (stream.trackAlias != null) {
      track = resolve(stream.trackAlias, stream.direction)
      kind = 'subgroup'
      id = stream.trackAlias
    } else {
      continue
    }
    if (track && include(track)) found.push({ stream, track, kind, id })
  }
  return found
}

/** Every data stream of `session` whose track is a catalog track. */
export function locateCatalogStreams(
  session: Pick<SessionEntry, 'streams' | 'tracks'>,
): CatalogStreamRef[] {
  const refs: CatalogStreamRef[] = []
  for (const { stream, track, kind, id } of locateTrackStreams(session, (t) =>
    isCatalogTrackName(t.trackName),
  )) {
    const namespace = namespaceText(track.trackNamespace)
    refs.push({
      streamId: stream.streamId,
      key: trackKey(namespace, track.trackName),
      namespace,
      name: track.trackName,
      kind,
      id,
      direction: stream.direction,
      closed: stream.closed,
      byteCount: stream.byteCount,
    })
  }
  return refs
}

// ─── What the panel keeps ─────────────────────────────────────────

/**
 * A problem with a catalog object: the library's, plus `object_order` for the
 * Group rules, which need the Group and Object IDs. Every rule either source
 * checks is a MUST, a Required field or a value's JSON type (msf 5), so each
 * is an error.
 */
export interface CatalogObjectProblem extends Omit<CatalogProblem, 'category' | 'severity'> {
  severity: 'error'
  category: CatalogProblemCategory | 'object_order'
}

function asObjectProblem(p: CatalogProblem): CatalogObjectProblem {
  return { ...p, severity: 'error' }
}

/**
 * What became of one catalog object.
 *
 * - `applied`: it changed the catalog
 * - `refused`: it broke a rule that binds the reader; the catalog stayed as it was
 * - `skipped`: a delta with nothing to apply to, because the independent
 *   catalog its Group starts with was not recorded
 */
export type CatalogObjectOutcome = 'applied' | 'refused' | 'skipped'

export interface CatalogObjectRecord {
  groupId: number
  subgroupId: number
  objectId: number
  /** The stream it was first read from; a FETCH may carry it again */
  streamId: number
  /** Payload bytes */
  size: number
  kind: ParsedCatalog['kind']
  draft: CatalogDraft | null
  outcome: CatalogObjectOutcome
  problems: CatalogObjectProblem[]
}

/** One catalog track as it stands now. */
export interface CatalogView {
  key: TrackKey
  namespace: string
  name: string
  /** The catalog with every applied object, as the media library keeps it */
  state: CatalogState
  /** The tracks it declares, normalised */
  tracks: CatalogTrack[]
  /** MSF-01 `publishTracks`: tracks the catalog asks to be published */
  publishTracks: CatalogTrack[]
  /** Every object read, in Group and Object order */
  objects: CatalogObjectRecord[]
  /** The data streams it was read from */
  streamIds: number[]
  /** Why objects the track sent may be missing; empty when none are known */
  incomplete: string[]
}

// ─── One catalog track ────────────────────────────────────────────

interface Entry extends CatalogObjectRecord {
  parsed: ParsedCatalog
  /** Problems known before applying: the library's parse problems and ours */
  readProblems: CatalogObjectProblem[]
}

/** Group ID, then Object ID: the order a catalog track's objects apply in. */
function compareEntries(
  a: { groupId: number; objectId: number },
  b: { groupId: number; objectId: number },
): number {
  return a.groupId - b.groupId || a.objectId - b.objectId
}

/** The MSF draft whose section 5 states a catalog's Group rules. */
function groupRuleSection(draft: CatalogDraft | null): string | null {
  if (draft === 'msf-00' || draft === 'cmsf-00') return 'MSF-00 5'
  if (draft === 'msf-01' || draft === 'cmsf-01') return 'MSF-01 5'
  return null
}

/**
 * The Group rules: the first object of a Group is independent (msf-00 5,
 * msf-01 5); from MSF-01 the rest of the Group is deltas, all in Subgroup 0.
 * The object still applies.
 */
function orderProblems(
  parsed: ParsedCatalog,
  groupId: number,
  subgroupId: number,
  objectId: number,
): CatalogObjectProblem[] {
  if (parsed.kind !== 'independent' && parsed.kind !== 'delta') return []
  // An open draft still has one Group rule when every candidate shares it.
  const drafts = parsed.draft ? [parsed.draft] : parsed.candidates
  const sections = new Set(drafts.map(groupRuleSection))
  const section = sections.size === 1 ? [...sections][0] : null
  if (!section) return []
  const msf01 = section === 'MSF-01 5'
  const problems: CatalogObjectProblem[] = []
  if (parsed.kind === 'delta' && objectId === 0) {
    problems.push({
      severity: 'error',
      category: 'object_order',
      path: '',
      section,
      message: `Object 0 of group ${groupId} is a delta; the first catalog object of a group must be independent.`,
    })
  }
  if (msf01 && parsed.kind === 'independent' && objectId > 0) {
    problems.push({
      severity: 'error',
      category: 'object_order',
      path: '',
      section,
      message: `Object ${objectId} of group ${groupId} is independent; every object after the first in a group must be a delta, and an independent catalog starts a new group.`,
    })
  }
  if (msf01 && subgroupId !== 0) {
    problems.push({
      severity: 'error',
      category: 'object_order',
      path: '',
      section,
      message: `Sent on subgroup ${subgroupId}; every catalog object must be on subgroup 0.`,
    })
  }
  return problems
}

/**
 * The objects of one catalog track, parsed, sorted by Group and Object ID and
 * applied up to `applied`. An object sorting before an applied one replays
 * the log from the start.
 */
class CatalogLog {
  readonly entries: Entry[] = []
  private readonly ids = new Set<string>()
  private applied = 0
  private replay = false
  state: CatalogState
  /** Group of the independent catalog `state` rests on; null before one */
  private baseGroup: number | null = null
  /** Groups whose deltas had no independent catalog to apply to */
  readonly missingBase = new Set<number>()
  readonly streamIds = new Set<number>()

  constructor(
    readonly key: TrackKey,
    readonly namespace: string,
    readonly name: string,
  ) {
    this.state = createCatalogState({ catalogNamespace: namespace })
  }

  /** Add one object's payload. False when the track already had it. */
  add(
    streamId: number,
    groupId: number,
    subgroupId: number,
    objectId: number,
    payload: Uint8Array,
  ): boolean {
    this.streamIds.add(streamId)
    // A subscription and its joining FETCH deliver the same objects.
    const id = `${groupId}:${objectId}`
    if (this.ids.has(id)) return false
    this.ids.add(id)

    const parsed = parseCatalog(payload, { catalogNamespace: this.namespace })
    const readProblems: CatalogObjectProblem[] = [
      // The draft badge shows every candidate draft.
      ...parsed.problems.filter((p) => p.category !== 'ambiguous_draft').map(asObjectProblem),
      ...orderProblems(parsed, groupId, subgroupId, objectId),
    ]
    const entry: Entry = {
      groupId,
      subgroupId,
      objectId,
      streamId,
      size: payload.length,
      kind: parsed.kind,
      draft: parsed.draft,
      outcome: 'skipped',
      problems: readProblems,
      parsed,
      readProblems,
    }

    // Live objects arrive in order, so search from the end.
    let at = this.entries.length
    while (at > 0 && compareEntries(this.entries[at - 1], entry) > 0) at--
    this.entries.splice(at, 0, entry)
    if (at < this.applied) this.replay = true
    return true
  }

  /** Apply what has not been applied, from the start if order demands it. */
  settle(): void {
    if (this.replay) {
      this.replay = false
      this.applied = 0
      this.state = createCatalogState({ catalogNamespace: this.namespace })
      this.baseGroup = null
      this.missingBase.clear()
    }
    for (; this.applied < this.entries.length; this.applied++) {
      this.apply(this.entries[this.applied])
    }
  }

  private apply(entry: Entry): void {
    const { parsed } = entry
    if (parsed.kind === 'delta') {
      // A delta applies only to the independent catalog starting its own
      // Group (msf-00 5, msf-01 5).
      if (this.baseGroup !== entry.groupId) {
        // An object 0 that arrived but was not independent has its own problem.
        if (!this.ids.has(`${entry.groupId}:0`)) {
          this.missingBase.add(entry.groupId)
        }
        entry.outcome = 'skipped'
        entry.problems = entry.readProblems
        return
      }
    }
    const update = applyCatalogObject(this.state, parsed)
    entry.problems = [...entry.readProblems, ...update.problems.map(asObjectProblem)]
    entry.outcome = update.applied ? 'applied' : 'refused'
    if (update.applied) {
      this.state = update.state
      if (parsed.kind === 'independent') this.baseGroup = entry.groupId
    }
  }
}

// ─── A session's catalogs ─────────────────────────────────────────

/** How far one catalog stream has been read. */
interface StreamProgress {
  key: TrackKey
  kind: CatalogStreamRef['kind']
  id: number
  /** Bytes of the stream the last read saw */
  readBytes: number
  /** Objects of the stream already taken, in framing order */
  consumed: number
  closed: boolean
  /** The stream was closed and its bytes have all been read */
  done: boolean
  /** The background had no bytes for it */
  unavailable: boolean
  /** Its bytes did not frame as the stream its header names */
  unframed: boolean
  /** Closed with an object cut short */
  truncated: boolean
  /** Gone from the session before it was read in full */
  vanished: boolean
}

/**
 * Every catalog of one session, read incrementally: call {@link sync} when
 * the session changes, read the streams it returns and pass their bytes to
 * {@link ingest}.
 */
export class SessionCatalogs {
  private readonly logs = new Map<TrackKey, CatalogLog>()
  private readonly progress = new Map<number, StreamProgress>()
  private pausedSeen = false
  private cache: CatalogView[] | null = null
  /** Bumped whenever what {@link views} returns may have changed */
  revision = 0

  /**
   * Bring the set of catalog streams up to date with `session`, and return
   * those with bytes not yet read: new streams, streams that grew, and
   * streams that closed since they were last read.
   */
  sync(
    session: Pick<SessionEntry, 'streams' | 'tracks' | 'streamRecording'>,
  ): CatalogStreamRef[] {
    let changed = false

    if (session.streamRecording === false && !this.pausedSeen) {
      this.pausedSeen = true
      changed = true
    }

    // Listed before any of its data arrives.
    for (const track of session.tracks.values()) {
      if (!isCatalogTrackName(track.trackName)) continue
      const namespace = namespaceText(track.trackNamespace)
      const key = trackKey(namespace, track.trackName)
      if (!this.logs.has(key)) {
        this.logs.set(key, new CatalogLog(key, namespace, track.trackName))
        changed = true
      }
    }

    const toRead: CatalogStreamRef[] = []
    for (const ref of locateCatalogStreams(session)) {
      let p = this.progress.get(ref.streamId)
      if (!p) {
        p = {
          key: ref.key,
          kind: ref.kind,
          id: ref.id,
          readBytes: 0,
          consumed: 0,
          closed: false,
          done: false,
          unavailable: false,
          unframed: false,
          truncated: false,
          vanished: false,
        }
        this.progress.set(ref.streamId, p)
        changed = true
      } else if (p.key !== ref.key) {
        // Alias claimed again by another track; read objects stay put.
        continue
      }
      if (p.done) continue
      if (ref.byteCount > p.readBytes || (ref.closed && !p.closed)) {
        toRead.push(ref)
      }
    }

    for (const [streamId, p] of this.progress) {
      if (p.done || p.vanished) continue
      if (!session.streams.has(streamId)) {
        p.vanished = true
        changed = true
      }
    }

    if (changed) this.touch()
    return toRead
  }

  /**
   * Read one catalog stream's bytes: frame them by `draft`, take the objects
   * not taken before, and apply them. `data` null means the bytes could not
   * be had.
   */
  ingest(ref: CatalogStreamRef, data: Uint8Array | null, draft?: string): void {
    const p = this.progress.get(ref.streamId)
    if (!p || p.key !== ref.key) return
    const log = this.logFor(ref)

    if (!data) {
      if (ref.byteCount > 0 && !p.unavailable) {
        p.unavailable = true
        this.touch()
      }
      return
    }
    p.unavailable = false
    p.readBytes = data.length
    p.closed = ref.closed

    // Rejects a framing of another kind or track.
    const matches = (f: ParsedStreamFraming | null): f is ParsedStreamFraming =>
      f != null &&
      f.streamType === ref.kind &&
      (ref.kind === 'subgroup'
        ? f.headerFields.trackAlias === ref.id
        : f.headerFields.requestId === ref.id)
    let framing = parseStreamFraming(data, draft)
    // A stream ending inside an object: read its complete objects.
    let cut = false
    if (!matches(framing) && draft !== undefined) {
      const prefix = parseStreamPrefix(data, draft, ref.kind)
      framing = prefix?.framing ?? null
      cut = prefix != null
    }
    if (!matches(framing)) {
      p.unframed = ref.closed
      p.done = ref.closed
      if (ref.closed) this.touch()
      return
    }
    p.unframed = false

    const objects = framing.objects
    let i = p.consumed
    for (; i < objects.length; i++) {
      const obj = objects[i]
      const end = obj.payloadOffset + obj.payloadLength
      if (end > data.length) break
      if (obj.payloadLength === 0) continue
      const groupId = obj.groupId ?? framing.headerFields.groupId ?? 0
      const subgroupId = obj.subgroupId ?? framing.headerFields.subgroupId ?? 0
      log.add(
        ref.streamId,
        groupId,
        subgroupId,
        obj.objectId,
        data.subarray(obj.payloadOffset, end),
      )
    }
    p.consumed = i
    p.truncated = ref.closed && (cut || i < objects.length)
    p.done = ref.closed
    log.streamIds.add(ref.streamId)
    log.settle()
    this.touch()
  }

  /** Every catalog track of the session, in the order they were found. */
  views(): CatalogView[] {
    if (this.cache) return this.cache
    this.cache = Array.from(this.logs.values(), (log) => this.viewOf(log))
    return this.cache
  }

  /** The catalog a stream was read for, when it is a catalog stream. */
  viewForStream(streamId: number): CatalogView | null {
    const p = this.progress.get(streamId)
    if (!p) return null
    return this.views().find((v) => v.key === p.key) ?? null
  }

  private logFor(ref: CatalogStreamRef): CatalogLog {
    let log = this.logs.get(ref.key)
    if (!log) {
      log = new CatalogLog(ref.key, ref.namespace, ref.name)
      this.logs.set(ref.key, log)
    }
    return log
  }

  private touch(): void {
    this.cache = null
    this.revision++
  }

  private viewOf(log: CatalogLog): CatalogView {
    const incomplete: string[] = []
    if (this.pausedSeen) {
      incomplete.push(
        'Stream recording was paused; catalog objects sent meanwhile were not recorded.',
      )
    }
    for (const [streamId, p] of this.progress) {
      if (p.key !== log.key) continue
      if (p.unavailable) {
        incomplete.push(`No bytes are stored for stream ${streamId}.`)
      } else if (p.vanished) {
        incomplete.push(
          `Stream ${streamId} was cleared before it was read in full.`,
        )
      } else if (p.unframed) {
        incomplete.push(
          `Stream ${streamId} closed but its bytes do not frame as a ${p.kind} stream.`,
        )
      } else if (p.truncated) {
        incomplete.push(`Stream ${streamId} closed inside an object.`)
      }
    }
    for (const group of log.missingBase) {
      incomplete.push(
        `The independent catalog that starts group ${group} was not recorded.`,
      )
    }
    const records: CatalogObjectRecord[] = log.entries.map(
      ({ parsed: _p, readProblems: _r, ...record }) => record,
    )
    const document = log.state.document
    const options = { catalogNamespace: log.namespace }
    return {
      key: log.key,
      namespace: log.namespace,
      name: log.name,
      state: log.state,
      tracks: catalogTracks(document, options),
      publishTracks: catalogTracks(document, { ...options, publish: true }),
      objects: records,
      streamIds: Array.from(log.streamIds),
      incomplete,
    }
  }
}

// ─── Packaging join ───────────────────────────────────────────────

/** What one catalog says about one track. */
export interface PackagingClaim {
  /** The catalog track that says it */
  catalog: TrackKey
  /** That catalog track's namespace and name, as the panel writes a track */
  catalogName: string
  track: CatalogTrack
  /** Declared in `publishTracks` rather than `tracks` */
  publish: boolean
  /** The draft of that catalog, or the drafts it may be while open */
  drafts: readonly CatalogDraft[]
}

/** What the session's catalogs say about one track. */
export interface TrackPackaging extends PackagingClaim {
  /** Every catalog's description of the track, the first one included */
  claims: PackagingClaim[]
}

/**
 * Every track the session's catalogs describe, keyed like the registry's
 * tracks so the two join on (namespace text, name). The entry's own fields
 * are the first description found, `tracks` before `publishTracks`; `claims`
 * holds them all.
 */
export function packagingIndex(
  views: readonly CatalogView[],
): Map<TrackKey, TrackPackaging> {
  const index = new Map<TrackKey, TrackPackaging>()
  for (const publish of [false, true]) {
    for (const view of views) {
      for (const track of publish ? view.publishTracks : view.tracks) {
        const key = trackKey(track.namespace, track.name)
        const claim: PackagingClaim = {
          catalog: view.key,
          catalogName: `${view.namespace} / ${view.name}`,
          track,
          publish,
          drafts: view.state.draft ? [view.state.draft] : view.state.candidates,
        }
        const entry = index.get(key)
        if (entry) entry.claims.push(claim)
        else index.set(key, { ...claim, claims: [claim] })
      }
    }
  }
  return index
}

/** One field on which a track's catalog descriptions differ. */
export interface PackagingConflict {
  field: 'packaging' | 'codec'
  /** Each description's value, null where it gives none */
  values: { catalogName: string; value: string | null }[]
}

/**
 * Where a track's catalog descriptions disagree: on packaging, or on codec
 * between descriptions that give one.
 */
export function packagingConflicts(p: TrackPackaging): PackagingConflict[] {
  const out: PackagingConflict[] = []
  const valuesOf = (get: (t: CatalogTrack) => string | null | undefined) =>
    p.claims.map((c) => ({ catalogName: c.catalogName, value: get(c.track) ?? null }))
  const packaging = valuesOf((t) => t.packaging)
  if (new Set(packaging.map((v) => v.value)).size > 1) {
    out.push({ field: 'packaging', values: packaging })
  }
  const codecs = valuesOf((t) => t.codec)
  if (new Set(codecs.filter((v) => v.value !== null).map((v) => v.value)).size > 1) {
    out.push({ field: 'codec', values: codecs })
  }
  return out
}

/** Every draft the catalogs describing a track are, or may be. */
export function catalogDrafts(p: TrackPackaging | undefined): Set<CatalogDraft> {
  return new Set(p?.claims.flatMap((c) => [...c.drafts]) ?? [])
}

/** A value every description gives alike, absence included; undefined when they differ. */
export function agreedValue<T>(
  p: TrackPackaging | undefined,
  get: (t: CatalogTrack) => T | null,
): T | null | undefined {
  if (!p) return null
  const values = new Set(p.claims.map((c) => get(c.track) ?? null))
  return values.size === 1 ? [...values][0]! : undefined
}

/** The packaging every description of the track gives, or null when they differ. */
export function agreedPackaging(p: TrackPackaging | undefined): string | null {
  if (!p) return null
  const values = new Set(p.claims.map((c) => c.track.packaging ?? null))
  return values.size === 1 ? [...values][0]! : null
}

/** The codec the descriptions that give one agree on, or null. */
export function agreedCodec(p: TrackPackaging | undefined): string | null {
  if (!p) return null
  const values = new Set(
    p.claims.map((c) => c.track.codec ?? null).filter((v) => v !== null),
  )
  return values.size === 1 ? [...values][0]! : null
}

/** A packaging value as a badge says it. */
export function packagingLabel(packaging: string | null): string | null {
  switch (packaging) {
    case null:
      return null
    case 'loc':
      return 'LOC'
    case 'cmaf':
      return 'CMAF'
    case 'mediatimeline':
      return 'media timeline'
    case 'eventtimeline':
      return 'event timeline'
    case 'moqlog':
      return 'log'
    case 'moqmetrics':
      return 'metrics'
    default:
      return packaging
  }
}

/**
 * A catalog track's shape in a few words: codec and picture size for video,
 * codec and sample rate for audio, whatever there is otherwise.
 */
export function trackSummary(track: CatalogTrack): string {
  const parts: string[] = []
  if (track.codec) parts.push(track.codec)
  if (track.width != null && track.height != null) {
    parts.push(`${track.width}×${track.height}`)
  }
  if (track.framerate != null) parts.push(`${track.framerate} fps`)
  if (track.samplerate != null) parts.push(`${track.samplerate} Hz`)
  if (track.channelConfig) parts.push(`ch ${track.channelConfig}`)
  if (parts.length === 0 && track.mimeType) parts.push(track.mimeType)
  if (parts.length === 0 && track.eventType) parts.push(track.eventType)
  return parts.join(' · ')
}

// ─── Vue ──────────────────────────────────────────────────────────

/** One reader per session, so returning to its view does not parse again. */
const readers = new WeakMap<SessionEntry, SessionCatalogs>()

function readerFor(session: SessionEntry): SessionCatalogs {
  const raw = toRaw(session)
  let reader = readers.get(raw)
  if (!reader) {
    reader = new SessionCatalogs()
    readers.set(raw, reader)
  }
  return reader
}

export interface SessionCatalogsView {
  /** Every catalog track of the session */
  catalogs: ComputedRef<CatalogView[]>
  /** Catalog-described tracks keyed by {@link registryTrackKey} */
  packaging: ComputedRef<Map<TrackKey, TrackPackaging>>
  /** The catalog a stream belongs to, when it is a catalog stream */
  catalogForStream: (streamId: number) => CatalogView | null
}

/**
 * A session's catalogs, kept current while the caller is mounted. Reads go
 * out one stream at a time.
 */
export function useSessionCatalogs(
  session: () => SessionEntry,
  getStreamData: (
    sessionId: string,
    streamId: number,
  ) => Promise<Uint8Array | null>,
): SessionCatalogsView {
  const revision = shallowRef(0)
  const reader = computed(() => readerFor(session()))

  /** Everything a catalog read depends on, so other chunks do not fire it. */
  const signature = computed(() => {
    const s = session()
    const parts: string[] = [s.sessionId, String(s.streamRecording !== false)]
    for (const ref of locateCatalogStreams(s)) {
      parts.push(`${ref.streamId}:${ref.key}:${ref.byteCount}:${ref.closed}`)
    }
    for (const track of s.tracks.values()) {
      if (isCatalogTrackName(track.trackName)) parts.push(track.subscribeId)
    }
    return parts.join('|')
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
        const toRead = r.sync(s)
        for (const ref of toRead) {
          if (stopped) return
          let data: Uint8Array | null = null
          try {
            data = await getStreamData(s.sessionId, ref.streamId)
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

  watch(signature, () => void pump(), { immediate: true })
  onBeforeUnmount(() => {
    stopped = true
  })

  const catalogs = computed(() => {
    void revision.value
    return reader.value.views()
  })
  const packaging = computed(() => packagingIndex(catalogs.value))

  return {
    catalogs,
    packaging,
    catalogForStream: (streamId) => {
      void revision.value
      return reader.value.viewForStream(streamId)
    },
  }
}

/** Re-exported so components need not import the media package for a type. */
export type { CatalogTrack }
