/**
 * Names for the control messages a .moqtrace file carries.
 *
 * The format names a control message only by the `"mt"` wire ID its draft
 * assigns it, and names the draft only in the header's protocol identifier;
 * turning that pair into "subscribe" is the reader's job. The decoded body's
 * `type` key is no substitute — nothing in the format promises it, and traces
 * this extension writes carry one only because the JS codec's decoded messages
 * are discriminated unions that happen to. A trace written by the Rust CLI has
 * no such key, so reading the name off the body showed every one of its
 * control messages as raw hex.
 */

import { getMessageTypeMap, isSupportedDraft } from '../codec/message-ids'

/**
 * The draft number a trace header's protocol identifier names, if it names one.
 *
 * The identifier is the IETF document name minus its `draft-ietf-` prefix, so
 * a draft-phase trace reads "moq-transport-07". The format also defines
 * "moq-transport-rfc9999" for the published standard, whose number is an RFC
 * and not a draft, and a trace from an unknown writer may carry anything at
 * all; both answer undefined, because no name beats one resolved through the
 * wrong draft's table.
 *
 * The number comes back as written rather than narrowed to a draft the codec
 * has a table for: it also labels the session, where a draft newer than this
 * build knows about is still worth showing.
 */
export function draftFromProtocol(
  protocol: string | undefined,
): string | undefined {
  return protocol?.match(/moq-transport-(\d+)/)?.[1]
}

/**
 * Name a control message from what its trace actually promises.
 *
 * In order: the `"mt"` wire ID resolved through the draft's table; then the
 * decoded body's `type`, which is all that is left when the draft is unknown
 * or the ID is one its table does not assign; then the ID in hex, which at
 * least repeats what the trace said rather than inventing a name for it.
 */
export function controlMessageName(
  messageType: number | undefined,
  draft: string | undefined,
  message?: Record<string, unknown>,
): string {
  // Narrow before the lookup: `getMessageTypeMap` is keyed by draft 07-20 and
  // answers undefined for anything else, including the draft a trace newer
  // than this build carries.
  if (
    messageType != null &&
    Number.isInteger(messageType) &&
    draft != null &&
    isSupportedDraft(draft)
  ) {
    const name = getMessageTypeMap(draft).get(BigInt(messageType))
    if (name != null) return name
  }
  const bodyType = message?.type
  if (typeof bodyType === 'string') return bodyType
  return `0x${(messageType ?? 0).toString(16)}`
}
