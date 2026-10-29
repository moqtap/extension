import { describe, expect, it } from 'vitest'
import { clampSplit, restoredSplit, splitKeySize, splitOrientation, storedSplit } from './split'

describe('splitOrientation', () => {
  it('stacks below 600 px and sits side by side from there', () => {
    expect(splitOrientation(420)).toBe('vertical')
    expect(splitOrientation(599)).toBe('vertical')
    expect(splitOrientation(600)).toBe('horizontal')
    expect(splitOrientation(1430)).toBe('horizontal')
  })

  it('does not stack before the split has been measured', () => {
    expect(splitOrientation(0)).toBe('horizontal')
  })
})

describe('clampSplit', () => {
  it('keeps both panes at their minimum', () => {
    expect(clampSplit(50, 1000, 160, 320)).toBe(160)
    expect(clampSplit(900, 1000, 160, 320)).toBe(680)
    expect(clampSplit(400.4, 1000, 160, 320)).toBe(400)
  })

  it('shares by the minimums when both do not fit', () => {
    expect(clampSplit(400, 300, 100, 200)).toBe(100)
  })

  it('is zero in an unmeasured split', () => {
    expect(clampSplit(400, 0, 100, 200)).toBe(0)
  })
})

describe('splitKeySize', () => {
  it('moves along the divider axis only', () => {
    expect(splitKeySize('ArrowRight', 200, 'horizontal')).toBe(216)
    expect(splitKeySize('ArrowLeft', 200, 'horizontal')).toBe(184)
    expect(splitKeySize('ArrowDown', 200, 'horizontal')).toBeNull()
    expect(splitKeySize('ArrowDown', 200, 'vertical')).toBe(216)
    expect(splitKeySize('ArrowUp', 200, 'vertical')).toBe(184)
  })

  it('goes to the limits with Home and End', () => {
    expect(splitKeySize('Home', 200, 'vertical')).toBe(0)
    expect(splitKeySize('End', 200, 'vertical')).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('storedSplit', () => {
  it('stores px as px and a share as a ratio, and reads them back', () => {
    expect(storedSplit(240.6, 1000, 'px')).toBe(241)
    expect(restoredSplit(241, 500, 'px')).toBe(241)
    expect(storedSplit(400, 1000, 'ratio')).toBe(0.4)
    expect(restoredSplit(0.4, 600, 'ratio')).toBe(240)
  })
})
