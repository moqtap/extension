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

  it('an object-payload with only its size makes headers+sizes', () => {
    const sizeOnly = { ...payload, payload: undefined } as TraceEvent
    const all = [ctl, opened, sizeOnly]
    expect(fitDetail(all)).toEqual({ detail: 'headers+sizes', events: all })
  })

  it('control messages and errors stay at control', () => {
    const err = { type: 'error', seq: 1, timestamp: 1, errorCode: 1, reason: 'x' } as TraceEvent
    expect(fitDetail([ctl, err])).toEqual({ detail: 'control', events: [ctl, err] })
  })

  const withRaw = (e: TraceEvent, raw: number[]) => ({ ...e, raw: new Uint8Array(raw) }) as TraceEvent
  const dataErr = {
    type: 'error',
    seq: 2,
    timestamp: 2,
    errorCode: 0,
    reason: 'x',
    errorKind: 'decode',
    streamId: 4n,
    rawLength: 1,
    raw: new Uint8Array([0xff]),
  } as TraceEvent
  const strip = (e: TraceEvent, ...keys: string[]) => {
    const out = { ...e } as Record<string, unknown>
    for (const k of keys) delete out[k]
    return out as unknown as TraceEvent
  }

  it('is full with payloads, raw on every control message and the bytes behind each error', () => {
    const all = [withRaw(ctl, [0x20]), opened, header, payload, dataErr, closed]
    expect(fitDetail(all)).toEqual({ detail: 'full', events: all })
  })

  it("counts an error's data stream bytes as recorded stream bytes", () => {
    const all = [withRaw(ctl, [0x20]), opened, dataErr, closed]
    expect(fitDetail(all, (e) => e === dataErr)).toEqual({ detail: 'full', events: all })
  })

  it('without raw on every control message, drops every raw and keeps rawlen at headers+data', () => {
    const all = [withRaw(ctl, [0x20]), ctl, opened, header, payload, dataErr, closed]
    expect(fitDetail(all)).toEqual({
      detail: 'headers+data',
      events: [ctl, ctl, opened, header, payload, strip(dataErr, 'raw'), closed],
    })
  })

  it('without payloads, drops every raw, and below headers+sizes every rawlen', () => {
    const all = [withRaw(ctl, [0x20]), opened, header, dataErr, closed]
    expect(fitDetail(all)).toEqual({
      detail: 'headers',
      events: [ctl, opened, header, strip(dataErr, 'raw', 'rawLength'), closed],
    })
    expect(fitDetail([withRaw(ctl, [0x20]), dataErr])).toEqual({
      detail: 'control',
      events: [ctl, strip(dataErr, 'raw', 'rawLength')],
    })
  })

  it('is not full when a flow whose error had bytes carries none', () => {
    const later = { ...strip(dataErr, 'raw'), seq: 6 } as TraceEvent
    const other = { ...later, streamId: 8n } as TraceEvent
    const base = [withRaw(ctl, [0x20]), opened, header, payload, dataErr]
    expect(fitDetail([...base, later]).detail).toBe('full')
    expect(fitDetail([...base, later, other]).detail).toBe('headers+data')
  })

  it('is not full when the caller says bytes were dropped', () => {
    const all = [withRaw(ctl, [0x20]), opened, header, payload]
    expect(fitDetail(all, undefined, { full: false })).toEqual({
      detail: 'headers+data',
      events: [ctl, opened, header, payload],
    })
  })
})
