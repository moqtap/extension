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
  decodeControlMessage,
  encodeControlMessage,
  isIncomplete,
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
