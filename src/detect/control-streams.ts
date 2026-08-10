/**
 * Recognising control-plane streams from their opening bytes.
 *
 * Which streams carry control messages changed twice in the draft series, and
 * neither change is visible from the transport:
 *
 *   drafts 07–15  one bidirectional control stream; requests ride it
 *   draft 16      + SUBSCRIBE_NAMESPACE on its own bidirectional stream
 *   drafts 17+    control stream becomes a pair of *unidirectional* streams
 *                 ("Change control stream from bidi to a pair of uni streams",
 *                 draft-17 changelog #1510), and each request gets its own
 *                 bidirectional stream
 *
 * The one invariant across all of them is that objects travel on
 * unidirectional streams, so bulk media never appears here. Everything else
 * has to come from the leading varint, which the spec makes reliable: a
 * request stream must begin with one of seven request messages, and anything
 * else on a bidirectional stream is a protocol violation (draft-19 §3.3).
 */

import { getMessageIdMap } from '../codec/message-ids'
import { decodeVarint } from '../codec/varint'
import type { SupportedDraft } from '../types/common'

/**
 * KNOWN DIVERGENCE — draft-17 §1.4.1 defines a new variable-length integer
 * encoding ("New variable-length integer encoding", changelog #1016): the
 * length is a unary run of leading 1 bits, not RFC 9000's two-bit prefix, and
 * a one-byte value covers 0–127 rather than 0–63.
 *
 * @moqtap/codec implements RFC 9000 for every draft, and @moqtap/test-vectors
 * encodes its draft-17+ fixtures the same way, so the two agree with each
 * other and not with the spec. The visible effect is on ids >= 0x40: SETUP
 * (0x2F00) is `6f 00` here where the spec says `af 00`, and draft-18+
 * SUBSCRIBE_NAMESPACE (0x50) / SUBSCRIBE_TRACKS (0x51) gain a spurious `40`
 * prefix. Ids below 0x40 are identical under both, which is most messages.
 *
 * This module deliberately follows the codec rather than the spec: the
 * extension decodes through that codec, so a classifier that disagreed with
 * it would recognise streams it then could not parse. If the codec is fixed,
 * this follows automatically — everything here resolves ids through
 * getMessageIdMap and encodes with the shared varint helpers.
 */

/**
 * Message types that open a request stream (draft-19 §3.3). Named rather than
 * hardcoded so wire ids come from the draft's own map — they have moved, and
 * will move again: SUBSCRIBE_NAMESPACE is 0x11 in draft-17 and 0x50 in
 * draft-18+. Draft-17 lists only six of these (no SUBSCRIBE_TRACKS), which
 * falls out of its map not defining the message.
 */
export const REQUEST_STREAM_OPENERS = [
  'track_status',
  'subscribe',
  'publish',
  'fetch',
  'publish_namespace',
  'subscribe_namespace',
  'subscribe_tracks',
] as const

/**
 * Message types that open a control stream. Draft-17 collapsed CLIENT_SETUP
 * and SERVER_SETUP into a single SETUP, so all three appear here and the
 * draft's map decides which exist.
 */
export const CONTROL_STREAM_OPENERS = [
  'setup',
  'client_setup',
  'server_setup',
] as const

/**
 * Whether this draft spreads its control plane over multiple streams.
 *
 * Before draft-17 a session has exactly one control stream, found by
 * detection, and no stream needs classifying.
 */
export function hasRequestStreams(draft: SupportedDraft): boolean {
  return Number(draft) >= 17
}

/** Wire ids for a set of message names, skipping any the draft doesn't define. */
function wireIds(draft: SupportedDraft, names: readonly string[]): Set<number> {
  const map = getMessageIdMap(draft)
  const ids = new Set<number>()
  for (const name of names) {
    const id = map.get(name)
    if (id != null) ids.add(Number(id))
  }
  return ids
}

const openerCache = new Map<
  SupportedDraft,
  { control: Set<number>; request: Set<number> }
>()

export function streamOpeners(draft: SupportedDraft) {
  let cached = openerCache.get(draft)
  if (!cached) {
    cached = {
      control: wireIds(draft, CONTROL_STREAM_OPENERS),
      // Empty before draft-17: requests ride the control stream there, so no
      // stream ever opens with SUBSCRIBE. Populating it anyway would let a
      // media stream whose first byte happens to equal SUBSCRIBE (0x03) be
      // decoded as control messages.
      request: hasRequestStreams(draft)
        ? wireIds(draft, REQUEST_STREAM_OPENERS)
        : new Set<number>(),
    }
    openerCache.set(draft, cached)
  }
  return cached
}

/**
 * What a stream is, judged by its opening bytes.
 *
 * 'pending' means the leading varint is not complete yet. Clients routinely
 * split a message's type, length and body across separate writes, so one byte
 * of a two-byte varint must not be mistaken for a verdict.
 */
export type OpenerVerdict = 'control' | 'request' | 'data' | 'pending'

export function classifyStreamOpener(
  lead: Uint8Array,
  draft: SupportedDraft,
): OpenerVerdict {
  let msgType: number
  try {
    ;[msgType] = decodeVarint(lead, 0)
  } catch {
    return 'pending'
  }
  const openers = streamOpeners(draft)
  if (openers.control.has(msgType)) return 'control'
  if (openers.request.has(msgType)) return 'request'
  return 'data'
}
