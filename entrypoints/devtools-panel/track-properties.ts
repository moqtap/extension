/**
 * The Track Properties a session's control messages carry (draft-16 Track
 * Extensions), by the track they describe: SUBSCRIBE_OK, PUBLISH and
 * FETCH_OK from draft-16, and REQUEST_OK for TRACK_STATUS from draft-18.
 */

import { pairRequests, trackEventFrom } from '@moqtap/inspect'
import type { LocPropertyInput } from '@moqtap/media/loc'
import { namespaceText, registryTrackKey, type TrackKey, trackKey } from './catalogs'
import { hexToBytes } from './decoded'
import { messageEvents, type MessageEvent, sessionDraft } from './requests'
import { decodeObjectProperties } from './stream-framing'
import type { MessageEntry, SessionEntry } from './use-inspector'

/** One message's Track Properties. */
export interface TrackPropertyList {
  message: MessageEntry
  /** The properties the codec does not name, and Immutable Properties with its contents */
  properties: LocPropertyInput[]
}

const IMMUTABLE_PROPERTIES = 0x0bn

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Bytes as the codec gives them, or as the hex the panel's decoded form holds. */
function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string' && /^(?:[0-9a-f]{2})*$/i.test(value)) return hexToBytes(value)
  return null
}

/**
 * A variable-length integer from its encoded bytes: the leading-ones form of
 * draft-17 on (draft-22 Section 8.1), the QUIC form (RFC 9000 16) before.
 */
function readVarint(bytes: Uint8Array, draft: string | undefined): bigint | null {
  if (bytes.length === 0) return null
  const first = bytes[0]!
  let size: number
  let v: bigint
  if (draft !== undefined && Number(draft) >= 17) {
    let ones = 0
    while (ones < 8 && first & (0x80 >> ones)) ones++
    size = ones === 8 ? 9 : ones + 1
    v = BigInt(first & (0xff >> (ones + 1)))
  } else {
    size = 1 << (first >> 6)
    v = BigInt(first & 0x3f)
  }
  if (bytes.length !== size) return null
  for (let i = 1; i < size; i++) v = (v << 8n) | BigInt(bytes[i]!)
  return v
}

/**
 * The properties of one message's Track Properties that the codec leaves
 * unnamed, each read by its type's parity, and Immutable Properties with its
 * contents.
 */
export function trackPropertyInputs(field: Record<string, unknown>, draft: string | undefined): LocPropertyInput[] {
  const out: LocPropertyInput[] = []
  const pushImmutable = (bytes: Uint8Array) => {
    const decoded = draft === undefined ? null : decodeObjectProperties(bytes, draft)
    out.push({
      type: IMMUTABLE_PROPERTIES,
      bytes,
      ...(decoded?.ok ? { properties: decoded.value } : {}),
    })
  }
  const unknown = Array.isArray(field.unknown) ? field.unknown : []
  for (const u of unknown) {
    const r = asRecord(u)
    if (!r || typeof r.id !== 'string' || typeof r.raw_hex !== 'string') continue
    let type: bigint
    try {
      type = BigInt(r.id)
    } catch {
      continue
    }
    const bytes = asBytes(r.raw_hex)
    if (!bytes) continue
    if (type % 2n === 0n) {
      const value = readVarint(bytes, draft)
      if (value !== null) out.push({ type, value })
    } else if (type === IMMUTABLE_PROPERTIES) {
      // The draft-16 codec leaves Immutable Extensions (draft-16 Section 11.2) unnamed.
      pushImmutable(bytes)
    } else {
      out.push({ type, bytes })
    }
  }
  const immutable = asBytes(field.immutable_properties)
  if (immutable) pushImmutable(immutable)
  return out
}

function propertyField(decoded: unknown): Record<string, unknown> | null {
  const r = asRecord(decoded)
  return asRecord(r?.track_properties) ?? asRecord(r?.track_extensions)
}

/**
 * Every message's Track Properties, by track. A response is placed by its
 * request's namespace and name; a joining FETCH_OK by the subscription it
 * joins.
 */
export function trackPropertyLists(
  session: Pick<SessionEntry, 'messages' | 'tracks' | 'draft'>,
): Map<TrackKey, TrackPropertyList[]> {
  const out = new Map<TrackKey, TrackPropertyList[]>()
  const carrying = session.messages.filter((m) => propertyField(m.decoded) !== null)
  if (carrying.length === 0) return out
  const events = messageEvents(session.messages)
  const requestOf = new Map<MessageEntry, MessageEvent>()
  for (const { request, response } of pairRequests(events, { draft: sessionDraft(session) })) {
    if (response !== null) requestOf.set(response.entry, request)
  }
  const byEntry = new Map(events.map((e) => [e.entry, e]))

  const keyOf = (event: MessageEvent | undefined): TrackKey | null => {
    if (!event || event.kind === 'undecodable' || !event.name) return null
    const fields = asRecord(event.entry.decoded)
    if (!fields) return null
    const track = trackEventFrom(event.name, fields)
    if (track?.kind === 'open') {
      if (track.joiningRequestId === undefined) {
        return trackKey(namespaceText(track.trackNamespace), track.trackName)
      }
      for (const t of session.tracks.values()) {
        if (t.subscribeId === track.joiningRequestId && t.direction === event.direction) {
          return registryTrackKey(t)
        }
      }
      return null
    }
    const ns = fields.track_namespace
    if (Array.isArray(ns) && ns.every((p) => typeof p === 'string') && typeof fields.track_name === 'string') {
      return trackKey(namespaceText(ns as string[]), fields.track_name)
    }
    return null
  }

  for (const message of carrying) {
    const event = byEntry.get(message)
    const key = keyOf(event) ?? keyOf(requestOf.get(message))
    if (key === null) continue
    const properties = trackPropertyInputs(propertyField(message.decoded)!, session.draft)
    if (properties.length === 0) continue
    const list = out.get(key) ?? []
    list.push({ message, properties })
    out.set(key, list)
  }
  return out
}
