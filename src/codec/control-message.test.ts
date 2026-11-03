/**
 * A control-plane reader has to tell a message that is still arriving from one
 * that will never decode. It holds the first, waiting for the rest of it, and
 * the bytes of the second would be held the same way forever — the stream's
 * later messages behind them, unread and unreported.
 *
 * These check the discriminator against bytes the codec itself refuses, rather
 * than against the codes named in the source, so that a codec whose refusals
 * move is caught here.
 */

import { describe, expect, it } from 'vitest'
import {
  controlMessageLength,
  decodeControlMessage,
  encodeControlMessage,
  isIncomplete,
  receiveLimit,
} from './control-message'
import { buildControlMessage, concat, encodeVarint, hex } from './test-helpers'

/** PUBLISH_NAMESPACE: Request ID, Track Namespace, Message Parameters. */
const MSG_PUBLISH_NAMESPACE = 0x06

/** Request ID 1, and a one-element namespace tuple holding "a". */
const PUBLISH_NAMESPACE_HEAD = hex('01 01 01 61')

/**
 * A Message Parameter block of one entry, whose Type is written as a delta
 * from zero. An odd Type carries a length; an even one carries a varint.
 */
function paramBlock(type: number, value: Uint8Array): Uint8Array {
  return concat(encodeVarint(1), encodeVarint(type), value)
}

function publishNamespace(params: Uint8Array): Uint8Array {
  return buildControlMessage(
    MSG_PUBLISH_NAMESPACE,
    concat(PUBLISH_NAMESPACE_HEAD, params),
  )
}

