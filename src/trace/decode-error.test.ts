import { describe, expect, it } from 'vitest'
import {
  DECODE_ERROR_CODE,
  DECODE_ERROR_MESSAGE_TYPE,
  decodeErrorReason,
  isDecodeError,
} from './decode-error'

describe('isDecodeError', () => {
  it('recognises the marker', () => {
    expect(isDecodeError(DECODE_ERROR_MESSAGE_TYPE)).toBe(true)
  })

  it('leaves real message types alone', () => {
    // Notably `unknown`, which the control reader uses for a message it
    // decoded but could not name — that one is still a message.
    for (const name of ['subscribe', 'setup', 'goaway', 'unknown', '']) {
      expect(isDecodeError(name)).toBe(false)
    }
  })
})

describe('decodeErrorReason', () => {
  it('joins the decoder code to its message', () => {
    expect(
      decodeErrorReason({
        code: 'UNKNOWN_MESSAGE_TYPE',
        reason: 'type 0x99 is not defined in draft-17',
      }),
    ).toBe('UNKNOWN_MESSAGE_TYPE: type 0x99 is not defined in draft-17')
  })

  it('falls back through the halves it has', () => {
    expect(decodeErrorReason({ code: 'DECODER_THREW' })).toBe('DECODER_THREW')
    expect(decodeErrorReason({ reason: 'ran off the end' })).toBe(
      'ran off the end',
    )
  })

  it('never yields an empty description', () => {
    // Export runs over state that has been through a reactive proxy and a JSON
    // round trip; losing the error because its description was malformed is
    // worse than a vague description.
    for (const input of [
      null,
      undefined,
      {},
      'a string',
      42,
      { code: '', reason: '' },
      { code: 7, reason: [] },
    ]) {
      expect(decodeErrorReason(input)).toBe('undecodable control bytes')
    }
  })
})

describe('DECODE_ERROR_CODE', () => {
  it('is zero, because no MoQT error code means "I could not parse this"', () => {
    // Any non-zero value would name a code the protocol defines and assert a
    // protocol error the peer never signalled.
    expect(DECODE_ERROR_CODE).toBe(0)
  })
})
