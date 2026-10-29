import { describe, expect, it } from 'vitest'
import type { TabImpairment } from '@/src/cli/messages'
import type { Profiles } from '@/src/cli/protocol'
import {
  cliHeader,
  impairmentButtonLabel,
  impairsSession,
  DEFAULT_FOLDER,
  holds,
  type MenuNode,
  menuTree,
  profileChoices,
  profileShortLabel,
  scenarioLabels,
  sessionProfile,
} from './impair-choices'

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

describe('impairsSession', () => {
  it('colours the gauge only for a known profile that impairs', () => {
    expect(impairsSession(sessionProfile(tab(), S1))).toBe(true)
    expect(impairsSession(sessionProfile(tab({ profile: { preset: 'none' }, name: 'Off' }), S1))).toBe(false)
    expect(impairsSession(sessionProfile(tab({ unknown: [S1] }), S1))).toBe(false)
    expect(impairsSession(null)).toBe(false)
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

describe('impairment menu', () => {
  const presets = [
    { name: 'Off', profile: { preset: 'none' as const } },
    { name: 'Offline', profile: { preset: 'offline' as const } },
    { name: '3G', profile: { preset: '3g' as const } },
  ]
  const own = (name: string, ...folder: string[]) => ({
    name,
    profile: { scenario: name },
    ...(folder.length > 0 ? { folder } : {}),
  })
  /** Each node as its name, a folder as [name, children]. */
  const shape = (nodes: readonly MenuNode[]): unknown[] =>
    nodes.map((n) => (n.kind === 'item' ? n.choice.name : [n.name, shape(n.children)]))

  it("keeps the presets at the top level while there are no scenarios of one's own", () => {
    expect(menuTree(presets).map(shape)).toEqual([['Off', 'Offline', '3G']])
    expect(menuTree([])).toEqual([])
  })

  it("moves the presets under Default once there are, Off staying on top", () => {
    expect(menuTree([...presets, own('lossy')]).map(shape)).toEqual([
      ['Off'],
      ['lossy'],
      [[DEFAULT_FOLDER, ['Offline', '3G']]],
    ])
  })

  it('nests scenarios by folder, folders first and by name, two levels deep', () => {
    const choices = [
      ...presets,
      own('top'),
      own('roaming', 'Mobile', 'Europe'),
      own('lte', 'Mobile'),
      own('fibre', 'Home'),
      own('hotel', 'Mobile', 'Europe'),
    ]
    expect(menuTree(choices).map(shape)).toEqual([
      ['Off'],
      [['Home', ['fibre']], ['Mobile', [['Europe', ['roaming', 'hotel']], 'lte']], 'top'],
      [[DEFAULT_FOLDER, ['Offline', '3G']]],
    ])
  })

  it('tells which submenu holds the current profile', () => {
    const [, mine] = menuTree([...presets, own('roaming', 'Mobile', 'Europe'), own('top')])
    expect(holds(mine[0], { scenario: 'roaming' })).toBe(true)
    expect(holds(mine[0], { scenario: 'top' })).toBe(false)
  })

  it('names the CLI by version and the first two groups of its identity', () => {
    const found = { identity: 'i', fingerprint: '21FE-31DF-A154-A261-626B', port: 47310, cliVersion: '0.9.0' }
    expect(cliHeader({ state: 'connected', ...found })).toBe('moqtap CLI 0.9.0 · 21FE-31DF')
    expect(cliHeader({ state: 'confirm', ...found })).toBe('moqtap CLI 0.9.0 · 21FE-31DF')
    expect(cliHeader({ state: 'absent' })).toBe("moqtap CLI isn't running")
    expect(cliHeader(null)).toBe("moqtap CLI isn't running")
    expect(cliHeader({ state: 'unsupported' })).toBe('This browser cannot verify the moqtap CLI')
  })

  it('labels the toolbar button with the tab profile', () => {
    expect(impairmentButtonLabel(null)).toBe('No impairment')
    expect(impairmentButtonLabel(tab({ profile: { preset: 'none' }, name: 'Off' }))).toBe('No impairment')
    expect(impairmentButtonLabel(tab())).toBe('3G')
  })
})

describe('profileShortLabel', () => {
  const none = new Map<string, string>()

  it('gives presets their short name', () => {
    expect(profileShortLabel({ preset: '3g' }, none)).toBe('3G')
    expect(profileShortLabel({ preset: '4g' }, none)).toBe('4G')
    expect(profileShortLabel({ preset: 'offline' }, none)).toBe('Offline')
    expect(profileShortLabel({ preset: 'none' }, none)).toBeNull()
    expect(profileShortLabel(null, none)).toBeNull()
  })

  it("gives a scenario its file's short label, and none without one", () => {
    const labels = scenarioLabels({
      account: { signedIn: true, org: null, plan: null, error: null },
      profiles: [
        { name: '3G', profile: { preset: '3g' } },
        { name: 'lte', profile: { scenario: 'lte' }, shortLabel: 'LTE' },
        { name: 'stall-every-10s', profile: { scenario: 'stall-every-10s' } },
      ],
      more: false,
    })
    expect([...labels]).toEqual([['lte', 'LTE']])
    expect(profileShortLabel({ scenario: 'lte' }, labels)).toBe('LTE')
    expect(profileShortLabel({ scenario: 'stall-every-10s' }, labels)).toBeNull()
  })
})
