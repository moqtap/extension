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

import { describe, expect, it } from 'vitest'
import { buildTrace } from './build-trace'
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
  })

  it('says "headers+data" when payloads are present', async () => {
    // A draft-14 subgroup stream: type 0x10, track alias 1, group 0,
    // subgroup 0, priority 128, then one object (id 0, length 2).
    const bytes = new Uint8Array([0x10, 0x01, 0x00, 0x00, 0x80, 0x00, 0x02, 0xde, 0xad])
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
