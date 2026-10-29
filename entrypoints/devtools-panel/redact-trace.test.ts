/** The share dialog's defaults leave payloads and authorization behind. */

import { decodeMessage, encodeMessage } from '@moqtap/codec/draft20'
import type { LibraryClient } from '@/src/account/library'
import { readMoqtrace, type Trace, type TraceEvent } from '@moqtap/trace'
import { redactCatalogText } from '@moqtap/media/catalog'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SHARE_CONTENT,
  redactTrace,
  scrubMessage,
  stripQuery,
} from './redact-trace'
import { shareTrace } from './share-trace'

const SECRET = 'SECRET-TOKEN-0123456789'
const enc = new TextEncoder()

function setupFrame(pathQuery = true): Uint8Array {
  return encodeMessage({
    type: 'setup',
    options: {
      path: pathQuery ? '/moq?jwt=path-secret' : '/moq',
      authorization_token: [
        { alias_type: 3n, token_type: 1n, token_value: enc.encode(SECRET) },
      ],
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
    {
      type: 'stream-opened',
      seq: 1,
      timestamp: 1,
      streamId: 2n,
      direction: 1,
      streamType: 0,
    } as TraceEvent,
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
    {
      type: 'stream-closed',
      seq: 4,
      timestamp: 3,
      streamId: 2n,
      errorCode: 0,
    } as TraceEvent,
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

const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/**
 * The decoded map as the panel holds it during a live capture: the background
 * serialises it with bytes tagged as hex (background.ts `jsonSafe`), and the
 * panel strips the tags (decoded.ts `untagDecoded`), so a token value
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
    if (t.__t === 'n')
      return Number.isSafeInteger(Number(t.v)) ? Number(t.v) : t.v
    if (t.__t === 'b') return t.v
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, untag(v)]))
  }
  return untag(JSON.parse(tagged))
}

const control = (t: Trace) =>
  t.events.find((e) => e.type === 'control') as TraceEvent & {
    message: unknown
    raw?: Uint8Array
  }

function capturingLibrary(): {
  library: LibraryClient
  uploaded: () => Uint8Array
} {
  let uploaded: Uint8Array | null = null
  const library: LibraryClient = {
    upload: async (_org, bytes) => {
      uploaded = bytes
      return {
        id: 'T',
        orgId: 'O',
        bytes: bytes.length,
        detail: 'headers',
        expiresAt: null,
      }
    },
    createLink: async () => ({
      id: 'S',
      audience: 'link',
      url: 'u',
      expiresAt: 1,
    }),
    shareWithOrg: async () => ({
      id: 'S',
      audience: 'org',
      url: null,
      expiresAt: null,
    }),
  }
  return { library, uploaded: () => uploaded! }
}

describe('redaction for sharing', () => {
  it('defaults leave both payloads and authorization out', async () => {
    expect(DEFAULT_SHARE_CONTENT).toEqual({ payloads: false, auth: false })
  })

  it('payloads off drops every object-payload, keeps the headers, and says so in detail', async () => {
    const out = await redactTrace(trace(), { payloads: false, auth: true }, '20')
    expect(out.events.map((e) => e.type)).toEqual([
      'control',
      'stream-opened',
      'object-header',
      'stream-closed',
    ])
    expect(out.events.map((e) => e.seq)).toEqual([0, 1, 2, 3])
    expect(out.header.detail).toBe('headers')
  })

  it('a session with no data stream, shared with the defaults, is control and carries no stream event', async () => {
    // A trace that carries the control stream's bytes as one raw object-payload,
    // as an imported trace can; nothing else marks an object.
    const t = trace(false)
    const controlBytes = setupFrame(false)
    const live: Trace = {
      ...t,
      events: [
        t.events[0]!,
        {
          type: 'stream-opened',
          seq: 1,
          timestamp: 1,
          streamId: 0n,
          direction: 0,
          streamType: 0,
        } as TraceEvent,
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
    for (const content of [
      DEFAULT_SHARE_CONTENT,
      { payloads: true, auth: false },
    ]) {
      const out = await redactTrace(live, content, '20', new Set([0n]))
      expect(out.header.detail).toBe('control')
      expect(out.events.map((e) => e.type)).toEqual(['control'])
      expect(out.events.map((e) => e.seq)).toEqual([0])
    }
  })

  it('payloads on keeps them at headers+data', async () => {
    const out = await redactTrace(trace(), { payloads: true, auth: true }, '20')
    expect(out.events.some((e) => e.type === 'object-payload')).toBe(true)
    expect(out.header.detail).toBe('headers+data')
  })

  it('auth off zero-fills the token in the wire bytes, length preserved, and in the decoded map', async () => {
    const before = trace(false)
    const out = await redactTrace(before, { payloads: true, auth: false }, '20')
    const raw = control(out).raw!
    expect(raw.length).toBe(control(before).raw!.length)
    expect(contains(raw, SECRET)).toBe(false)
    // The redacted frame still decodes, with the token's presence kept.
    const redecoded = decodeMessage(raw)
    expect(redecoded.ok).toBe(true)
    const msg = control(out).message as {
      options: {
        authorization_token: { token_value: Uint8Array }[]
        path: string
      }
    }
    expect(msg.options.authorization_token[0]!.token_value).toEqual(
      new Uint8Array(SECRET.length),
    )
    expect(msg.options.path).toBe('/moq')
    expect(out.header.endpoint).toBe('https://relay.example/moq')
    // The input is untouched.
    expect(contains(control(before).raw!, SECRET)).toBe(true)
  })

  it('a SETUP whose path carries a query loses its wire bytes, which hold the query too', async () => {
    const out = await redactTrace(trace(true), DEFAULT_SHARE_CONTENT, '20')
    expect(control(out).raw).toBeUndefined()
    expect(
      (control(out).message as { options: { path: string } }).options.path,
    ).toBe('/moq')
  })

  it('auth on ships the frame as captured', async () => {
    const out = await redactTrace(trace(), { payloads: true, auth: true }, '20')
    expect(contains(control(out).raw!, SECRET)).toBe(true)
    expect(out.header.endpoint).toBe(
      'https://relay.example/moq?token=url-secret#frag',
    )
  })

  it('wire bytes the redactor cannot vouch for are dropped, not shipped', async () => {
    const unknownDraft = await redactTrace(trace(), DEFAULT_SHARE_CONTENT, null)
    expect(control(unknownDraft).raw).toBeUndefined()
    const notADraft = await redactTrace(trace(), DEFAULT_SHARE_CONTENT, '99')
    expect(control(notADraft).raw).toBeUndefined()
    // A whole frame of a type the draft does not define: the redactor walks
    // nothing, so "no token found" says nothing about its bytes.
    const unknownType = new Uint8Array([0x3e, 0x00, 0x02, 0x61, 0x62])
    const t = trace(false)
    const odd = {
      ...t,
      events: t.events.map((e) =>
        e.type === 'control' ? { ...e, raw: unknownType } : e,
      ),
    }
    expect(
      control(await redactTrace(odd, DEFAULT_SHARE_CONTENT, '20')).raw,
    ).toBeUndefined()
  })

  it("draft-07's authorization_info is replaced", async () => {
    expect(
      scrubMessage({ params: { authorization_info: 'Bearer x', role: 1n } }),
    ).toEqual({
      params: { authorization_info: '[redacted]', role: 1n },
    })
  })

  it('an unparseable endpoint is dropped', async () => {
    expect(stripQuery('not a url ?token=x')).toBeUndefined()
    const t = trace()
    const out = await redactTrace(
      { ...t, header: { ...t.header, endpoint: '::?k=v' } },
      DEFAULT_SHARE_CONTENT,
      '20',
    )
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
        e.type === 'control'
          ? ({
              ...e,
              message: asLivePanelHolds((e as { message: unknown }).message),
            } as TraceEvent)
          : e,
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
    expect(msg.options.authorization_token[0]!.token_value).toBe(
      '0'.repeat(secretHex.length),
    )
  })

  it('a token_value the redactor does not recognise is dropped, not shipped', async () => {
    const out = scrubMessage({
      t: { token_value: { anything: SECRET }, token_type: 1 },
    })
    expect(out).toEqual({ t: { token_type: 1 } })
  })

  it("auth off drops the control and request streams' own bytes, which hold SETUP and SUBSCRIBE tokens, even with payloads on", async () => {
    const t = trace(false)
    const controlBytes = setupFrame(true)
    const live: Trace = {
      ...t,
      events: [
        ...t.events,
        {
          type: 'stream-opened',
          seq: 5,
          timestamp: 4,
          streamId: 0n,
          direction: 0,
          streamType: 0,
        } as TraceEvent,
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
    for (const secret of [SECRET, 'path-secret'])
      expect(contains(bytes, secret)).toBe(false)
    const back = readMoqtrace(bytes)
    // The media stream's payload is still there: the user asked for payloads.
    expect(
      back.events
        .filter((e) => e.type === 'object-payload')
        .map((e) => (e as { streamId: bigint }).streamId),
    ).toEqual([2n])
    expect(
      back.events
        .filter((e) => e.type === 'object-header')
        .map((e) => (e as { streamId: bigint }).streamId),
    ).toEqual([2n])
  })

  it('auth off drops a request stream the trace itself names, with no panel marker, even with payloads on', async () => {
    // An imported trace: the panel marked no stream, but the SUBSCRIBE's own
    // stream id says stream 4 is a request stream, and its bytes are framed
    // as an object holding the token.
    const t = trace(false)
    const subscribe = enc.encode(`SUBSCRIBE ${SECRET}`)
    const imported: Trace = {
      ...t,
      events: [
        ...t.events,
        {
          type: 'control',
          seq: 5,
          timestamp: 4,
          direction: 0,
          messageType: 0x3,
          message: {},
          streamId: 4n,
        } as TraceEvent,
        {
          type: 'stream-opened',
          seq: 6,
          timestamp: 4,
          streamId: 4n,
          direction: 0,
          streamType: 0,
        } as TraceEvent,
        {
          type: 'object-header',
          seq: 7,
          timestamp: 4,
          streamId: 4n,
          groupId: 0n,
          objectId: 0n,
          publisherPriority: 0,
          objectStatus: 0,
        } as TraceEvent,
        {
          type: 'object-payload',
          seq: 8,
          timestamp: 4,
          streamId: 4n,
          groupId: 0n,
          objectId: 0n,
          size: subscribe.length,
          payload: subscribe,
        } as TraceEvent,
      ],
    }
    const out = await redactTrace(imported, { payloads: true, auth: false }, '20')
    const objects = out.events
      .filter((e) => e.type === 'object-payload' || e.type === 'object-header')
      .map((e) => (e as { streamId: bigint }).streamId)
    expect(objects).toEqual([2n, 2n])
    // The request's message itself stays.
    expect(out.events.filter((e) => e.type === 'control')).toHaveLength(2)
  })

  it('auth on keeps the control stream bytes when payloads are on', async () => {
    const t = trace(false)
    const live: Trace = {
      ...t,
      events: [
        ...t.events,
        {
          type: 'object-payload',
          seq: 5,
          timestamp: 4,
          streamId: 0n,
          groupId: 0n,
          objectId: 0n,
          size: 1,
          payload: new Uint8Array([1]),
        } as TraceEvent,
      ],
    }
    const out = await redactTrace(
      live,
      { payloads: true, auth: true },
      '20',
      new Set([0n]),
    )
    expect(out.events.filter((e) => e.type === 'object-payload')).toHaveLength(
      2,
    )
  })
})

/** An MSF-01 / CMSF catalog holding every kind of secret a catalog can carry, and what a reader needs. */
const CATALOG = JSON.stringify({
  version: '1',
  tracks: [
    {
      name: 'video',
      packaging: 'cmaf',
      connectionUri: 'https://cdn.example/live?sig=URI-SECRET#FRAG-SECRET',
      token: 'TOKEN-SECRET',
      authInfo: { bearer: { key: 'AUTHINFO-SECRET' } },
      trackBaseKey: 'BASEKEY-SECRET',
      keyId: 'KEYID-KEEP',
      initData: 'AAAAINITKEEP',
    },
  ],
})

/** The base fixture plus one catalog object per payload, on a stream of their own (6). */
function catalogTrace(...payloads: Uint8Array[]): Trace {
  const t = trace(false)
  const events: TraceEvent[] = [...t.events]
  payloads.forEach((payload, i) => {
    const objectId = BigInt(i)
    events.push(
      {
        type: 'object-header',
        seq: 0,
        timestamp: 5,
        streamId: 6n,
        groupId: 0n,
        objectId,
        publisherPriority: 0,
        objectStatus: 0,
      } as TraceEvent,
      {
        type: 'object-payload',
        seq: 0,
        timestamp: 5,
        streamId: 6n,
        groupId: 0n,
        objectId,
        size: payload.length,
        payload,
      } as TraceEvent,
    )
  })
  return { ...t, events: events.map((e, seq) => ({ ...e, seq }) as TraceEvent) }
}

/** The payloads left on the catalog's stream, by object id. */
function catalogPayloads(
  t: Trace,
): Map<bigint, { size: number; payload: Uint8Array }> {
  const out = new Map<bigint, { size: number; payload: Uint8Array }>()
  for (const e of t.events) {
    if (e.type !== 'object-payload') continue
    const p = e as TraceEvent & {
      streamId: bigint
      objectId: bigint
      size: number
      payload: Uint8Array
    }
    if (p.streamId === 6n) out.set(p.objectId, p)
  }
  return out
}

const catalogHeaders = (t: Trace) =>
  t.events.filter(
    (e) =>
      e.type === 'object-header' && (e as { streamId: bigint }).streamId === 6n,
  )

const text = (b: Uint8Array) => new TextDecoder().decode(b)

async function pipe(
  b: Uint8Array,
  t: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const stream = new Blob([b as BlobPart]).stream().pipeThrough(t)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
const gzip = (b: Uint8Array) => pipe(b, new CompressionStream('gzip'))
const gunzip = (b: Uint8Array) => pipe(b, new DecompressionStream('gzip'))

describe('catalog redaction for sharing', () => {
  it('auth off replaces credentials and the content key, keeps key ids and init data, and fixes the size', async () => {
    const out = await redactTrace(
      catalogTrace(enc.encode(CATALOG)),
      { payloads: true, auth: false },
      '20',
    )
    const p = catalogPayloads(out).get(0n)!
    for (const secret of [
      'URI-SECRET',
      'FRAG-SECRET',
      'TOKEN-SECRET',
      'AUTHINFO-SECRET',
      'BASEKEY-SECRET',
    ]) {
      expect(contains(p.payload, secret)).toBe(false)
    }
    const track = (
      JSON.parse(text(p.payload)) as { tracks: Record<string, unknown>[] }
    ).tracks[0]!
    expect(track).toMatchObject({
      connectionUri: 'https://cdn.example/live?[redacted]#[redacted]',
      token: '[redacted]',
      authInfo: { bearer: '[redacted]' },
      trackBaseKey: '[redacted]',
      keyId: 'KEYID-KEEP',
      initData: 'AAAAINITKEEP',
    })
    expect(p.size).toBe(p.payload.length)
    expect(out.header.detail).toBe('headers+data')
  })

  it('auth on keeps the credentials but still replaces trackBaseKey, a content key', async () => {
    const out = await redactTrace(
      catalogTrace(enc.encode(CATALOG)),
      { payloads: true, auth: true },
      '20',
    )
    const p = catalogPayloads(out).get(0n)!
    for (const kept of [
      'URI-SECRET',
      'FRAG-SECRET',
      'TOKEN-SECRET',
      'AUTHINFO-SECRET',
      'KEYID-KEEP',
      'AAAAINITKEEP',
    ]) {
      expect(contains(p.payload, kept)).toBe(true)
    }
    expect(contains(p.payload, 'BASEKEY-SECRET')).toBe(false)
    expect(p.size).toBe(p.payload.length)
  })

  it('delta objects of both drafts are redacted too', async () => {
    const msf01 = {
      deltaUpdate: [
        {
          op: 'add',
          tracks: [
            { name: 'audio', token: 'DELTA-TOKEN', trackBaseKey: 'DELTA-KEY' },
          ],
        },
      ],
    }
    const msf00 = {
      deltaUpdate: true,
      addTracks: [
        { name: 'audio', token: 'ADD-TOKEN', trackBaseKey: 'ADD-KEY' },
      ],
    }
    const t = catalogTrace(
      enc.encode(JSON.stringify(msf01)),
      enc.encode(JSON.stringify(msf00)),
    )
    const off = catalogPayloads(
      await redactTrace(t, { payloads: true, auth: false }, '20'),
    )
    for (const secret of ['DELTA-TOKEN', 'DELTA-KEY'])
      expect(contains(off.get(0n)!.payload, secret)).toBe(false)
    for (const secret of ['ADD-TOKEN', 'ADD-KEY'])
      expect(contains(off.get(1n)!.payload, secret)).toBe(false)
    const on = catalogPayloads(
      await redactTrace(t, { payloads: true, auth: true }, '20'),
    )
    expect(contains(on.get(0n)!.payload, 'DELTA-TOKEN')).toBe(true)
    expect(contains(on.get(0n)!.payload, 'DELTA-KEY')).toBe(false)
    expect(contains(on.get(1n)!.payload, 'ADD-KEY')).toBe(false)
  })

  it('a gzip catalog comes back gzip, holding the redacted text, auth on or off', async () => {
    const t = catalogTrace(await gzip(enc.encode(CATALOG)))
    const off = catalogPayloads(
      await redactTrace(t, { payloads: true, auth: false }, '20'),
    ).get(0n)!
    expect([off.payload[0], off.payload[1]]).toEqual([0x1f, 0x8b])
    expect(off.size).toBe(off.payload.length)
    const offText = text(await gunzip(off.payload))
    expect(offText).toBe(
      redactCatalogText(enc.encode(CATALOG), { credentials: true }),
    )
    for (const secret of ['TOKEN-SECRET', 'BASEKEY-SECRET', 'URI-SECRET'])
      expect(offText).not.toContain(secret)
    expect(offText).toContain('KEYID-KEEP')

    const on = catalogPayloads(
      await redactTrace(t, { payloads: true, auth: true }, '20'),
    ).get(0n)!
    const onText = text(await gunzip(on.payload))
    expect(onText).toBe(
      redactCatalogText(enc.encode(CATALOG), { credentials: false }),
    )
    expect(onText).toContain('TOKEN-SECRET')
    expect(onText).not.toContain('BASEKEY-SECRET')
  })

  it('gzip of text that is not JSON and names no secret goes as captured', async () => {
    const plain = await gzip(enc.encode('just some text, no fields'))
    const out = await redactTrace(
      catalogTrace(plain),
      { payloads: true, auth: false },
      '20',
    )
    expect(catalogPayloads(out).get(0n)!.payload).toBe(plain)
  })

  it('gzip that names a secret outside JSON, does not decompress, holds broken JSON or is too large loses its payload and keeps its header', async () => {
    const named = await gzip(enc.encode('x "trackBaseKey": "K"'))
    const garbage = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4])
    const broken = await gzip(enc.encode('{"a":'))
    const huge = await gzip(new Uint8Array(16 * 1024 * 1024 + 1).fill(0x20))
    for (const auth of [false, true]) {
      const out = await redactTrace(
        catalogTrace(named, garbage, broken, huge),
        { payloads: true, auth },
        '20',
      )
      expect(catalogPayloads(out).size).toBe(0)
      expect(catalogHeaders(out)).toHaveLength(4)
    }
    // Inflates 16 MiB twice
  }, 30_000)

  it('a catalog-looking object that does not parse is dropped; one that names no catalog field is kept', async () => {
    const broken = enc.encode('{"tracks":[{"name":"v","token":"CUT-SHORT"')
    const other = enc.encode('{not json at all')
    const out = await redactTrace(
      catalogTrace(broken, other),
      { payloads: true, auth: false },
      '20',
    )
    const left = catalogPayloads(out)
    expect(left.has(0n)).toBe(false)
    expect(left.get(1n)!.payload).toEqual(other)
    expect(catalogHeaders(out)).toHaveLength(2)
  })

  it('a catalog that is not UTF-8 is dropped, not decoded loosely', async () => {
    const bytes = enc.encode('{"tracks":[{"name":"v","token":"T"}],"x":"ab"}')
    bytes[bytes.length - 3] = 0xff
    const out = await redactTrace(
      catalogTrace(bytes),
      { payloads: true, auth: false },
      '20',
    )
    expect(catalogPayloads(out).size).toBe(0)
  })

  it('JSON that is not a catalog, and a catalog with nothing secret, go as captured', async () => {
    const app = enc.encode('{"user":"APP-DATA","score":1}')
    const plain = enc.encode(
      '{"version":"1","tracks":[{"name":"v","keyId":"K"}]}',
    )
    const out = await redactTrace(
      catalogTrace(app, plain),
      { payloads: true, auth: false },
      '20',
    )
    const left = catalogPayloads(out)
    expect(left.get(0n)!.payload).toBe(app)
    expect(left.get(1n)!.payload).toBe(plain)
    // Media is not touched either.
    const media = out.events.find(
      (e) =>
        e.type === 'object-payload' &&
        (e as { streamId: bigint }).streamId === 2n,
    ) as TraceEvent & { payload: Uint8Array }
    expect(text(media.payload)).toBe('media')
  })

  it('JSON without a catalog shape is kept with the same members redacted', async () => {
    // tracks as an object, a catalog nested in another document, application
    // data with a token: each is spliced like a catalog, wherever the member
    // sits.
    const wrongShape = enc.encode(
      '{"version":1,"tracks":{"v":{"trackBaseKey":"SHAPE-KEY"}}}',
    )
    const nested = enc.encode(
      '{"catalog":{"tracks":[{"name":"v","trackBaseKey":"NESTED-KEY"}]}}',
    )
    const appToken = enc.encode('{"token":"APP-TOKEN","score":1}')
    const t = catalogTrace(wrongShape, nested, appToken)
    for (const auth of [false, true]) {
      const left = catalogPayloads(
        await redactTrace(t, { payloads: true, auth }, '20'),
      )
      expect([...left.keys()]).toEqual([0n, 1n, 2n])
      expect(contains(left.get(0n)!.payload, 'SHAPE-KEY')).toBe(false)
      expect(contains(left.get(1n)!.payload, 'NESTED-KEY')).toBe(false)
      for (const p of left.values()) {
        expect(p.size).toBe(p.payload.length)
        expect(() => JSON.parse(text(p.payload))).not.toThrow()
      }
      const app = left.get(2n)!.payload
      if (auth) expect(app).toBe(appToken)
      else {
        expect(contains(app, 'APP-TOKEN')).toBe(false)
        expect(JSON.parse(text(app)).score).toBe(1)
      }
    }
  })

  it('a UTF-16 catalog, which does not parse as UTF-8, is dropped', async () => {
    const json = '{"tracks":[{"name":"v","trackBaseKey":"WIDE-KEY"}]}'
    const wide = new Uint8Array(json.length * 2)
    for (let i = 0; i < json.length; i++) wide[i * 2] = json.charCodeAt(i)
    const out = await redactTrace(
      catalogTrace(wide),
      { payloads: true, auth: true },
      '20',
    )
    expect(catalogPayloads(out).size).toBe(0)
  })

  it('a catalog behind framing bytes is dropped when it names a secret', async () => {
    // A stream exported framed wrong: its JSON does not start at byte 0.
    const framed = (json: string) =>
      new Uint8Array([0x10, 0x05, 0x00, 0x00, ...enc.encode(json)])
    const key = framed('{"tracks":[{"name":"v","trackBaseKey":"BEHIND-KEY"}]}')
    const token = framed('{"tracks":[{"name":"v","token":"BEHIND-TOKEN"}]}')
    const plain = framed('{"tracks":[{"name":"v"}]}')
    const t = catalogTrace(key, token, plain)
    const on = catalogPayloads(
      await redactTrace(t, { payloads: true, auth: true }, '20'),
    )
    expect([...on.keys()]).toEqual([1n, 2n])
    const off = catalogPayloads(
      await redactTrace(t, { payloads: true, auth: false }, '20'),
    )
    expect([...off.keys()]).toEqual([2n])
  })

  it('a member name written in JSON escapes is found at an array root, in text that does not parse and behind a second BOM', async () => {
    const B = '\\'
    const BOM = [0xef, 0xbb, 0xbf]
    const arrayKey = enc.encode(`[{"trackBase${B}u004bey":"ARRAY-KEY"}]`)
    const arrayToken = enc.encode(`[{"tok${B}u0065n":"ARRAY-TOKEN"}]`)
    const arrayUri = enc.encode(
      `[{"connection${B}u0055ri":"https://u:ARRAY-PW@h/?q=ARRAY-Q"}]`,
    )
    const ndjson = enc.encode(`{"a":1}\n{"trackBase${B}u004bey":"NDJSON-KEY"}`)
    const cut = enc.encode(`{"trackBase${B}u004Bey":"CUT-KEY"`)
    const doubleBom = new Uint8Array([
      ...BOM,
      ...BOM,
      ...enc.encode(`{"trackBase${B}u004bey":"BOM-KEY"}`),
    ])
    const t = catalogTrace(
      arrayKey,
      arrayToken,
      arrayUri,
      ndjson,
      cut,
      doubleBom,
    )
    for (const auth of [false, true]) {
      const left = catalogPayloads(
        await redactTrace(t, { payloads: true, auth }, '20'),
      )
      // The arrays are JSON and are redacted in place; the rest are dropped.
      expect([...left.keys()]).toEqual([0n, 1n, 2n])
      for (const p of left.values()) {
        expect(() => JSON.parse(text(p.payload))).not.toThrow()
        expect(p.size).toBe(p.payload.length)
      }
      expect(contains(left.get(0n)!.payload, 'ARRAY-KEY')).toBe(false)
      for (const secret of ['ARRAY-TOKEN', 'ARRAY-PW', 'ARRAY-Q']) {
        const at = secret === 'ARRAY-TOKEN' ? 1n : 2n
        expect(contains(left.get(at)!.payload, secret)).toBe(auth)
      }
    }
  })

  it('a stream exported unframed loses its payload when it holds gzip; a framed object does not', async () => {
    const bytes = new Uint8Array([
      0x10, 0x05, 0x00, 0x00, 0x00, 0x09, 0x1f, 0x8b, 0x08, 0, 1, 2, 3, 4,
    ])
    const t = catalogTrace(bytes)
    const headed = catalogPayloads(
      await redactTrace(t, { payloads: true, auth: true }, '20'),
    )
    expect(headed.size).toBe(1)
    // The same bytes with no object header: a whole stream, as build-trace
    // exports one that frames as nothing.
    const unframed = {
      ...t,
      events: t.events.filter(
        (e) =>
          !(
            e.type === 'object-header' &&
            (e as { streamId: bigint }).streamId === 6n
          ),
      ),
    }
    const out = catalogPayloads(
      await redactTrace(unframed, { payloads: true, auth: true }, '20'),
    )
    expect(out.size).toBe(0)
  })

  it('the uploaded bytes hold no catalog credential or content key', async () => {
    const { library, uploaded } = capturingLibrary()
    await shareTrace(library, {
      trace: catalogTrace(enc.encode(CATALOG)),
      draft: '20',
      content: { payloads: true, auth: false },
      controlStreams: new Set(),
      orgId: 'O',
      title: null,
      audience: { kind: 'org' },
    })
    const bytes = uploaded()
    for (const secret of [
      'URI-SECRET',
      'TOKEN-SECRET',
      'AUTHINFO-SECRET',
      'BASEKEY-SECRET',
    ]) {
      expect(contains(bytes, secret)).toBe(false)
    }
    expect(contains(bytes, 'KEYID-KEEP')).toBe(true)
  })
})
