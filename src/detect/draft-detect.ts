/**
 * MoQT draft auto-detection from WebTransport control stream bytes.
 *
 * Detection strategy:
 * 1. Peek at the first varint on the control stream. Which of the two varint
 *    encodings is in force depends on the draft, which is what we are trying
 *    to establish, so the bytes are read both ways (see ../codec/varint).
 * 2. If it matches a known message type ID, it's likely MoQT:
 *    - 0x40 → CLIENT_SETUP for drafts ≤ 10        (RFC 9000: `40 40`)
 *    - 0x20 → CLIENT_SETUP for drafts 11-16       (RFC 9000: `20`)
 *    - 0x2F00 → SETUP for draft-17+ (ALPN-based version negotiation),
 *      written with MoQT's varint as `af 00`
 * 3. For CLIENT_SETUP: parse supported_versions to identify draft
 * 4. For SETUP (0x2F00): defaults to latest known draft (version via ALPN,
 *    not in wire — drafts 17, 18 and 19 are wire-indistinguishable on the
 *    first message)
 * 5. After SERVER_SETUP (drafts ≤ 16), map selected_version to known draft
 * 6. If nothing matches → unknown protocol (pass through gracefully)
 */

import { decodeMoqtVarint, decodeVarint } from '../codec/varint'
import type { SupportedDraft } from '../types/common'

/** Known CLIENT_SETUP / SETUP message type IDs by era */
const CLIENT_SETUP_DRAFT07 = 0x40 // drafts ≤ 10
const CLIENT_SETUP_DRAFT11 = 0x20 // drafts 11-16
const SETUP_DRAFT17_PLUS = 0x2f00 // draft-17+ (unidirectional control streams)

/**
 * Every message type that can legally open a control stream, split by the
 * varint encoding its draft writes: draft-17 §1.4.1 replaced the RFC 9000
 * integer, so the leading bytes have to be read both ways before the draft is
 * known. SERVER_SETUP is included because a control stream carries both
 * directions and we make no assumption about which side we observe first.
 *
 * The sets do not overlap in practice: no draft ≤ 16 defines message type
 * 0x2F00, and draft-17 collapsed CLIENT_SETUP and SERVER_SETUP into SETUP.
 */
const RFC9000_STREAM_OPENERS: ReadonlySet<number> = new Set([
  CLIENT_SETUP_DRAFT07,
  0x41, // SERVER_SETUP, drafts ≤ 10
  CLIENT_SETUP_DRAFT11,
  0x21, // SERVER_SETUP, drafts 11-16
])

const MOQT_STREAM_OPENERS: ReadonlySet<number> = new Set([SETUP_DRAFT17_PLUS])

/**
 * Could a stream that begins with these bytes be a MoQT control stream?
 *
 * Answers from the leading varint alone, so a caller can stop retaining a
 * stream's bytes as soon as it is provably not a control stream — which is
 * every media stream, after two bytes.
 *
 * Deliberately answers `true` while undecided: with too few bytes to read the
 * leading varint the honest answer is "keep looking", and control streams get
 * written in small pieces (a client may write the message type, length and
 * body as three separate writes).
 *
 * Note this is about the *stream*, not the transport: the control stream is
 * bidirectional through draft-16 but a pair of unidirectional streams from
 * draft-17 on, so stream direction cannot stand in for this check.
 */
export function couldBeControlStream(leadingBytes: Uint8Array): boolean {
  // Which encoding is in force is exactly what detection has not established
  // yet, so both are tried. A stream is only ruled out once neither can still
  // turn into an opener — at most nine bytes, the longest MoQT varint.
  let incomplete = false

  try {
    const [msgType] = decodeVarint(leadingBytes, 0)
    if (RFC9000_STREAM_OPENERS.has(msgType)) return true
  } catch {
    incomplete = true
  }

  try {
    const [msgType] = decodeMoqtVarint(leadingBytes, 0)
    if (MOQT_STREAM_OPENERS.has(msgType)) return true
  } catch {
    incomplete = true
  }

  return incomplete
}

/** Latest draft assumed when only the ALPN-era SETUP message type is visible. */
const LATEST_ALPN_DRAFT: SupportedDraft = '19'
const LATEST_ALPN_DRAFT_VERSION = 0xff000013

/** Known version wire values → supported draft */
const VERSION_TO_DRAFT: ReadonlyMap<number, SupportedDraft> = new Map([
  [0xff000007, '07'],
  [0xff000008, '08'],
  [0xff000009, '09'],
  [0xff00000a, '10'],
  [0xff00000b, '11'],
  [0xff00000c, '12'],
  [0xff00000d, '13'],
  [0xff00000e, '14'],
  [0xff00000f, '15'],
  [0xff000010, '16'],
  [0xff000011, '17'],
  [0xff000012, '18'],
  [0xff000013, '19'],
])

