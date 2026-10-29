import { describe, expect, it } from 'vitest'
import { FIRST_TAB, filters, isSessionTab, shownTab, tabList } from './session-tabs'

describe('session tabs', () => {
  it('opens on Streams the first time', () => {
    expect(FIRST_TAB).toBe('streams')
  })

  it('lists Tracks only for MoQT, Problems with its count, Details last without one', () => {
    expect(tabList({ messages: 10, streams: 477, tracks: 3, problems: 16 })).toEqual([
      { id: 'messages', label: 'Messages', count: 10 },
      { id: 'streams', label: 'Streams', count: 477 },
      { id: 'tracks', label: 'Tracks', count: 3 },
      { id: 'problems', label: 'Problems', count: 16 },
      { id: 'details', label: 'Details', count: null },
    ])
    expect(tabList({ messages: 0, streams: 2, tracks: null, problems: 0 }).map((t) => t.id)).toEqual([
      'messages',
      'streams',
      'problems',
      'details',
    ])
  })

  it('shows Streams when the remembered Tracks tab does not apply', () => {
    expect(shownTab('tracks', false)).toBe('streams')
    expect(shownTab('tracks', true)).toBe('tracks')
    expect(shownTab('problems', false)).toBe('problems')
  })

  it('filters every view but Details', () => {
    expect(filters('streams')).toBe(true)
    expect(filters('details')).toBe(false)
  })

  it('accepts only known tabs from storage', () => {
    expect(isSessionTab('problems')).toBe(true)
    expect(isSessionTab('sidebar')).toBe(false)
    expect(isSessionTab(undefined)).toBe(false)
  })
})
