/**
 * A .moqtrace read back into a panel session. A trace records each data
 * stream's track (Event 1), objects (Event 3) and payloads (Event 4) but not
 * its framing, so each stream is encoded again with the session draft's codec
 * and read back to check. Where it cannot be (no draft, missing fields, an
 * object with no header event) the payloads are kept as they were and the
 * stream is marked as having no framing.
 */

import {
  displayFields,
  setupImplementation,
  TrackRegistry,
  trackDisplayName,
} from '@moqtap/inspect'
import { createCodec } from '@moqtap/codec'
import { detectAnnexB } from '@moqtap/media/annexb'
import { detectMediaInfo, type PayloadMediaInfo } from '@moqtap/media/bmff'
import type {
  ControlMessageEvent,
  ObjectHeaderEvent,
  ObjectPayloadEvent,
  StreamClosedEvent,
  StreamOpenedEvent,
  Trace,
} from '@moqtap/trace'
import { controlMessageFields } from '@moqtap/trace'
import {
  detectContentType,
  type StreamContentType,
} from '@/src/detect/content-detect'
import { controlMessageName, draftFromProtocol } from '@/src/trace/message-name'
import { isSupportedDraft, type SupportedDraft } from '@/src/types/common'
import {
  decodeObjectProperties,
  type ParsedStreamFraming,
  parseStreamFraming,
} from './stream-framing'
import type {
  DatagramGroupEntry,
  SessionEntry,
  TrackEntry,
} from './use-inspector'

/**
 * Record the `moqt_implementation` either side advertises in its setup
 * message, for live and imported sessions alike.
 */
export function applySetupImplementation(
  session: SessionEntry,
  messageType: string,
  fields: Record<string, unknown> | null,
  direction: 'tx' | 'rx',
): void {
  if (!fields) return
  // Draft-17 merged CLIENT_SETUP and SERVER_SETUP into one SETUP, whose sender
  // is the end that sent it: the page is the client.
  const found = setupImplementation(messageType, fields, direction === 'tx')
  if (!found) return
  if (found.side === 'client')
    session.clientImplementation = found.implementation
  else session.serverImplementation = found.implementation
}

/** A trace rebuilt as a session, with the bytes its streams carried. */
export interface ImportedSession {
  session: SessionEntry
  /** Each stream's bytes, by stream id */
  streamData: Map<number, Uint8Array>
  /**
   * Each datagram group's buffer, by group key: 4-byte little-endian length
   * prefixed datagrams, as the background's heap store keeps them.
   */
  datagramData: Map<string, Uint8Array>
}

export interface ImportOptions {
  sessionId: string
  /** Shown as the session's URL when the trace names no endpoint */
  filename: string
  /** The next track colour, shared with the live sessions */
  nextColorIndex: () => number
}

/** One object as Events 3 and 4 recorded it. */
interface RecordedObject {
  groupId: bigint
  objectId: bigint
  priority: number
  status: number
  /** The property block, when the object had a properties field */
  properties?: Uint8Array
  /** Undefined until its payload event, and after one that held no bytes */
  payload?: Uint8Array
  paired: boolean
}

/** What the events say about one stream, or one datagram group. */
interface RecordedStream {
  objects: RecordedObject[]
  /** Every payload that held bytes, in order: the fallback's whole content */
  payloads: Uint8Array[]
  /** False once an object turns up that the encoder cannot be given */
  framable: boolean
  /** Headers with no payload yet, by `group:object` */
  unpaired: Map<string, RecordedObject[]>
}

interface RecordedDataStream extends RecordedStream {
  kind?: 'subgroup' | 'fetch'
  trackAlias?: bigint
  subgroupId?: bigint
  fetchRequestId?: bigint
}

interface RecordedDatagramGroup extends RecordedStream {
  trackAlias?: bigint
  groupId: bigint
}

/**
 * Build a session from a trace: control messages, the tracks they register,
 * and every data stream and datagram group with its bytes re-framed where the
 * trace says enough to.
 */
