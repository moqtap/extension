/**
 * LOC tracks, read in the panel. Which tracks are LOC follows
 * `mediaPackaging` in packaging.ts: the catalogs' packaging. A track's profile
 * comes from the property IDs its objects carry, under the rules of
 * `@moqtap/media/loc`: one possible profile, or the track is ambiguous and the
 * candidates are reported.
 */

import type { ObjectProperty } from '@moqtap/codec'
import {
  analyzeLocPayload,
  type DecodeLocOptions,
  decodeLocProperties,
  decodeLocTrackProperties,
  describeProfile,
  type FrameMarking,
  LOC_PROFILES,
  type LocPayloadFraming,
  type LocProfile,
  type LocPropertyResult,
  type LocPropertyType,
  type LocResolution,
  locPropertyTypes,
  type NalFraming,
  possibleProfiles,
  resolveProfile,
  type TransportDraft,
  type VideoConfig,
  videoCodecFamily,
} from '@moqtap/media/loc'
import {
  computed,
  type ComputedRef,
  onBeforeUnmount,
  shallowRef,
  toRaw,
  watch,
} from 'vue'
import {
  agreedCodec,
  aliasResolver,
  locateTrackStreams,
  type PackagingConflict,
  packagingConflicts,
  registryTrackKey,
  type TrackKey,
  type TrackPackaging,
} from './catalogs'
import {
  decodeObjectProperties,
  type ParsedStreamFraming,
  parseDatagramGroupFraming,
  parseStreamFraming,
  parseStreamPrefix,
  type StreamObject,
} from './stream-framing'
import { messageTypeName } from './format'
import { mediaPackaging } from './packaging'
import {
  makeProblem,
  objectLabel,
  type PanelProblem,
  type ProblemPlace,
  specsFromSection,
  trackSubject,
} from './problems'
import { type TrackPropertyList, trackPropertyLists } from './track-properties'
import type { SessionEntry, TrackEntry } from './use-inspector'

const TRANSPORT_DRAFTS = new Set<string>([
  '08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19',
  '20', '21', '22',
])

/** The session draft as `@moqtap/media/loc` names it; undefined for one it does not cover. */
export function transportDraftOf(draft: string | undefined): TransportDraft | undefined {
  return draft !== undefined && TRANSPORT_DRAFTS.has(draft)
    ? (draft as TransportDraft)
    : undefined
}

// ─── Sources ──────────────────────────────────────────────────────

/** A data stream (`s:<id>`) or a datagram group (`d:<group key>`). */
export type LocSource = string

export function streamSource(streamId: number): LocSource {
  return `s:${streamId}`
}

export function datagramSource(groupKey: string): LocSource {
  return `d:${groupKey}`
}

/**
 * The track a stream or datagram group carries: by request id for a fetch
 * stream, otherwise by alias as {@link aliasResolver} resolves it.
 */
export function trackForSource(
  session: Pick<SessionEntry, 'streams' | 'tracks' | 'datagramGroups'>,
  source: LocSource,
): TrackEntry | null {
  let alias: number | undefined
  let direction: 'tx' | 'rx'
  if (source.startsWith('d:')) {
    const group = session.datagramGroups.get(source.slice(2))
    if (!group) return null
    alias = group.trackAlias
    direction = group.direction
  } else {
    const stream = session.streams.get(Number(source.slice(2)))
    if (!stream || stream.isControl) return null
    if (stream.fetchRequestId != null) {
      return session.tracks.get(String(stream.fetchRequestId)) ?? null
    }
    alias = stream.trackAlias
    direction = stream.direction
  }
  if (alias == null) return null
  return aliasResolver(session.tracks.values())(alias, direction)
}

/** A source of a LOC track with bytes the reader has not seen. */
export interface LocSourceRef {
  source: LocSource
  key: TrackKey
  kind: 'subgroup' | 'fetch' | 'datagram'
  /** The stream's id, for a stream */
  streamId?: number
  /** The group's key, for a datagram group */
  groupKey?: string
  /** The alias (subgroup, datagram) or request id (fetch) its framing carries */
  id: number
  closed: boolean
  byteCount: number
  firstDataAt?: number
}

/**
 * The sources of the tracks `include` accepts: their data streams, and their
 * datagram groups.
 */
export function listSources(
  session: Pick<SessionEntry, 'streams' | 'tracks' | 'datagramGroups'>,
  include: (track: TrackEntry) => boolean,
): LocSourceRef[] {
  const refs: LocSourceRef[] = []
  for (const { stream, track, kind, id } of locateTrackStreams(session, include)) {
    refs.push({
      source: streamSource(stream.streamId),
      key: registryTrackKey(track),
      kind,
      streamId: stream.streamId,
      id,
      closed: stream.closed,
      byteCount: stream.byteCount,
      ...(stream.firstDataAt !== undefined ? { firstDataAt: stream.firstDataAt } : {}),
    })
  }
  if (session.datagramGroups.size > 0) {
    const resolve = aliasResolver(session.tracks.values())
    for (const group of session.datagramGroups.values()) {
      const track = resolve(group.trackAlias, group.direction)
      if (!track || !include(track)) continue
      refs.push({
        source: datagramSource(group.groupKey),
        key: registryTrackKey(track),
        kind: 'datagram',
        groupKey: group.groupKey,
        id: group.trackAlias,
        closed: group.closed,
        byteCount: group.byteCount,
        ...(group.firstDataAt !== undefined ? { firstDataAt: group.firstDataAt } : {}),
      })
    }
  }
  return refs
}

