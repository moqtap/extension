import { describe, expect, it } from 'vitest'
import { readTimelineObject, type TimelineState } from './timelines'

function mediaState(timelineDraft: TimelineState['timelineDraft']): TimelineState {
  return {
    key: 'live\u0000timeline',
    kind: 'media',
    via: 'catalog',
    draft: null,
    timelineDraft,
    timelineSection: 'MSF-01 7.1.1',
    namespace: 'live',
    depends: [],
    eventType: null,
    objectCount: 0,
  }
}

const OBJECT = new TextEncoder().encode('{}')

describe('a media timeline object that is not an array', () => {
  it('is an error under MSF-00', () => {
    const view = readTimelineObject(OBJECT, mediaState('msf-00'))
    expect(view).toMatchObject({
      kind: 'invalid',
      problems: [{ severity: 'error', category: 'invalid_value', section: 'MSF-00 7.1' }],
    })
  })

  it('is shown as bytes under MSF-01, with no problem', () => {
    const view = readTimelineObject(OBJECT, mediaState('msf-01'))
    expect(view).toEqual({ kind: 'invalid', problems: [] })
  })

  it('is shown as bytes without one draft, with no problem', () => {
    const view = readTimelineObject(OBJECT, mediaState(null))
    expect(view).toEqual({ kind: 'invalid', problems: [] })
  })
})
