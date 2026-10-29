import { describe, expect, it } from 'vitest'
import type { TabImpairment } from '@/src/cli/messages'
import type { Profiles } from '@/src/cli/protocol'
import { profileChoices, sessionProfile } from './impair-choices'

const S1 = 'A'.repeat(21) + 'Q'
const S2 = 'B'.repeat(21) + 'Q'

const tab = (over: Partial<TabImpairment> = {}): TabImpairment => ({
  tabId: 3,
  profile: { preset: '3g' },
  name: '3G',
  sessions: [],
  unknown: [],
  sessionErrors: [],
  failure: null,
  error: null,
  ...over,
})

const listed: Profiles = {
  account: { signedIn: true, org: null, plan: null, error: null },
  profiles: [
    { name: 'Off', profile: { preset: 'none' } },
    { name: '3G', profile: { preset: '3g' } },
    { name: 'Lossy', profile: { scenario: 'lossy' } },
  ],
  more: false,
}

describe('sessionProfile', () => {
  it("is the tab's profile for a session without its own", () => {
    expect(sessionProfile(tab(), S1)).toEqual({ name: '3G', profile: { preset: '3g' }, own: false })
  })

  it("is the session's own profile when it has one", () => {
    const t = tab({ sessions: [{ session: S1, profile: { scenario: 'lossy' }, name: 'Lossy' }] })
    expect(sessionProfile(t, S1)).toEqual({ name: 'Lossy', profile: { scenario: 'lossy' }, own: true })
    expect(sessionProfile(t, S2)).toEqual({ name: '3G', profile: { preset: '3g' }, own: false })
  })

  it('follows the tab once its session profiles are cleared', () => {
    const before = tab({ sessions: [{ session: S1, profile: { preset: 'none' }, name: 'Off' }] })
    expect(sessionProfile(before, S1).name).toBe('Off')
    expect(sessionProfile(tab({ profile: { preset: '4g' }, name: '4G' }), S1)).toEqual({
      name: '4G',
      profile: { preset: '4g' },
      own: false,
    })
  })

  it('has no name for a session the CLI lists with a profile nobody picked', () => {
    expect(sessionProfile(tab({ unknown: [S1] }), S1)).toEqual({ name: null, profile: null, own: true })
    expect(sessionProfile(tab({ unknown: [S1] }), S2).name).toBe('3G')
  })

  it('is Off before the tab is known', () => {
    expect(sessionProfile(null, S1)).toEqual({ name: 'Off', profile: { preset: 'none' }, own: false })
  })
})

describe('profileChoices', () => {
  it('lists what the CLI offers, scenarios included', () => {
    expect(profileChoices(listed, null).map((c) => c.name)).toEqual(['Off', '3G', 'Lossy'])
  })

  it('offers Off while the list is read', () => {
    expect(profileChoices(undefined, null)).toEqual([{ name: 'Off', profile: { preset: 'none' } }])
  })

  it('keeps the current profile when the CLI no longer lists it', () => {
    const current = { name: 'Old', profile: { scenario: 'old' } }
    expect(profileChoices(listed, current).map((c) => c.name)).toEqual(['Off', '3G', 'Lossy', 'Old'])
    expect(profileChoices(listed, { name: '3G', profile: { preset: '3g' } })).toHaveLength(3)
  })
})
