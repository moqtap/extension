import { readMoqtrace, type Trace, type TraceEvent, writeMoqtrace } from '@moqtap/trace'
import { describe, expect, it } from 'vitest'
import { EXPORT_CHOICES, exportedTrace } from './export-trace'

const bytes = (...b: number[]) => new Uint8Array(b)

function trace(withObjects = true): Trace {
  const events: TraceEvent[] = [
    {
      type: 'control',
      seq: 0,
      timestamp: 0,
      direction: 0,
      messageType: 3,
      message: { request_id: 0n, token_value: 'abcd' },
      streamId: 0n,
      raw: bytes(3, 0, 1, 0),
    },
    ...(withObjects
      ? ([
          { type: 'stream-opened', seq: 1, timestamp: 1, streamId: 2n, direction: 1, streamType: 0 },
          {
            type: 'object-header',
            seq: 2,
            timestamp: 2,
            streamId: 2n,
            groupId: 0n,
            objectId: 0n,
            publisherPriority: 0,
            objectStatus: 0,
          },
          {
            type: 'object-payload',
            seq: 3,
            timestamp: 2,
            streamId: 2n,
            groupId: 0n,
            objectId: 0n,
            size: 2,
            payload: bytes(1, 2),
          },
        ] as TraceEvent[])
      : []),
    {
      type: 'error',
      seq: 4,
      timestamp: 3,
      errorCode: 0,
      reason: 'X: y',
      errorKind: 'decode',
      streamId: 2n,
      rawLength: 1,
      raw: bytes(9),
    },
  ]
  return {
    header: {
      protocol: 'moq-transport-22',
      perspective: 'observer',
      detail: 'full',
      startTime: 1000,
      endpoint: 'https://relay.example/moq?token=secret',
    },
    events: events.map((e, seq) => ({ ...e, seq }) as TraceEvent),
  }
}

describe('the Export menu', () => {
  it('offers without payloads first, as the default', () => {
    expect(EXPORT_CHOICES.map((c) => c.payloads)).toEqual([false, true])
  })
})

describe('an export with payloads', () => {
  it('is the trace as built', async () => {
    const t = trace()
    expect(await exportedTrace(t, true, '22', new Set())).toBe(t)
  })
})

describe('an export without payloads', () => {
  it('has no payload-bearing event or field, and declares headers', async () => {
    const out = await exportedTrace(trace(), false, '22', new Set([0n]))
    expect(out.header.detail).toBe('headers')
    expect(out.events.map((e) => e.type)).toEqual([
      'control',
      'stream-opened',
      'object-header',
      'error',
    ])
    expect(out.events.map((e) => e.seq)).toEqual([0, 1, 2, 3])
    for (const e of out.events) {
      expect(e).not.toHaveProperty('raw')
      expect(e).not.toHaveProperty('payload')
    }
    // `"rawlen"` is gated at headers+sizes.
    expect(out.events[3]).not.toHaveProperty('rawLength')
    // It reads back at the level it declares.
    expect(readMoqtrace(writeMoqtrace(out)).header.detail).toBe('headers')
  })

  it('keeps auth as the export with payloads does', async () => {
    const out = await exportedTrace(trace(), false, '22', new Set([0n]))
    expect(out.header.endpoint).toBe('https://relay.example/moq?token=secret')
    expect((out.events[0] as { message: unknown }).message).toEqual({
      request_id: 0n,
      token_value: 'abcd',
    })
  })

  it('declares control, with no stream events, when no object is left', async () => {
    const out = await exportedTrace(trace(false), false, '22', new Set([0n]))
    expect(out.header.detail).toBe('control')
    expect(out.events.map((e) => e.type)).toEqual(['control', 'error'])
  })
})
