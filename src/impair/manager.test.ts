import { describe, expect, it } from 'vitest'
import type { KeyValueArea } from '@/src/account/stores'
import type { SessionFailure, TabImpairment } from '@/src/cli/messages'
import type { CliTab, Profile, Refusal } from '@/src/cli/protocol'
import type { CliTarget, CreateError, SwitchResult } from '@/src/cli/service'
import { ImpairManager, LEASE_MS, PROFILES_KEY, type ImpairCli } from './manager'
import type { TabAnswerMsg } from './messages'

const CERT = 'B'.repeat(43)
const TARGET: CliTarget = { identity: 'cli-identity', port: 47310, certHash: CERT }
const G3: Profile = { preset: '3g' }
const G4: Profile = { preset: '4g' }
const OFF: Profile = { preset: 'none' }

class FakeCli implements ImpairCli {
  current: CliTarget | null = TARGET
  tabsById = new Map<string, CliTab>()
  leases: string[] = []
  deletes: string[] = []
  switches: [string, Profile][] = []
  sessionSwitches: [string, Profile | null][] = []
  sessionResult: SwitchResult | null = null
  /** Switches apply but their replies are lost. */
  lostReply = false
  createError: CreateError | null = null
  refusal: Refusal | null = null
  switchResult: SwitchResult | null = null
  probes = 0
  /** createTab waits on this while set. */
  gate: Promise<void> | null = null
  log: string[] = []
  private n = 0
  private listeners = new Set<() => void>()

  target() {
    return this.current
  }
  async probe() {
    this.probes++
  }
  onChange(fn: () => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  change(target: CliTarget | null) {
    this.current = target
    for (const fn of this.listeners) fn()
  }
  async createTab(owner: string, profile: Profile) {
    this.log.push('createTab')
    if (this.gate !== null) await this.gate
    if (this.current === null) return { error: 'unreachable' as const }
    if (this.createError === 'refused') return { error: 'refused' as const, refused: this.refusal }
    if (this.createError !== null) return { error: this.createError }
    const id = `t${++this.n}`.padEnd(22, '0')
    const port = 50000 + this.n
    this.tabsById.set(id, { id, port, owner, profile, sessions: [] })
    return { id, port, token: `k${this.n}`.padEnd(22, '0') }
  }
  async setTabProfile(id: string, profile: Profile): Promise<SwitchResult> {
    if (this.switchResult !== null) return this.switchResult
    if (this.current === null) return 'unreachable'
    const t = this.tabsById.get(id)
    if (t === undefined) return 'gone'
    this.switches.push([id, profile])
    this.tabsById.set(id, { ...t, profile, sessions: t.sessions.map((s) => ({ ...s, profile })) })
    return this.lostReply ? 'unreachable' : 'ok'
  }
  /** A session the page opened on a tab port. */
  addSession(tabId: string, id: string) {
    const t = this.tabsById.get(tabId)!
    const s = { id, upstream: 'https://relay.example/moq', profile: t.profile, connected: true }
    this.tabsById.set(tabId, { ...t, sessions: [...t.sessions, s] })
  }
  dropSession(id: string) {
    for (const [k, t] of this.tabsById) this.tabsById.set(k, { ...t, sessions: t.sessions.filter((s) => s.id !== id) })
  }
  async setSessionProfile(id: string, profile: Profile | null): Promise<SwitchResult> {
    if (this.sessionResult !== null) return this.sessionResult
    if (this.current === null) return 'unreachable'
    const t = [...this.tabsById.values()].find((t) => t.sessions.some((s) => s.id === id))
    if (t === undefined) return 'gone'
    this.sessionSwitches.push([id, profile])
    const sessions = t.sessions.map((s) => (s.id === id ? { ...s, profile: profile ?? t.profile } : s))
    this.tabsById.set(t.id, { ...t, sessions })
    return this.lostReply ? 'unreachable' : 'ok'
  }
  async deleteTab(id: string) {
    this.deletes.push(id)
    this.tabsById.delete(id)
  }
  async renewLease(owner: string) {
    if (this.current === null) return false
    this.leases.push(owner)
    return true
  }
  async tabs() {
    return this.current === null ? null : [...this.tabsById.values()]
  }
}

function memoryArea(): KeyValueArea & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    get: async (k) => structuredClone(data.get(k)),
    set: async (k, v) => void data.set(k, structuredClone(v)),
    remove: async (k) => void data.delete(k),
  }
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