export function sessionFromTrace(
  trace: Trace,
  options: ImportOptions,
): ImportedSession {
  const { sessionId } = options
  const header = trace.header

  // Determine draft from protocol string (e.g. "moq-transport-14")
  const draft = draftFromProtocol(header.protocol)

  const session: SessionEntry = {
    sessionId,
    url: header.endpoint ?? options.filename,
    createdAt: header.startTime,
    closed: true,
    closedReason: 'imported',
    protocol: draft ? 'moqt' : 'unknown',
    draft,
    streams: new Map(),
    messages: [],
    tracks: new Map(),
    datagramGroups: new Map(),
    bitrateSamples: [],
    imported: true,
  }

  const recorded = new Map<number, RecordedDataStream>()
  const datagramGroups = new Map<string, RecordedDatagramGroup>()
  // Every datagram stream shares stream id 0, and an object event names only
  // its group: the alias comes from the datagram stream-opened before it.
  const datagramAlias = new Map<bigint, bigint>()
  // Every alias a group id has been opened on, and the group ids opened again
  // since their last datagram.
  const datagramAliases = new Map<bigint, Set<bigint>>()
  const datagramOpened = new Set<bigint>()
  const ambiguousGroups = new Set<bigint>()

  function recordedStream(streamId: number): RecordedDataStream {
    let rec = recorded.get(streamId)
    if (!rec) {
      rec = { objects: [], payloads: [], framable: true, unpaired: new Map() }
      recorded.set(streamId, rec)
    }
    return rec
  }

  function datagramGroup(groupId: bigint): RecordedDatagramGroup {
    const trackAlias = datagramAlias.get(groupId)
    // Without an alias, a group is filed under alias 0.
    const gk = `${trackAlias ?? 0n}:${groupId}`
    let group = datagramGroups.get(gk)
    if (!group) {
      group = {
        objects: [],
        payloads: [],
        framable: trackAlias !== undefined && !ambiguousGroups.has(groupId),
        unpaired: new Map(),
        groupId,
        ...(trackAlias !== undefined ? { trackAlias } : {}),
      }
      datagramGroups.set(gk, group)
    }
    return group
  }

  /**
   * A datagram header with no stream-opened right before it, in a group id
   * opened on more than one alias: every group of that id keeps its payloads
   * and loses its framing.
   */
  function datagramHeader(groupId: bigint): void {
    const opened = datagramOpened.delete(groupId)
    if (opened || (datagramAliases.get(groupId)?.size ?? 0) < 2) return
    ambiguousGroups.add(groupId)
    for (const group of datagramGroups.values()) {
      if (group.groupId === groupId) group.framable = false
    }
  }

  function ensureStream(streamId: number, direction: 'tx' | 'rx' = 'rx') {
    let stream = session.streams.get(streamId)
    if (!stream) {
      stream = {
        streamId,
        direction,
        closed: false,
        byteCount: 0,
        chunkCount: 0,
        contentType: 'binary',
      }
      session.streams.set(streamId, stream)
    }
    return stream
  }

  // Tracks are rebuilt from the control messages as they are live, with the
  // stream each came from: a draft-17+ response identifies its request only by
  // its stream. Without stream ids, draft-17+ subscriptions stay unresolved.
  const trackRegistry = new TrackRegistry<TrackEntry>(
    session.tracks,
    (fields) => ({
      ...fields,
      fullName: trackDisplayName(fields),
      colorIndex: options.nextColorIndex(),
    }),
  )

  // Reconstruct state from trace events
  for (const event of trace.events) {
    switch (event.type) {
      case 'control': {
        const ce = event as ControlMessageEvent
        // `message` may be a text rendering rather than a field map; fields
        // are read only from a field map.
        const fields = controlMessageFields(ce.message)
        const msgType = controlMessageName(ce.messageType, draft, fields)
        session.messages.push({
          timestamp: ce.timestamp,
          direction: ce.direction === 0 ? 'tx' : 'rx',
          messageType: msgType,
          ...(ce.streamId != null ? { streamId: Number(ce.streamId) } : {}),
          decoded: ce.message,
          decodedPretty: fields ? displayFields(msgType, fields) : ce.message,
          raw: ce.raw ?? new Uint8Array(0),
        })

        applySetupImplementation(
          session,
          msgType,
          fields ?? null,
          ce.direction === 0 ? 'tx' : 'rx',
        )

        // Extract track info from control messages.
        if (fields) {
          trackRegistry.apply(msgType, fields, {
            direction: ce.direction === 0 ? 'tx' : 'rx',
            ...(ce.streamId != null ? { streamId: Number(ce.streamId) } : {}),
            timestamp: ce.timestamp,
          })
        }
        break
      }

      case 'stream-opened': {
        const se = event as StreamOpenedEvent
        // A datagram "stream" is no stream: it says which alias the group's
        // datagrams that follow it are on.
        if (se.streamType === 1) {
          if (se.groupId != null && se.trackAlias != null) {
            datagramAlias.set(se.groupId, se.trackAlias)
            let aliases = datagramAliases.get(se.groupId)
            if (!aliases) {
              aliases = new Set()
              datagramAliases.set(se.groupId, aliases)
            }
            aliases.add(se.trackAlias)
            datagramOpened.add(se.groupId)
          }
          break
        }
        const streamId = Number(se.streamId)
        const isFetch = se.streamType === 2
        if (!session.streams.has(streamId)) {
          session.streams.set(streamId, {
            streamId,
            direction: se.direction === 0 ? 'tx' : 'rx',
            closed: false,
            byteCount: 0,
            chunkCount: 0,
            contentType: 'binary',
            // What the stream's header said: the alias on a subgroup stream,
            // the request on a fetch stream (type 2).
            ...(!isFetch && se.trackAlias != null
              ? { trackAlias: Number(se.trackAlias) }
              : {}),
            ...(isFetch && se.fetchRequestId != null
              ? { fetchRequestId: Number(se.fetchRequestId) }
              : {}),
          })
        }
        const rec = recordedStream(streamId)
        rec.kind = isFetch ? 'fetch' : 'subgroup'
        if (isFetch) rec.fetchRequestId = se.fetchRequestId
        else {
          rec.trackAlias = se.trackAlias
          rec.subgroupId = se.subgroupId
        }
        break
      }

      case 'object-header': {
        const oh = event as ObjectHeaderEvent
        const streamId = Number(oh.streamId)
        if (streamId === 0) datagramHeader(oh.groupId)
        const rec =
          streamId === 0 ? datagramGroup(oh.groupId) : recordedStream(streamId)
        if (streamId !== 0) ensureStream(streamId)
        const object: RecordedObject = {
          groupId: oh.groupId,
          objectId: oh.objectId,
          priority: oh.publisherPriority,
          status: oh.objectStatus,
          ...(oh.properties ? { properties: toBytes(oh.properties) } : {}),
          paired: false,
        }
        rec.objects.push(object)
        const key = `${oh.groupId}:${oh.objectId}`
        const waiting = rec.unpaired.get(key)
        if (waiting) waiting.push(object)
        else rec.unpaired.set(key, [object])
        break
      }

      case 'object-payload': {
        const op = event as ObjectPayloadEvent
        const streamId = Number(op.streamId)

        // Datagrams use stream id 0 by convention
        const rec =
          streamId === 0 ? datagramGroup(op.groupId) : recordedStream(streamId)
        if (streamId !== 0) ensureStream(streamId)

        const payload = op.payload
          ? toBytes(op.payload)
          : op.size === 0
            ? new Uint8Array(0)
            : undefined
        if (payload && payload.length > 0) rec.payloads.push(payload)

        // The waiting header with the same group and object; payloads may
        // follow their headers in any order. Without one, or without a
        // payload, the object cannot be encoded.
        const header = rec.unpaired.get(`${op.groupId}:${op.objectId}`)?.pop()
        if (!header || !payload) rec.framable = false
        if (header) {
          header.paired = true
          header.payload = payload
        }
        break
      }

      case 'stream-closed': {
        const sc = event as StreamClosedEvent
        const streamId = Number(sc.streamId)
        const stream = session.streams.get(streamId)
        if (stream) stream.closed = true
        break
      }
    }
  }

  const codecDraft = draft && isSupportedDraft(draft) ? draft : undefined
  const streamData = new Map<number, Uint8Array>()
  for (const [streamId, rec] of recorded) {
    const stream = session.streams.get(streamId)
    if (!stream) continue
    if (rec.objects.length === 0 && rec.payloads.length === 0) continue

    const framed = codecDraft ? frameStream(rec, codecDraft) : null
    const data = framed ?? concat(rec.payloads)
    if (data.length === 0) continue

    stream.importedFraming = framed ? 'reconstructed' : 'unavailable'
    stream.byteCount = data.length
    Object.assign(stream, detectPayload(rec.payloads[0]))
    streamData.set(streamId, data)
  }

  // Reconstruct datagram groups from imported trace
  const datagramData = new Map<string, Uint8Array>()
  for (const [gk, rec] of datagramGroups) {
    const framed = codecDraft ? frameDatagramGroup(rec, codecDraft) : null
    const datagrams = framed ?? rec.payloads
    if (datagrams.length === 0) continue

    // Build length-prefixed datagram group data (matching heap store format)
    let totalLen = 0
    for (const dg of datagrams) totalLen += 4 + dg.length
    const merged = new Uint8Array(totalLen)
    const dv = new DataView(merged.buffer)
    let offset = 0
    for (const dg of datagrams) {
      dv.setUint32(offset, dg.length, true)
      merged.set(dg, offset + 4)
      offset += 4 + dg.length
    }

    const detected = detectPayload(rec.payloads[0])
    const entry: DatagramGroupEntry = {
      groupKey: gk,
      trackAlias: Number(rec.trackAlias ?? 0n),
      groupId: Number(rec.groupId),
      direction: 'rx',
      closed: true,
      byteCount: totalLen,
      datagramCount: datagrams.length,
      contentType: detected.contentType,
      mediaInfo: detected.mediaInfo,
      importedFraming: framed ? 'reconstructed' : 'unavailable',
    }
    session.datagramGroups.set(gk, entry)
    datagramData.set(gk, merged)
  }

  return { session, streamData, datagramData }
}