/** Frame a source's bytes as the stream or datagram group it is, or null. */
export function frameSource(
  ref: Pick<LocSourceRef, 'kind' | 'id'>,
  data: Uint8Array,
  draft: string | undefined,
): ParsedStreamFraming | null {
  if (ref.kind === 'datagram') {
    const framing = parseDatagramGroupFraming(data, draft)
    return framing?.headerFields.trackAlias === ref.id ? framing : null
  }
  const matches = (f: ParsedStreamFraming | null): f is ParsedStreamFraming =>
    f != null &&
    f.streamType === ref.kind &&
    (ref.kind === 'subgroup'
      ? f.headerFields.trackAlias === ref.id
      : f.headerFields.requestId === ref.id)
  const framing = parseStreamFraming(data, draft)
  if (matches(framing)) return framing
  if (draft === undefined) return null
  // A stream that ends inside an object: its complete objects.
  const prefix = parseStreamPrefix(data, draft, ref.kind)
  return matches(prefix?.framing ?? null) ? prefix!.framing : null
}

/** How far one source has been read. */
interface SourceProgress {
  key: TrackKey
  readBytes: number
  closed: boolean
  done: boolean
  firstDataAt?: number
}

// ─── Objects ──────────────────────────────────────────────────────

/** One object of a LOC track, as far as the track's profile needs it. */
export interface LocObjectRecord {
  source: LocSource
  /** Byte offset of the object in its source */
  offset: number
  groupId: number
  objectId: number
  payloadLength: number
  status?: number
  /** Absent when the object had no properties field */
  propertiesOffset?: number
  propertiesLength?: number
  /** The decoded property block, its bytes copied out of the source */
  properties: readonly ObjectProperty[]
  /** The block did not decode under the session's draft */
  propertiesError?: string
}

function recordKey(source: LocSource, offset: number): string {
  return `${source}@${offset}`
}

/** Decode one object's property block from its source bytes. */
export function readObjectRecord(
  source: LocSource,
  obj: StreamObject,
  groupId: number,
  data: Uint8Array,
  draft: string | undefined,
): LocObjectRecord {
  const record: LocObjectRecord = {
    source,
    offset: obj.offset,
    groupId,
    objectId: obj.objectId,
    payloadLength: obj.payloadLength,
    properties: [],
  }
  if (obj.status !== undefined) record.status = obj.status
  if (obj.propertiesOffset === undefined) return record
  const length = obj.propertiesLength ?? 0
  record.propertiesOffset = obj.propertiesOffset
  record.propertiesLength = length
  if (length === 0) return record
  const block = data.slice(obj.propertiesOffset, obj.propertiesOffset + length)
  const decoded = draft === undefined ? null : decodeObjectProperties(block, draft)
  if (decoded === null) return record
  if (!decoded.ok) {
    record.propertiesError = decoded.error.message
  } else {
    record.properties = decoded.value
  }
  return record
}

// ─── Track state ──────────────────────────────────────────────────

export interface LocTrackState {
  key: TrackKey
  /** Why the track is read as LOC */
  via: 'catalog'
  /** Objects read so far */
  objectCount: number
  /** Objects whose property block did not decode; they count toward nothing */
  malformedCount: number
  /** Property types that count toward the profile, ascending */
  types: LocPropertyType[]
  possible: LocProfile[]
  resolution: LocResolution
  /** The codec string the catalogs give, when those that give one agree */
  codec?: string
  /** Where the catalogs describing the track disagree */
  conflicts?: PackagingConflict[]
  /** The track's Track Properties, decoded under `resolution` */
  trackProperties: LocPropertyResult[]
  /** The distinct Timescales its Track Properties carry */
  trackTimescales: TrackTimescale[]
}

export interface TrackTimescale {
  value: bigint
  /** The messages that carry it, as the panel names them */
  messages: string[]
}

/** One profile, ambiguity between candidates, or no profile at all. */
export function resolutionLabel(resolution: LocResolution): string {
  if ('profile' in resolution) return resolution.profile
  if (resolution.candidates.length === 0) return 'no profile fits'
  return `ambiguous: ${resolution.candidates.join(', ')}`
}

function resolutionSignature(resolution: LocResolution): string {
  return 'profile' in resolution
    ? resolution.profile
    : `?${resolution.candidates.join(',')}`
}

interface TrackLog {
  key: TrackKey
  objectCount: number
  malformedCount: number
  /** By {@link typeKey} */
  types: Map<string, LocPropertyType>
  /** Object 0 of each group, which the group-start check reads */
  groupStarts: LocObjectRecord[]
  /** Objects carrying a property ID that some profile defines as Video Config */
  configCarriers: LocObjectRecord[]
  /** H.264 and H.265 payloads that read with 3-byte start codes or with length prefixes */
  payloads: PayloadFacts[]
}

/** What one payload's bytes allow, for the track-wide start code rule (LOC 2.1.4). */
interface PayloadFacts {
  record: LocObjectRecord
  family: 'h264' | 'h265'
  /** It reads as start codes, with a 3-byte one; otherwise it does not read as start codes */
  threeByte: boolean
  /** The length sizes under which it reads with length prefixes */
  lengthSizes: number[]
  /** Of those, the sizes under which every reading has length prefixes, then 3-byte start codes */
  mixedThreeByteSizes: number[]
}

const LENGTH_SIZES = [1, 2, 3, 4]

/**
 * The facts of one payload, or null when it neither has a 3-byte start code
 * nor reads as lengths only. A payload that reads with 4-byte start codes
 * starts 00 00 00 01, which reads as no length prefix of any size (2.1.3).
 */
