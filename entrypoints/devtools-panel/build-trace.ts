/**
 * Build a .moqtrace Trace object from panel-side session state.
 *
 * Stream data is fetched via a callback (typically routed through the
 * background service worker which owns the page buffers + IDB).
 *
 * Events are collected with the wall-clock time they happened and are sorted
 * and numbered at the end. Numbering them in source order instead — every
 * control message, then every stream, then every datagram group — would put
 * `seq` in an order the timestamps contradict, and `seq` is what the format
 * says to order by.
 */

import { getMessageIdMap } from '@/src/codec/message-ids'
import { traceSource } from '@/src/trace/source'
import type { SupportedDraft } from '@/src/types/common'
import type { Trace, TraceEvent, TraceHeader } from '@moqtap/trace'
import {
  parseDatagramFraming,
  parseDatagramGroupFraming,
  parseStreamFraming,
  parseStreamPrefix,
  type StreamObject,
} from './stream-framing'
import { arrivalAt } from '@/src/trace/arrivals'
import { fitDetail } from '@/src/trace/detail'
import {
  DECODE_ERROR_CODE,
  decodeErrorLength,
  decodeErrorReason,
  MAX_DECODE_ERROR_RAW,
  isDecodeError,
} from '@/src/trace/decode-error'
import { holdsHeaderBytes } from './import-trace'
import type { SessionEntry } from './use-inspector'

/** Resolve a message type name (e.g. "subscribe") to its wire ID number. */
function resolveMessageTypeId(name: string, draft: SupportedDraft): number {
  const id = getMessageIdMap(draft).get(name)
  return id != null ? Number(id) : 0
}

/** Convert an absolute epoch-ms timestamp to a relative microsecond offset. */
function toRelativeUs(timestampMs: number, startTimeMs: number): number {
  return Math.round((timestampMs - startTimeMs) * 1000)
}

/** Unwrap a potential Vue reactive proxy back to a plain Uint8Array. */
function toBytes(data: Uint8Array): Uint8Array {
  return new Uint8Array(data)
}

/**
 * An event plus the absolute time it happened, before `seq` and the
 * header-relative timestamp are assigned.
 */
interface PendingEvent {
  /** Absolute wall-clock time, epoch ms. */
  at: number
  event: TraceEvent
}

/**
 * MoQT data stream type, as the format's Event 1 `"st"` field defines it:
 * 0 = subgroup, 1 = datagram, 2 = fetch. Not the QUIC bidi/uni distinction.
 */
const STREAM_TYPE_SUBGROUP = 0
const STREAM_TYPE_DATAGRAM = 1
const STREAM_TYPE_FETCH = 2

/** `{ [key]: bigint }` when the id is known, nothing otherwise. */
function optionalId<K extends string>(
  key: K,
  id: number | string | bigint | null | undefined,
): { [P in K]?: bigint } {
  if (id == null) return {}
  return { [key]: BigInt(id) } as { [P in K]?: bigint }
}

/**
 * The object's property block as the wire carried it, for Event 3's `"props"`.
 * Nothing when the object had no properties field.
 */
function propertiesOf(
  data: Uint8Array,
  obj: StreamObject,
): { properties?: Uint8Array } {
  if (obj.propertiesOffset === undefined) return {}
  const end = obj.propertiesOffset + (obj.propertiesLength ?? 0)
  return { properties: data.slice(obj.propertiesOffset, end) }
}

/**
 * Each datagram's bytes before its payload, in the order of the group buffer
 * (4-byte little-endian length, then the datagram), for Event 1's `"hdr"`.
 * Undefined for a datagram that does not frame under the session's draft.
 */
function datagramHeaders(
  data: Uint8Array,
  draft: string | undefined,
): (Uint8Array | undefined)[] {
  const out: (Uint8Array | undefined)[] = []
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 0
  while (offset + 4 <= data.length) {
    const length = view.getUint32(offset, true)
    if (length === 0 || offset + 4 + length > data.length) break
    const datagram = data.subarray(offset + 4, offset + 4 + length)
    const framing = parseDatagramFraming(datagram, draft)
    out.push(framing ? datagram.slice(0, framing.headerEnd) : undefined)
    offset += 4 + length
  }
  return out
}

/**
 * Build a complete Trace from a session, including stream payload data.
 */