// ─── Content detection ────────────────────────────────────────────

/** What the first payload looks like; imported payloads are raw object data. */
function detectPayload(first: Uint8Array | undefined): {
  contentType: StreamContentType
  mediaInfo?: PayloadMediaInfo
  codecString?: string
} {
  if (!first) return { contentType: 'binary' }
  const contentType = detectContentType(first)
  if (contentType === 'fmp4') {
    return { contentType, mediaInfo: detectMediaInfo(first) ?? undefined }
  }
  if (contentType === 'h264' || contentType === 'h265') {
    return { contentType, codecString: detectAnnexB(first)?.codecString }
  }
  return { contentType }
}

// ─── Re-framing ───────────────────────────────────────────────────

/** The codec's data stream encoders; their inputs are per-draft shapes. */
interface DataStreamEncoder {
  encodeSubgroupStream(stream: unknown): Uint8Array
  encodeFetchStream(stream: unknown): Uint8Array
  encodeDatagram(dg: unknown): Uint8Array
  /** Draft-08 to -10: a status datagram is a type of its own */
  encodeDatagramStatus?(dg: unknown): Uint8Array
}

const encoders = new Map<SupportedDraft, DataStreamEncoder>()

function encoderFor(draft: SupportedDraft): DataStreamEncoder {
  let encoder = encoders.get(draft)
  if (!encoder) {
    encoder = createCodec({ draft }) as unknown as DataStreamEncoder
    encoders.set(draft, encoder)
  }
  return encoder
}

