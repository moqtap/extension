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
  parseDatagramGroupFraming,
  parseStreamFraming,
  parseStreamPrefix,
  type StreamObject,
} from './stream-framing'
import { arrivalAt } from '@/src/trace/arrivals'
import { fitDetail } from '@/src/trace/detail'
import {
  DECODE_ERROR_CODE,
  decodeErrorReason,
  isDecodeError,
} from '@/src/trace/decode-error'
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
 * Nothing when the object had no properties field — not an empty block, which
 * is a field that carried nothing.
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
    // An undecodable run is the absence of a control message, not one of type
    // zero. The format keeps a protocol violation in its error event, so that
    // is where this goes. The offending bytes stay behind: Event 6 has no
    // field to carry them, and Event 0's `raw` is not available to an event
    // that is not a message.
    if (isDecodeError(msg.messageType)) {
      push(msg.timestamp, {
        type: 'error',
        seq: 0,
        timestamp: 0,
        errorCode: DECODE_ERROR_CODE,
        reason: decodeErrorReason(msg.decoded),
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

    // Load stream data via callback (background serves from memory + IDB)
    let data: Uint8Array | null = null
    if (stream.byteCount > 0 && !controlStreams.has(stream.streamId)) {
      try {
        data = await getStreamData(session.sessionId, stream.streamId)
      } catch {
        // Stream data load failed — the stream is still exported, without objects
      }
    }
    // The session's own draft first: a parser for another draft can accept the
    // same bytes and read different fields out of them.
    let framing = data ? parseStreamFraming(data, session.draft) : null
    // A stream is never a datagram. The parser falls back to reading it as
    // one when the stream does not frame whole, which is what a stream that
    // ends inside an object does (reset, cut short, or still open when the
    // trace is built), and the "datagram" it finds is the whole stream,
    // framing bytes and all, as one object's payload. Exported, that object
    // would hide a catalog's JSON behind those bytes from the share
    // redaction, which reads payloads from their first byte. The objects
    // before the cut frame on their own; the one cut short is left out,
    // since its bytes are not an object.
    if (data && (framing == null || framing.streamType === 'datagram')) {
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
        ? optionalId('fetchRequestId', stream.fetchRequestId ?? hf.requestId)
        : {
            ...optionalId('trackAlias', stream.trackAlias ?? hf.trackAlias),
            ...optionalId('subgroupId', hf.subgroupId),
          }),
    })

    if (data) {
      try {
        if (framing && framing.objects.length > 0) {
          for (const obj of framing.objects) {
            const end = Math.min(
              obj.payloadOffset + obj.payloadLength,
              data.length,
            )
            const payload = data.slice(obj.payloadOffset, end)
            // When this object's bytes actually arrived, resolved through the
            // chunk-boundary index the panel keeps. Absent for streams
            // replayed from IDB, which nobody watched arrive.
            const objectAt =
              arrivalAt(stream.arrivals, obj.payloadOffset) ?? openedAt

            // A fetch object carries its own Group ID and Priority; a
            // subgroup object inherits the stream header's. Preferring the
            // object's own is what makes a fetch stream export correctly,
            // and is a no-op on a subgroup stream, where they are absent.
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
            // Datagrams are not a QUIC stream and have no stream id; the
            // convention here is 0. Declaring one open as a datagram stream
            // is how a reader learns that from the format's own stream-type
            // field rather than inferring it from the id being zero.
            push(groupAt, {
              type: 'stream-opened',
              seq: 0,
              timestamp: 0,
              streamId: 0n,
              direction: dg.direction === 'tx' ? 0 : 1,
              streamType: STREAM_TYPE_DATAGRAM,
              // Every datagram stream shares stream id 0, so the alias and the
              // group are all that tell one track's datagrams from another's.
              ...optionalId('trackAlias', framing.headerFields.trackAlias),
              groupId: BigInt(dg.groupId),
            })

            for (const obj of framing.objects) {
              const end = Math.min(
                obj.payloadOffset + obj.payloadLength,
                data.length,
              )
              const payload = data.slice(obj.payloadOffset, end)
              // Each datagram was timestamped as it arrived, so unlike a
              // stream this needs no offset arithmetic.
              const objectAt = dg.arrivals?.get(obj.objectId) ?? groupAt

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