export type DetectionResult =
  | { protocol: 'moqt'; draft: SupportedDraft; versions: number[] }
  | { protocol: 'moqt-unknown-draft'; versions: number[] }
  | { protocol: 'unknown' }

/**
 * Attempt to detect MoQT from the first bytes of a control stream.
 *
 * Expects the raw bytes of the first message on the control stream.
 * Returns a detection result indicating whether this looks like MoQT and
 * which draft versions were offered.
 *
 * This uses only the inline varint decoder — no codec dependency — so it
 * can run before we know which codec to instantiate.
 */
export function detectFromControlStream(bytes: Uint8Array): DetectionResult {
  if (bytes.length < 2) {
    return { protocol: 'unknown' }
  }

  // Draft-17+: SETUP (0x2F00) on a unidirectional control stream, written with
  // MoQT's own varint — `af 00`, not the `6f 00` RFC 9000 would produce.
  // Version is negotiated via ALPN, not present in wire bytes — drafts 17,
  // 18 and 19 are indistinguishable here, so we default to the newest.
  try {
    const [msgType] = decodeMoqtVarint(bytes, 0)
    if (msgType === SETUP_DRAFT17_PLUS) {
      return {
        protocol: 'moqt',
        draft: LATEST_ALPN_DRAFT,
        versions: [LATEST_ALPN_DRAFT_VERSION],
      }
    }
  } catch {
    // Too few bytes for the MoQT form; the RFC 9000 reading may still land.
  }

  // Drafts ≤ 16: CLIENT_SETUP on a bidirectional control stream. Everything
  // below stays on RFC 9000 because only those drafts reach it.
  try {
    const [msgType, msgTypeLen] = decodeVarint(bytes, 0)

    if (msgType !== CLIENT_SETUP_DRAFT07 && msgType !== CLIENT_SETUP_DRAFT11) {
      return { protocol: 'unknown' }
    }

    // Try to parse version list from CLIENT_SETUP payload.
    // Wire format: MsgType(varint) + MsgLength(varint) + Payload
    // Payload for CLIENT_SETUP starts with: NumVersions(varint) + Version(varint)...
    let offset = msgTypeLen

    // Skip message length (varint in draft-14, or fixed in some drafts)
    const [_msgLen, msgLenLen] = decodeVarint(bytes, offset)
    offset += msgLenLen

    // Parse supported_versions count
    const [numVersions, numVersionsLen] = decodeVarint(bytes, offset)
    offset += numVersionsLen

    const versions: number[] = []
    for (let i = 0; i < numVersions && offset < bytes.length; i++) {
      const [version, versionLen] = decodeVarint(bytes, offset)
      offset += versionLen
      versions.push(version)
    }

    if (versions.length === 0) {
      return { protocol: 'unknown' }
    }

    // Check if any offered version maps to a known draft
    for (const v of versions) {
      if (VERSION_TO_DRAFT.has(v)) {
        return { protocol: 'moqt', draft: VERSION_TO_DRAFT.get(v)!, versions }
      }
    }

    // Looks like MoQT (valid CLIENT_SETUP structure) but unknown version
    return { protocol: 'moqt-unknown-draft', versions }
  } catch {
    // Parse failure → not MoQT
    return { protocol: 'unknown' }
  }
}

/**
 * Refine detection using the SERVER_SETUP selected version.
 *
 * Called after the server responds, to confirm or narrow the draft.
 * The selectedVersion from SERVER_SETUP is authoritative.
 * Not applicable for draft-17+ (version negotiated via ALPN, no SERVER_SETUP).
 */
export function refineFromSelectedVersion(
  selectedVersion: number,
  clientResult: DetectionResult,
): DetectionResult {
  const draft = VERSION_TO_DRAFT.get(selectedVersion)
  if (draft) {
    const versions =
      clientResult.protocol !== 'unknown'
        ? clientResult.versions
        : [selectedVersion]
    return { protocol: 'moqt', draft, versions }
  }

  // Server selected an unknown version
  if (clientResult.protocol !== 'unknown') {
    return { protocol: 'moqt-unknown-draft', versions: clientResult.versions }
  }
  return { protocol: 'moqt-unknown-draft', versions: [selectedVersion] }
}

/**
 * Get the known draft for a specific version number, if any.
 */
export function versionToDraft(version: number): SupportedDraft | undefined {
  return VERSION_TO_DRAFT.get(version)
}