const EMPTY = new Uint8Array(0)

/**
 * A stream's bytes encoded from what its events say, or null when they do not
 * say enough, or the encoding does not read back as the same objects.
 */
function frameStream(
  rec: RecordedDataStream,
  draft: SupportedDraft,
): Uint8Array | null {
  if (!rec.framable || rec.objects.length === 0) return null
  if (rec.objects.some((o) => !o.paired)) return null
  try {
    if (rec.kind === 'subgroup') return frameSubgroup(rec, draft)
    if (rec.kind === 'fetch') return frameFetch(rec, draft)
  } catch {
    // An id the draft cannot express (a fetch whose groups go backwards from
    // draft-19, objects out of order): the payloads are all there is.
  }
  return null
}

/**
 * A subgroup stream: the header names one group and one priority, so every
 * object has to agree on both. The type carries PROPERTIES when any object had
 * a properties field, and an explicit Subgroup ID when the trace gave one;
 * without one the stream is in subgroup 0.
 */
function frameSubgroup(
  rec: RecordedDataStream,
  draft: SupportedDraft,
): Uint8Array | null {
  if (rec.trackAlias === undefined) return null
  const first = rec.objects[0]
  for (const o of rec.objects) {
    if (o.groupId !== first.groupId || o.priority !== first.priority)
      return null
  }
  const withProperties = rec.objects.some((o) => o.properties !== undefined)
  const explicitSubgroup = rec.subgroupId !== undefined
  // Draft-11's subgroup types start at 0x08; 0x10 from draft-12. Through
  // draft-10 there is one type and the encoder writes it whatever this says.
  const type =
    (draft === '11' ? 0x08 : 0x10) |
    (withProperties ? 0x01 : 0) |
    (explicitSubgroup ? 0x04 : 0)

  const objects = []
  for (const o of rec.objects) {
    const obj = encoderObject(o, withProperties, draft)
    if (!obj) return null
    objects.push(obj)
  }
  const data = encoderFor(draft).encodeSubgroupStream({
    type: 'subgroup',
    // `streamTypeId` up to draft-13, `headerType` from draft-14
    streamTypeId: type,
    headerType: type,
    trackAlias: rec.trackAlias,
    groupId: first.groupId,
    subgroupId: rec.subgroupId ?? 0n,
    publisherPriority: first.priority,
    objects,
  })

  const framing = parseStreamFraming(data, draft)
  if (framing?.streamType !== 'subgroup') return null
  const hf = framing.headerFields
  if (
    hf.trackAlias !== Number(rec.trackAlias) ||
    hf.groupId !== Number(first.groupId) ||
    (explicitSubgroup && hf.subgroupId !== Number(rec.subgroupId)) ||
    (hf.publisherPriority !== undefined &&
      hf.publisherPriority !== first.priority)
  )
    return null
  return sameObjects(framing, data, rec.objects, false) ? data : null
}

