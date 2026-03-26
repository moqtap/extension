/**
 * MoQT draft auto-detection from WebTransport control stream bytes.
 *
 * Detection strategy:
 * 1. Peek at the first varint on the control stream
 * 2. If it matches a known message type ID, it's likely MoQT:
 *    - 0x40 → CLIENT_SETUP for drafts ≤ 10
 *    - 0x20 → CLIENT_SETUP for drafts 11-16
 *    - 0x2F00 → SETUP for draft-17+ (ALPN-based version negotiation)
 * 3. For CLIENT_SETUP: parse supported_versions to identify draft
 * 4. For SETUP (0x2F00): draft-17 implied (version via ALPN, not in wire)
 * 5. After SERVER_SETUP (drafts ≤ 16), map selected_version to known draft
 * 6. If nothing matches → unknown protocol (pass through gracefully)
 */

import type { SupportedDraft } from '../types/common';
import { decodeVarint } from '../codec/varint';

/** Known CLIENT_SETUP / SETUP message type IDs by era */
const CLIENT_SETUP_DRAFT07 = 0x40;   // drafts ≤ 10
const CLIENT_SETUP_DRAFT11 = 0x20;   // drafts 11-16
const SETUP_DRAFT17 = 0x2f00;        // draft-17+ (unidirectional control streams)

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
]);

export type DetectionResult =
  | { protocol: 'moqt'; draft: SupportedDraft; versions: number[] }
  | { protocol: 'moqt-unknown-draft'; versions: number[] }
  | { protocol: 'unknown' };

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
    return { protocol: 'unknown' };
  }

  try {
    const [msgType, msgTypeLen] = decodeVarint(bytes, 0);

    // Draft-17+: SETUP (0x2F00) on unidirectional control stream.
    // Version is negotiated via ALPN, not present in wire bytes.
    if (msgType === SETUP_DRAFT17) {
      return { protocol: 'moqt', draft: '17', versions: [0xff000011] };
    }

    // Drafts ≤ 16: CLIENT_SETUP on bidirectional control stream
    if (msgType !== CLIENT_SETUP_DRAFT07 && msgType !== CLIENT_SETUP_DRAFT11) {
      return { protocol: 'unknown' };
    }

    // Try to parse version list from CLIENT_SETUP payload.
    // Wire format: MsgType(varint) + MsgLength(varint) + Payload
    // Payload for CLIENT_SETUP starts with: NumVersions(varint) + Version(varint)...
    let offset = msgTypeLen;

    // Skip message length (varint in draft-14, or fixed in some drafts)
    const [_msgLen, msgLenLen] = decodeVarint(bytes, offset);
    offset += msgLenLen;

    // Parse supported_versions count
    const [numVersions, numVersionsLen] = decodeVarint(bytes, offset);
    offset += numVersionsLen;

    const versions: number[] = [];
    for (let i = 0; i < numVersions && offset < bytes.length; i++) {
      const [version, versionLen] = decodeVarint(bytes, offset);
      offset += versionLen;
      versions.push(version);
    }

    if (versions.length === 0) {
      return { protocol: 'unknown' };
    }

    // Check if any offered version maps to a known draft
    for (const v of versions) {
      if (VERSION_TO_DRAFT.has(v)) {
        return { protocol: 'moqt', draft: VERSION_TO_DRAFT.get(v)!, versions };
      }
    }

    // Looks like MoQT (valid CLIENT_SETUP structure) but unknown version
    return { protocol: 'moqt-unknown-draft', versions };
  } catch {
    // Parse failure → not MoQT
    return { protocol: 'unknown' };
  }
}

/**
 * Refine detection using the SERVER_SETUP selected version.
 *
 * Called after the server responds, to confirm or narrow the draft.
 * The selectedVersion from SERVER_SETUP is authoritative.
 * Not applicable for draft-17+ (no SERVER_SETUP).
 */
export function refineFromSelectedVersion(
  selectedVersion: number,
  clientResult: DetectionResult,
): DetectionResult {
  const draft = VERSION_TO_DRAFT.get(selectedVersion);
  if (draft) {
    const versions = clientResult.protocol !== 'unknown' ? clientResult.versions : [selectedVersion];
    return { protocol: 'moqt', draft, versions };
  }

  // Server selected an unknown version
  if (clientResult.protocol !== 'unknown') {
    return { protocol: 'moqt-unknown-draft', versions: clientResult.versions };
  }
  return { protocol: 'moqt-unknown-draft', versions: [selectedVersion] };
}

/**
 * Get the known draft for a specific version number, if any.
 */
export function versionToDraft(version: number): SupportedDraft | undefined {
  return VERSION_TO_DRAFT.get(version);
}
