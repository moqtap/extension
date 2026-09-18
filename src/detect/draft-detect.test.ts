/**
 * Tests for MoQT draft detection.
 *
 * Two separate questions, and the tests keep them apart:
 *
 *   is this MoQT      the first varint on the stream — a CLIENT_SETUP or SETUP
 *                     message type
 *   which draft       a version number on the wire for drafts 07-14, and the
 *                     negotiated `moqt-NN` protocol string for drafts 15+,
 *                     which put no version number on the wire at all
 *
 * Wire format for CLIENT_SETUP (drafts 11-14):
 *   MsgType (varint) + MsgLength (varint) + NumVersions (varint) + Version... (varint each)
 *
 * Drafts 15-16 keep the same message type but drop the version list: the
 * payload is setup options straight after the length.
 */

import { describe, it, expect } from 'vitest'
import {
  couldBeControlStream,
  detectFromControlStream,
  draftFromProtocolString,
  isDraftAssumed,
  NEWEST_SUPPORTED_DRAFT,
  refineFromSelectedVersion,
  resolveNegotiatedProtocol,
  versionToDraft,
} from './draft-detect'
import { SUPPORTED_DRAFTS } from '../types/common'
import { encodeVarint, concat } from '../codec/test-helpers'
import { encodeMoqtVarint } from '../codec/varint'

// ═══════════════════════════════════════════════════════════════════════
// Helpers: build raw wire bytes
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

/**
 * A drafts 15-16 CLIENT_SETUP: same 0x20 message type, but the payload is a
 * setup-options count and KVP options, with no version list anywhere in it.
 * Feeding this to a version-list parser yields the option count and option
 * type IDs, which is exactly the misreading the detector has to not make.
 */
function buildVersionlessClientSetupBytes(): Uint8Array {
  const payload = concat(
    encodeVarint(2), // Number of Setup Options
    encodeVarint(0x07), // MOQT_IMPLEMENTATION
    encodeVarint(4),
    new Uint8Array([0x74, 0x65, 0x73, 0x74]), // "test"
    encodeVarint(0x04), // MAX_AUTH_TOKEN_CACHE_SIZE
    encodeVarint(8192),
  )
  return concat(encodeVarint(0x20), encodeVarint(payload.length), payload)
}

/** The two bytes a draft-17+ endpoint opens its control stream with. */
const SETUP_BYTES = encodeMoqtVarint(0x2f00)

// ═══════════════════════════════════════════════════════════════════════
// draftFromProtocolString / resolveNegotiatedProtocol
// ═══════════════════════════════════════════════════════════════════════

describe('draftFromProtocolString', () => {
  it('reads the draft number out of a moqt-NN string', () => {
    expect(draftFromProtocolString('moqt-19')).toBe('19')
    expect(draftFromProtocolString('moqt-20')).toBe('20')
    expect(draftFromProtocolString('moqt-21')).toBe('21')
  })

  it('normalises a single-digit draft to the two-digit form the tables use', () => {
    expect(draftFromProtocolString('moqt-7')).toBe('07')
  })

  it('reads a draft number past what this build supports', () => {
    // Knowing it is draft-25 is what stops it being decoded as draft-21.
    expect(draftFromProtocolString('moqt-25')).toBe('25')
  })

  it('names no draft for the final-version ALPN or another dialect', () => {
    // "moqt" with no number is the published standard, not a draft.
    expect(draftFromProtocolString('moqt')).toBeUndefined()
    expect(draftFromProtocolString('moq-00')).toBeUndefined()
    expect(draftFromProtocolString('moq-lite')).toBeUndefined()
    expect(draftFromProtocolString('h3')).toBeUndefined()
    expect(draftFromProtocolString('')).toBeUndefined()
  })
})

