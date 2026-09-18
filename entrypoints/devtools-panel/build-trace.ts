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
import type { DetailLevel, Trace, TraceEvent, TraceHeader } from '@moqtap/trace'
import { parseDatagramGroupFraming, parseStreamFraming } from './stream-framing'
import { arrivalAt } from '@/src/trace/arrivals'
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

  // Streams — open events, payload data, close events
  for (const stream of session.streams.values()) {
    // Nothing records when a stream opened, so the first chunk's arrival is
    // the earliest moment it is known to have existed. A stream that carried
    // no data falls back to session start.
    const openedAt = stream.firstDataAt ?? startTime

    push(openedAt, {
      type: 'stream-opened',
      seq: 0,
      timestamp: 0,
      streamId: BigInt(stream.streamId),
      direction: stream.direction === 'tx' ? 0 : 1,
      // A fetch stream carries a request id in its framing header where a
      // subgroup stream carries a track alias; that is what tells them apart.
      streamType:
        stream.fetchRequestId != null
          ? STREAM_TYPE_FETCH
          : STREAM_TYPE_SUBGROUP,
    })

    // Load stream data via callback (background serves from memory + IDB)
    if (stream.byteCount > 0) {
      try {
        const data = await getStreamData(session.sessionId, stream.streamId)
        if (data) {
          // Try to parse MoQT framing to extract individual objects
          const framing = parseStreamFraming(data)
          if (framing && framing.objects.length > 0) {
            const hf = framing.headerFields
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
        }
      } catch {
        // Stream data load failed — skip
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
              })

              push(objectAt, {
                type: 'object-payload',
                seq: 0,
                timestamp: 0,
                streamId: 0n,
                groupId: BigInt(dg.groupId),
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

  const events: TraceEvent[] = pending.map(
    ({ at, event }, seq) =>
      ({
        ...event,
        seq,
        timestamp: toRelativeUs(at, startTime),
      }) as TraceEvent,
  )

  // `detail` describes what this trace actually carries, so it is derived
  // rather than declared. Payload capture can be off -- `streamRecording ===
  // false` makes `getStreamData` return null -- and then no object-header and
  // no object-payload event is built at all. A constant 'headers+data' claims
  // bytes that are absent, and a reader trusting the header would conclude the
  // session carried no objects rather than that they were not recorded.
  const carriesPayload = events.some(
    (e) => e.type === 'object-payload' && (e as { payload?: unknown }).payload !== undefined,
  )
  const carriesObjects = carriesPayload || events.some((e) => e.type === 'object-header')
  const detail: DetailLevel = carriesPayload
    ? 'headers+data'
    : carriesObjects
      ? 'headers'
      : 'control'

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
