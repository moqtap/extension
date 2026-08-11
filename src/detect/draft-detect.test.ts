/**
 * Tests for MoQT draft auto-detection from control stream bytes.
 *
 * Detection peeks at the first message on a bidirectional control stream
 * and checks for known CLIENT_SETUP message type IDs + version numbers.
 *
 * Wire format for CLIENT_SETUP:
 *   MsgType (varint) + MsgLength (varint) + NumVersions (varint) + Version... (varint each)
 */

import { describe, it, expect } from 'vitest'
import {
  couldBeControlStream,
  detectFromControlStream,
  refineFromSelectedVersion,
  versionToDraft,
} from './draft-detect'
import { encodeVarint, concat } from '../codec/test-helpers'
import { encodeMoqtVarint } from '../codec/varint'

// ═══════════════════════════════════════════════════════════════════════
// Helper: build raw CLIENT_SETUP wire bytes
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build a minimal CLIENT_SETUP wire message for detection purposes.
 *
 * @param msgType  - CLIENT_SETUP message type ID (0x20 for draft-14, 0x40 for draft-07)
 * @param versions - supported version wire numbers
 */
function buildClientSetupBytes(
  msgType: number,
  versions: number[],
): Uint8Array {
  // Payload: NumVersions (varint) + Version1 (varint) + Version2 (varint) + ...
  const payload = concat(
    encodeVarint(versions.length),
    ...versions.map((v) => encodeVarint(v)),
  )

  // Frame: MsgType (varint) + MsgLength (varint) + Payload
  return concat(encodeVarint(msgType), encodeVarint(payload.length), payload)
}

// ═══════════════════════════════════════════════════════════════════════
// detectFromControlStream
// ═══════════════════════════════════════════════════════════════════════