/**
 * A fetch stream. Each object carries its own Group ID, Object ID and
 * Priority, so an object says everything about itself: the Group ID is sent
 * when it changes (a delta from the one before, from draft-19), the Object ID
 * and Priority always, and the property block when any object had one. The
 * Subgroup ID, which the trace does not record, is left at 0.
 */
function frameFetch(
  rec: RecordedDataStream,
  draft: SupportedDraft,
): Uint8Array | null {
  if (rec.fetchRequestId === undefined) return null
  // From draft-16 an empty Normal object may stand for an End of Range
  // marker, which is no object, so such a stream is not re-framed.
  if (
    Number(draft) >= 16 &&
    rec.objects.some((o) => o.status === 0 && (o.payload?.length ?? 0) === 0)
  )
    return null
  const withProperties = rec.objects.some((o) => o.properties !== undefined)

  const objects = []
  let prevGroup: bigint | undefined
  for (const o of rec.objects) {
    const obj = encoderObject(o, withProperties, draft)
    if (!obj) return null
    const flags =
      (o.groupId !== prevGroup ? 0x08 : 0) |
      0x04 |
      0x10 |
      (withProperties ? 0x20 : 0)
    prevGroup = o.groupId
    // Serialization Flags from draft-15; earlier drafts send every field
    objects.push({ ...obj, serializationFlags: flags })
  }
  const data = encoderFor(draft).encodeFetchStream({
    type: 'fetch',
    // `subscribeId` through draft-10, `requestId` after it
    requestId: rec.fetchRequestId,
    subscribeId: rec.fetchRequestId,
    objects,
  })

  const framing = parseStreamFraming(data, draft)
  if (framing?.streamType !== 'fetch') return null
  if (framing.headerFields.requestId !== Number(rec.fetchRequestId))
    return null
  return sameObjects(framing, data, rec.objects, true) ? data : null
}

/**
 * A datagram group as one encoded datagram per object. Each datagram has its
 * own type, so PROPERTIES is set on those that had a block and no other. One
 * that does not encode, or does not read back as itself, leaves the whole
 * group as payloads.
 */