describe('resolveNegotiatedProtocol', () => {
  it('takes the server’s selection over the offer', () => {
    const r = resolveNegotiatedProtocol({
      selected: 'moqt-19',
      offered: ['moqt-19', 'moqt-20'],
    })
    expect(r).toMatchObject({
      ok: true,
      draft: '19',
      protocol: 'moqt-19',
      source: 'selected',
    })
  })

  it('takes a single-entry offer as determinative', () => {
    // The server either accepts the one protocol offered or the session never
    // opens, so one entry is an answer and not a guess.
    const r = resolveNegotiatedProtocol({ offered: ['moqt-20'] })
    expect(r).toMatchObject({ ok: true, draft: '20', source: 'offered' })
  })

  it('reports a supported-draft-less protocol as ok with no draft', () => {
    const r = resolveNegotiatedProtocol({ offered: ['moqt-25'] })
    expect(r).toMatchObject({ ok: true, protocol: 'moqt-25' })
    expect(r.ok && r.draft).toBeUndefined()
  })

  it('does not settle a multi-entry offer, but guesses the newest offered', () => {
    const r = resolveNegotiatedProtocol({ offered: ['moqt-18', 'moqt-19'] })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.bestGuess).toBe('19')
      expect(r.reason).toContain('moqt-18, moqt-19')
    }
  })

  it('ignores offer entries that are not MoQT', () => {
    const r = resolveNegotiatedProtocol({ offered: ['moq-lite', 'moqt-20'] })
    expect(r).toMatchObject({ ok: true, draft: '20', source: 'offered' })
  })

  it('resolves nothing from an offer with no moqt-NN entry', () => {
    const r = resolveNegotiatedProtocol({ offered: ['moq-00'] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('no moqt-NN entry')
  })

  it('resolves nothing when the transport negotiated nothing visible', () => {
    expect(resolveNegotiatedProtocol().ok).toBe(false)
    expect(resolveNegotiatedProtocol({}).ok).toBe(false)
    expect(resolveNegotiatedProtocol({ offered: [] }).ok).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// detectFromControlStream — drafts that put a version on the wire
// ═══════════════════════════════════════════════════════════════════════

describe('detectFromControlStream — wire versions (drafts 07-14)', () => {
  it('detects draft-14 CLIENT_SETUP (type 0x20, version 0xff00000e)', () => {
    const bytes = buildClientSetupBytes(0x20, [0xff00000e])
    const result = detectFromControlStream(bytes)

    expect(result.protocol).toBe('moqt')
    if (result.protocol === 'moqt') {
      expect(result.draft).toBe('14')
      expect(result.evidence).toEqual({
        via: 'wire-version',
        versions: [0xff00000e],
      })
    }
  })

  it('detects draft-07 CLIENT_SETUP (type 0x40, version 0xff000007)', () => {
    const bytes = buildClientSetupBytes(0x40, [0xff000007])
    const result = detectFromControlStream(bytes)

    expect(result.protocol).toBe('moqt')
    if (result.protocol === 'moqt') {
      expect(result.draft).toBe('07')
      expect(result.evidence).toEqual({
        via: 'wire-version',
        versions: [0xff000007],
      })
    }
  })

  it('detects moqt-unknown-draft for unknown version with valid CLIENT_SETUP type', () => {
    const bytes = buildClientSetupBytes(0x20, [0xff000099])
    const result = detectFromControlStream(bytes)

    expect(result.protocol).toBe('moqt-unknown-draft')
    if (result.protocol === 'moqt-unknown-draft') {
      expect(result.evidence).toEqual({
        via: 'wire-version',
        versions: [0xff000099],
      })
    }
  })

  it('picks the first known version when multiple are offered', () => {
    const bytes = buildClientSetupBytes(0x20, [0xff000099, 0xff00000e])
    const result = detectFromControlStream(bytes)

    expect(result.protocol).toBe('moqt')
    if (result.protocol === 'moqt') {
      expect(result.draft).toBe('14')
      expect(result.evidence).toEqual({
        via: 'wire-version',
        versions: [0xff000099, 0xff00000e],
      })
    }
  })

  it('lets a version on the wire outrank the negotiated protocol string', () => {
    // Drafts 07-14 negotiate in SETUP; the protocol string for those is
    // "moq-00" and carries no draft number, so a moqt-NN alongside a draft-14
    // CLIENT_SETUP is incoherent. The wire wins.
    const bytes = buildClientSetupBytes(0x20, [0xff00000e])
    const result = detectFromControlStream(bytes, { offered: ['moqt-20'] })
    expect(result.protocol).toBe('moqt')
    if (result.protocol === 'moqt') expect(result.draft).toBe('14')
  })

  it('is unaffected by a moq-00 offer, which names no draft', () => {
    const bytes = buildClientSetupBytes(0x40, [0xff000007])
    const result = detectFromControlStream(bytes, { offered: ['moq-00'] })
    expect(result.protocol).toBe('moqt')
    if (result.protocol === 'moqt') expect(result.draft).toBe('07')
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
})

// ═══════════════════════════════════════════════════════════════════════
// detectFromControlStream — drafts that negotiate by protocol string
// ═══════════════════════════════════════════════════════════════════════

describe('detectFromControlStream — negotiated protocol (drafts 15+)', () => {
  it('reads draft-20 out of the offered protocol for SETUP (type 0x2F00)', () => {
    expect(Array.from(SETUP_BYTES)).toEqual([0xaf, 0x00])

    const result = detectFromControlStream(SETUP_BYTES, {
      offered: ['moqt-20'],
    })

    expect(result.protocol).toBe('moqt')
    if (result.protocol === 'moqt') {
      expect(result.draft).toBe('20')
      expect(result.evidence).toEqual({
        via: 'negotiated-protocol',
        protocol: 'moqt-20',
        source: 'offered',
      })
    }
    expect(isDraftAssumed(result)).toBe(false)
  })

  it('tells draft-21 from draft-20 by the protocol string alone', () => {
    // Nothing else can. Draft-21 restructures draft-20 and moves no byte of
    // the wire, so a draft-20 and a draft-21 peer open with the identical
    // SETUP and the negotiated string is the whole of the difference.
    for (const draft of ['20', '21'] as const) {
      const result = detectFromControlStream(SETUP_BYTES, {
        selected: `moqt-${draft}`,
      })
      expect(result.protocol).toBe('moqt')
      if (result.protocol === 'moqt') {
        expect(result.draft).toBe(draft)
        expect(isDraftAssumed(result)).toBe(false)
      }
    }
  })

  it('reads draft-19 out of the offered protocol, not the newest known draft', () => {
    // The defect this replaces: every draft-17+ session was reported as the
    // newest draft the build knew, whatever the protocol string said.
    const result = detectFromControlStream(SETUP_BYTES, {
      offered: ['moqt-19'],
    })
    expect(result.protocol).toBe('moqt')
    if (result.protocol === 'moqt') expect(result.draft).toBe('19')
  })

  it('prefers the server’s selection over the offer', () => {
    const result = detectFromControlStream(SETUP_BYTES, {
      selected: 'moqt-19',
      offered: ['moqt-19', 'moqt-20'],
    })
    expect(result.protocol).toBe('moqt')
    if (result.protocol === 'moqt') {
      expect(result.draft).toBe('19')
      expect(result.evidence).toEqual({
        via: 'negotiated-protocol',
        protocol: 'moqt-19',
        source: 'selected',
      })
    }
  })

  it('synthesizes no version number for a protocol-negotiated draft', () => {
    // Drafts 15+ put no version on the wire. A `versions` array here would be
    // a number nobody sent, presented as one that was observed.
    const result = detectFromControlStream(SETUP_BYTES, {
      offered: ['moqt-20'],
    })
    expect(JSON.stringify(result)).not.toContain('4278190100') // 0xff000014
    if (result.protocol === 'moqt') {
      expect(result.evidence.via).not.toBe('wire-version')
    }
  })

  it('refuses to decode a draft it has no tables for', () => {
    const result = detectFromControlStream(SETUP_BYTES, {
      selected: 'moqt-25',
    })
    expect(result.protocol).toBe('moqt-unknown-draft')
    if (result.protocol === 'moqt-unknown-draft') {
      expect(result.evidence).toEqual({
        via: 'negotiated-protocol',
        protocol: 'moqt-25',
        source: 'selected',
      })
    }
  })

  it('assumes the newest draft the tables cover, not a stale constant', () => {
    // The fallback is only honest if it names a draft this build can decode,
    // and a draft added to the tables without moving this constant leaves it
    // naming the one below — which decodes and reports as confidently.
    expect(NEWEST_SUPPORTED_DRAFT).toBe(
      SUPPORTED_DRAFTS[SUPPORTED_DRAFTS.length - 1],
    )
  })

  it('falls back to the newest supported draft, and says it is a fallback', () => {
    const result = detectFromControlStream(SETUP_BYTES)
    expect(result.protocol).toBe('moqt')
    if (result.protocol === 'moqt') {
      expect(result.draft).toBe(NEWEST_SUPPORTED_DRAFT)
      expect(result.evidence.via).toBe('unidentified')
      if (result.evidence.via === 'unidentified') {
        expect(result.evidence.reason).toBeTruthy()
      }
    }
    expect(isDraftAssumed(result)).toBe(true)
  })

  it('falls back to the newest offered draft when the offer is ambiguous', () => {
    // Two MoQT protocols offered and no selection visible: still a fallback,
    // but a better-informed one than "the newest draft this build knows".
    const result = detectFromControlStream(SETUP_BYTES, {
      offered: ['moqt-17', 'moqt-18'],
    })
    expect(result.protocol).toBe('moqt')
    if (result.protocol === 'moqt') {
      expect(result.draft).toBe('18')
      expect(result.evidence.via).toBe('unidentified')
    }
    expect(isDraftAssumed(result)).toBe(true)
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
// detectFromControlStream — drafts 15-16, CLIENT_SETUP with no version list
// ═══════════════════════════════════════════════════════════════════════

describe('detectFromControlStream — versionless CLIENT_SETUP (drafts 15-16)', () => {
  it('reads the draft from the protocol string, not from the option bytes', () => {
    const result = detectFromControlStream(buildVersionlessClientSetupBytes(), {
      offered: ['moqt-16'],
    })
    expect(result.protocol).toBe('moqt')
    if (result.protocol === 'moqt') {
      expect(result.draft).toBe('16')
      expect(result.evidence).toEqual({
        via: 'negotiated-protocol',
        protocol: 'moqt-16',
        source: 'offered',
      })
    }
  })

  it('narrows an ambiguous offer to the newest draft offered', () => {
    const result = detectFromControlStream(buildVersionlessClientSetupBytes(), {
      offered: ['moqt-15', 'moqt-16'],
    })
    expect(result.protocol).toBe('moqt')
    if (result.protocol === 'moqt') {
      expect(result.draft).toBe('16')
      expect(result.evidence.via).toBe('unidentified')
    }
    expect(isDraftAssumed(result)).toBe(true)
  })

  it('does not fall back to a draft that has no CLIENT_SETUP to send', () => {
    // The draft-17+ path assumes the newest supported draft when nothing names
    // one. Doing that here would report draft-21 for bytes draft-21 cannot
    // have written: it has no CLIENT_SETUP at all.
    const result = detectFromControlStream(buildVersionlessClientSetupBytes(), {
      offered: ['moq-lite'],
    })
    expect(result.protocol).toBe('moqt-unknown-draft')
  })

  it('reports no version at all rather than the setup options it just read', () => {
    // The old parse read "2, 0x07, 4" out of this payload and reported them as
    // offered versions. They are an option count and option type IDs.
    const result = detectFromControlStream(buildVersionlessClientSetupBytes())
    expect(result.protocol).toBe('moqt-unknown-draft')
    if (result.protocol === 'moqt-unknown-draft') {
      expect(result.evidence.via).toBe('unidentified')
    }
    expect(JSON.stringify(result)).not.toContain('versions')
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
      expect(refined.evidence).toEqual({
        via: 'wire-version',
        versions: [0xff00000e],
      })
    }
  })

  it('narrows to unknown-draft when server selects unrecognized version', () => {
    const clientResult = detectFromControlStream(
      buildClientSetupBytes(0x20, [0xff00000e, 0xff000099]),
    )
    const refined = refineFromSelectedVersion(0xff000099, clientResult)

    expect(refined.protocol).toBe('moqt-unknown-draft')
    if (refined.protocol === 'moqt-unknown-draft') {
      expect(refined.evidence).toEqual({
        via: 'wire-version',
        versions: [0xff00000e, 0xff000099],
      })
    }
  })

  it('refines from unknown client result with known server version', () => {
    const clientResult = detectFromControlStream(new Uint8Array(0))
    expect(clientResult.protocol).toBe('unknown')

    const refined = refineFromSelectedVersion(0xff00000e, clientResult)
    expect(refined.protocol).toBe('moqt')
    if (refined.protocol === 'moqt') {
      expect(refined.draft).toBe('14')
      expect(refined.evidence).toEqual({
        via: 'wire-version',
        versions: [0xff00000e],
      })
    }
  })

  it('returns moqt-unknown-draft when both client and server versions are unknown', () => {
    const clientResult = detectFromControlStream(new Uint8Array(0))
    const refined = refineFromSelectedVersion(0xff000099, clientResult)

    expect(refined.protocol).toBe('moqt-unknown-draft')
    if (refined.protocol === 'moqt-unknown-draft') {
      expect(refined.evidence).toEqual({
        via: 'wire-version',
        versions: [0xff000099],
      })
    }
  })

  it('does not carry a protocol-negotiated draft into a version list', () => {
    // Nothing should ever call this for a draft-15+ session, but if it does,
    // the result must not claim the protocol string was a version number.
    const clientResult = detectFromControlStream(SETUP_BYTES, {
      offered: ['moqt-20'],
    })
    const refined = refineFromSelectedVersion(0xff00000e, clientResult)
    expect(refined.protocol).toBe('moqt')
    if (refined.protocol === 'moqt') {
      expect(refined.evidence).toEqual({
        via: 'wire-version',
        versions: [0xff00000e],
      })
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

  it('knows no version number for drafts 15 and up', () => {
    // Those drafts negotiate by protocol string and put nothing on the wire,
    // so 0xff00000f..0xff000014 are values no peer ever sends. The table used
    // to carry them, and detection synthesized 0xff000013 for every draft-17+
    // session and reported it as observed.
    expect(versionToDraft(0xff00000f)).toBeUndefined() // would have been 15
    expect(versionToDraft(0xff000010)).toBeUndefined() // 16
    expect(versionToDraft(0xff000011)).toBeUndefined() // 17
    expect(versionToDraft(0xff000012)).toBeUndefined() // 18
    expect(versionToDraft(0xff000013)).toBeUndefined() // 19
    expect(versionToDraft(0xff000014)).toBeUndefined() // 20
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
