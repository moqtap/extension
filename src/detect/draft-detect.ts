/**
 * MoQT draft detection.
 *
 * Two things have to be established, and they come from different places:
 *
 *   *is* this MoQT      from the first varint on a candidate control stream
 *   *which draft*       from the negotiated application protocol, or — for the
 *                       drafts that put one there — from a version on the wire
 *
 * Draft-20 Section 3.1 is explicit about the second half:
 *
 *   > MOQT uses ALPN in QUIC and "WT-Available-Protocols" in WebTransport
 *   > ([WebTransport], Section 3.3) to perform version negotiation. [...]
 *   > ALPNs used to identify IETF drafts are created by appending the draft
 *   > number to "moqt-". For example, draft-ietf-moq-transport-13 would be
 *   > identified as "moqt-13".
 *   >
 *   > Note: Draft versions prior to -15 all used moq-00 ALPN, followed by
 *   > version negotiation in the SETUP messages.
 *
 * This extension observes WebTransport, so the mechanism it sees is
 * `WT-Available-Protocols` — the `protocols` member of WebTransportOptions,
 * which the page hands to the WebTransport constructor and the hook captures —
 * and the server's pick, exposed as the session's `protocol` attribute. (ALPN
 * on a WebTransport connection is `h3`; it names HTTP/3, not MoQT.)
 *
 * So:
 *   drafts 07-14   a version list in CLIENT_SETUP, `0xff000000 + n`
 *   drafts 15+     `moqt-NN`, and no version number on the wire at all
 *
 * Message type IDs by era, read off the first bytes of the stream:
 *   - 0x40   → CLIENT_SETUP, drafts ≤ 10      (RFC 9000 varint: `40 40`)
 *   - 0x20   → CLIENT_SETUP, drafts 11-16     (RFC 9000 varint: `20`)
 *   - 0x2F00 → SETUP, drafts 17+, on a unidirectional control stream,
 *              written with MoQT's own varint as `af 00`
 *
 * Nothing here parses a SETUP body, so the type ID is only ever a
 * MoQT/not-MoQT signal. Which draft wrote it is a separate question, answered
 * above.
 */

import { decodeMoqtVarint, decodeVarint } from '../codec/varint'
import { isSupportedDraft, type SupportedDraft } from '../types/common'

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

/**
 * The draft assumed when nothing named one. Only ever reached through
 * `{ via: 'unidentified' }` evidence, which says so.
 */
export const NEWEST_SUPPORTED_DRAFT: SupportedDraft = '20'

/**
 * Wire version numbers → draft, for the drafts that negotiate a version in
 * SETUP.
 *
 * Stops at 14 on purpose. Draft-15 moved version negotiation to the protocol
 * string and sends no version number at all, so `0xff00000f` and everything
 * above it is a value no peer ever writes. Earlier revisions of this file
 * carried entries through 19 and synthesised `0xff000013` for every draft-17+
 * session, presenting a number nobody had sent as an observed one; the table
 * ends where the wire does.
 */
const VERSION_TO_DRAFT: ReadonlyMap<number, SupportedDraft> = new Map([
  [0xff000007, '07'],
  [0xff000008, '08'],
  [0xff000009, '09'],
  [0xff00000a, '10'],
  [0xff00000b, '11'],
  [0xff00000c, '12'],
  [0xff00000d, '13'],
  [0xff00000e, '14'],
])

/**
 * The range MoQT draft versions live in: `0xff000000 + draft number`.
 *
 * Used to tell "a draft version this build has no table for" from "a varint
 * that is not a version at all" — which is what a drafts 15-16 CLIENT_SETUP
 * payload yields, since its first fields are a parameter count and parameter
 * type IDs, not a version list.
 */
const DRAFT_VERSION_MIN = 0xff000000
const DRAFT_VERSION_MAX = 0xff0000ff

/** The application protocol strings MoQT drafts negotiate under. */
const MOQT_PROTOCOL_RE = /^moqt-(\d+)$/