function payloadFacts(
  record: LocObjectRecord,
  payload: Uint8Array,
  family: 'h264' | 'h265',
): PayloadFacts | null {
  const readings = (r: LocPayloadFraming | null): NalFraming[] =>
    r === null ? [] : r.framing === 'ambiguous' ? r.candidates : [r]
  const usesLengths = (f: NalFraming) => f.framing === 'length-prefixed' || f.framing === 'mixed'
  const mixedThreeByte = (f: NalFraming) => f.framing === 'mixed' && f.threeByteStartCodes === true
  const four = readings(analyzeLocPayload(payload, family))
  const start = four.find((f) => f.framing === 'start-code')
  if (start && !start.threeByteStartCodes) return null
  const lengthSizes: number[] = []
  const mixedThreeByteSizes: number[] = []
  for (const lengthSize of [4, 1, 2, 3]) {
    const read =
      lengthSize === 4 ? four : readings(analyzeLocPayload(payload, family, { lengthSize }))
    const lengths = read.filter(usesLengths)
    if (lengths.length === 0) continue
    lengthSizes.push(lengthSize)
    if (!start && lengths.every(mixedThreeByte)) mixedThreeByteSizes.push(lengthSize)
  }
  if (!start && lengthSizes.length === 0) return null
  return { record, family, threeByte: start !== undefined, lengthSizes, mixedThreeByteSizes }
}

/** Property IDs some profile defines as Video Config. */
const VIDEO_CONFIG_IDS = new Set<bigint>(
  LOC_PROFILES.flatMap((p) =>
    describeProfile(p)
      .properties.filter((d) => d.meaning === 'video-config')
      .map((d) => BigInt(d.id)),
  ),
)

function definesVideoConfig(profile: LocProfile, type: bigint): boolean {
  return describeProfile(profile).properties.some(
    (d) => BigInt(d.id) === type && d.meaning === 'video-config',
  )
}

/** The Video Configs a track's objects and Track Properties carry, as far as they could be read. */
interface TrackVideoConfigs {
  configs: VideoConfig[]
  /** Objects, and the Track Properties, with a property that is, or may be, a Video Config not decoded */
  unread: number
  /** What each carrier object holds */
  byRecord: Map<LocObjectRecord, ObjectVideoConfig>
  /** The first object with a property that is a Video Config under every candidate */
  shownBy: LocObjectRecord | null
  /** The Track Properties hold a property that is a Video Config under every candidate */
  shownByTrack: boolean
}

interface ObjectVideoConfig {
  config?: VideoConfig
  unread: boolean
  /** A property is a Video Config under every candidate */
  shown: boolean
}

/**
 * The Video Config one object carries, decoded, and whether it has a
 * property that is, or under some candidate may be, a Video Config that did
 * not decode.
 */
function objectVideoConfig(results: readonly LocPropertyResult[]): ObjectVideoConfig {
  let config: VideoConfig | undefined
  let unread = false
  let shown = false
  for (const r of results) {
    if (r.transport || !VIDEO_CONFIG_IDS.has(r.type)) continue
    if (r.meaning === 'video-config') shown = true
    if (r.decoded?.kind === 'video-config') {
      config ??= r.decoded.config
    } else if (
      r.meaning === 'video-config' ||
      r.ambiguous?.some((a) => definesVideoConfig(a.profile, r.type))
    ) {
      unread = true
    }
  }
  return config ? { config, unread, shown } : { unread, shown }
}

/**
 * The NAL length sizes an object's payload may use (LOC 2.1.3): its own Video
 * Config's, else the track's, else 4; any size while a Video Config that
 * applies did not decode.
 */
function lengthSizesFor(record: LocObjectRecord, track: TrackVideoConfigs): number[] {
  const own = track.byRecord.get(record)
  if (own?.config) return [own.config.lengthSize]
  if (own?.unread || track.unread > 0) return LENGTH_SIZES
  if (track.configs.length === 0) return [4]
  return [...new Set(track.configs.map((c) => c.lengthSize))]
}

// ─── Per-object views ─────────────────────────────────────────────

/** One property of an object, with where its bytes sit in the source. */
export interface LocPropertyRow {
  result: LocPropertyResult
  /** Byte offset of its Type field in the source */
  offset: number
  /** Bytes from its Type field to the end of its value */
  length: number
}

export interface LocObjectView {
  record: LocObjectRecord
  properties: LocPropertyRow[]
  /**
   * How the payload delimits its NAL units, for an H.264 or H.265 track.
   * Null when the payload fits no framing; undefined when the codec is not
   * known or not one of those, or a Video Config on the track did not decode.
   */
  payload?: LocPayloadFraming | null
  /** The object has no Timescale of its own and the track's Track Properties give one */
  timescaleFromTrack?: true
}

/** Pair decoded results with the properties they came from, in block order. */
function propertyRows(
  record: LocObjectRecord,
  results: LocPropertyResult[],
): LocPropertyRow[] {
  const base = record.propertiesOffset ?? 0
  const rows: LocPropertyRow[] = []
  let i = 0
  for (const p of record.properties) {
    const r = results[i++]
    if (!r) break
    rows.push({ result: r, offset: base + p.offset, length: p.length })
    let inner = 0
    while (results[i]?.immutable && p.properties?.[inner]) {
      const q = p.properties[inner++]!
      rows.push({ result: results[i++]!, offset: base + q.offset, length: q.length })
    }
  }
  return rows
}

/**
 * A payload read under each length size `configs` give (LOC 2.1.3), 3-byte
 * start codes refused (2.1.4); ambiguous when the readings differ.
 */
function analyzeUnderConfigs(
  payload: Uint8Array,
  family: 'h264' | 'h265',
  configs: readonly VideoConfig[],
): LocPayloadFraming | null {
  const bySize = new Map<number, VideoConfig>()
  for (const c of configs) if (!bySize.has(c.lengthSize)) bySize.set(c.lengthSize, c)
  const found = new Map<string, NalFraming>()
  for (const config of bySize.values()) {
    const r = analyzeLocPayload(payload, family, config)
    if (r === null) continue
    for (const f of r.framing === 'ambiguous' ? r.candidates : [r]) {
      found.set(JSON.stringify(f), f)
    }
  }
  const all = [...found.values()]
  if (all.length === 0) return null
  if (all.length === 1) return all[0]!
  return { framing: 'ambiguous', candidates: all }
}