describe('isIncomplete', () => {
  it('holds a message that is still arriving', () => {
    // Built by the codec so the only thing wrong with it is its length.
    const whole = encodeControlMessage(
      { type: 'goaway', new_session_uri: 'https://example.test/', timeout: 0n },
      '19',
    )
    expect(whole.length).toBeGreaterThan(3)

    for (let cut = 3; cut < whole.length; cut++) {
      const result = decodeControlMessage(whole.subarray(0, cut), '19')
      expect(result.ok, `truncated to ${cut} bytes`).toBe(false)
      if (result.ok) continue
      expect(result.error.code).toBe('UNEXPECTED_END')
      expect(isIncomplete(result.error)).toBe(true)
    }

    // And the whole thing decodes, so the loop above measured truncation
    // rather than a message the codec refuses for some other reason.
    expect(decodeControlMessage(whole, '19').ok).toBe(true)
  })

  it('does not hold a Message Parameter the draft has no definition for', () => {
    // 0x3f is odd, so its value is length-prefixed and could in principle be
    // skipped; a receiver still may not, having no definition to skip by.
    const result = decodeControlMessage(
      publishNamespace(paramBlock(0x3f, hex('00'))),
      '19',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INVALID_PARAMETER')
    expect(isIncomplete(result.error)).toBe(false)
  })

  it('does not hold a Message Parameter outside the messages it belongs to', () => {
    // 0x0a is Fill Timeout, whose definition names FETCH and no other message.
    const result = decodeControlMessage(
      publishNamespace(paramBlock(0x0a, encodeVarint(100))),
      '19',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CONSTRAINT_VIOLATION')
    expect(isIncomplete(result.error)).toBe(false)
  })

  it('does not hold a message type the draft does not have', () => {
    // 0x3d sits in the gap draft-19 leaves between PUBLISH and SUBSCRIBE_NAMESPACE.
    const result = decodeControlMessage(
      buildControlMessage(0x3d, hex('00')),
      '19',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('UNKNOWN_MESSAGE_TYPE')
    expect(isIncomplete(result.error)).toBe(false)
  })

  it('accepts the same message carrying no parameters at all', () => {
    // The two refusals above have to be the parameter rules firing, not this
    // message failing to parse however it is built. The only difference
    // between this and those is the one entry in the block.
    const result = decodeControlMessage(
      publishNamespace(encodeVarint(0)),
      '19',
    )
    expect(result.ok).toBe(true)
  })
})

describe('controlMessageLength', () => {
  it('frames a message the codec refuses, so the next one can be read', () => {
    const bad = publishNamespace(paramBlock(0x3f, hex('00')))
    const next = encodeControlMessage(
      { type: 'goaway', new_session_uri: 'https://example.test/', timeout: 0n },
      '19',
    )
    const run = concat(bad, next)
    expect(decodeControlMessage(run, '19').ok).toBe(false)
    expect(controlMessageLength(run, '19')).toBe(bad.length)
    const after = run.subarray(bad.length)
    expect(controlMessageLength(after, '19')).toBe(next.length)
    expect(decodeControlMessage(after, '19').ok).toBe(true)
  })

  it('waits while the Type and Length are arriving', () => {
    const msg = publishNamespace(encodeVarint(0))
    expect(controlMessageLength(msg.subarray(0, 1), '19')).toBe('incomplete')
    expect(controlMessageLength(msg.subarray(0, 2), '19')).toBe('incomplete')
    expect(controlMessageLength(msg.subarray(0, 3), '19')).toBe(msg.length)
  })

  it('reads a varint Length through draft-10', () => {
    // CLIENT_SETUP-sized frame: type 0x40 0x40, length 3, three bytes
    const msg = hex('40 40 03 01 02 03')
    expect(controlMessageLength(msg, '10')).toBe(6)
  })
})

describe('draft-20 against draft-19', () => {
  /**
   * The whole difference between the two control message registries is
   * PUBLISH_STATE_NOTIFY at 0x22 (draft-20 §10.10) — every other codepoint
   * holds the same name in both. So this one message is the only thing that
   * can catch a session decoded under the wrong one of the two, which is what
   * made the draft coming from the negotiated protocol string worth fixing.
   */
  const publishStateNotify = encodeControlMessage(
    { type: 'publish_state_notify', parameters: {} },
    '20',
  )

  it('decodes PUBLISH_STATE_NOTIFY on draft-20', () => {
    const result = decodeControlMessage(publishStateNotify, '20')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.type).toBe('publish_state_notify')
  })

  it('writes it at 0x22, with no request id of its own', () => {
    // Identified by the subscription's bidirectional stream, not a request id.
    expect(publishStateNotify[0]).toBe(0x22)
  })

  it('refuses it on draft-19, which does not assign 0x22', () => {
    const result = decodeControlMessage(publishStateNotify, '19')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('UNKNOWN_MESSAGE_TYPE')
    expect(isIncomplete(result.error)).toBe(false)
  })

  it('holds a draft-20 message that is still arriving', () => {
    const whole = encodeControlMessage(
      { type: 'goaway', new_session_uri: 'https://example.test/', timeout: 0n },
      '20',
    )
    for (let cut = 3; cut < whole.length; cut++) {
      const result = decodeControlMessage(whole.subarray(0, cut), '20')
      expect(result.ok, `truncated to ${cut} bytes`).toBe(false)
      if (result.ok) continue
      expect(isIncomplete(result.error)).toBe(true)
    }
    expect(decodeControlMessage(whole, '20').ok).toBe(true)
  })
})

describe('draft-23 against draft-22', () => {
  /**
   * draft-22 Section 9, Figure 5: "Message Length (16)". draft-23 Section 9,
   * Figure 6: "Message Length (vi64)". The same bytes frame differently under
   * the two, and neither reading fails on the other's bytes, so the framing
   * has to be the session draft's.
   */
  const REQUEST_OK_23 = encodeControlMessage(
    { type: 'request_ok', parameters: {}, track_properties: {} },
    '23',
  )
  const GOAWAY_23 = encodeControlMessage(
    { type: 'goaway', new_session_uri: 'https://example.test/', timeout: 0n },
    '23',
  )

  it('writes the Length as a varint', () => {
    expect(REQUEST_OK_23).toEqual(hex('07 01 00'))
    expect(controlMessageLength(REQUEST_OK_23, '23')).toBe(3)
    // Draft-22 reads `01 00` as a Length of 256.
    expect(controlMessageLength(REQUEST_OK_23, '22')).toBe(3 + 256)
  })

  it('frames a run of draft-23 messages one at a time', () => {
    const run = concat(REQUEST_OK_23, GOAWAY_23)
    expect(controlMessageLength(run, '23')).toBe(REQUEST_OK_23.length)
    const after = run.subarray(REQUEST_OK_23.length)
    expect(controlMessageLength(after, '23')).toBe(GOAWAY_23.length)
    expect(decodeControlMessage(after, '23').ok).toBe(true)
  })

  it('reads multi-byte Lengths, including ones 16 bits cannot hold', () => {
    // 300 is `81 2c`, 70000 is `c1 11 70` (draft-23 Section 8.1).
    expect(controlMessageLength(hex('07 81 2c'), '23')).toBe(1 + 2 + 300)
    expect(controlMessageLength(hex('07 c1 11 70'), '23')).toBe(1 + 3 + 70000)
    // A non-minimal Length is still its value.
    expect(controlMessageLength(hex('07 c0 00 01 00'), '23')).toBe(1 + 3 + 1)
  })

  it('waits while a varint Length is arriving', () => {
    expect(controlMessageLength(hex('07'), '23')).toBe('incomplete')
    expect(controlMessageLength(hex('07 81'), '23')).toBe('incomplete')
    expect(controlMessageLength(hex('07 c1 11'), '23')).toBe('incomplete')
  })

  it('holds a draft-23 message that is still arriving', () => {
    for (let cut = 1; cut < GOAWAY_23.length; cut++) {
      const result = decodeControlMessage(GOAWAY_23.subarray(0, cut), '23')
      expect(result.ok, `truncated to ${cut} bytes`).toBe(false)
      if (result.ok) continue
      expect(isIncomplete(result.error)).toBe(true)
    }
    expect(decodeControlMessage(GOAWAY_23, '23').ok).toBe(true)
  })

  it('does not hold a draft-22 frame read as draft-23', () => {
    // Draft-22's empty REQUEST_OK, `07 00 01 00`: under draft-23 a zero-length
    // REQUEST_OK, which lacks its Number of Parameters, then `01 00`.
    const d22 = encodeControlMessage(
      { type: 'request_ok', parameters: {}, track_properties: {} },
      '22',
    )
    expect(d22).toEqual(hex('07 00 01 00'))
    expect(controlMessageLength(d22, '23')).toBe(2)
    const result = decodeControlMessage(d22.subarray(0, 2), '23')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(isIncomplete(result.error)).toBe(false)
  })

  it('refuses 0x18, which draft-23 reserves (FETCH_OK in draft-22)', () => {
    // draft-23 Section 9, Table 5: "0x18 | RESERVED (FETCH_OK in <= 22)".
    const result = decodeControlMessage(hex('18 00'), '23')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('UNKNOWN_MESSAGE_TYPE')
    expect(isIncomplete(result.error)).toBe(false)
  })
})

describe('draft-23 MAX_CONTROL_MESSAGE_SIZE', () => {
  /**
   * draft-23 Section 9: "If an endpoint receives a control message with a
   * length larger than its MAX_CONTROL_MESSAGE_SIZE, it MUST close the session
   * with FIELD_LENGTH_EXCEEDED." Section 9.1.8: "If not present, the default
   * value is 65535. Until an endpoint receives the peer's SETUP, it uses the
   * default value, including for SETUP itself."
   */
  it('is 65535 until the receiver advertises more, and absent before draft-23', () => {
    expect(receiveLimit('23', undefined)).toBe(65535n)
    expect(receiveLimit('23', 100000n)).toBe(100000n)
    expect(receiveLimit('22', 100000n)).toBeUndefined()
  })

  it('refuses a Length over the limit before its body arrives', () => {
    // GOAWAY with a Length of 70000, `c1 11 70`, and no body yet.
    const header = hex('10 c1 11 70')
    const over = decodeControlMessage(header, '23', 65535n)
    expect(over.ok).toBe(false)
    if (over.ok) return
    expect(over.error.code).toBe('CONSTRAINT_VIOLATION')
    expect(isIncomplete(over.error)).toBe(false)

    const under = decodeControlMessage(header, '23', 100000n)
    expect(under.ok).toBe(false)
    if (under.ok) return
    expect(isIncomplete(under.error)).toBe(true)
  })

  it('holds SETUP to 65535 whatever the receiver advertised', () => {
    const result = decodeControlMessage(hex('af 00 c1 11 70'), '23', 100000n)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(isIncomplete(result.error)).toBe(false)
  })

  it('decodes a SETUP with no options, three bytes', () => {
    expect(decodeControlMessage(hex('af 00 00'), '23', 65535n)).toMatchObject({
      ok: true,
      value: { type: 'setup', options: {} },
    })
  })
})