/**
 * What the transport knows about the application protocol for this session.
 *
 * `offered` is `WT-Available-Protocols` — the `protocols` member of
 * WebTransportOptions, readable the moment the page constructs the session.
 * `selected` is the server's pick, the session's `protocol` attribute, which
 * is only meaningful once `ready` has resolved and is absent on browsers that
 * have not implemented protocol negotiation.
 */
export interface NegotiatedProtocol {
  selected?: string
  offered?: string[]
}

/** How a draft number was arrived at — the evidence, not just the answer. */
export type DraftEvidence =
  /**
   * A version number the peer put on the wire, in CLIENT_SETUP or
   * SERVER_SETUP. Drafts 07-14 only.
   */
  | { via: 'wire-version'; versions: number[] }
  /**
   * The negotiated application protocol string, `moqt-NN`. This is how drafts
   * 15+ negotiate their version, and they send no version number at all.
   * `source` is 'selected' when the server's pick was visible and 'offered'
   * when the client's offer named exactly one MoQT protocol, which the server
   * must either accept or fail the session over.
   */
  | {
      via: 'negotiated-protocol'
      protocol: string
      source: 'selected' | 'offered'
    }
  /**
   * Nothing named the draft. On a `protocol: 'moqt'` result the `draft` field
   * is a fallback and `reason` says why one was needed.
   */
  | { via: 'unidentified'; reason: string }

export type DetectionResult =
  | { protocol: 'moqt'; draft: SupportedDraft; evidence: DraftEvidence }
  | { protocol: 'moqt-unknown-draft'; evidence: DraftEvidence }
  | { protocol: 'unknown' }

/** Whether this result's draft is a fallback rather than something observed. */
export function isDraftAssumed(result: DetectionResult): boolean {
  return result.protocol === 'moqt' && result.evidence.via === 'unidentified'
}

/**
 * The draft number a `moqt-NN` protocol string names, whether or not this
 * build has tables for it.
 */
export function draftFromProtocolString(protocol: string): string | undefined {
  const n = MOQT_PROTOCOL_RE.exec(protocol.trim())?.[1]
  // "moqt-7" and "moqt-07" name the same draft; the tables are keyed by the
  // two-digit form the drafts themselves use.
  return n == null ? undefined : n.padStart(2, '0')
}

export type ProtocolResolution =
  | {
      ok: true
      protocol: string
      /** Undefined when the string names a draft this build cannot decode. */
      draft?: SupportedDraft
      source: 'selected' | 'offered'
    }
  | {
      ok: false
      reason: string
      /** The best guess, when the offer narrowed it without settling it. */
      bestGuess?: SupportedDraft
    }

/**
 * Read the draft out of what the transport negotiated.
 *
 * The server's selection wins outright. Failing that the offer settles it when
 * it names exactly one MoQT protocol: the server either takes that one or the
 * session does not open. An offer naming several leaves the answer with the
 * server, which is not visible here — that is reported as unresolved, with the
 * newest offered draft as the guess rather than the newest this build knows.
 */
export function resolveNegotiatedProtocol(
  negotiated?: NegotiatedProtocol,
): ProtocolResolution {
  const selected = negotiated?.selected?.trim()
  if (selected) {
    const n = draftFromProtocolString(selected)
    if (n != null) {
      return {
        ok: true,
        protocol: selected,
        draft: isSupportedDraft(n) ? n : undefined,
        source: 'selected',
      }
    }
    // A selection that is not MoQT at all (moq-lite, say) is a definite answer
    // about MoQT's absence, but this function only reports draft numbers.
    return {
      ok: false,
      reason: `selected protocol "${selected}" is not a moqt-NN string`,
    }
  }

  const offered = (negotiated?.offered ?? []).filter(
    (p): p is string => typeof p === 'string' && p.trim().length > 0,
  )
  if (offered.length === 0) {
    return {
      ok: false,
      reason:
        'no WT-Available-Protocols offer was captured and the server’s selection is not visible',
    }
  }

  const moqt = offered
    .map((p) => ({ protocol: p.trim(), n: draftFromProtocolString(p) }))
    .filter((e): e is { protocol: string; n: string } => e.n != null)

  if (moqt.length === 0) {
    return {
      ok: false,
      reason:
        `WT-Available-Protocols offered ${offered.join(', ')}` +
        ' — no moqt-NN entry',
    }
  }

  if (moqt.length === 1) {
    const { protocol, n } = moqt[0]
    return {
      ok: true,
      protocol,
      draft: isSupportedDraft(n) ? n : undefined,
      source: 'offered',
    }
  }

  // Several offered and no selection visible. Newest offered is the likeliest
  // pick — servers take the highest draft they speak — but it is still a guess.
  const newest = moqt.reduce((a, b) => (Number(b.n) > Number(a.n) ? b : a))
  return {
    ok: false,
    reason: `WT-Available-Protocols offered ${moqt
      .map((e) => e.protocol)
      .join(', ')} and the server’s selection is not visible`,
    bestGuess: isSupportedDraft(newest.n) ? newest.n : undefined,
  }
}