/**
 * The one Frame Marking an object carries, when it decodes to one reading:
 * one property with that meaning, read under one form.
 */
export function unambiguousFrameMarking(
  results: readonly LocPropertyResult[],
): FrameMarking | null {
  const marks = results.filter((r) => r.meaning === 'video-frame-marking')
  if (marks.length !== 1) return null
  const decoded = marks[0]!.decoded
  if (decoded?.kind !== 'video-frame-marking') return null
  return decoded.candidates.length === 1 ? decoded.candidates[0]! : null
}

// ─── Problems ─────────────────────────────────────────────────────

/** Where each profile's drafts give the video example (informative). */
const EXAMPLE_SECTIONS: Record<LocProfile, string> = {
  'ietf-00/01': 'LOC-00 5.2, LOC-01 4.2',
  'ietf-02': 'LOC-02 4.2',
  'ietf-03': 'LOC-03 4.2',
  'ietf-04': 'LOC-04 4.2',
  'mzanaty-05': 'mzanaty LOC-05 5.2',
}

function exampleSections(resolution: LocResolution): string {
  const profiles =
    'profile' in resolution ? [resolution.profile] : resolution.candidates
  return profiles.map((p) => EXAMPLE_SECTIONS[p]).join('; ')
}

/** Where each profile's drafts state the start code rule. */
const START_CODE_SECTIONS: Record<LocProfile, string> = {
  'ietf-00/01': 'LOC-00 2.1.4, LOC-01 2.1.4',
  'ietf-02': 'LOC-02 2.1.4',
  'ietf-03': 'LOC-03 2.1.4',
  'ietf-04': 'LOC-04 2.1.4',
  'mzanaty-05': 'mzanaty LOC-05 2.1.4',
}

function startCodeSections(resolution: LocResolution): string {
  const profiles =
    'profile' in resolution
      ? [resolution.profile]
      : resolution.candidates.length > 0
        ? resolution.candidates
        : LOC_PROFILES
  return profiles.map((p) => START_CODE_SECTIONS[p]).join('; ')
}

function objectPlace(record: LocObjectRecord, note: string | null): ProblemPlace {
  return {
    label: objectLabel(record.groupId, record.objectId),
    note,
    target: { kind: 'object', source: record.source, offset: record.offset },
  }
}

// ─── A session's LOC tracks ───────────────────────────────────────

/**
 * Every LOC track of one session, read incrementally: call {@link sync} when
 * the session changes, read the sources it returns and pass their bytes to
 * {@link ingest}. An open source is read again once its size has doubled
 * since the last read, and once more when it closes; objects already read
 * are not decoded again.
 */
export class SessionLoc {
  private readonly logs = new Map<TrackKey, TrackLog>()
  private readonly progress = new Map<LocSource, SourceProgress>()
  private readonly records = new Map<string, LocObjectRecord>()
  private readonly views = new Map<string, { signature: string; view: LocObjectView }>()
  private readonly starts = new Map<string, { signature: string; mark: FrameMarking | null }>()
  private readonly configs = new Map<
    TrackKey,
    { signature: string; count: number; value: TrackVideoConfigs }
  >()
  /** Each LOC track's codec family as of its last {@link sync}, null when not H.264 or H.265 */
  private readonly families = new Map<TrackKey, 'h264' | 'h265' | null>()
  /** Bumped whenever what the reader reports may have changed */
  revision = 0

  /** Whether `track` is read as LOC, and why. */
  locVia(
    track: TrackEntry,
    packaging: ReadonlyMap<TrackKey, TrackPackaging>,
  ): 'catalog' | null {
    const key = registryTrackKey(track)
    const media = mediaPackaging(packaging.get(key))
    return media?.packaging === 'loc' ? media.via : null
  }

  /**
   * The LOC sources due for a read: new ones with bytes, ones that doubled
   * since the last read, ones that closed. Changes nothing.
   */
  sync(
    session: Pick<SessionEntry, 'streams' | 'tracks' | 'datagramGroups'>,
    packaging: ReadonlyMap<TrackKey, TrackPackaging>,
  ): LocSourceRef[] {
    const refs = listSources(session, (t) => this.locVia(t, packaging) !== null)
    for (const ref of refs) {
      const codec = agreedCodec(packaging.get(ref.key))
      this.families.set(ref.key, codec ? videoCodecFamily(codec) : null)
    }
    return refs.filter((ref) => {
      if (ref.byteCount === 0) return false
      const p = this.progress.get(ref.source)
      if (!p) return true
      if (p.key !== ref.key || p.done) return false
      return ref.byteCount >= 2 * p.readBytes || (ref.closed && !p.closed)
    })
  }

