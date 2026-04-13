/**
 * Build a .moqtrace Trace object from panel-side session state.
 *
 * Stream data is fetched via a callback (typically routed through the
 * background service worker which owns the page buffers + IDB).
 */

import { getMessageIdMap } from '@/src/codec/message-ids'
import type { SupportedDraft } from '@/src/types/common'
import type { Trace, TraceEvent, TraceHeader } from '@moqtap/trace'
import { parseDatagramGroupFraming, parseStreamFraming } from './stream-framing'
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

  const header: TraceHeader = {
    protocol: `moq-transport-${draft}`,
    perspective: 'observer',
    detail: 'headers+data',
    startTime,
    endTime: Date.now(),
    source: 'moqtap-extension/0.1.0',
    endpoint: session.url,
  }

  const events: TraceEvent[] = []
  let seq = 0

  // Control messages
  for (const msg of session.messages) {
    events.push({
      type: 'control',
      seq: seq++,
      timestamp: toRelativeUs(msg.timestamp, startTime),
      direction: msg.direction === 'tx' ? 0 : 1,
      messageType: resolveMessageTypeId(msg.messageType, session.draft as SupportedDraft),
      message: (msg.decoded ?? {}) as Record<string, unknown>,
      raw: msg.raw.length > 0 ? toBytes(msg.raw) : undefined,
    })
  }

  // Streams — open events, payload data, close events
  for (const stream of session.streams.values()) {
    const ts = toRelativeUs(startTime, startTime) // 0 — we don't have per-stream timestamps

    events.push({
      type: 'stream-opened',
      seq: seq++,
      timestamp: ts,
      streamId: BigInt(stream.streamId),
      direction: stream.direction === 'tx' ? 0 : 1,
      streamType: 0, // bidi=0, we don't distinguish
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

              events.push({
                type: 'object-header',
                seq: seq++,
                timestamp: ts,
                streamId: BigInt(stream.streamId),
                groupId: BigInt(hf.groupId ?? 0),
                objectId: BigInt(obj.objectId),
                publisherPriority: hf.publisherPriority ?? 0,
                objectStatus: 0,
              })

              events.push({
                type: 'object-payload',
                seq: seq++,
                timestamp: ts,
                streamId: BigInt(stream.streamId),
                groupId: BigInt(hf.groupId ?? 0),
                objectId: BigInt(obj.objectId),
                size: payload.length,
                payload: toBytes(payload),
              })
            }
          } else {
            // No MoQT framing — store raw as a single object-payload
            events.push({
              type: 'object-payload',
              seq: seq++,
              timestamp: ts,
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
      events.push({
        type: 'stream-closed',
        seq: seq++,
        timestamp: ts,
        streamId: BigInt(stream.streamId),
        errorCode: 0,
      })
    }
  }

  // Datagram groups — export as object-header + object-payload events
  if (getDatagramGroupData) {
    for (const dg of session.datagramGroups.values()) {
      const ts = toRelativeUs(dg.firstDataAt ?? startTime, startTime)

      try {
        const data = await getDatagramGroupData(session.sessionId, dg.groupKey)
        if (data) {
          const framing = parseDatagramGroupFraming(data, session.draft)
          if (framing && framing.objects.length > 0) {
            for (const obj of framing.objects) {
              const end = Math.min(
                obj.payloadOffset + obj.payloadLength,
                data.length,
              )
              const payload = data.slice(obj.payloadOffset, end)

              events.push({
                type: 'object-header',
                seq: seq++,
                timestamp: ts,
                streamId: 0n, // datagrams use streamId=0 by convention
                groupId: BigInt(dg.groupId),
                objectId: BigInt(obj.objectId),
                publisherPriority: framing.headerFields.publisherPriority ?? 0,
                objectStatus: 0,
              })

              events.push({
                type: 'object-payload',
                seq: seq++,
                timestamp: ts,
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

  return { header, events }
}