function setup(
  opts: { cli?: FakeCli; store?: ReturnType<typeof memoryArea>; closed?: Set<number>; flagFails?: () => boolean } = {},
) {
  const cli = opts.cli ?? new FakeCli()
  const store = opts.store ?? memoryArea()
  const closed = opts.closed ?? new Set<number>()
  const sent: { tabId: number; frameId: number; msg: TabAnswerMsg }[] = []
  const flags: boolean[] = []
  const ticks: (() => void)[] = []
  let owners = 0
  const manager = new ImpairManager({
    cli,
    store,
    sendToFrame: (tabId, frameId, msg) => sent.push({ tabId, frameId, msg }),
    tabExists: async (tabId) => !closed.has(tabId),
    newOwner: () => `owner-${++owners}`,
    every: (ms, fn) => {
      expect(ms).toBe(LEASE_MS)
      ticks.push(fn)
      return () => ticks.splice(ticks.indexOf(fn), 1)
    },
    setFlag: async (any) => {
      if (opts.flagFails?.()) throw new Error('refused')
      cli.log.push(`flag ${any}`)
      flags.push(any)
    },
  })
  const tabs: TabImpairment[] = []
  manager.onTab((t) => tabs.push(t))
  const last = (tabId: number, frameId: number) =>
    sent.filter((s) => s.tabId === tabId && s.frameId === frameId).at(-1)?.msg.answer
  const tick = async () => {
    for (const fn of [...ticks]) fn()
    await settle()
  }
  return { cli, store, manager, sent, last, tabs, tick, ticks, closed, flags }
}

const routeOf = (cli: FakeCli, n: number) => ({
  port: 50000 + n,
  token: `k${n}`.padEnd(22, '0'),
  certHash: CERT,
})