/** Turn a protocol resolution into a result for a confirmed MoQT stream. */
function identifyFromProtocol(
  resolution: ProtocolResolution,
): DetectionResult {
  if (resolution.ok) {
    if (resolution.draft) {
      return {
        protocol: 'moqt',
        draft: resolution.draft,
        evidence: {
          via: 'negotiated-protocol',
          protocol: resolution.protocol,
          source: resolution.source,
        },
      }
    }
    // A draft this build has no codec for. Naming it draft-19 and decoding it
    // anyway is how the wrong bytes get shown as the right message.
    return {
      protocol: 'moqt-unknown-draft',
      evidence: {
        via: 'negotiated-protocol',
        protocol: resolution.protocol,
        source: resolution.source,
      },
    }
  }

  return {
    protocol: 'moqt',
    draft: resolution.bestGuess ?? NEWEST_SUPPORTED_DRAFT,
    evidence: { via: 'unidentified', reason: resolution.reason },
  }
}

/**
 * Read the leading varints of a CLIENT_SETUP payload as a supported-versions
 * list. Drafts 11-14 put one there; drafts 15-16 do not, and what comes back
 * for those is a parameter count followed by parameter type IDs, which is why
 * the caller checks the values against the draft-version range before
 * believing them.
 */
function readVersionList(bytes: Uint8Array, offset: number): number[] {
  // Wire format: MsgType(varint) + MsgLength(varint) + Payload, payload
  // starting with NumVersions(varint) + Version(varint)...
  const [, msgLenLen] = decodeVarint(bytes, offset)
  offset += msgLenLen

  const [numVersions, numVersionsLen] = decodeVarint(bytes, offset)
  offset += numVersionsLen

  const versions: number[] = []
  for (let i = 0; i < numVersions && offset < bytes.length; i++) {
    const [version, versionLen] = decodeVarint(bytes, offset)
    offset += versionLen
    versions.push(version)
  }
  return versions
}

/**
 * Attempt to detect MoQT from the first bytes of a control stream.
 *
 * Expects the raw bytes of the first message on the control stream, and
 * whatever the transport negotiated for the session — the second is what names
 * the draft for anything from draft-15 on, so a caller that has it should pass
 * it.
 *
 * This uses only the inline varint decoder — no codec dependency — so it
 * can run before we know which codec to instantiate.
 */
