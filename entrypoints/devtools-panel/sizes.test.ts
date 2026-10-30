import { describe, expect, it } from 'vitest'
import { sessionBytes, streamBytes } from './sizes'

describe('streamBytes', () => {
  it('is what the stream holds, else what its trace records', () => {
    expect(streamBytes({ byteCount: 1200 })).toBe(1200)
    expect(streamBytes({ byteCount: 0, recordedBytes: 900 })).toBe(900)
    expect(streamBytes({ byteCount: 0 })).toBe(0)
  })
  it('is unknown when the trace records objects without sizes', () => {
    expect(streamBytes({ byteCount: 0, sizeUnknown: true })).toBeNull()
  })
})

describe('sessionBytes', () => {
  const streams = new Map([
    [1, { byteCount: 1000 }],
    [2, { byteCount: 0, recordedBytes: 300 }],
  ])
  const datagramGroups = new Map([['0:1', { byteCount: 50 }]])

  it('adds streams, datagram groups and the sizes no stream holds', () => {
    expect(sessionBytes({ streams, datagramGroups, recordedBytes: 300 })).toBe(1350)
    expect(sessionBytes({ streams: new Map(), datagramGroups: new Map() })).toBe(0)
  })
  it('is unknown for a trace that records no sizes', () => {
    expect(sessionBytes({ streams, datagramGroups, sizeUnknown: true })).toBeNull()
  })
})