describe('ImpairManager', () => {
  it('answers a frame that connects: direct while the tab has no profile', async () => {
    const { manager, last, flags } = setup()
    manager.frameConnected(3, 0)
    await settle()
    expect(last(3, 0)).toEqual({ on: false, route: null })
    expect(flags).toEqual([false])
  })

  it('opens one tab port for a profile and gives every frame its route', async () => {
    const { cli, manager, last, flags } = setup()
    manager.frameConnected(3, 0)
    manager.frameConnected(3, 5)
    await manager.setProfile(3, G3, '3G')
    expect([...cli.tabsById.values()]).toEqual([
      expect.objectContaining({ owner: 'owner-1', profile: G3 }),
    ])
    expect(last(3, 0)).toEqual({ on: true, route: routeOf(cli, 1) })
    expect(last(3, 5)).toEqual({ on: true, route: routeOf(cli, 1) })
    expect(flags).toEqual([false, true])
    expect(manager.view(3)).toEqual({ tabId: 3, profile: G3, name: '3G', sessions: [], unknown: [], sessionErrors: [], failure: null, error: null, refusal: null, refusedName: null })
  })

  it('keeps the tab port across reloads and answers each new document with it', async () => {
    const { cli, manager, last } = setup()
    await manager.setProfile(3, G3, '3G')
    manager.frameGone(3, 0)
    manager.frameConnected(3, 0)
    await settle()
    expect(last(3, 0)).toEqual({ on: true, route: routeOf(cli, 1) })
    expect(cli.tabsById.size).toBe(1)
  })

  it('switches the tab port live on a profile change', async () => {
    const { cli, manager, last } = setup()
    manager.frameConnected(3, 0)
    await manager.setProfile(3, G3, '3G')
    await manager.setProfile(3, G4, '4G')
    expect(cli.switches).toEqual([['t1'.padEnd(22, '0'), G4]])
    expect(cli.tabsById.size).toBe(1)
    expect(last(3, 0)).toEqual({ on: true, route: routeOf(cli, 1) })
    expect(manager.view(3).name).toBe('4G')
  })

  it('keeps sessions running on Off and sends only new sessions direct', async () => {
    const { cli, manager, last, flags } = setup()
    manager.frameConnected(3, 0)
    await manager.setProfile(3, G3, '3G')
    await manager.setProfile(3, OFF, 'Off')
    expect(cli.switches.at(-1)).toEqual(['t1'.padEnd(22, '0'), OFF])
    expect(cli.deletes).toEqual([])
    expect(last(3, 0)).toEqual({ on: false, route: null })
    expect(flags.at(-1)).toBe(false)
    await manager.setProfile(3, G3, '3G')
    expect(cli.tabsById.size).toBe(1)
    expect(last(3, 0)).toEqual({ on: true, route: routeOf(cli, 1) })
  })

  it('deletes the tab port when the tab closes', async () => {
    const { cli, manager, flags } = setup()
    await manager.setProfile(3, G3, '3G')
    await manager.tabRemoved(3)
    expect(cli.deletes).toEqual(['t1'.padEnd(22, '0')])
    expect(manager.view(3).profile).toEqual(OFF)
    expect(flags.at(-1)).toBe(false)
  })

  it('gives two tabs their own ports and profiles', async () => {
    const { cli, manager, last } = setup()
    manager.frameConnected(3, 0)
    manager.frameConnected(4, 0)
    await manager.setProfile(3, G3, '3G')
    await manager.setProfile(4, G4, '4G')
    expect(last(3, 0)?.route?.port).toBe(50001)
    expect(last(4, 0)?.route?.port).toBe(50002)
    expect([...cli.tabsById.values()].map((t) => [t.owner, t.profile])).toEqual([
      ['owner-1', G3],
      ['owner-2', G4],
    ])
  })

  it('renews every lease, and drops a tab that closed unseen', async () => {
    const { cli, manager, tick, closed } = setup()
    await manager.setProfile(3, G3, '3G')
    await manager.setProfile(4, G4, '4G')
    closed.add(4)
    await tick()
    expect(cli.leases).toEqual(['owner-1'])
    expect(cli.deletes).toEqual(['t2'.padEnd(22, '0')])
  })

  it('reopens a tab port the CLI no longer has and gives frames the new route', async () => {
    const { cli, manager, last, tick } = setup()
    manager.frameConnected(3, 0)
    await manager.setProfile(3, G3, '3G')
    cli.tabsById.clear()
    await tick()
    expect(last(3, 0)).toEqual({ on: true, route: routeOf(cli, 2) })
  })

  it('fails closed while the CLI is unreachable, then recovers', async () => {
    const cli = new FakeCli()
    cli.current = null
    const { manager, last, tick } = setup({ cli })
    manager.frameConnected(3, 0)
    await manager.setProfile(3, G3, '3G')
    expect(last(3, 0)).toEqual({ on: true, route: null })
    expect(manager.view(3).error).toBe('unreachable')
    cli.current = TARGET
    await tick()
    expect(last(3, 0)).toEqual({ on: true, route: routeOf(cli, 1) })
    expect(manager.view(3).error).toBeNull()
  })

  it('reports the CLI tab limit', async () => {
    const cli = new FakeCli()
    cli.createError = 'limit'
    const { manager, last } = setup({ cli })
    manager.frameConnected(3, 0)
    await manager.setProfile(3, G3, '3G')
    expect(manager.view(3).error).toBe('limit')
    // A pick the CLI will not open impairs nothing.
    expect(last(3, 0)).toEqual({ on: false, route: null })
  })

  it('reopens on a switch the CLI answers with gone', async () => {
    const { cli, manager, last } = setup()
    manager.frameConnected(3, 0)
    await manager.setProfile(3, G3, '3G')
    cli.tabsById.clear()
    await manager.setProfile(3, G4, '4G')
    expect(last(3, 0)).toEqual({ on: true, route: routeOf(cli, 2) })
    expect(cli.tabsById.get('t2'.padEnd(22, '0'))?.profile).toEqual(G4)
  })

  it('drops an Off tab whose port the CLI lost', async () => {
    const { cli, manager, tick, flags } = setup()
    await manager.setProfile(3, G3, '3G')
    await manager.setProfile(3, OFF, 'Off')
    cli.tabsById.clear()
    await tick()
    expect(cli.tabsById.size).toBe(0)
    expect(flags.at(-1)).toBe(false)
  })

  it('reopens tab ports at a CLI with another identity', async () => {
    const { cli, manager, last } = setup()
    manager.frameConnected(3, 0)
    await manager.setProfile(3, G3, '3G')
    cli.change({ ...TARGET, identity: 'other' })
    await settle()
    expect(last(3, 0)).toEqual({ on: true, route: routeOf(cli, 2) })
  })

  it('records a failure the page reports while the tab has a profile, and clears it on reload', async () => {
    const { manager } = setup()
    manager.failed(3, 'local-network')
    expect(manager.view(3).failure).toBeNull()
    await manager.setProfile(3, G3, '3G')
    manager.failed(3, 'local-network')
    expect(manager.view(3).failure).toBe('local-network')
    manager.frameConnected(3, 0)
    expect(manager.view(3).failure).toBeNull()
  })

  it('picks up after a restart: answers frames only once restored, and keeps the tab port', async () => {
    const store = memoryArea()
    const first = setup({ store })
    await first.manager.setProfile(3, G3, '3G')
    const cli = first.cli
    const second = setup({ cli, store })
    second.manager.frameConnected(3, 0)
    await settle()
    expect(second.sent.map((s) => s.msg.answer)).toEqual([{ on: true, route: routeOf(cli, 1) }])
    expect(second.flags).toEqual([true])
    expect(second.manager.view(3)).toEqual(expect.objectContaining({ profile: G3, name: '3G' }))
    expect(cli.tabsById.size).toBe(1)
    expect(store.data.get(PROFILES_KEY)).toEqual({
      3: expect.objectContaining({ owner: 'owner-1', profile: G3, name: '3G' }),
    })
  })

  it('serialises profile changes in the order given', async () => {
    const { cli, manager } = setup()
    const a = manager.setProfile(3, G3, '3G')
    const b = manager.setProfile(3, G4, '4G')
    const c = manager.setProfile(3, OFF, 'Off')
    await Promise.all([a, b, c])
    expect(cli.tabsById.size).toBe(1)
    expect(cli.switches.map(([, p]) => p)).toEqual([G4, OFF])
    expect(manager.view(3).profile).toEqual(OFF)
  })

  it('registers the flag before opening the tab port, and holds frames until it opens', async () => {
    const cli = new FakeCli()
    let release = () => {}
    cli.gate = new Promise((r) => (release = r))
    const { manager, sent, last } = setup({ cli })
    const picked = manager.setProfile(3, G3, '3G')
    await settle()
    expect(cli.log).toEqual(['flag false', 'flag true', 'createTab'])
    manager.frameConnected(3, 0)
    await settle()
    expect(sent).toEqual([])
    release()
    await picked
    expect(last(3, 0)).toEqual({ on: true, route: routeOf(cli, 1) })
    expect(sent.every((s) => s.msg.answer.route !== null)).toBe(true)
  })

  it('answers held frames Off once the CLI refuses to open the tab port', async () => {
    const cli = new FakeCli()
    cli.createError = 'refused'
    let release = () => {}
    cli.gate = new Promise((r) => (release = r))
    const { manager, last } = setup({ cli })
    const picked = manager.setProfile(3, G3, '3G')
    await settle()
    manager.frameConnected(3, 0)
    await settle()
    expect(last(3, 0)).toBeUndefined()
    release()
    await picked
    expect(last(3, 0)).toEqual({ on: false, route: null })
  })

  for (const error of ['refused', 'not-allowed', 'protocol'] as const) {
    it(`drops a pick the CLI answered ${error}, and does not try it again`, async () => {
      const cli = new FakeCli()
      cli.createError = error
      const { manager, last, tick, store } = setup({ cli })
      manager.frameConnected(3, 0)
      await manager.setProfile(3, G3, '3G')
      expect(manager.view(3)).toEqual(expect.objectContaining({ profile: OFF, error, refusedName: '3G' }))
      expect(last(3, 0)).toEqual({ on: false, route: null })
      expect(store.data.get(PROFILES_KEY)).toEqual({})
      const opens = cli.log.filter((l) => l === 'createTab').length
      await tick()
      await tick()
      expect(cli.log.filter((l) => l === 'createTab').length).toBe(opens)
    })
  }

  it('keeps an unreachable pick and opens it once the CLI answers', async () => {
    const cli = new FakeCli()
    cli.current = null
    const { manager, last, tick } = setup({ cli })
    manager.frameConnected(3, 0)
    await manager.setProfile(3, G3, '3G')
    expect(manager.view(3).error).toBe('unreachable')
    cli.current = TARGET
    await tick()
    expect(last(3, 0)).toEqual({ on: true, route: routeOf(cli, 1) })
  })

  it('clears what the last pick ran into when Off is picked, or when dismissed', async () => {
    const cli = new FakeCli()
    cli.createError = 'not-allowed'
    const { manager } = setup({ cli })
    await manager.setProfile(3, G3, '3G')
    expect(manager.view(3).error).toBe('not-allowed')
    await manager.setProfile(3, OFF, 'Off')
    expect(manager.view(3)).toEqual(expect.objectContaining({ profile: OFF, error: null, refusedName: null }))
    await manager.setProfile(3, G3, '3G')
    expect(manager.view(3).error).toBe('not-allowed')
    await manager.clearError(3)
    expect(manager.view(3).error).toBeNull()
  })

  it('holds frames after a restart until the tab port reopens', async () => {
    const store = memoryArea()
    const first = setup({ store })
    await first.manager.setProfile(3, G3, '3G')
    const cli = first.cli
    cli.tabsById.clear()
    store.data.set(PROFILES_KEY, { 3: { owner: 'owner-1', profile: G3, name: '3G', held: null } })
    const second = setup({ cli, store })
    second.manager.frameConnected(3, 0)
    await settle()
    expect(second.sent.map((s) => s.msg.answer)).toEqual([{ on: true, route: routeOf(cli, 2) }])
  })

  it('retries a flag the browser refused, and reports it until it registers', async () => {
    let fail = true
    const { manager, tick, flags } = setup({ flagFails: () => fail })
    await manager.setProfile(3, G3, '3G')
    expect(flags).toEqual([])
    expect(manager.view(3).error).toBe('flag')
    await tick()
    expect(manager.view(3).error).toBe('flag')
    fail = false
    await tick()
    expect(flags).toEqual([true])
    expect(manager.view(3).error).toBeNull()
  })
})

