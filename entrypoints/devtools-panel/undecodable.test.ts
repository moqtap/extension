import { describe, expect, it } from 'vitest'
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

  it('writes bytes as hex, 16 to a line', () => {
    expect(hexLines(new Uint8Array(17))).toBe(`${'00 '.repeat(15)}00\n00`)
  })
})
