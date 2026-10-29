import { describe, expect, it } from 'vitest'
import { trackNameParts, trackViewLabel } from './track-view'

describe('trackViewLabel', () => {
  it('says which tracks show', () => {
    expect(trackViewLabel({ activeOnly: false, direction: 'all', grouped: false })).toBe('All tracks')
    expect(trackViewLabel({ activeOnly: true, direction: 'all', grouped: false })).toBe('Active tracks')
    expect(trackViewLabel({ activeOnly: false, direction: 'tx', grouped: false })).toBe('Outgoing tracks')
    expect(trackViewLabel({ activeOnly: true, direction: 'rx', grouped: false })).toBe('Active incoming tracks')
  })

  it('adds the grouping', () => {
    expect(trackViewLabel({ activeOnly: false, direction: 'all', grouped: true })).toBe('All tracks by namespace')
  })
})

describe('trackNameParts', () => {
  const t = { trackNamespace: ['moqtail', 'ch07_all'], trackName: 'video_1080p' }
  it('puts the namespace apart from the name, so the namespace gives way first', () => {
    expect(trackNameParts(t, false)).toEqual({ namespace: 'moqtail/ch07_all / ', name: 'video_1080p' })
  })
  it('carries the name alone under a namespace group, or with no namespace', () => {
    expect(trackNameParts(t, true)).toEqual({ namespace: null, name: 'video_1080p' })
    expect(trackNameParts({ trackNamespace: [], trackName: 'x' }, false)).toEqual({ namespace: null, name: 'x' })
  })
})