  /**
   * Read one source's bytes: frame them by `draft` and decode the property
   * block of every object not read before. `data` null means the bytes could
   * not be had.
   */
  ingest(ref: LocSourceRef, data: Uint8Array | null, draft: string | undefined): void {
    let p = this.progress.get(ref.source)
    if (!p) {
      p = { key: ref.key, readBytes: 0, closed: false, done: false }
      this.progress.set(ref.source, p)
    }
    if (p.key !== ref.key || !data) return
    p.firstDataAt ??= ref.firstDataAt
    p.readBytes = Math.max(data.length, 1)
    p.closed = ref.closed
    p.done = ref.closed

    const framing = frameSource(ref, data, draft)
    if (!framing) return
    const log = this.logFor(ref.key)
    const transport = transportDraftOf(draft)
    const family = this.families.get(ref.key) ?? null
    let added = false
    for (const obj of framing.objects) {
      if (obj.payloadOffset + obj.payloadLength > data.length) break
      if (obj.endOfRange !== undefined) continue
      const key = recordKey(ref.source, obj.offset)
      if (this.records.has(key)) continue
      const groupId = obj.groupId ?? framing.headerFields.groupId ?? 0
      const record = readObjectRecord(ref.source, obj, groupId, data, draft)
      this.records.set(key, record)
      added = true
      log.objectCount++
      if (record.propertiesError !== undefined) {
        log.malformedCount++
      } else {
        for (const t of locPropertyTypes(record.properties, transport)) log.types.set(typeKey(t), t)
      }
      if (record.objectId === 0 && record.payloadLength > 0) log.groupStarts.push(record)
      if (
        locPropertyTypes(record.properties, transport).some((t) => VIDEO_CONFIG_IDS.has(t.type))
      ) {
        log.configCarriers.push(record)
      }
      if (family && obj.payloadLength > 0) {
        const payload = data.subarray(obj.payloadOffset, obj.payloadOffset + obj.payloadLength)
        const facts = payloadFacts(record, payload, family)
        if (facts) log.payloads.push(facts)
      }
    }
    if (added) this.revision++
  }

  private logFor(key: TrackKey): TrackLog {
    let log = this.logs.get(key)
    if (!log) {
      log = {
        key,
        objectCount: 0,
        malformedCount: 0,
        types: new Map(),
        groupStarts: [],
        configCarriers: [],
        payloads: [],
      }
      this.logs.set(key, log)
    }
    return log
  }

  /**
   * A LOC track's profile as its objects so far allow, and its Track
   * Properties read under it; null for a track that is not LOC.
   */
  trackState(
    track: TrackEntry,
    packaging: ReadonlyMap<TrackKey, TrackPackaging>,
    draft: string | undefined,
    trackProperties: readonly TrackPropertyList[] = [],
  ): LocTrackState | null {
    const via = this.locVia(track, packaging)
    if (!via) return null
    const key = registryTrackKey(track)
    const log = this.logs.get(key)
    const types = log ? [...log.types.values()].sort(compareTypes) : []
    const transport = transportDraftOf(draft)
    const possible = possibleProfiles(types, transport)
    const described = packaging.get(key)
    const codec = agreedCodec(described)
    const conflicts = described ? packagingConflicts(described) : []
    const resolution = resolveProfile(possible)

    const results: LocPropertyResult[] = []
    const timescales = new Map<bigint, Set<string>>()
    for (const list of trackProperties) {
      const decoded = decodeLocTrackProperties(list.properties, resolution, {
        ...(transport ? { transportDraft: transport } : {}),
        ...(codec ? { videoCodec: codec } : {}),
      })
      results.push(...decoded)
      for (const r of decoded) {
        if (r.decoded?.kind !== 'timescale') continue
        const value = r.decoded.unitsPerSecond
        const messages = timescales.get(value) ?? new Set()
        messages.add(messageTypeName(list.message.messageType))
        timescales.set(value, messages)
      }
    }
    return {
      key,
      via,
      objectCount: log?.objectCount ?? 0,
      malformedCount: log?.malformedCount ?? 0,
      types,
      possible,
      resolution,
      ...(codec ? { codec } : {}),
      ...(conflicts.length > 0 ? { conflicts } : {}),
      trackProperties: results,
      trackTimescales: [...timescales].map(([value, messages]) => ({
        value,
        messages: [...messages],
      })),
    }
  }

  /** The Video Configs the track's objects read so far and its Track Properties carry, under `state`. */
  private trackVideoConfigs(
    state: LocTrackState,
    draft: string | undefined,
    signature: string,
  ): TrackVideoConfigs {
    const options = this.decodeOptions(state, draft)
    const carriers = this.logs.get(state.key)?.configCarriers ?? []
    const cached = this.configs.get(state.key)
    let objects: TrackVideoConfigs
    if (cached && cached.signature === signature && cached.count === carriers.length) {
      objects = cached.value
    } else {
      objects = { configs: [], unread: 0, byRecord: new Map(), shownBy: null, shownByTrack: false }
      for (const record of carriers) {
        const found = objectVideoConfig(
          decodeLocProperties(record.properties, state.resolution, options),
        )
        objects.byRecord.set(record, found)
        if (found.config) objects.configs.push(found.config)
        if (found.unread) objects.unread++
        if (found.shown) objects.shownBy ??= record
      }
      this.configs.set(state.key, { signature, count: carriers.length, value: objects })
    }
    const track = objectVideoConfig(state.trackProperties)
    if (!track.config && !track.unread && !track.shown) return objects
    return {
      ...objects,
      configs: track.config ? [...objects.configs, track.config] : objects.configs,
      unread: objects.unread + (track.unread ? 1 : 0),
      shownByTrack: track.shown,
    }
  }

  /** The decode options of a track's objects. */
  private decodeOptions(state: LocTrackState, draft: string | undefined): DecodeLocOptions {
    const options: DecodeLocOptions = {}
    const transport = transportDraftOf(draft)
    if (transport) options.transportDraft = transport
    if (state.codec) options.videoCodec = state.codec
    if (state.trackTimescales.length > 0) {
      options.trackTimescales = state.trackTimescales.map((t) => t.value)
    }
    return options
  }

