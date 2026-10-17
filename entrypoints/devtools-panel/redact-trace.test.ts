/** The share dialog's defaults leave payloads and authorization behind. */

import { decodeMessage, encodeMessage } from '@moqtap/codec/draft20'
import type { LibraryClient } from '@/src/account/library'
import { readMoqtrace, type Trace, type TraceEvent } from '@moqtap/trace'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SHARE_CONTENT, redactTrace, scrubMessage, stripQuery } from './redact-trace'
import { shareTrace } from './share-trace'

const SECRET = 'SECRET-TOKEN-0123456789'
const enc = new TextEncoder()

function setupFrame(pathQuery = true): Uint8Array {
  return encodeMessage({
    type: 'setup',
    options: {
      path: pathQuery ? '/moq?jwt=path-secret' : '/moq',
      authorization_token: [{ alias_type: 3n, token_type: 1n, token_value: enc.encode(SECRET) }],
      moqt_implementation: 'test-client',
    },
  } as Parameters<typeof encodeMessage>[0])
}

function contains(hay: Uint8Array, needle: string): boolean {
  const n = enc.encode(needle)
  outer: for (let i = 0; i + n.length <= hay.length; i++) {
    for (let j = 0; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer
    return true
  }
  return false
}

function trace(pathQuery = true): Trace {
  const raw = setupFrame(pathQuery)
  const decoded = decodeMessage(raw)
  if (!decoded.ok) throw new Error('fixture does not decode')
  const events: TraceEvent[] = [
    {
      type: 'control',
      seq: 0,
      timestamp: 0,
      direction: 0,
      messageType: 0x2f00,
      message: decoded.value,
      raw,
    } as TraceEvent,
    { type: 'stream-opened', seq: 1, timestamp: 1, streamId: 2n, direction: 1, streamType: 0 } as TraceEvent,
    {
      type: 'object-header',
      seq: 2,
      timestamp: 2,
      streamId: 2n,
      groupId: 0n,
      objectId: 0n,
      publisherPriority: 0,
      objectStatus: 0,
    } as TraceEvent,
    {
      type: 'object-payload',
      seq: 3,
      timestamp: 2,
      streamId: 2n,
      groupId: 0n,
      objectId: 0n,
      size: 5,
      payload: enc.encode('media'),
    } as TraceEvent,
    { type: 'stream-closed', seq: 4, timestamp: 3, streamId: 2n, errorCode: 0 } as TraceEvent,
  ]
  return {
    header: {
      protocol: 'moq-transport-20',
      perspective: 'observer',
      detail: 'headers+data',
      startTime: 1000,
      endpoint: 'https://relay.example/moq?token=url-secret#frag',
    },
    events,
  }
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/**
 * The decoded map as the panel holds it during a live capture: the background
 * serialises it with bytes tagged as hex (background.ts `jsonSafe`), and the
 * panel strips the tags (use-inspector.ts `untagDecoded`), so a token value
 * arrives as a hex string, not a Uint8Array.
 */
function asLivePanelHolds(message: unknown): unknown {
  const tagged = JSON.stringify(message, (_k, v) => {
    if (typeof v === 'bigint') return { __t: 'n', v: v.toString() }
    if (v instanceof Uint8Array) return { __t: 'b', v: hex(v) }
    return v
  })
  const untag = (o: unknown): unknown => {
    if (Array.isArray(o)) return o.map(untag)
    if (o === null || typeof o !== 'object') return o
    const t = o as { __t?: string; v?: string }
    if (t.__t === 'n') return Number.isSafeInteger(Number(t.v)) ? Number(t.v) : t.v
    if (t.__t === 'b') return t.v
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, untag(v)]))
  }
  return untag(JSON.parse(tagged))
}

const control = (t: Trace) =>
  t.events.find((e) => e.type === 'control') as TraceEvent & { message: unknown; raw?: Uint8Array }

