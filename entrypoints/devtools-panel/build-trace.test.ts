/**
 * The exported trace's `detail` has to describe what it actually carries.
 *
 * It was the constant `'headers+data'`. That level asserts captured object
 * payloads, and whether there are any is conditional: with stream recording
 * off, `getStreamData` returns null, neither `object-header` nor
 * `object-payload` is built, and the export is control messages and stream
 * lifecycle only. A reader trusting the header would then conclude the session
 * genuinely carried no objects, rather than that nobody recorded them — and a
 * trace that over-declares its own capture level is the thing SPEC's "MUST NOT
 * enable by default" is there to prevent.
 */

import { encodeSubgroupStream } from '@moqtap/codec/draft22'
import { writeMoqtrace } from '@moqtap/trace'
import { describe, expect, it } from 'vitest'
import { buildTrace } from './build-trace'
import { redactTrace } from './redact-trace'
import type { SessionEntry } from './use-inspector'

// SessionEntry carries far more than buildTrace reads; the fixture supplies
// the fields it actually touches.
// biome-ignore lint/suspicious/noExplicitAny: see above
type AnySession = any

function session(overrides: Record<string, unknown> = {}): SessionEntry {
  return {
    sessionId: 's1',
    url: 'https://relay.example/moq',
    createdAt: 1000,
    closed: false,
    protocol: 'moqt',
    draft: '14',
    messages: [],
    streams: [],
    datagramGroups: [],
    ...overrides,
  } as AnySession
}

const noData = async () => null

describe('the exported trace declares the capture level it actually has', () => {
  it('says "control" when no stream bytes were recorded', async () => {
    // The stream is known and was counted, but recording was off, so the
    // background has no bytes to serve.
    const trace = await buildTrace(
      session({
        streams: [
          {
            streamId: 1,
            byteCount: 4096,
            closed: false,
            direction: 'rx',
            firstDataAt: 1010,
            lastDataAt: 1020,
            arrivals: [],
          },
        ],
      }),
      noData,
    )

    expect(trace.header.detail).toBe('control')
    expect(trace.events.some((e) => e.type === 'object-payload')).toBe(false)
    // `control` admits no data stream events; the stream it knows of goes too.
    expect(trace.events.some((e) => e.type === 'stream-opened')).toBe(false)
  })

  it('says "headers+data" when payloads are present', async () => {
    // A draft-14 subgroup stream: type 0x10, track alias 1, group 0,
    // subgroup 0, priority 128, then one object (id 0, length 2).
    const bytes = new Uint8Array([
      0x10, 0x01, 0x00, 0x00, 0x80, 0x00, 0x02, 0xde, 0xad,
    ])
    const trace = await buildTrace(
      session({
        streams: [
          {
            streamId: 1,
            byteCount: bytes.length,
            closed: true,
            direction: 'rx',
            firstDataAt: 1010,
            lastDataAt: 1020,
            arrivals: [],
          },
        ],
      }),
      async () => bytes,
    )

    // Guards the assertion below: if the fixture stopped parsing, `detail`
    // would fall back to 'control' and the test would pass for the wrong
    // reason.
    expect(trace.events.some((e) => e.type === 'object-payload')).toBe(true)
    expect(trace.header.detail).toBe('headers+data')
  })

  it('says "control" for a session with only control messages', async () => {
    const trace = await buildTrace(session(), noData)
    expect(trace.header.detail).toBe('control')
  })
})

