import { describe, expect, it } from 'vitest'
import { decodeControlMessage } from '@/src/codec/control-message'
import type { SupportedDraft } from '@/src/types/common'
import { hexLines, undefinedParameter } from './undecodable'
import type { MessageEntry } from './use-inspector'

// A draft-22 SUBSCRIBE with parameter 0x24, as a captured trace recorded it.
const RAW = Uint8Array.from(
  '03002d0602076d6f717461696c08636830375f616c6c0831303830705f32730420320102c1bae9000201000103020180'
    .match(/../g)!
    .map((h) => parseInt(h, 16)),
)

function entry(over: Partial<MessageEntry>): MessageEntry {
  return { timestamp: 1, messageType: 'x', decoded: null, decodedPretty: null, raw: new Uint8Array(), ...over }
}

const undecodable = entry({
  messageType: 'decode_error',
  streamId: 20,
  decoded: { code: 'INVALID_PARAMETER', reason: 'Unknown Message Parameter type 0x24' },
  raw: RAW,
})
const ok = entry({ messageType: 'subscribe_ok', direction: 'rx', streamId: 20, timestamp: 2 })

describe('a message with a parameter its draft does not define', () => {
  it('names the message, the parameter, the sender that opened the request stream, and the rule', () => {
    const p = undefinedParameter(undecodable, {
      draft: '22',
      streams: new Map([[20, { direction: 'tx' as const }]]),
      messages: [undecodable, ok],
    })
    expect(p).toMatchObject({
      title: "SUBSCRIBE carries parameter 0x24, which draft-22 doesn't define",
      found: 'Parameter type 0x24 in SUBSCRIBE',
      remedy: 'Remove parameter 0x24 from SUBSCRIBE, or negotiate it with a Setup Option',
      sender: 'page',
      spec: {
        label: 'MoQT-22 9.20',
        url: 'https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport-22#section-9.20',
        quote: expect.stringContaining('An endpoint that receives an unknown Message Parameter MUST close the session'),
      },
    })
    expect(p!.evidence!.split('\n')[0]).toBe('03 00 2d 06 02 07 6d 6f 71 74 61 69 6c 08 63 68')
  })

  it('names no sender when the bytes are not the first on their stream, or the draft has no request streams', () => {
    const streams = new Map([[20, { direction: 'tx' as const }]])
    expect(undefinedParameter(undecodable, { draft: '22', streams, messages: [ok, undecodable] })!.sender).toBeNull()
    expect(undefinedParameter(undecodable, { draft: '16', streams, messages: [undecodable] })!.sender).toBeNull()
  })

  it('keeps the library wording for other failures and drafts without the rule', () => {
    const other = entry({ ...undecodable, decoded: { code: 'UNKNOWN_MESSAGE_TYPE', reason: 'type 0x99' } })
    const ctx = { draft: '22', streams: new Map(), messages: [] }
    expect(undefinedParameter(other, ctx)).toBeNull()
    expect(undefinedParameter(undecodable, { ...ctx, draft: '14' })).toBeNull()
  })

  /** A decode-error entry for `hex`, as the background records one. */
  function refused(draft: SupportedDraft, hex: string): MessageEntry {
    const raw = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)))
    const result = decodeControlMessage(raw, draft)
    if (result.ok) throw new Error('expected the codec to refuse these bytes')
    return entry({
      messageType: 'decode_error',
      direction: 'tx',
      decoded: { code: result.error.code, reason: result.error.message },
      raw,
    })
  }

  it('cites the draft-23 rule, which closes with INVALID_PARAMETER', () => {
    // SUBSCRIBE, Request ID 4, ("live") / "video", one parameter 0x24 = 0,
    // with draft-23's varint Length.
    const msg = refused('23', '03100401046c69766505766964656f012400')
    expect(undefinedParameter(msg, { draft: '23', streams: new Map(), messages: [msg] })).toMatchObject({
      title: "SUBSCRIBE carries parameter 0x24, which draft-23 doesn't define",
      spec: {
        label: 'MoQT-23 9.19',
        url: 'https://datatracker.ietf.org/doc/html/draft-ietf-moq-transport-23#section-9.19',
        quote: expect.stringContaining('MUST close the session with INVALID_PARAMETER'),
      },
    })
  })

  it("reads the message type with the draft's own varint", () => {
    // SUBSCRIBE_NAMESPACE is 0x50, one byte from draft-17 on. Read as an
    // RFC 9000 varint it would be a two-byte type 0x1000.
    const msg = refused('23', '500a0201046c697665012400')
    expect(undefinedParameter(msg, { draft: '23', streams: new Map(), messages: [msg] })?.title).toBe(
      "SUBSCRIBE_NAMESPACE carries parameter 0x24, which draft-23 doesn't define",
    )
  })

  it('names SUBSCRIBE_NAMESPACE and SUBSCRIBE_TRACKS on draft-22, with its 16-bit Length', () => {
    for (const [hex, name] of [
      ['50000a0201046c697665012400', 'SUBSCRIBE_NAMESPACE'],
      ['51000a0201046c697665012400', 'SUBSCRIBE_TRACKS'],
    ]) {
      const msg = refused('22', hex)
      expect(undefinedParameter(msg, { draft: '22', streams: new Map(), messages: [msg] })).toMatchObject({
        title: `${name} carries parameter 0x24, which draft-22 doesn't define`,
        spec: { label: 'MoQT-22 9.20' },
      })
    }
  })

  it('writes bytes as hex, 16 to a line', () => {
    expect(hexLines(new Uint8Array(17))).toBe(`${'00 '.repeat(15)}00\n00`)
  })
})