function frameDatagramGroup(
  rec: RecordedDatagramGroup,
  draft: SupportedDraft,
): Uint8Array[] | null {
  if (!rec.framable || rec.trackAlias === undefined) return null
  if (rec.objects.length === 0 || rec.objects.some((o) => !o.paired))
    return null
  const n = Number(draft)
  const out: Uint8Array[] = []
  try {
    for (const o of rec.objects) {
      const withProperties = o.properties !== undefined
      const obj = encoderObject(o, withProperties, draft)
      if (!obj) return null
      // A zero-length object with a non-Normal status is a status datagram.
      // Through draft-10 the encoder picks its own type: draft-08's datagram
      // carries a status, draft-09 and -10 use DATAGRAM_STATUS, and draft-07
      // has none.
      const status = obj.payloadLength === 0 && o.status !== 0
      const props = withProperties ? 0x01 : 0
      const type =
        n <= 10
          ? 0
          : n === 11
            ? props | (status ? 0x02 : 0)
            : n <= 13
              ? props | (status ? 0x04 : 0)
              : props | (status ? 0x20 : 0)
      const encoder = encoderFor(draft)
      const fields = {
        ...obj,
        // `streamTypeId` up to draft-13, `datagramType` from draft-14
        streamTypeId: type,
        datagramType: type,
        trackAlias: rec.trackAlias,
        objectStatus: BigInt(o.status),
      }
      const data =
        status && (n === 9 || n === 10) && encoder.encodeDatagramStatus
          ? encoder.encodeDatagramStatus({
              ...fields,
              type: 'datagram_status',
              streamTypeId: 0x02,
              extensionHeadersLength: BigInt(obj.extensionHeadersLength),
            })
          : encoder.encodeDatagram({ ...fields, type: 'datagram' })

      const framing = parseStreamFraming(data, draft)
      if (framing?.streamType !== 'datagram') return null
      const hf = framing.headerFields
      if (
        hf.trackAlias !== Number(rec.trackAlias) ||
        hf.groupId !== Number(o.groupId) ||
        hf.publisherPriority !== o.priority
      )
        return null
      if (!sameObjects(framing, data, [o], false)) return null
      out.push(data)
    }
  } catch {
    return null
  }
  return out
}

/**
 * One object in the shape every draft's encoder reads, with each draft's
 * spelling of a field side by side; an encoder takes the ones it defines.
 * Null when the property block cannot be expressed in this draft.
 */
function encoderObject(
  o: RecordedObject,
  withProperties: boolean,
  draft: SupportedDraft,
) {
  const payload = o.payload ?? EMPTY
  // An object that recorded no block on a stream that carries the field gets
  // an empty one; through draft-10 every object carries the field.
  const block = (withProperties ? o.properties : undefined) ?? EMPTY
  // Draft-08 counts its extension headers rather than giving their length.
  let extensionCount = 0
  if (draft === '08' && block.length > 0) {
    const decoded = decodeObjectProperties(block, draft)
    if (!decoded?.ok) return null
    extensionCount = decoded.value.length
  }
  // Only a zero-length object carries a status.
  const status = payload.length === 0 ? BigInt(o.status) : undefined
  return {
    type: 'object' as const,
    byteOffset: 0,
    payloadByteOffset: 0,
    groupId: o.groupId,
    subgroupId: 0n,
    objectId: o.objectId,
    publisherPriority: o.priority,
    payloadLength: payload.length,
    payload,
    ...(status !== undefined ? { status } : {}),
    extensionData: block,
    extensionCount,
    extensionHeadersLength: block.length,
  }
}

/**
 * Whether framed bytes read back as the objects recorded: ids, payloads, the
 * status of an empty one and the property block, and on a fetch stream each
 * object's own group and priority. An object that recorded no block matches
 * one that has an empty block, which is what a stream that carries the field
 * gives it.
 */
function sameObjects(
  framing: ParsedStreamFraming,
  data: Uint8Array,
  expected: RecordedObject[],
  ownGroup: boolean,
): boolean {
  if (framing.objects.length !== expected.length) return false
  for (let i = 0; i < expected.length; i++) {
    const actual = framing.objects[i]
    const o = expected[i]
    if (actual.objectId !== Number(o.objectId)) return false
    if (
      ownGroup &&
      (actual.groupId !== Number(o.groupId) ||
        actual.publisherPriority !== o.priority)
    )
      return false
    const payload = data.subarray(
      actual.payloadOffset,
      actual.payloadOffset + actual.payloadLength,
    )
    if (!sameBytes(payload, o.payload ?? EMPTY)) return false
    if (payload.length === 0 && (actual.status ?? 0) !== o.status) return false
    const block =
      actual.propertiesOffset === undefined
        ? undefined
        : data.subarray(
            actual.propertiesOffset,
            actual.propertiesOffset + (actual.propertiesLength ?? 0),
          )
    if (o.properties) {
      if (!block || !sameBytes(block, o.properties)) return false
    } else if (block && block.length > 0) {
      return false
    }
  }
  return true
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

function toBytes(data: Uint8Array | ArrayLike<number>): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}