export async function buildTrace(
  session: SessionEntry,
  getStreamData: (
    sessionId: string,
    streamId: number,
  ) => Promise<Uint8Array | null>,
  getDatagramGroupData?: (
    sessionId: string,
    groupKey: string,
  ) => Promise<Uint8Array | null>,
): Promise<Trace> {
  const draft = session.draft ?? 'unknown'
  const startTime = session.createdAt

  const pending: PendingEvent[] = []
  const push = (at: number, event: TraceEvent) => pending.push({ at, event })

  // Control messages
  for (const msg of session.messages) {
    // Not a message: the format keeps it as an error event, with its bytes.
    if (isDecodeError(msg.messageType)) {
      const length = decodeErrorLength(msg.decoded)
      push(msg.timestamp, {
        type: 'error',
        seq: 0,
        timestamp: 0,
        errorCode: DECODE_ERROR_CODE,
        reason: decodeErrorReason(msg.decoded),
        errorKind: 'decode',
        ...(msg.streamId != null ? { streamId: BigInt(msg.streamId) } : {}),
        ...(length !== null ? { rawLength: length } : {}),
        ...(msg.raw.length > 0
          ? { raw: toBytes(msg.raw).slice(0, MAX_DECODE_ERROR_RAW) }
          : {}),
      })
      continue
    }

    push(msg.timestamp, {
      type: 'control',
      seq: 0,
      timestamp: 0,
      direction: msg.direction === 'tx' ? 0 : 1,
      messageType: resolveMessageTypeId(
        msg.messageType,
        session.draft as SupportedDraft,
      ),
      // An imported trace may carry something here that is not a field map, and
      // re-exporting `{}` in its place would drop what this build did not recognise.
      message: msg.decoded ?? {},
      // Lets an importer pair a draft-17+ response with its request.
      ...(msg.streamId != null ? { streamId: BigInt(msg.streamId) } : {}),
      raw: msg.raw.length > 0 ? toBytes(msg.raw) : undefined,
    })
  }

  // The control stream and each draft-17+ request stream carry SETUP,
  // SUBSCRIBE and the rest in clear, Authorization Tokens included, and their
  // messages are already the control events above. Their bytes are not
  // objects, so they are never written as object events: a reader that keeps
  // payloads but drops tokens would otherwise ship every token. The panel's
  // marker covers the streams the background identified; a message's own
  // stream id covers a request stream it did not.
  const controlStreams = new Set<number>()
  for (const stream of session.streams.values()) {
    if (stream.isControl) controlStreams.add(stream.streamId)
  }
  for (const msg of session.messages) {
    if (msg.streamId != null) controlStreams.add(Number(msg.streamId))
  }

  // Streams — open events, payload data, close events
  for (const stream of session.streams.values()) {
    // Nothing records when a stream opened, so the first chunk's arrival is
    // the earliest moment it is known to have existed. A stream that carried
    // no data falls back to session start.
    const openedAt = stream.firstDataAt ?? startTime

    let data: Uint8Array | null = null
    if (stream.byteCount > 0 && !controlStreams.has(stream.streamId)) {
      try {
        data = await getStreamData(session.sessionId, stream.streamId)
      } catch {
        // Stream data load failed — the stream is still exported, without objects
      }
    }
    let framing = data ? parseStreamFraming(data, session.draft) : null
    // A stream that ends inside an object keeps the objects before the cut.
    if (data && framing == null) {
      const draft = session.draft
      // A stream the background saw a fetch header on is a fetch stream;
      // otherwise either kind may be.
      const kinds =
        stream.fetchRequestId != null
          ? (['fetch'] as const)
          : (['subgroup', 'fetch'] as const)
      framing = null
      for (const kind of kinds) {
        if (!draft) break
        framing = parseStreamPrefix(data, draft, kind)?.framing ?? null
        if (framing) break
      }
    }
    const hf = framing?.headerFields ?? {}
    const isFetch =
      framing?.streamType === 'fetch' || stream.fetchRequestId != null

    push(openedAt, {
      type: 'stream-opened',
      seq: 0,
      timestamp: 0,
      streamId: BigInt(stream.streamId),
      direction: stream.direction === 'tx' ? 0 : 1,
      // A fetch stream carries a request id in its framing header where a
      // subgroup stream carries a track alias; that is what tells them apart.
      streamType: isFetch ? STREAM_TYPE_FETCH : STREAM_TYPE_SUBGROUP,
      // What the stream header carried, so a reader can attribute the stream to
      // its track: by alias on a subgroup stream, by request on a fetch stream.
      ...(isFetch
        ? optionalId('fetchRequestId', hf.requestId ?? stream.fetchRequestId)
        : {
            // The stored bytes, parsed whole, over what the capture read.
            ...optionalId('trackAlias', hf.trackAlias ?? stream.trackAlias),
            ...optionalId('subgroupId', hf.subgroupId),
          }),
      // Only bytes the capture or the trace recorded; an import without them
      // holds bytes rebuilt from the fields, which are not evidence.
      ...(data && framing && holdsHeaderBytes(session, stream.streamId)
        ? { headerRaw: data.slice(0, framing.headerEnd) }
        : {}),
    })

    if (data) {
      try {
        if (framing && framing.objects.length > 0) {
          for (const obj of framing.objects) {
            // An End of Range marker is not an object; the format has no event for it.
            if (obj.endOfRange !== undefined) continue
            const end = Math.min(
              obj.payloadOffset + obj.payloadLength,
              data.length,
            )
            const payload = data.slice(obj.payloadOffset, end)
            // Absent for streams replayed from IDB.
            const objectAt =
              arrivalAt(stream.arrivals, obj.payloadOffset) ?? openedAt

            // A fetch object carries its own Group ID and Priority; a
            // subgroup object inherits the stream header's.
            const objectGroupId = BigInt(obj.groupId ?? hf.groupId ?? 0)
            const objectPriority =
              obj.publisherPriority ?? hf.publisherPriority ?? 0

            push(objectAt, {
              type: 'object-header',
              seq: 0,
              timestamp: 0,
              streamId: BigInt(stream.streamId),
              groupId: objectGroupId,
              objectId: BigInt(obj.objectId),
              publisherPriority: objectPriority,
              // Only a zero-length object has a status, and it is the
              // difference between "carried no bytes" and "ended the group".
              objectStatus: obj.status ?? 0,
              ...propertiesOf(data, obj),
            })

            push(objectAt, {
              type: 'object-payload',
              seq: 0,
              timestamp: 0,
              streamId: BigInt(stream.streamId),
              groupId: objectGroupId,
              objectId: BigInt(obj.objectId),
              size: payload.length,
              payload: toBytes(payload),
            })
          }
        } else {
          // No MoQT framing — store raw as a single object-payload
          push(openedAt, {
            type: 'object-payload',
            seq: 0,
            timestamp: 0,
            streamId: BigInt(stream.streamId),
            groupId: 0n,
            objectId: 0n,
            size: data.length,
            payload: toBytes(data),
          })
        }
      } catch {
        // Framing could not be read — the stream is still exported, without objects
      }
    }

    if (stream.closed) {
      push(stream.lastDataAt ?? openedAt, {
        type: 'stream-closed',
        seq: 0,
        timestamp: 0,
        streamId: BigInt(stream.streamId),
        errorCode: 0,
      })
    }
  }

  // Datagram groups — export as object-header + object-payload events
  if (getDatagramGroupData) {
    for (const dg of session.datagramGroups.values()) {
      const groupAt = dg.firstDataAt ?? startTime

      try {
        const data = await getDatagramGroupData(session.sessionId, dg.groupKey)
        if (data) {
          const framing = parseDatagramGroupFraming(data, session.draft)
          if (framing && framing.objects.length > 0) {
            // One object per datagram, in buffer order.
            const headers =
              !session.imported || dg.importedFraming === 'recorded'
                ? datagramHeaders(data, session.draft)
                : []
            for (const [i, obj] of framing.objects.entries()) {
              const headerRaw = headers[i]
              const end = Math.min(
                obj.payloadOffset + obj.payloadLength,
                data.length,
              )
              const payload = data.slice(obj.payloadOffset, end)
              // Each datagram was timestamped as it arrived, so unlike a
              // stream this needs no offset arithmetic.
              const objectAt = dg.arrivals?.get(obj.objectId) ?? groupAt

              // Datagrams have no stream id: 0 by convention, typed as a
              // datagram stream.
              push(objectAt, {
                type: 'stream-opened',
                seq: 0,
                timestamp: 0,
                streamId: 0n,
                direction: dg.direction === 'tx' ? 0 : 1,
                streamType: STREAM_TYPE_DATAGRAM,
                // Every datagram shares stream id 0, so each is opened with
                // its alias right before it; interleaved tracks stay apart.
                ...optionalId('trackAlias', framing.headerFields.trackAlias),
                groupId: BigInt(dg.groupId),
                ...(headerRaw ? { headerRaw } : {}),
              })

              push(objectAt, {
                type: 'object-header',
                seq: 0,
                timestamp: 0,
                streamId: 0n, // datagrams use streamId=0 by convention
                groupId: BigInt(obj.groupId ?? dg.groupId),
                objectId: BigInt(obj.objectId),
                publisherPriority:
                  obj.publisherPriority ??
                  framing.headerFields.publisherPriority ??
                  0,
                objectStatus: obj.status ?? 0,
                ...propertiesOf(data, obj),
              })

              push(objectAt, {
                type: 'object-payload',
                seq: 0,
                timestamp: 0,
                streamId: 0n,
                // The same group as the header above: a reader pairs a payload
                // with its header by stream, group and object.
                groupId: BigInt(obj.groupId ?? dg.groupId),
                objectId: BigInt(obj.objectId),
                size: payload.length,
                payload: toBytes(payload),
              })
            }
          }
        }
      } catch {
        // Datagram group data load failed — skip
      }
    }
  }

  // Sort by time, then number. The sort is stable, so an object-header still
  // precedes the payload it shares a timestamp with, as the format requires.
  pending.sort((a, b) => a.at - b.at)

  const numbered: TraceEvent[] = pending.map(
    ({ at, event }, seq) =>
      ({
        ...event,
        seq,
        timestamp: toRelativeUs(at, startTime),
      }) as TraceEvent,
  )

  // `detail` describes what this trace actually carries (src/trace/detail.ts).
  // Payload capture can be off -- `streamRecording === false` makes
  // `getStreamData` return null -- and then no object-header and no
  // object-payload event is built at all, and the trace is `control`.
  const { detail, events: kept } = fitDetail(numbered)
  const events = kept.map((e, seq) => ({ ...e, seq }) as TraceEvent)

  const header: TraceHeader = {
    protocol: `moq-transport-${draft}`,
    perspective: 'observer',
    detail,
    startTime,
    endTime: Date.now(),
    source: traceSource(),
    endpoint: session.url,
  }

  return { header, events }
}
