/**
 * A trace's `detail` and its events must agree (moqtrace SPEC.md, "Detail
 * Levels"): `control` holds no data stream events. The moqtap server checks
 * exactly this on upload and answers 415 `level_mismatch` otherwise.
 */

import type { TraceEvent } from '@moqtap/trace'
import { describe, expect, it } from 'vitest'
import { fitDetail } from './detail'

const ctl = { type: 'control', seq: 0, timestamp: 0, direction: 0, messageType: 0x20, message: {} } as TraceEvent
const opened = { type: 'stream-opened', seq: 1, timestamp: 1, streamId: 0n, direction: 0, streamType: 0 } as TraceEvent
const closed = { type: 'stream-closed', seq: 4, timestamp: 4, streamId: 0n, errorCode: 0 } as TraceEvent
const header = {
  type: 'object-header',
  seq: 2,
  timestamp: 2,
  streamId: 0n,
  groupId: 0n,
  objectId: 0n,
  publisherPriority: 0,
  objectStatus: 0,
} as TraceEvent
const payload = {
  type: 'object-payload',
  seq: 3,
  timestamp: 2,
  streamId: 0n,
  groupId: 0n,
  objectId: 0n,
  size: 1,
  payload: new Uint8Array([1]),
} as TraceEvent
const types = (events: readonly TraceEvent[]) => events.map((e) => e.type)

describe('fitDetail', () => {
  it('payload bytes make headers+data and keep every event', () => {
    const all = [ctl, opened, header, payload, closed]
    expect(fitDetail(all)).toEqual({ detail: 'headers+data', events: all })
  })

  it('a stream with only raw bytes (no framing, no object header) is still headers+data', () => {
    const all = [ctl, opened, payload]
    expect(fitDetail(all).detail).toBe('headers+data')
  })

  it('object headers without payloads make headers and keep the stream events', () => {
    const all = [ctl, opened, header, closed]
    expect(fitDetail(all)).toEqual({ detail: 'headers', events: all })
  })

  it('with no object left, control drops the stream events it does not admit', () => {
    const out = fitDetail([ctl, opened, closed])
    expect(out.detail).toBe('control')
    expect(types(out.events)).toEqual(['control'])
  })

  it('an object-payload with no bytes is not an object at control either', () => {
    const sizeOnly = { ...payload, payload: undefined } as TraceEvent
    expect(types(fitDetail([ctl, opened, sizeOnly]).events)).toEqual(['control'])
  })

  it('control messages and errors stay at control', () => {
    const err = { type: 'error', seq: 1, timestamp: 1, errorCode: 1, reason: 'x' } as TraceEvent
    expect(fitDetail([ctl, err])).toEqual({ detail: 'control', events: [ctl, err] })
  })
})
