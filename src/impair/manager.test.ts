import { describe, expect, it } from 'vitest'
import type { KeyValueArea } from '@/src/account/stores'
import type { TabImpairment } from '@/src/cli/messages'
import type { CliTab, Profile } from '@/src/cli/protocol'
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
  createError: CreateError | null = null
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
    this.tabsById.set(id, { ...t, profile })
    return 'ok'
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
    expect(manager.view(3)).toEqual({ tabId: 3, profile: G3, name: '3G', failure: null, error: null })
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
    expect(last(3, 0)).toEqual({ on: true, route: null })
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

  it('answers held frames with no route once the tab port fails to open', async () => {
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
    expect(last(3, 0)).toEqual({ on: true, route: null })
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