describe('ImpairManager: a session with its own profile', () => {
  const TAB = 't1'.padEnd(22, '0')
  const S1 = 'A'.repeat(21) + 'Q'
  const S2 = 'B'.repeat(21) + 'Q'

  async function withSessions() {
    const s = setup()
    await s.manager.setProfile(3, G3, '3G')
    s.cli.addSession(TAB, S1)
    s.cli.addSession(TAB, S2)
    return s
  }

  it('gives one session its own profile and shows it beside the tab profile', async () => {
    const { cli, manager, tabs } = await withSessions()
    await manager.setSessionProfile(3, S1, { profile: G4, name: '4G' })
    expect(cli.sessionSwitches).toEqual([[S1, G4]])
    expect(manager.view(3)).toEqual(
      expect.objectContaining({ profile: G3, name: '3G', sessions: [{ session: S1, profile: G4, name: '4G' }] }),
    )
    expect(tabs.at(-1)?.sessions).toEqual([{ session: S1, profile: G4, name: '4G' }])
  })

  it('returns a session to the tab profile', async () => {
    const { cli, manager } = await withSessions()
    await manager.setSessionProfile(3, S1, { profile: G4, name: '4G' })
    await manager.setSessionProfile(3, S1, null)
    expect(cli.sessionSwitches).toEqual([
      [S1, G4],
      [S1, null],
    ])
    expect(manager.view(3).sessions).toEqual([])
  })

  it('clears every session profile when the tab profile changes', async () => {
    const { manager, tabs } = await withSessions()
    await manager.setSessionProfile(3, S1, { profile: G4, name: '4G' })
    await manager.setSessionProfile(3, S2, { profile: OFF, name: 'Off' })
    expect(manager.view(3).sessions).toHaveLength(2)
    await manager.setProfile(3, OFF, 'Off')
    expect(manager.view(3)).toEqual(expect.objectContaining({ name: 'Off', sessions: [] }))
    expect(tabs.at(-1)).toEqual(expect.objectContaining({ name: 'Off', sessions: [] }))
  })

  it('keeps session profiles when the CLI refuses the tab switch', async () => {
    const { cli, manager } = await withSessions()
    await manager.setSessionProfile(3, S1, { profile: G4, name: '4G' })
    cli.switchResult = { refused: null }
    await manager.setProfile(3, OFF, 'Off')
    expect(manager.view(3).sessions).toEqual([{ session: S1, profile: G4, name: '4G' }])
    expect(manager.view(3).error).toBe('refused')
  })

  it("keeps what the CLI said when it refuses a tab's profile, until one is taken", async () => {
    const { cli, manager, tick } = await withSessions()
    const before = manager.view(3)
    const said: Refusal = { error: 'There is no scenario named "x".', reason: 'unknown_scenario', plan: null, upgrade: null }
    cli.switchResult = { refused: said }
    await manager.setProfile(3, { scenario: 'x' }, 'x')
    expect(manager.view(3)).toEqual(
      expect.objectContaining({ profile: before.profile, name: before.name, error: 'refused', refusal: said, refusedName: 'x' }),
    )
    await tick()
    expect(manager.view(3)).toEqual(expect.objectContaining({ error: 'refused', refusal: said }))
    cli.switchResult = null
    await manager.setProfile(3, G4, '4G')
    expect(manager.view(3)).toEqual(expect.objectContaining({ error: null, refusal: null }))
  })

  it("keeps what the CLI said when it refuses to open a tab port", async () => {
    const cli = new FakeCli()
    cli.createError = 'refused'
    cli.refusal = { error: 'Pro plan is required to run this scenario.', upgrade: { plan: 'Pro', url: 'https://moqtap.com/x' } }
    const { manager } = setup({ cli })
    await manager.setProfile(3, { scenario: 'lte' }, 'lte')
    expect(manager.view(3)).toEqual(
      expect.objectContaining({ profile: OFF, name: 'Off', error: 'refused', refusal: cli.refusal, refusedName: 'lte' }),
    )
  })

  it('forgets a session the CLI no longer has', async () => {
    const { cli, manager, tick, tabs } = await withSessions()
    await manager.setSessionProfile(3, S1, { profile: G4, name: '4G' })
    await manager.setSessionProfile(3, S2, { profile: OFF, name: 'Off' })
    cli.dropSession(S1)
    const before = tabs.length
    await tick()
    expect(manager.view(3).sessions).toEqual([{ session: S2, profile: OFF, name: 'Off' }])
    expect(tabs.length).toBeGreaterThan(before)
    cli.dropSession(S2)
    await manager.setSessionProfile(3, S2, { profile: G4, name: '4G' })
    expect(manager.view(3).sessions).toEqual([])
  })

  it('records nothing and reports it for that session when the CLI does not take it', async () => {
    const { cli, manager, tabs } = await withSessions()
    const said: Refusal = { error: 'Pro plan is required to run this scenario.', upgrade: { plan: 'Pro', url: 'https://moqtap.com/x' } }
    const results: [SwitchResult, SessionFailure][] = [
      ['unreachable', { session: S1, error: 'unreachable', refusal: null }],
      [{ refused: null }, { session: S1, error: 'refused', refusal: null }],
      [{ refused: said }, { session: S1, error: 'refused', refusal: said }],
    ]
    for (const [r, failed] of results) {
      cli.sessionResult = r
      const before = tabs.length
      await manager.setSessionProfile(3, S1, { profile: G4, name: '4G' })
      expect(tabs.length).toBeGreaterThan(before)
      expect(manager.view(3)).toEqual(expect.objectContaining({ sessions: [], sessionErrors: [failed], error: null }))
    }
    cli.sessionResult = null
    await manager.setSessionProfile(3, S1, { profile: G4, name: '4G' })
    expect(manager.view(3).sessionErrors).toEqual([])
  })

  it('clears a session error once the tab profile changes or the session ends', async () => {
    const { cli, manager, tick } = await withSessions()
    cli.sessionResult = { refused: null }
    await manager.setSessionProfile(3, S1, { profile: G4, name: '4G' })
    await manager.setSessionProfile(3, S2, { profile: G4, name: '4G' })
    cli.dropSession(S1)
    await tick()
    expect(manager.view(3).sessionErrors).toEqual([{ session: S2, error: 'refused', refusal: null }])
    await manager.setProfile(3, G4, '4G')
    expect(manager.view(3).sessionErrors).toEqual([])
  })

  it('does nothing for a tab without a tab port, and still answers the panel', async () => {
    const { cli, manager, tabs } = setup()
    await manager.setSessionProfile(3, S1, { profile: G4, name: '4G' })
    expect(cli.sessionSwitches).toEqual([])
    expect(manager.view(3).sessions).toEqual([])
    expect(tabs).toHaveLength(1)
  })

  it('follows the profile the CLI lists after a reply was lost', async () => {
    const { cli, manager, tick, tabs } = await withSessions()
    await manager.setSessionProfile(3, S1, { profile: G4, name: '4G' })
    cli.lostReply = true
    await manager.setSessionProfile(3, S1, null)
    await manager.setSessionProfile(3, S2, { profile: OFF, name: 'Off' })
    expect(manager.view(3).sessions).toEqual([{ session: S1, profile: G4, name: '4G' }])
    const before = tabs.length
    await tick()
    expect(manager.view(3)).toEqual(expect.objectContaining({ sessions: [], unknown: [S2] }))
    expect(tabs.length).toBeGreaterThan(before)
    cli.lostReply = false
    await manager.setSessionProfile(3, S2, null)
    expect(manager.view(3).unknown).toEqual([])
  })

  it('names no profile for sessions after a tab switch whose reply was lost', async () => {
    const { cli, manager, tick } = await withSessions()
    await manager.setSessionProfile(3, S1, { profile: OFF, name: 'Off' })
    cli.lostReply = true
    await manager.setProfile(3, G4, '4G')
    await tick()
    expect(manager.view(3)).toEqual(expect.objectContaining({ name: '4G', sessions: [], unknown: [] }))
    cli.switchResult = 'unreachable'
    await manager.setProfile(3, OFF, 'Off')
    await tick()
    expect(manager.view(3)).toEqual(expect.objectContaining({ name: 'Off', unknown: [S1, S2] }))
  })

  it('drops session profiles with a tab port the CLI lost', async () => {
    const { cli, manager, tick } = await withSessions()
    await manager.setSessionProfile(3, S1, { profile: G4, name: '4G' })
    cli.tabsById.clear()
    await tick()
    expect(manager.view(3).sessions).toEqual([])
  })

  it('keeps session profiles across a restart of the background', async () => {
    const store = memoryArea()
    const first = setup({ store })
    await first.manager.setProfile(3, G3, '3G')
    first.cli.addSession(TAB, S1)
    await first.manager.setSessionProfile(3, S1, { profile: G4, name: '4G' })
    const second = setup({ cli: first.cli, store })
    await second.manager.ready
    expect(second.manager.view(3).sessions).toEqual([{ session: S1, profile: G4, name: '4G' }])
  })
})