  /**
   * One object of a LOC track decoded under the track's resolution: its
   * properties and, for H.264 and H.265, its payload framing. `data` holds the
   * source's bytes. Kept per object until the resolution or codec changes.
   */
  objectView(
    source: LocSource,
    obj: StreamObject,
    groupId: number,
    data: Uint8Array,
    state: LocTrackState,
    draft: string | undefined,
  ): LocObjectView {
    const key = recordKey(source, obj.offset)
    let record = this.records.get(key)
    if (!record) {
      record = readObjectRecord(source, obj, groupId, data, draft)
      this.records.set(key, record)
    }
    const options = this.decodeOptions(state, draft)
    const family = state.codec ? videoCodecFamily(state.codec) : null
    const base = `${resolutionSignature(state.resolution)}|${state.codec ?? ''}|${draft ?? ''}`
    // LOC 2.1.3: the length size depends on the Video Configs of the whole
    // track, not only this object's.
    const trackConfigs =
      family && obj.payloadLength > 0 ? this.trackVideoConfigs(state, draft, base) : null
    const signature = [
      base,
      options.trackTimescales?.join(',') ?? '',
      trackConfigs
        ? `${trackConfigs.configs.map((c) => c.lengthSize).join(',')}|${trackConfigs.unread}`
        : '',
    ].join('|')
    const cached = this.views.get(key)
    if (cached && cached.signature === signature) return cached.view

    const results = decodeLocProperties(record.properties, state.resolution, options)
    const view: LocObjectView = { record, properties: propertyRows(record, results) }
    if (
      options.trackTimescales &&
      !results.some((r) => r.meaning === 'timescale' && !r.transport)
    ) {
      view.timescaleFromTrack = true
    }
    if (family && trackConfigs) {
      const end = Math.min(obj.payloadOffset + obj.payloadLength, data.length)
      const payload = data.subarray(obj.payloadOffset, end)
      const own = objectVideoConfig(results)
      if (own.config) {
        view.payload = analyzeUnderConfigs(payload, family, [own.config])
      } else if (!own.unread && trackConfigs.unread === 0) {
        // Otherwise the length size is in a Video Config that did not decode.
        view.payload =
          trackConfigs.configs.length > 0
            ? analyzeUnderConfigs(payload, family, trackConfigs.configs)
            : analyzeLocPayload(payload, family)
      }
    }
    this.views.set(key, { signature, view })
    return view
  }

  /**
   * LOC 2.1.4: start codes SHOULD be 4 bytes; 3 bytes MAY be used only if the
   * track never uses length prefixes or a Video Config. Raised for objects
   * that read only as 3-byte start codes, on a track that carries a Video
   * Config or an object that reads only as length prefixes, and for objects
   * that read only as length prefixes, then 3-byte start codes.
   */
  private startCodeProblem(
    track: TrackEntry,
    state: LocTrackState,
    log: TrackLog,
    draft: string | undefined,
  ): PanelProblem | null {
    const family = state.codec ? videoCodecFamily(state.codec) : null
    const payloads = log.payloads.filter((p) => p.family === family)
    if (!family || payloads.length === 0) return null
    const base = `${resolutionSignature(state.resolution)}|${state.codec ?? ''}|${draft ?? ''}`
    const configs = this.trackVideoConfigs(state, draft, base)
    const threeByte: LocObjectRecord[] = []
    const mixed: LocObjectRecord[] = []
    const lengths: LocObjectRecord[] = []
    /** The flagged objects, in the order they came */
    const flagged: LocObjectRecord[] = []
    for (const p of payloads) {
      const sizes = p.lengthSizes.filter((s) => lengthSizesFor(p.record, configs).includes(s))
      if (p.threeByte && sizes.length === 0) {
        threeByte.push(p.record)
        flagged.push(p.record)
      } else if (!p.threeByte && sizes.length > 0) {
        if (sizes.every((s) => p.mixedThreeByteSizes.includes(s))) {
          mixed.push(p.record)
          flagged.push(p.record)
        } else lengths.push(p.record)
      }
    }
    const config = configs.shownBy !== null || configs.shownByTrack
    const usesLengths = lengths.length > 0 || mixed.length > 0
    if (mixed.length === 0 && (threeByte.length === 0 || (!config && !usesLengths))) return null

    const shows: string[] = []
    if (configs.shownByTrack) shows.push('carries a Video Config in its Track Properties')
    else if (configs.shownBy) shows.push('carries a Video Config')
    if (usesLengths) shows.push('has objects framed with length prefixes')
    // What shows the rule applies comes first, so it is not folded away.
    const notes = new Map<LocObjectRecord, string[]>()
    const note = (record: LocObjectRecord, text: string) =>
      notes.set(record, [...(notes.get(record) ?? []), text])
    if (configs.shownBy) note(configs.shownBy, 'Video Config')
    if (lengths[0]) note(lengths[0], 'length prefixes')
    for (const record of flagged) {
      note(
        record,
        mixed.includes(record) ? 'length prefixes, then 3-byte start codes' : '3-byte start codes',
      )
    }
    const specs = specsFromSection(startCodeSections(state.resolution))
    return makeProblem({
      source: 'loc',
      id: 'loc.start-code.three-byte',
      severity: 'warning',
      subject: trackSubject(track),
      title: 'Objects use 3-byte start codes where the track rules them out',
      found: `3-byte start codes on a track that ${shows.join(' and ')}`,
      expected:
        '4-byte start codes; 3-byte ones only on a track that never uses length prefixes or a Video Config',
      remedy: 'Write 4-byte start codes',
      spec: specs[0] ?? null,
      also: specs.slice(1),
      places: [...notes].map(([record, texts]) => objectPlace(record, texts.join(', '))),
      examined: log.payloads.length,
      atMs: this.progress.get(flagged[0]!.source)?.firstDataAt ?? null,
    })
  }

