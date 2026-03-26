/**
 * Tests for MoQT draft auto-detection from control stream bytes.
 *
 * Detection peeks at the first message on a bidirectional control stream
 * and checks for known CLIENT_SETUP message type IDs + version numbers.
 *
 * Wire format for CLIENT_SETUP:
 *   MsgType (varint) + MsgLength (varint) + NumVersions (varint) + Version... (varint each)
 */

import { describe, it, expect } from 'vitest';
import {
  detectFromControlStream,
  refineFromSelectedVersion,
  versionToDraft,
} from './draft-detect';
import { encodeVarint, concat } from '../codec/test-helpers';

// ═══════════════════════════════════════════════════════════════════════
// Helper: build raw CLIENT_SETUP wire bytes
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build a minimal CLIENT_SETUP wire message for detection purposes.
 *
 * @param msgType  - CLIENT_SETUP message type ID (0x20 for draft-14, 0x40 for draft-07)
 * @param versions - supported version wire numbers
 */
function buildClientSetupBytes(msgType: number, versions: number[]): Uint8Array {
  // Payload: NumVersions (varint) + Version1 (varint) + Version2 (varint) + ...
  const payload = concat(
    encodeVarint(versions.length),
    ...versions.map((v) => encodeVarint(v)),
  );

  // Frame: MsgType (varint) + MsgLength (varint) + Payload
  return concat(
    encodeVarint(msgType),
    encodeVarint(payload.length),
    payload,
  );
}

// ═══════════════════════════════════════════════════════════════════════
// detectFromControlStream
// ═══════════════════════════════════════════════════════════════════════

describe('detectFromControlStream', () => {
  it('detects draft-14 CLIENT_SETUP (type 0x20, version 0xff00000e)', () => {
    const bytes = buildClientSetupBytes(0x20, [0xff00000e]);
    const result = detectFromControlStream(bytes);

    expect(result.protocol).toBe('moqt');
    if (result.protocol === 'moqt') {
      expect(result.draft).toBe('14');
      expect(result.versions).toEqual([0xff00000e]);
    }
  });

  it('detects draft-07 CLIENT_SETUP (type 0x40, version 0xff000007)', () => {
    const bytes = buildClientSetupBytes(0x40, [0xff000007]);
    const result = detectFromControlStream(bytes);

    expect(result.protocol).toBe('moqt');
    if (result.protocol === 'moqt') {
      expect(result.draft).toBe('07');
      expect(result.versions).toEqual([0xff000007]);
    }
  });

  it('detects moqt-unknown-draft for unknown version with valid CLIENT_SETUP type', () => {
    const bytes = buildClientSetupBytes(0x20, [0xff000099]);
    const result = detectFromControlStream(bytes);

    expect(result.protocol).toBe('moqt-unknown-draft');
    if (result.protocol === 'moqt-unknown-draft') {
      expect(result.versions).toEqual([0xff000099]);
    }
  });

  it('picks the first known version when multiple are offered', () => {
    const bytes = buildClientSetupBytes(0x20, [0xff000099, 0xff00000e]);
    const result = detectFromControlStream(bytes);

    expect(result.protocol).toBe('moqt');
    if (result.protocol === 'moqt') {
      expect(result.draft).toBe('14');
      expect(result.versions).toEqual([0xff000099, 0xff00000e]);
    }
  });

  it('returns unknown for random bytes', () => {
    const bytes = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
    const result = detectFromControlStream(bytes);
    expect(result.protocol).toBe('unknown');
  });

  it('returns unknown for empty buffer', () => {
    const bytes = new Uint8Array(0);
    const result = detectFromControlStream(bytes);
    expect(result.protocol).toBe('unknown');
  });

  it('returns unknown for single-byte buffer', () => {
    const bytes = new Uint8Array([0x20]);
    const result = detectFromControlStream(bytes);
    expect(result.protocol).toBe('unknown');
  });

  it('returns unknown when message type is not CLIENT_SETUP', () => {
    // 0x21 is SERVER_SETUP, not CLIENT_SETUP
    const bytes = buildClientSetupBytes(0x21, [0xff00000e]);
    const result = detectFromControlStream(bytes);
    expect(result.protocol).toBe('unknown');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// refineFromSelectedVersion
// ═══════════════════════════════════════════════════════════════════════

describe('refineFromSelectedVersion', () => {
  it('confirms draft-14 when server selects 0xff00000e', () => {
    const clientResult = detectFromControlStream(
      buildClientSetupBytes(0x20, [0xff00000e]),
    );
    const refined = refineFromSelectedVersion(0xff00000e, clientResult);

    expect(refined.protocol).toBe('moqt');
    if (refined.protocol === 'moqt') {
      expect(refined.draft).toBe('14');
      expect(refined.versions).toEqual([0xff00000e]);
    }
  });

  it('narrows to unknown-draft when server selects unrecognized version', () => {
    const clientResult = detectFromControlStream(
      buildClientSetupBytes(0x20, [0xff00000e, 0xff000099]),
    );
    const refined = refineFromSelectedVersion(0xff000099, clientResult);

    expect(refined.protocol).toBe('moqt-unknown-draft');
    if (refined.protocol === 'moqt-unknown-draft') {
      expect(refined.versions).toEqual([0xff00000e, 0xff000099]);
    }
  });

  it('refines from unknown client result with known server version', () => {
    const clientResult = detectFromControlStream(new Uint8Array(0));
    expect(clientResult.protocol).toBe('unknown');

    const refined = refineFromSelectedVersion(0xff00000e, clientResult);
    expect(refined.protocol).toBe('moqt');
    if (refined.protocol === 'moqt') {
      expect(refined.draft).toBe('14');
      expect(refined.versions).toEqual([0xff00000e]);
    }
  });

  it('returns moqt-unknown-draft when both client and server versions are unknown', () => {
    const clientResult = detectFromControlStream(new Uint8Array(0));
    const refined = refineFromSelectedVersion(0xff000099, clientResult);

    expect(refined.protocol).toBe('moqt-unknown-draft');
    if (refined.protocol === 'moqt-unknown-draft') {
      expect(refined.versions).toEqual([0xff000099]);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// versionToDraft
// ═══════════════════════════════════════════════════════════════════════

describe('versionToDraft', () => {
  it('returns "14" for 0xff00000e', () => {
    expect(versionToDraft(0xff00000e)).toBe('14');
  });

  it('returns "07" for 0xff000007', () => {
    expect(versionToDraft(0xff000007)).toBe('07');
  });

  it('returns undefined for unknown version', () => {
    expect(versionToDraft(0xff000001)).toBeUndefined();
  });

  it('returns undefined for version 0', () => {
    expect(versionToDraft(0)).toBeUndefined();
  });

  it('returns undefined for reserved RFC version 1', () => {
    expect(versionToDraft(1)).toBeUndefined();
  });
});