describe('detectFromControlStream', () => {
  it('detects draft-14 CLIENT_SETUP (type 0x20, version 0xff00000e)', () => {
    const bytes = buildClientSetupBytes(0x20, [0xff00000e])
    const result = detectFromControlStream(bytes)

    expect(result.protocol).toBe('moqt')
    if (result.protocol === 'moqt') {
      expect(result.draft).toBe('14')
      expect(result.versions).toEqual([0xff00000e])
    }
  })

  it('detects draft-07 CLIENT_SETUP (type 0x40, version 0xff000007)', () => {
    const bytes = buildClientSetupBytes(0x40, [0xff000007])
    const result = detectFromControlStream(bytes)

    expect(result.protocol).toBe('moqt')
    if (result.protocol === 'moqt') {
      expect(result.draft).toBe('07')
      expect(result.versions).toEqual([0xff000007])
    }
  })

  it('detects moqt-unknown-draft for unknown version with valid CLIENT_SETUP type', () => {
    const bytes = buildClientSetupBytes(0x20, [0xff000099])
    const result = detectFromControlStream(bytes)

    expect(result.protocol).toBe('moqt-unknown-draft')
    if (result.protocol === 'moqt-unknown-draft') {
      expect(result.versions).toEqual([0xff000099])
    }
  })

  it('picks the first known version when multiple are offered', () => {
    const bytes = buildClientSetupBytes(0x20, [0xff000099, 0xff00000e])
    const result = detectFromControlStream(bytes)

    expect(result.protocol).toBe('moqt')
    if (result.protocol === 'moqt') {
      expect(result.draft).toBe('14')
      expect(result.versions).toEqual([0xff000099, 0xff00000e])
    }
  })

  it('returns unknown for random bytes', () => {
    const bytes = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05])
    const result = detectFromControlStream(bytes)
    expect(result.protocol).toBe('unknown')
  })

  it('returns unknown for empty buffer', () => {
    const bytes = new Uint8Array(0)
    const result = detectFromControlStream(bytes)
    expect(result.protocol).toBe('unknown')
  })

  it('returns unknown for single-byte buffer', () => {
    const bytes = new Uint8Array([0x20])
    const result = detectFromControlStream(bytes)
    expect(result.protocol).toBe('unknown')
  })

  it('returns unknown when message type is not CLIENT_SETUP', () => {
    // 0x21 is SERVER_SETUP, not CLIENT_SETUP
    const bytes = buildClientSetupBytes(0x21, [0xff00000e])
    const result = detectFromControlStream(bytes)
    expect(result.protocol).toBe('unknown')
  })

  it('defaults to latest ALPN draft-19 for SETUP (type 0x2F00)', () => {
    // Draft-17+ SETUP carries no version on the wire (negotiated via ALPN),
    // so detection defaults to the newest known ALPN-era draft.
    const bytes = encodeMoqtVarint(0x2f00)
    expect(Array.from(bytes)).toEqual([0xaf, 0x00])

    const result = detectFromControlStream(bytes)

    expect(result.protocol).toBe('moqt')
    if (result.protocol === 'moqt') {
      expect(result.draft).toBe('19')
      expect(result.versions).toEqual([0xff000013])
    }
  })

  it('does not read SETUP with the RFC 9000 varint', () => {
    // `6f 00` is what RFC 9000 makes of 0x2F00, and no draft writes it: the
    // drafts that define SETUP replaced that encoding. Accepting it would mean
    // detection is reading draft-17+ streams the pre-17 way.
    expect(detectFromControlStream(encodeVarint(0x2f00)).protocol).toBe(
      'unknown',
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// refineFromSelectedVersion
// ═══════════════════════════════════════════════════════════════════════

describe('refineFromSelectedVersion', () => {
  it('confirms draft-14 when server selects 0xff00000e', () => {
    const clientResult = detectFromControlStream(
      buildClientSetupBytes(0x20, [0xff00000e]),
    )
    const refined = refineFromSelectedVersion(0xff00000e, clientResult)

    expect(refined.protocol).toBe('moqt')
    if (refined.protocol === 'moqt') {
      expect(refined.draft).toBe('14')
      expect(refined.versions).toEqual([0xff00000e])
    }
  })

  it('narrows to unknown-draft when server selects unrecognized version', () => {
    const clientResult = detectFromControlStream(
      buildClientSetupBytes(0x20, [0xff00000e, 0xff000099]),
    )
    const refined = refineFromSelectedVersion(0xff000099, clientResult)

    expect(refined.protocol).toBe('moqt-unknown-draft')
    if (refined.protocol === 'moqt-unknown-draft') {
      expect(refined.versions).toEqual([0xff00000e, 0xff000099])
    }
  })

  it('refines from unknown client result with known server version', () => {
    const clientResult = detectFromControlStream(new Uint8Array(0))
    expect(clientResult.protocol).toBe('unknown')

    const refined = refineFromSelectedVersion(0xff00000e, clientResult)
    expect(refined.protocol).toBe('moqt')
    if (refined.protocol === 'moqt') {
      expect(refined.draft).toBe('14')
      expect(refined.versions).toEqual([0xff00000e])
    }
  })

  it('returns moqt-unknown-draft when both client and server versions are unknown', () => {
    const clientResult = detectFromControlStream(new Uint8Array(0))
    const refined = refineFromSelectedVersion(0xff000099, clientResult)

    expect(refined.protocol).toBe('moqt-unknown-draft')
    if (refined.protocol === 'moqt-unknown-draft') {
      expect(refined.versions).toEqual([0xff000099])
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// versionToDraft
// ═══════════════════════════════════════════════════════════════════════

describe('versionToDraft', () => {
  it('returns "14" for 0xff00000e', () => {
    expect(versionToDraft(0xff00000e)).toBe('14')
  })

  it('returns "07" for 0xff000007', () => {
    expect(versionToDraft(0xff000007)).toBe('07')
  })

  it('returns "19" for 0xff000013', () => {
    expect(versionToDraft(0xff000013)).toBe('19')
  })

  it('returns undefined for unknown version', () => {
    expect(versionToDraft(0xff000001)).toBeUndefined()
  })

  it('returns undefined for version 0', () => {
    expect(versionToDraft(0)).toBeUndefined()
  })

  it('returns undefined for reserved RFC version 1', () => {
    expect(versionToDraft(1)).toBeUndefined()
  })
})

describe('couldBeControlStream', () => {
  const bytes = (...b: number[]) => new Uint8Array(b)

  it('accepts CLIENT_SETUP for drafts <= 10 and 11-16', () => {
    expect(couldBeControlStream(bytes(0x40, 0x40, 0x02))).toBe(true)
    expect(couldBeControlStream(bytes(0x20, 0x00, 0x2c))).toBe(true)
  })

  it('accepts SERVER_SETUP, since either direction may be observed first', () => {
    expect(couldBeControlStream(bytes(0x40, 0x41, 0x02))).toBe(true)
    expect(couldBeControlStream(bytes(0x21, 0x00, 0x0a))).toBe(true)
  })

  it('accepts the draft-17+ unidirectional control stream type 0x2F00', () => {
    // The control stream stopped being bidirectional in draft-17, so this
    // case is the one a direction-based test would wrongly reject. 0x2F00 is
    // `af 00` because draft-17 also replaced the varint encoding.
    expect(couldBeControlStream(bytes(0xaf, 0x00))).toBe(true)
  })

  it('rejects data stream types', () => {
    expect(couldBeControlStream(bytes(0x05, 0x01))).toBe(false) // FETCH_HEADER
    expect(couldBeControlStream(bytes(0x10, 0x01))).toBe(false) // SUBGROUP_HEADER
    expect(couldBeControlStream(bytes(0x04, 0x0b, 0x63))).toBe(false)
  })

  it('rejects an Annex-B video chunk', () => {
    expect(couldBeControlStream(bytes(0x00, 0x00, 0x00, 0x01, 0x09))).toBe(
      false,
    )
  })

  it('stays undecided while the leading varint is incomplete', () => {
    // A client may write a control message's type, length and body as three
    // separate writes, so one byte of a two-byte varint must not rule it out.
    expect(couldBeControlStream(bytes(0xaf))).toBe(true)
    expect(couldBeControlStream(bytes())).toBe(true)
  })

  it('rejects a complete varint that merely starts like 0x2F00', () => {
    // Long enough to finish under both encodings: `af 01` is 0x2F01 to MoQT,
    // and all four bytes are 0x2F010000 to RFC 9000. Neither opens a stream.
    expect(couldBeControlStream(bytes(0xaf, 0x01, 0x00, 0x00))).toBe(false)
  })
})