  /**
   * What the session's LOC tracks give reason to note: a track whose profile
   * is ambiguous or fits none, objects with 3-byte start codes on a track
   * that rules them out, and a group whose object 0 is marked as not
   * independent where its Frame Marking reads one way.
   */
  problems(
    tracks: Iterable<TrackEntry>,
    packaging: ReadonlyMap<TrackKey, TrackPackaging>,
    draft: string | undefined,
    trackProperties: ReadonlyMap<TrackKey, readonly TrackPropertyList[]> = new Map(),
  ): PanelProblem[] {
    const out: PanelProblem[] = []
    const seen = new Set<TrackKey>()
    const transport = transportDraftOf(draft)
    for (const track of tracks) {
      const key = registryTrackKey(track)
      if (seen.has(key)) continue
      seen.add(key)

      const state = this.trackState(track, packaging, draft, trackProperties.get(key))
      if (!state || state.objectCount === 0) continue
      const { resolution } = state
      const ids =
        state.types.length === 0
          ? 'No LOC property IDs'
          : `Property ${state.types.length === 1 ? 'ID' : 'IDs'} ${state.types.map(propertyTypeText).join(', ')}`
      if ('candidates' in resolution) {
        if (resolution.candidates.length === 0) {
          out.push(
            makeProblem({
              source: 'loc',
              id: 'loc.profile.none',
              severity: 'warning',
              subject: trackSubject(track),
              title: 'LOC properties fit no LOC draft',
              found: `${ids}: no LOC draft defines ${state.types.length === 1 ? 'it' : 'all of them'} where ${state.types.length === 1 ? 'it was' : 'they were'} seen`,
              expected: 'Property IDs one LOC draft defines where they are carried',
              remedy: 'Carry only the properties one LOC draft defines',
            }),
          )
        } else {
          out.push(
            makeProblem({
              source: 'loc',
              id: 'loc.profile.open',
              severity: 'info',
              subject: trackSubject(track),
              title: 'LOC properties fit more than one LOC draft',
              found: `${ids}; read as ${resolution.candidates.join(' or ')}`,
            }),
          )
        }
      }

      const log = this.logs.get(state.key)
      if (!log) continue
      const startCodes = this.startCodeProblem(track, state, log, draft)
      if (startCodes) out.push(startCodes)
      const signature = resolutionSignature(resolution)
      // A subscription and its joining FETCH carry the same group start.
      const groups = new Set<number>()
      for (const record of log.groupStarts) {
        if (groups.has(record.groupId)) continue
        const key = recordKey(record.source, record.offset)
        let start = this.starts.get(key)
        if (!start || start.signature !== signature) {
          const results = decodeLocProperties(record.properties, resolution, {
            ...(transport ? { transportDraft: transport } : {}),
          })
          start = { signature, mark: unambiguousFrameMarking(results) }
          this.starts.set(key, start)
        }
        if (!start.mark || start.mark.independent) continue
        groups.add(record.groupId)
        const specs = specsFromSection(exampleSections(resolution))
        const atMs = this.progress.get(record.source)?.firstDataAt ?? null
        out.push(
          makeProblem({
            source: 'loc',
            id: 'loc.group-start.not-independent',
            severity: 'info',
            subject: trackSubject(track),
            title: 'Groups start with an object marked not independent',
            found: 'Frame Marking I=0 on object 0',
            expected: 'Object 0 of a group marked independent, as in the drafts’ example',
            spec: specs[0] ?? null,
            also: specs.slice(1),
            places: [
              {
                label: objectLabel(record.groupId, record.objectId),
                note: null,
                target: { kind: 'object', source: record.source, offset: record.offset },
                atMs,
              },
            ],
            atMs,
          }),
        )
      }
    }
    return out
  }
}

function typeKey(t: LocPropertyType): string {
  return `${t.immutable}:${t.type}`
}

function compareTypes(a: LocPropertyType, b: LocPropertyType): number {
  if (a.type !== b.type) return a.type < b.type ? -1 : 1
  return Number(a.immutable) - Number(b.immutable)
}

function hexId(type: bigint): string {
  return `0x${type.toString(16).toUpperCase().padStart(2, '0')}`
}

// ─── Display ──────────────────────────────────────────────────────

/** A property type as the panel writes it. */
export function propertyId(type: bigint): string {
  return hexId(type)
}

/** A property type as seen on objects, marked when it was inside Immutable Properties. */
export function propertyTypeText(t: LocPropertyType): string {
  return t.immutable ? `${hexId(t.type)} (immutable)` : hexId(t.type)
}

const HEX_LIMIT = 32

