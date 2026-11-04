/**
 * One datagram's MoQT header and payload, read under the session's draft.
 */

/** A datagram as the background stores it. */
export interface DatagramRead {
  trackAlias: bigint
  groupId: bigint
  objectId: bigint
  publisherPriority: number
  endOfGroup?: boolean
  payload: Uint8Array
  payloadLength: number
}

export interface DatagramCodec {
  decodeDatagram(bytes: Uint8Array):
    | { ok: true; value: DatagramRead }
    | { ok: false; error: { code: string; message: string } }
  /** The draft-08 to -10 codecs, which decode a status datagram separately */
  decodeDatagramStatus?(bytes: Uint8Array):
    | { ok: true; value: Omit<DatagramRead, 'payload' | 'payloadLength'>; bytesRead: number }
    | { ok: false }
}

/** The datagram, or the decoder's code and reason when it does not decode. */
export function readDatagram(
  codec: DatagramCodec,
  bytes: Uint8Array,
): { ok: true; value: DatagramRead } | { ok: false; code: string; reason: string } {
  const result = codec.decodeDatagram(bytes)
  if (result.ok) return result
  // draft-08 Section 8.3, draft-09 Section 8.3 and draft-10 Section 9.3:
  // "An OBJECT_DATAGRAM_STATUS is similar to OBEJCT_DATAGRAM except it
  // conveys an Object Status and has no payload." The datagram decoder
  // refuses one; its own decoder reads it, and it ends where the status does.
  const status = codec.decodeDatagramStatus?.(bytes)
  if (status?.ok && status.bytesRead === bytes.length) {
    return { ok: true, value: { ...status.value, payload: new Uint8Array(0), payloadLength: 0 } }
  }
  return { ok: false, code: result.error.code, reason: result.error.message }
}
