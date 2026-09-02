import { describe, expect, it } from 'vitest'
import {
  type ByteArrival,
  MAX_ARRIVALS,
  arrivalAt,
  recordArrival,
} from './arrivals'

/** Append a run of `bytes` at time `at`, tracking the cumulative offset. */
function build(chunks: Array<[bytes: number, at: number]>): ByteArrival[] {
  const arrivals: ByteArrival[] = []
  let total = 0
  for (const [bytes, at] of chunks) {
    total += bytes
    recordArrival(arrivals, total, at)
  }
  return arrivals
}

describe('recordArrival', () => {
  it('records one entry per chunk', () => {
    expect(
      build([
        [10, 1000],
        [10, 1001],
        [10, 1002],
      ]),
    ).toEqual([
      { end: 10, at: 1000 },
      { end: 20, at: 1001 },
      { end: 30, at: 1002 },
    ])
  })

  it('coalesces chunks sharing a millisecond', () => {
    // Three chunks at the same instant are one run — the index cannot tell
    // them apart in time, so it should not pretend to.
    expect(
      build([
        [10, 1000],
        [10, 1000],
        [10, 1000],
        [5, 1001],
      ]),
    ).toEqual([
      { end: 30, at: 1000 },
      { end: 35, at: 1001 },
    ])
  })

  it('halves rather than truncates once past the cap', () => {
    const arrivals = build(
      Array.from(
        { length: MAX_ARRIVALS + 1 },
        (_, i) => [1, 1000 + i] as [number, number],
      ),
    )

    expect(arrivals.length).toBe(Math.ceil((MAX_ARRIVALS + 1) / 2))
    // The most recent data survives — the point of halving over truncating.
    expect(arrivals[arrivals.length - 1]).toEqual({
      end: MAX_ARRIVALS + 1,
      at: 1000 + MAX_ARRIVALS,
    })
    // Offsets stay ascending, so the binary search stays valid.
    for (let i = 1; i < arrivals.length; i++) {
      expect(arrivals[i].end).toBeGreaterThan(arrivals[i - 1].end)
      expect(arrivals[i].at).toBeGreaterThan(arrivals[i - 1].at)
    }
  })

  it('stays bounded across repeated halving', () => {
    const arrivals = build(
      Array.from(
        { length: MAX_ARRIVALS * 8 },
        (_, i) => [1, 1000 + i] as [number, number],
      ),
    )
    expect(arrivals.length).toBeLessThanOrEqual(MAX_ARRIVALS)
  })
})

describe('arrivalAt', () => {
  const arrivals = build([
    [10, 1000],
    [10, 1500],
    [10, 2000],
  ])

  it('resolves an offset to the run containing it', () => {
    expect(arrivalAt(arrivals, 0)).toBe(1000)
    expect(arrivalAt(arrivals, 9)).toBe(1000)
    expect(arrivalAt(arrivals, 10)).toBe(1500)
    expect(arrivalAt(arrivals, 19)).toBe(1500)
    expect(arrivalAt(arrivals, 20)).toBe(2000)
    expect(arrivalAt(arrivals, 29)).toBe(2000)
  })

  it('clamps an offset past the last byte to the final run', () => {
    // Nothing arrived after the last chunk, so that is the latest time any
    // byte is known to have landed.
    expect(arrivalAt(arrivals, 1_000_000)).toBe(2000)
  })

  it('returns undefined without an index', () => {
    // Imported traces and IDB-replayed state never saw the chunks arrive.
    expect(arrivalAt(undefined, 0)).toBeUndefined()
    expect(arrivalAt([], 0)).toBeUndefined()
  })

  it('agrees with a linear scan across a large index', () => {
    const many = build(
      Array.from({ length: 500 }, (_, i) => [3, 1000 + i] as [number, number]),
    )
    for (let offset = 0; offset < 1500; offset += 7) {
      const expected = many.find((a) => a.end > offset)?.at
      expect(arrivalAt(many, offset)).toBe(expected)
    }
  })

  it('errs late rather than early after halving', () => {
    // A dropped run's bytes are absorbed by the run after it, so a resolved
    // time is never earlier than when the byte really arrived.
    const exact = build(
      Array.from(
        { length: MAX_ARRIVALS * 4 },
        (_, i) => [1, 1000 + i] as [number, number],
      ),
    )
    for (let offset = 0; offset < MAX_ARRIVALS * 4; offset += 13) {
      const trueArrival = 1000 + offset
      expect(arrivalAt(exact, offset)!).toBeGreaterThanOrEqual(trueArrival)
    }
  })
})