/** Bytes as spaced hex, the first {@link HEX_LIMIT} of them. */
export function hexBytes(bytes: Uint8Array): string {
  const shown = Array.from(bytes.subarray(0, HEX_LIMIT), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join(' ')
  return bytes.length > HEX_LIMIT ? `${shown} … (${bytes.length} bytes)` : shown
}

/** A raw value: an even type's integer, an odd type's bytes. */
export function rawValue(raw: LocPropertyResult['raw']): string {
  if (raw === undefined) return '—'
  if (typeof raw === 'bigint') return `${raw} (0x${raw.toString(16)})`
  return raw.length === 0 ? '(empty)' : hexBytes(raw)
}

function frameMarkingText(m: FrameMarking): string {
  const flags = (['S', 'E', 'I', 'D', 'B'] as const).filter(
    (_f, i) =>
      [m.startOfFrame, m.endOfFrame, m.independent, m.discardable, m.baseLayerSync][i],
  )
  const parts = [flags.length ? flags.join(' ') : 'no flags', `TID ${m.temporalId}`]
  if (m.layerId !== undefined) parts.push(`LID ${m.layerId}`)
  if (m.tl0PicIdx !== undefined) parts.push(`TL0PICIDX ${m.tl0PicIdx}`)
  return `${parts.join(' · ')} (${m.octets}-octet form)`
}

function videoConfigText(c: VideoConfig): string {
  if (c.codec === 'h264') {
    return `avcC · profile ${c.profile} · level ${c.level} · ${c.lengthSize}-byte lengths · ${c.spsCount} SPS · ${c.ppsCount} PPS`
  }
  const arrays = c.arrays.map((a) => `${a.count}× NAL ${a.nalType}`).join(', ')
  return `hvcC · profile ${c.profile} · tier ${c.tier} · level ${c.level} · ${c.lengthSize}-byte lengths${arrays ? ` · ${arrays}` : ''}`
}

function epochMicrosText(microseconds: bigint): string {
  const ms = Number(microseconds / 1000n)
  const iso = Number.isFinite(ms) && ms <= 8.64e15 ? new Date(ms).toISOString() : null
  return `${microseconds} µs since the Unix epoch${iso ? ` (${iso})` : ''}`
}

/**
 * A decoded value as the panel writes it, one line per reading: a Frame
 * Marking that fits several forms gives one line for each. `timescaleFromTrack`
 * marks a Timestamp read with the track's Timescale.
 */
export function decodedLines(result: LocPropertyResult, timescaleFromTrack = false): string[] {
  const d = result.decoded
  if (!d) return []
  switch (d.kind) {
    case 'capture-timestamp':
      return [epochMicrosText(d.microseconds)]
    case 'timestamp':
      // Without a Timescale, wall-clock microseconds since the Unix epoch (LOC-02..04 2.3.1.1).
      if (d.timescales.length === 0) {
        return [epochMicrosText(d.value)]
      }
      if (d.timescales.length === 1) {
        const scale = d.timescales[0]!
        return [`${d.value} at ${scale} units/s${timescaleFromTrack ? ' (track Timescale)' : ''}`]
      }
      return [`${d.value} (Timescales disagree: ${d.timescales.join(', ')})`]
    case 'timescale':
      return [`${d.unitsPerSecond} units/s`]
    case 'video-frame-marking':
      return d.candidates.map(frameMarkingText)
    case 'audio-level':
      return [`${d.dBov} dBov · voice ${d.voiceActivity ? 'active' : 'inactive'}`]
    case 'video-config':
      return [videoConfigText(d.config)]
  }
}

/** A track Timescale as the panel writes it, and the messages that carry it. */
export function trackTimescaleText(t: TrackTimescale): { text: string; title: string } {
  return { text: `Track Timescale ${t.value}/s`, title: `Track Property in ${t.messages.join(', ')}` }
}

/** A payload framing as the panel writes it. */
export function payloadText(framing: LocPayloadFraming | null | undefined): string | null {
  if (framing === undefined) return null
  if (framing === null) return 'fits neither start-code nor length-prefixed framing'
  if (framing.framing === 'ambiguous') {
    return `ambiguous: ${framing.candidates.map(oneFraming).join(' or ')}`
  }
  return oneFraming(framing)
}

function oneFraming(f: Exclude<LocPayloadFraming, { framing: 'ambiguous' }>): string {
  const threeByte = f.threeByteStartCodes ? ' (3-byte present)' : ''
  const how =
    f.framing === 'start-code'
      ? `start codes${threeByte}`
      : f.framing === 'length-prefixed'
        ? `${f.lengthSize}-byte lengths`
        : `${f.lengthSize}-byte lengths, then start codes${threeByte}`
  return `${how} · NAL ${f.nalTypes.join(' ')}${f.keyframe ? ' · keyframe' : ''}`
}

// ─── Vue ──────────────────────────────────────────────────────────

/** One reader per session. */
const readers = new WeakMap<SessionEntry, SessionLoc>()

function readerFor(session: SessionEntry): SessionLoc {
  const raw = toRaw(session)
  let reader = readers.get(raw)
  if (!reader) {
    reader = new SessionLoc()
    readers.set(raw, reader)
  }
  return reader
}

export interface SessionLocView {
  /** The LOC state of a registry track, null when it is not LOC */
  trackState: (track: TrackEntry) => LocTrackState | null
  /** The LOC state of the track a source carries, null when it is not LOC */
  sourceState: (source: LocSource) => LocTrackState | null
  /** Read when first asked for, and again only once what it rests on changes */
  problems: ComputedRef<PanelProblem[]>
  objectView: (
    source: LocSource,
    obj: StreamObject,
    groupId: number,
    data: Uint8Array,
    state: LocTrackState,
  ) => LocObjectView
}

/** A session's LOC tracks, kept current while the caller is mounted. */
export function useSessionLoc(
  session: () => SessionEntry,
  packaging: () => ReadonlyMap<TrackKey, TrackPackaging>,
  getStreamData: (sessionId: string, streamId: number) => Promise<Uint8Array | null>,
  getDatagramGroupData: (sessionId: string, groupKey: string) => Promise<Uint8Array | null>,
): SessionLocView {
  const revision = shallowRef(0)
  const reader = computed(() => readerFor(session()))
  const trackProperties = computed(() => trackPropertyLists(session()))

  /** The sources due for a read, so chunks below the next threshold do not fire it. */
  const due = computed(() => {
    void revision.value
    const s = session()
    return reader.value
      .sync(s, packaging())
      .map((r) => `${r.source}:${r.closed}`)
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
    const s = session()
    return reader.value.trackState(
      track,
      packaging(),
      s.draft,
      trackProperties.value.get(registryTrackKey(track)),
    )
  }

  return {
    trackState,
    sourceState: (source) => {
      const track = trackForSource(session(), source)
      return track ? trackState(track) : null
    },
    problems: computed(() => {
      void revision.value
        const s = session()
      return reader.value.problems(s.tracks.values(), packaging(), s.draft, trackProperties.value)
    }),
    objectView: (source, obj, groupId, data, state) =>
      reader.value.objectView(source, obj, groupId, data, state, session().draft),
  }
}
