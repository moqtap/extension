/**
 * The marker a control-plane read leaves behind when a peer sends bytes that
 * no continuation can decode.
 *
 * It travels the same path a decoded control message does — background to
 * panel to the session's message list — because that is where it belongs on
 * screen: beside the messages that did decode, in the stream that stopped.
 *
 * It is not a control message, though. Exporting it as one writes a message
 * the peer never sent, under a type ID no draft assigns, which is worse than
 * omitting it: a reader cannot tell the difference between a trace that
 * recorded a violation and one that recorded a message. In a trace it belongs
 * in the format's error event instead.
 */

/** `MessageEntry.messageType` for an undecodable run of control bytes. */
export const DECODE_ERROR_MESSAGE_TYPE = 'decode_error'

/** Whether a message entry is an undecodable-bytes marker rather than a message. */
export function isDecodeError(messageType: string): boolean {
  return messageType === DECODE_ERROR_MESSAGE_TYPE
}

/**
 * Error code to record for an undecodable run.
 *
 * The decoder names its failures with strings (`UNKNOWN_MESSAGE_TYPE`,
 * `DECODER_THREW`); the trace format's error code is a number drawn from
 * MoQT's own registry. There is no number that means "this reader could not
 * parse these bytes", and inventing one would collide with a code the protocol
 * defines, so the field carries zero and the decoder's name is kept in the
 * reason text. This matches what the CLI's observer already writes for a
 * locally-observed parse failure.
 */
export const DECODE_ERROR_CODE = 0

/**
 * Human-readable reason for a decode-error marker, from the `{ code, reason }`
 * payload the background attaches.
 *
 * Tolerant of a payload that is missing or shaped differently: this runs at
 * export time over state that may have been through a reactive proxy and a
 * JSON round trip, and a trace that loses the error entirely because its
 * description was malformed is a worse outcome than one carrying a vague
 * description.
 */
export function decodeErrorReason(decoded: unknown): string {
  const fallback = 'undecodable control bytes'
  if (decoded == null || typeof decoded !== 'object') return fallback

  const { code, reason } = decoded as { code?: unknown; reason?: unknown }
  const codeText = typeof code === 'string' && code.length > 0 ? code : null
  const reasonText =
    typeof reason === 'string' && reason.length > 0 ? reason : null

  if (codeText && reasonText) return `${codeText}: ${reasonText}`
  return codeText ?? reasonText ?? fallback
}