describe('the exported trace never carries control-plane bytes as objects', () => {
  const SECRET = 'SECRET-TOKEN-0123456789'
  const enc = new TextEncoder()
  const contains = (hay: Uint8Array, needle: string) => {
    const n = enc.encode(needle)
    outer: for (let i = 0; i + n.length <= hay.length; i++) {
      for (let j = 0; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer
      return true
    }
    return false
  }
  /** A draft-14 subgroup stream with one object holding `payload`. */
  const subgroup = (payload: string) => {
    const p = enc.encode(payload)
    return new Uint8Array([0x10, 0x01, 0x00, 0x00, 0x80, 0x00, p.length, ...p])
  }
  const stream = (
    streamId: number,
    byteCount: number,
    extra: Record<string, unknown> = {},
  ) => ({
    streamId,
    byteCount,
    closed: true,
    direction: 'tx',
    firstDataAt: 1010,
    lastDataAt: 1020,
    arrivals: [],
    ...extra,
  })

  it('leaves out the control stream and a request stream, keeping their messages and a media stream', async () => {
    // The control stream as captured: a CLIENT_SETUP whose token is in clear.
    const setupBytes = enc.encode(`CLIENT_SETUP ${SECRET}`)
    // A request stream the panel never marked, whose SUBSCRIBE happens to
    // read as subgroup framing; only its message's stream id names it.
    const requestBytes = subgroup(`SUBSCRIBE ${SECRET}`)
    const mediaBytes = subgroup('media')
    const data = new Map<number, Uint8Array>([
      [0, setupBytes],
      [4, requestBytes],
      [6, mediaBytes],
    ])
    const trace = await buildTrace(
      session({
        messages: [
          {
            messageType: 'client_setup',
            direction: 'tx',
            timestamp: 1005,
            decoded: {},
            raw: new Uint8Array(),
          },
          {
            messageType: 'subscribe',
            direction: 'tx',
            timestamp: 1011,
            decoded: {},
            raw: new Uint8Array(),
            streamId: 4,
          },
        ],
        streams: [
          stream(0, setupBytes.length, {
            isControl: true,
            controlRole: 'control',
          }),
          stream(4, requestBytes.length),
          stream(6, mediaBytes.length),
        ],
      }),
      async (_s, id) => data.get(id) ?? null,
    )

    const objectStreams = trace.events
      .filter((e) => e.type === 'object-payload' || e.type === 'object-header')
      .map((e) => (e as { streamId: bigint }).streamId)
    expect(new Set(objectStreams)).toEqual(new Set([6n]))
    expect(trace.events.filter((e) => e.type === 'control')).toHaveLength(2)
    expect(contains(writeMoqtrace(trace), SECRET)).toBe(false)
    expect(contains(writeMoqtrace(trace), 'media')).toBe(true)
  })
})

describe('the exported trace carries what the stream header and object said', () => {
  function stream(
    streamId: number,
    bytes: Uint8Array,
    extra: Record<string, unknown> = {},
  ) {
    return {
      streamId,
      byteCount: bytes.length,
      closed: true,
      direction: 'rx',
      firstDataAt: 1010,
      lastDataAt: 1020,
      arrivals: [],
      ...extra,
    }
  }

  it('names the track alias and subgroup of a subgroup stream', async () => {
    // draft-22 SUBGROUP_HEADER type 0x14 (explicit Subgroup ID): alias 7,
    // group 3, subgroup 2, priority 0x80, then object 0 with 2 payload bytes.
    const bytes = new Uint8Array([
      0x14, 0x07, 0x03, 0x02, 0x80, 0x00, 0x02, 0xde, 0xad,
    ])
    const trace = await buildTrace(
      session({ draft: '22', streams: [stream(1, bytes)] }),
      async () => bytes,
    )
    const opened = trace.events.find((e) => e.type === 'stream-opened')
    expect(opened).toMatchObject({ trackAlias: 7n, subgroupId: 2n })
    expect(opened).not.toHaveProperty('fetchRequestId')
  })

  it("carries each data stream's header bytes, from the type through the last field", async () => {
    const sub = new Uint8Array([
      0x14, 0x07, 0x03, 0x02, 0x80, 0x00, 0x02, 0xde, 0xad,
    ])
    const fetch = new Uint8Array([
      0x05, 0x09, 0x1c, 0x04, 0x00, 0x0a, 0x01, 0xff,
    ])
    const data = new Map([
      [1, sub],
      [5, fetch],
    ])
    const trace = await buildTrace(
      session({
        draft: '22',
        streams: [stream(1, sub), stream(5, fetch, { fetchRequestId: 9 })],
      }),
      async (_s, id) => data.get(id) ?? null,
    )
    const hdr = (id: bigint) => {
      const e = trace.events.find((e) => e.type === 'stream-opened' && e.streamId === id)
      return e?.type === 'stream-opened' ? Array.from(e.headerRaw ?? []) : null
    }
    expect(hdr(1n)).toEqual([0x14, 0x07, 0x03, 0x02, 0x80])
    expect(hdr(5n)).toEqual([0x05, 0x09])
  })

  it('carries no header bytes for a stream that does not frame', async () => {
    const bytes = new Uint8Array([0xff, 0xff, 0xff, 0xff])
    const trace = await buildTrace(
      session({ draft: '22', streams: [stream(1, bytes)] }),
      async () => bytes,
    )
    const opened = trace.events.find((e) => e.type === 'stream-opened')
    expect(opened).toBeDefined()
    expect(opened).not.toHaveProperty('headerRaw')
  })

  it('takes the alias from the stored bytes over the one the capture read', async () => {
    const bytes = new Uint8Array([
      0x14, 0x07, 0x03, 0x02, 0x80, 0x00, 0x02, 0xde, 0xad,
    ])
    const trace = await buildTrace(
      session({
        draft: '22',
        streams: [stream(1, bytes, { trackAlias: 1042940161 })],
      }),
      async () => bytes,
    )
    const opened = trace.events.find((e) => e.type === 'stream-opened')
    expect(opened).toMatchObject({ trackAlias: 7n })
  })

  it('names the request of a fetch stream, and no alias', async () => {
    // draft-22 FETCH_HEADER: type 0x05, request id 9, then one object with
    // flags 0x1c (group, object, priority), group 4, object 0, priority 10,
    // and 1 payload byte.
    const bytes = new Uint8Array([
      0x05, 0x09, 0x1c, 0x04, 0x00, 0x0a, 0x01, 0xff,
    ])
    const trace = await buildTrace(
      session({
        draft: '22',
        streams: [stream(5, bytes, { fetchRequestId: 9 })],
      }),
      async () => bytes,
    )
    const opened = trace.events.find((e) => e.type === 'stream-opened')
    expect(opened).toMatchObject({ streamType: 2, fetchRequestId: 9n })
    expect(opened).not.toHaveProperty('trackAlias')
  })

  it("keeps each object's property block byte for byte, and an empty one as empty", async () => {
    // draft-22 SUBGROUP_HEADER type 0x11 (PROPERTIES): alias 1, group 0,
    // priority 0x80. Object 0 carries the block 3c02 (Prior Group ID Gap = 2);
    // object 1 (delta 0) carries an empty block.
    const bytes = new Uint8Array([
      0x11, 0x01, 0x00, 0x80, 0x00, 0x02, 0x3c, 0x02, 0x01, 0xaa, 0x00, 0x00,
      0x01, 0xbb,
    ])
    const trace = await buildTrace(
      session({ draft: '22', streams: [stream(1, bytes)] }),
      async () => bytes,
    )
    const headers = trace.events.filter((e) => e.type === 'object-header')
    expect(
      headers.map(
        (h) => h.type === 'object-header' && Array.from(h.properties ?? []),
      ),
    ).toEqual([[0x3c, 0x02], []])
  })

  it('leaves the block off an object whose stream has no properties field', async () => {
    const bytes = new Uint8Array([
      0x10, 0x01, 0x00, 0x80, 0x00, 0x02, 0xde, 0xad,
    ])
    const trace = await buildTrace(
      session({ draft: '22', streams: [stream(1, bytes)] }),
      async () => bytes,
    )
    const header = trace.events.find((e) => e.type === 'object-header')
    expect(header).toBeDefined()
    expect(header).not.toHaveProperty('properties')
  })
})

describe('a stream that ends inside an object', () => {
  const enc = new TextEncoder()
  const CATALOG = JSON.stringify({
    version: 1,
    tracks: [{ name: 'v', packaging: 'loc', trackBaseKey: 'SECRETKEY' }],
  })
  /** A draft-22 subgroup stream on alias 5 holding `payloads`, objects 0.. */
  const subgroup = (payloads: string[]) =>
    encodeSubgroupStream({
      type: 'subgroup',
      headerType: 0x10,
      trackAlias: 5n,
      groupId: 0n,
      subgroupId: 0n,
      publisherPriority: 0,
      objects: payloads.map((text, i) => {
        const payload = enc.encode(text)
        return {
          type: 'object',
          byteOffset: 0,
          payloadByteOffset: 0,
          objectId: BigInt(i),
          payloadLength: payload.length,
          payload,
          extensionData: new Uint8Array(0),
        }
      }),
    } as AnySession)

  it('exports the objects before the cut as objects, not the stream as a datagram', async () => {
    const whole = subgroup([CATALOG, CATALOG])
    const cut = whole.subarray(0, whole.length - 5)
    const trace = await buildTrace(
      session({
        draft: '22',
        streams: [
          {
            streamId: 3,
            byteCount: cut.length,
            closed: true,
            direction: 'rx',
            trackAlias: 5,
            firstDataAt: 1010,
            lastDataAt: 1020,
            arrivals: [],
          },
        ],
      }),
      async () => cut,
    )
    const payloads = trace.events.filter((e) => e.type === 'object-payload')
    expect(payloads).toHaveLength(1)
    expect(
      new TextDecoder().decode(
        (payloads[0] as { payload: Uint8Array }).payload,
      ),
    ).toBe(CATALOG)
    expect(trace.events.find((e) => e.type === 'stream-opened')).toMatchObject({
      streamType: 0,
      trackAlias: 5n,
    })

    // Shared with payloads, the catalog's key is redacted, auth on or off.
    for (const auth of [false, true]) {
      const shared = writeMoqtrace(
        await redactTrace(trace, { payloads: true, auth }, '22'),
      )
      expect(new TextDecoder('latin1').decode(shared)).not.toContain(
        'SECRETKEY',
      )
    }
  })
})

describe('a control message that did not decode', () => {
  const bytes = new Uint8Array([0x03, 0x00, 0x02, 0x24, 0x01])
  const marker = {
    messageType: 'decode_error',
    direction: 'tx',
    timestamp: 1484,
    streamId: 21,
    decoded: {
      code: 'INVALID_PARAMETER',
      reason: 'Unknown Message Parameter type 0x24',
      length: bytes.length,
    },
    raw: bytes,
  }

  it('is an error event with its stream and bytes', async () => {
    const trace = await buildTrace(session({ messages: [marker] }), noData)
    const error = trace.events.find((e) => e.type === 'error')
    expect(error).toMatchObject({
      errorCode: 0,
      errorKind: 'decode',
      reason: 'INVALID_PARAMETER: Unknown Message Parameter type 0x24',
      streamId: 21n,
      rawLength: 5,
    })
    expect(Array.from((error as { raw: Uint8Array }).raw)).toEqual(
      Array.from(bytes),
    )
  })

  it('keeps at most 4 KB of the bytes', async () => {
    const big = new Uint8Array(10000).fill(7)
    const trace = await buildTrace(
      session({ messages: [{ ...marker, raw: big, decoded: { length: 10000 } }] }),
      noData,
    )
    const error = trace.events.find((e) => e.type === 'error') as {
      raw: Uint8Array
      rawLength: number
    }
    expect(error.raw.length).toBe(4096)
    expect(error.rawLength).toBe(10000)
  })

  it('drops its bytes from a share without credentials', async () => {
    const trace = await buildTrace(session({ messages: [marker] }), noData)
    const shared = await redactTrace(
      trace,
      { payloads: false, auth: false },
      '14',
    )
    const error = shared.events.find((e) => e.type === 'error')
    expect(error).toMatchObject({ streamId: 21n })
    expect(error).not.toHaveProperty('raw')
  })
})