export function detectFromControlStream(
  bytes: Uint8Array,
  negotiated?: NegotiatedProtocol,
): DetectionResult {
  if (bytes.length < 2) {
    return { protocol: 'unknown' }
  }

  const resolution = resolveNegotiatedProtocol(negotiated)

  // Draft-17+: SETUP (0x2F00) on a unidirectional control stream, written with
  // MoQT's own varint — `af 00`, not the `6f 00` RFC 9000 would produce.
  //
  // The type ID alone does not separate drafts 17, 18, 19 and 20: all four
  // write SETUP as 0x2F00. That is a claim about the message type varint and
  // nothing more — the bodies are not identical (draft-19 added Setup Options
  // 0x06 MAX_FILTER_RANGES and 0x08 MAX_REQUEST_UPDATES, so either one present
  // rules out 17 and 18) — but every option is optional and unknown ones must
  // be ignored, so their absence proves nothing and no body read here could
  // settle it either way. It does not need to: the type ID says MoQT, and the
  // negotiated protocol string says which draft.
  try {
    const [msgType] = decodeMoqtVarint(bytes, 0)
    if (msgType === SETUP_DRAFT17_PLUS) return identifyFromProtocol(resolution)
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

    const versions = readVersionList(bytes, msgTypeLen)

    // A version the table knows settles it — drafts 07-14.
    for (const v of versions) {
      const draft = VERSION_TO_DRAFT.get(v)
      if (draft) {
        return {
          protocol: 'moqt',
          draft,
          evidence: { via: 'wire-version', versions },
        }
      }
    }

    // Nothing recognised on the wire. Two different situations land here:
    //
    //   - drafts 15-16, whose CLIENT_SETUP carries no version list at all, so
    //     the varints just read are a parameter count and parameter type IDs
    //   - a draft 07-14 peer offering only versions this build has no table for
    //
    // The negotiated protocol string separates them, and for the first it is
    // the only thing that can.
    if (resolution.ok) return identifyFromProtocol(resolution)

    // An ambiguous offer — several moqt-NN and no visible selection — still
    // narrows it to a draft that at least uses this era's CLIENT_SETUP.
    // Unlike the draft-17+ path there is no blanket fallback here: with no
    // MoQT protocol offered at all, `NEWEST_SUPPORTED_DRAFT` would name a
    // draft that does not have a CLIENT_SETUP to have sent these bytes.
    if (resolution.bestGuess) {
      return {
        protocol: 'moqt',
        draft: resolution.bestGuess,
        evidence: { via: 'unidentified', reason: resolution.reason },
      }
    }

    const draftVersions = versions.filter(
      (v) => v >= DRAFT_VERSION_MIN && v <= DRAFT_VERSION_MAX,
    )
    if (draftVersions.length > 0) {
      return {
        protocol: 'moqt-unknown-draft',
        evidence: { via: 'wire-version', versions },
      }
    }

    if (versions.length === 0) {
      return { protocol: 'unknown' }
    }

    // Well-formed CLIENT_SETUP framing with no version in it — drafts 15-16 —
    // and no protocol string to name the draft. Reporting the parameter bytes
    // as "offered versions" would be inventing an observation.
    return {
      protocol: 'moqt-unknown-draft',
      evidence: { via: 'unidentified', reason: resolution.reason },
    }
  } catch {
    // Parse failure → not MoQT
    return { protocol: 'unknown' }
  }
}

/**
 * Refine detection using the SERVER_SETUP selected version.
 *
 * Called after the server responds, to confirm or narrow the draft. The
 * selectedVersion from SERVER_SETUP is authoritative — for the drafts that
 * have one. Drafts 15-16 send SERVER_SETUP with no version field, and from
 * draft-17 there is no SERVER_SETUP at all; for those the protocol string
 * already decided and there is nothing to refine.
 */
export function refineFromSelectedVersion(
  selectedVersion: number,
  clientResult: DetectionResult,
): DetectionResult {
  const priorVersions =
    clientResult.protocol !== 'unknown' &&
    clientResult.evidence.via === 'wire-version'
      ? clientResult.evidence.versions
      : [selectedVersion]

  const draft = VERSION_TO_DRAFT.get(selectedVersion)
  if (draft) {
    return {
      protocol: 'moqt',
      draft,
      evidence: { via: 'wire-version', versions: priorVersions },
    }
  }

  return {
    protocol: 'moqt-unknown-draft',
    evidence: { via: 'wire-version', versions: priorVersions },
  }
}

/**
 * Get the known draft for a specific version number, if any.
 *
 * Only drafts 07-14 have one — see `VERSION_TO_DRAFT`.
 */
export function versionToDraft(version: number): SupportedDraft | undefined {
  return VERSION_TO_DRAFT.get(version)
}