function capturingLibrary(): { library: LibraryClient; uploaded: () => Uint8Array } {
  let uploaded: Uint8Array | null = null
  const library: LibraryClient = {
    upload: async (_org, bytes) => {
      uploaded = bytes
      return { id: 'T', orgId: 'O', bytes: bytes.length, detail: 'headers', expiresAt: null }
    },
    createLink: async () => ({ id: 'S', audience: 'link', url: 'u', expiresAt: 1 }),
    shareWithOrg: async () => ({ id: 'S', audience: 'org', url: null, expiresAt: null }),
  }
  return { library, uploaded: () => uploaded! }
}

describe('redaction for sharing', () => {
  it('defaults leave both payloads and authorization out', () => {
    expect(DEFAULT_SHARE_CONTENT).toEqual({ payloads: false, auth: false })
  })

  it('payloads off drops every object-payload, keeps the headers, and says so in detail', () => {
    const out = redactTrace(trace(), { payloads: false, auth: true }, '20')
    expect(out.events.map((e) => e.type)).toEqual([
      'control',
      'stream-opened',
      'object-header',
      'stream-closed',
    ])
    expect(out.events.map((e) => e.seq)).toEqual([0, 1, 2, 3])
    expect(out.header.detail).toBe('headers')
  })

  it('a session with no data stream, shared with the defaults, is control and carries no stream event', () => {
    // A trace that carries the control stream's bytes as one raw object-payload,
    // as an imported trace can; nothing else marks an object.
    const t = trace(false)
    const controlBytes = setupFrame(false)
    const live: Trace = {
      ...t,
      events: [
        t.events[0]!,
        { type: 'stream-opened', seq: 1, timestamp: 1, streamId: 0n, direction: 0, streamType: 0 } as TraceEvent,
        {
          type: 'object-payload',
          seq: 2,
          timestamp: 1,
          streamId: 0n,
          groupId: 0n,
          objectId: 0n,
          size: controlBytes.length,
          payload: controlBytes,
        } as TraceEvent,
      ],
    }
    for (const content of [DEFAULT_SHARE_CONTENT, { payloads: true, auth: false }]) {
      const out = redactTrace(live, content, '20', new Set([0n]))
      expect(out.header.detail).toBe('control')
      expect(out.events.map((e) => e.type)).toEqual(['control'])
      expect(out.events.map((e) => e.seq)).toEqual([0])
    }
  })

  it('payloads on keeps them at headers+data', () => {
    const out = redactTrace(trace(), { payloads: true, auth: true }, '20')
    expect(out.events.some((e) => e.type === 'object-payload')).toBe(true)
    expect(out.header.detail).toBe('headers+data')
  })

  it('auth off zero-fills the token in the wire bytes, length preserved, and in the decoded map', () => {
    const before = trace(false)
    const out = redactTrace(before, { payloads: true, auth: false }, '20')
    const raw = control(out).raw!
    expect(raw.length).toBe(control(before).raw!.length)
    expect(contains(raw, SECRET)).toBe(false)
    // The redacted frame still decodes, with the token's presence kept.
    const redecoded = decodeMessage(raw)
    expect(redecoded.ok).toBe(true)
    const msg = control(out).message as { options: { authorization_token: { token_value: Uint8Array }[]; path: string } }
    expect(msg.options.authorization_token[0]!.token_value).toEqual(new Uint8Array(SECRET.length))
    expect(msg.options.path).toBe('/moq')
    expect(out.header.endpoint).toBe('https://relay.example/moq')
    // The input is untouched.
    expect(contains(control(before).raw!, SECRET)).toBe(true)
  })

  it('a SETUP whose path carries a query loses its wire bytes, which hold the query too', () => {
    const out = redactTrace(trace(true), DEFAULT_SHARE_CONTENT, '20')
    expect(control(out).raw).toBeUndefined()
    expect((control(out).message as { options: { path: string } }).options.path).toBe('/moq')
  })

  it('auth on ships the frame as captured', () => {
    const out = redactTrace(trace(), { payloads: true, auth: true }, '20')
    expect(contains(control(out).raw!, SECRET)).toBe(true)
    expect(out.header.endpoint).toBe('https://relay.example/moq?token=url-secret#frag')
  })

  it('wire bytes the redactor cannot vouch for are dropped, not shipped', () => {
    const unknownDraft = redactTrace(trace(), DEFAULT_SHARE_CONTENT, null)
    expect(control(unknownDraft).raw).toBeUndefined()
    const notADraft = redactTrace(trace(), DEFAULT_SHARE_CONTENT, '99')
    expect(control(notADraft).raw).toBeUndefined()
    // A whole frame of a type the draft does not define: the redactor walks
    // nothing, so "no token found" says nothing about its bytes.
    const unknownType = new Uint8Array([0x3e, 0x00, 0x02, 0x61, 0x62])
    const t = trace(false)
    const odd = { ...t, events: t.events.map((e) => (e.type === 'control' ? { ...e, raw: unknownType } : e)) }
    expect(control(redactTrace(odd, DEFAULT_SHARE_CONTENT, '20')).raw).toBeUndefined()
  })

  it("draft-07's authorization_info is replaced", () => {
    expect(scrubMessage({ params: { authorization_info: 'Bearer x', role: 1n } })).toEqual({
      params: { authorization_info: '[redacted]', role: 1n },
    })
  })

  it('an unparseable endpoint is dropped', () => {
    expect(stripQuery('not a url ?token=x')).toBeUndefined()
    const t = trace()
    const out = redactTrace({ ...t, header: { ...t.header, endpoint: '::?k=v' } }, DEFAULT_SHARE_CONTENT, '20')
    expect(out.header.endpoint).toBeUndefined()
  })

  it('a share with the default toggles uploads a headers trace with no token and no payload anywhere in its bytes', async () => {
    const { library, uploaded } = capturingLibrary()
    await shareTrace(library, {
      trace: trace(),
      draft: '20',
      content: DEFAULT_SHARE_CONTENT,
      controlStreams: new Set(),
      orgId: 'O',
      title: null,
      audience: { kind: 'link', days: 7 },
    })
    const bytes = uploaded()
    for (const secret of [SECRET, 'path-secret', 'url-secret', 'media']) {
      expect(contains(bytes, secret)).toBe(false)
    }
    const back = readMoqtrace(bytes)
    expect(back.header.detail).toBe('headers')
    expect(back.events.some((e) => e.type === 'object-payload')).toBe(false)
  })

  it('auth off removes a live capture token, which the panel holds as a hex string, from the upload', async () => {
    const t = trace(false)
    const live = {
      ...t,
      events: t.events.map((e) =>
        e.type === 'control' ? ({ ...e, message: asLivePanelHolds((e as { message: unknown }).message) } as TraceEvent) : e,
      ),
    }
    const secretHex = hex(enc.encode(SECRET))
    // The fixture really does hold the token the way the live panel does.
    expect(JSON.stringify(control(live).message)).toContain(secretHex)
    const { library, uploaded } = capturingLibrary()
    await shareTrace(library, {
      trace: live,
      draft: '20',
      content: DEFAULT_SHARE_CONTENT,
      controlStreams: new Set(),
      orgId: 'O',
      title: null,
      audience: { kind: 'org' },
    })
    const bytes = uploaded()
    expect(contains(bytes, SECRET)).toBe(false)
    expect(contains(bytes, secretHex)).toBe(false)
    expect(contains(bytes, secretHex.toUpperCase())).toBe(false)
    const msg = control(readMoqtrace(bytes)).message as {
      options: { authorization_token: { token_value: unknown }[] }
    }
    expect(msg.options.authorization_token[0]!.token_value).toBe('0'.repeat(secretHex.length))
  })

  it('a token_value the redactor does not recognise is dropped, not shipped', () => {
    const out = scrubMessage({ t: { token_value: { anything: SECRET }, token_type: 1 } })
    expect(out).toEqual({ t: { token_type: 1 } })
  })

  it("auth off drops the control and request streams' own bytes, which hold SETUP and SUBSCRIBE tokens, even with payloads on", async () => {
    const t = trace(false)
    const controlBytes = setupFrame(true)
    const live: Trace = {
      ...t,
      events: [
        ...t.events,
        { type: 'stream-opened', seq: 5, timestamp: 4, streamId: 0n, direction: 0, streamType: 0 } as TraceEvent,
        {
          type: 'object-header',
          seq: 6,
          timestamp: 4,
          streamId: 0n,
          groupId: 0n,
          objectId: 0n,
          publisherPriority: 0,
          objectStatus: 0,
        } as TraceEvent,
        {
          type: 'object-payload',
          seq: 7,
          timestamp: 4,
          streamId: 0n,
          groupId: 0n,
          objectId: 0n,
          size: controlBytes.length,
          payload: controlBytes,
        } as TraceEvent,
      ],
    }
    const { library, uploaded } = capturingLibrary()
    await shareTrace(library, {
      trace: live,
      draft: '20',
      content: { payloads: true, auth: false },
      controlStreams: new Set([0n]),
      orgId: 'O',
      title: null,
      audience: { kind: 'org' },
    })
    const bytes = uploaded()
    for (const secret of [SECRET, 'path-secret']) expect(contains(bytes, secret)).toBe(false)
    const back = readMoqtrace(bytes)
    // The media stream's payload is still there: the user asked for payloads.
    expect(back.events.filter((e) => e.type === 'object-payload').map((e) => (e as { streamId: bigint }).streamId)).toEqual([2n])
    expect(back.events.filter((e) => e.type === 'object-header').map((e) => (e as { streamId: bigint }).streamId)).toEqual([2n])
  })

  it('auth off drops a request stream the trace itself names, with no panel marker, even with payloads on', () => {
    // An imported trace: the panel marked no stream, but the SUBSCRIBE's own
    // stream id says stream 4 is a request stream, and its bytes are framed
    // as an object holding the token.
    const t = trace(false)
    const subscribe = enc.encode(`SUBSCRIBE ${SECRET}`)
    const imported: Trace = {
      ...t,
      events: [
        ...t.events,
        { type: 'control', seq: 5, timestamp: 4, direction: 0, messageType: 0x3, message: {}, streamId: 4n } as TraceEvent,
        { type: 'stream-opened', seq: 6, timestamp: 4, streamId: 4n, direction: 0, streamType: 0 } as TraceEvent,
        { type: 'object-header', seq: 7, timestamp: 4, streamId: 4n, groupId: 0n, objectId: 0n, publisherPriority: 0, objectStatus: 0 } as TraceEvent,
        { type: 'object-payload', seq: 8, timestamp: 4, streamId: 4n, groupId: 0n, objectId: 0n, size: subscribe.length, payload: subscribe } as TraceEvent,
      ],
    }
    const out = redactTrace(imported, { payloads: true, auth: false }, '20')
    const objects = out.events
      .filter((e) => e.type === 'object-payload' || e.type === 'object-header')
      .map((e) => (e as { streamId: bigint }).streamId)
    expect(objects).toEqual([2n, 2n])
    // The request's message itself stays.
    expect(out.events.filter((e) => e.type === 'control')).toHaveLength(2)
  })

  it('auth on keeps the control stream bytes when payloads are on', () => {
    const t = trace(false)
    const live: Trace = {
      ...t,
      events: [
        ...t.events,
        { type: 'object-payload', seq: 5, timestamp: 4, streamId: 0n, groupId: 0n, objectId: 0n, size: 1, payload: new Uint8Array([1]) } as TraceEvent,
      ],
    }
    const out = redactTrace(live, { payloads: true, auth: true }, '20', new Set([0n]))
    expect(out.events.filter((e) => e.type === 'object-payload')).toHaveLength(2)
  })
})
