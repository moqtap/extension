import { describe, expect, it } from 'vitest'
import { menuKey } from './menu-keys'

const at = (index: number, extra: { onTrigger?: boolean; nested?: boolean } = {}) => ({
  index,
  count: 4,
  onTrigger: false,
  nested: false,
  ...extra,
})

describe('menuKey', () => {
  it('moves with the arrows, wrapping, and jumps with Home and End', () => {
    expect(menuKey('ArrowDown', at(3))).toEqual({ kind: 'focus', index: 0 })
    expect(menuKey('ArrowDown', at(-1))).toEqual({ kind: 'focus', index: 0 })
    expect(menuKey('ArrowUp', at(0))).toEqual({ kind: 'focus', index: 3 })
    expect(menuKey('ArrowUp', at(-1))).toEqual({ kind: 'focus', index: 3 })
    expect(menuKey('Home', at(2))).toEqual({ kind: 'focus', index: 0 })
    expect(menuKey('End', at(0))).toEqual({ kind: 'focus', index: 3 })
    expect(menuKey('ArrowDown', { ...at(-1), count: 0 })).toBeNull()
  })

  it('opens a submenu with ArrowRight, Enter or Space on its item only', () => {
    for (const key of ['ArrowRight', 'Enter', ' ']) {
      expect(menuKey(key, at(1, { onTrigger: true }))).toEqual({ kind: 'open-sub' })
      expect(menuKey(key, at(1))).toBeNull()
    }
  })

  it('closes a submenu back to its item with ArrowLeft or Escape', () => {
    expect(menuKey('ArrowLeft', at(0, { nested: true }))).toEqual({ kind: 'close-sub' })
    expect(menuKey('Escape', at(0, { nested: true }))).toEqual({ kind: 'close-sub' })
    expect(menuKey('ArrowLeft', at(0))).toBeNull()
  })

  it('closes a top-level menu with Escape and leaves every menu with Tab', () => {
    expect(menuKey('Escape', at(0))).toEqual({ kind: 'close' })
    expect(menuKey('Tab', at(0, { nested: true }))).toEqual({ kind: 'leave' })
    expect(menuKey('a', at(0))).toBeNull()
  })
})
