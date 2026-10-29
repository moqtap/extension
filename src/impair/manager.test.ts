import { describe, expect, it } from 'vitest'
import type { KeyValueArea } from '@/src/account/stores'
import type { TabImpairment } from '@/src/cli/messages'
import type { CliSession, Preset } from '@/src/cli/protocol'
import type { CliTarget, CreateError } from '@/src/cli/service'
import { ImpairManager, LEASE_MS, PROFILES_KEY, type ImpairCli } from './manager'
import type { PoolMsg } from './messages'

const TARGET: CliTarget = { identity: 'cli-identity', port: 47310, certHash: 'CERT' }

class FakeCli implements ImpairCli {
  current: CliTarget | null = TARGET
  sessionsById = new Map<string, CliSession>()
  leases: string[] = []
  deletes: string[] = []
  presets: [string, Preset][] = []
  createError: CreateError | null = null
  probes = 0
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
  async createSession(owner: string, preset: Preset) {
    if (this.current === null) return { error: 'unreachable' as const }
    if (this.createError !== null) return { error: this.createError }
    const id = `s${++this.n}`.padEnd(22, '0')
    const port = 50000 + this.n
    this.sessionsById.set(id, { id, port, owner, upstream: null, preset, connected: false })
    return { id, port, secret: 'BwcHBwcHBwcHBwcHBwcHBw' }
  }
  async setSessionPreset(id: string, preset: Preset) {
    const s = this.sessionsById.get(id)
    if (s === undefined) return false
    this.presets.push([id, preset])
    this.sessionsById.set(id, { ...s, preset })
    return true
  }
  async deleteSession(id: string) {
    this.deletes.push(id)
    this.sessionsById.delete(id)
  }
  async renewLease(owner: string) {
    if (this.current === null) return false
    this.leases.push(owner)
    return true
  }
  async sessions() {
    return this.current === null ? null : [...this.sessionsById.values()]
  }
  connect(id: string) {
    const s = this.sessionsById.get(id)!
    this.sessionsById.set(id, { ...s, connected: true })
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

const settle = () => new Promise((r) => setTimeout(r, 0))

function setup(opts: { cli?: FakeCli; store?: ReturnType<typeof memoryArea>; closed?: Set<number> } = {}) {
  const cli = opts.cli ?? new FakeCli()
  const store = opts.store ?? memoryArea()
  const closed = opts.closed ?? new Set<number>()
  const sent: { tabId: number; frameId: number; msg: PoolMsg }[] = []
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
  })
  const tabs: TabImpairment[] = []
  manager.onTab((t) => tabs.push(t))
  const last = (tabId: number, frameId: number) =>
    sent.filter((s) => s.tabId === tabId && s.frameId === frameId).at(-1)?.msg
  const tick = async () => {
    for (const fn of [...ticks]) fn()
    await settle()
    await settle()
  }
  return { cli, store, manager, sent, last, tabs, tick, ticks, closed }
}

describe('ImpairManager', () => {
  it('sends a frame nothing to use while the tab has no profile', async () => {
    const { manager, last } = setup()
    await manager.ready
    manager.frameConnected(1, 0)
    expect(last(1, 0)).toEqual({ type: 'impair:pool', on: false, certHash: 'CERT', entries: [], want: 2 })
  })

  it('fills each frame of a tab with a profile, the top frame with more', async () => {
    const { manager, cli, last } = setup()
    manager.frameConnected(1, 0)
    manager.frameConnected(1, 5)
    await manager.setPreset(1, '3g')
    await settle()
    expect(last(1, 0)?.on).toBe(true)
    expect(last(1, 0)?.entries).toHaveLength(2)
    expect(last(1, 5)?.entries).toHaveLength(1)
    expect([...cli.sessionsById.values()].every((s) => s.owner === 'owner-1' && s.preset === '3g')).toBe(true)
  })

  it('refills a frame after the page takes a session', async () => {
    const { manager, cli, last } = setup()
    manager.frameConnected(1, 0)
    await manager.setPreset(1, '4g')
    await settle()
    const taken = last(1, 0)!.entries[0]!
    manager.fromPage(1, 0, { type: 'impair:took', id: taken.id })
    await settle()
    expect(last(1, 0)!.entries.map((e) => e.id)).not.toContain(taken.id)
    expect(last(1, 0)!.entries).toHaveLength(2)
    expect(cli.sessionsById.size).toBe(3)
  })

  it('grows a frame for its workers and deletes a released session', async () => {
    const { manager, cli, last } = setup()
    manager.frameConnected(1, 0)
    await manager.setPreset(1, '3g')
    await settle()
    manager.fromPage(1, 0, { type: 'impair:want', count: 3 })
    await settle()
    expect(last(1, 0)!.want).toBe(3)
    expect(last(1, 0)!.entries).toHaveLength(3)
    const id = last(1, 0)!.entries[2]!.id
    manager.fromPage(1, 0, { type: 'impair:release', id })
    await settle()
    expect(cli.deletes).toEqual([id])
    manager.fromPage(1, 0, { type: 'impair:want', count: 1000 })
    expect(last(1, 0)!.want).toBe(8)
  })

  it('reports exhaustion at the CLI and recovers on the next lease renewal', async () => {
    const { manager, cli, last, tabs, tick } = setup()
    cli.createError = 'limit'
    manager.frameConnected(1, 0)
    await manager.setPreset(1, '3g')
    await settle()
    expect(manager.view(1).poolError).toBe('limit')
    expect(tabs.at(-1)?.poolError).toBe('limit')
    expect(last(1, 0)).toMatchObject({ on: true, entries: [] })
    cli.createError = null
    await tick()
    expect(manager.view(1).poolError).toBeNull()
    expect(last(1, 0)!.entries).toHaveLength(2)
  })

  it('switches every session the tab has, connected or idle', async () => {
    const { manager, cli, last } = setup()
    manager.frameConnected(1, 0)
    manager.frameConnected(2, 0)
    await manager.setPreset(1, '3g')
    await manager.setPreset(2, '3g')
    await settle()
    const taken = last(1, 0)!.entries[0]!.id
    manager.fromPage(1, 0, { type: 'impair:took', id: taken })
    cli.connect(taken)
    await settle()
    await manager.setPreset(1, 'offline')
    const mine = [...cli.sessionsById.values()].filter((s) => s.owner === 'owner-1')
    const theirs = [...cli.sessionsById.values()].filter((s) => s.owner === 'owner-2')
    expect(mine).toHaveLength(3)
    expect(mine.every((s) => s.preset === 'offline')).toBe(true)
    expect(theirs.every((s) => s.preset === '3g')).toBe(true)
    expect(manager.view(1).preset).toBe('offline')
  })

  it('arms a session created during a switch with the new profile', async () => {
    const { manager, cli } = setup()
    manager.frameConnected(1, 0)
    const pending = manager.setPreset(1, '3g')
    await pending
    void manager.setPreset(1, '4g')
    await settle()
    await settle()
    expect([...cli.sessionsById.values()].every((s) => s.preset === '4g')).toBe(true)
  })

  it('deletes every session of the tab on Off and sends new sessions direct', async () => {
    const { manager, cli, last, ticks } = setup()
    manager.frameConnected(1, 0)
    await manager.setPreset(1, '3g')
    await settle()
    const taken = last(1, 0)!.entries[0]!.id
    manager.fromPage(1, 0, { type: 'impair:took', id: taken })
    cli.connect(taken)
    await settle()
    await manager.setPreset(1, 'none')
    expect(cli.sessionsById.size).toBe(0)
    expect(cli.deletes).toContain(taken)
    expect(last(1, 0)).toMatchObject({ on: false, entries: [] })
    expect(ticks).toHaveLength(0)
  })

  it('deletes the tab sessions when the tab closes', async () => {
    const { manager, cli, store } = setup()
    manager.frameConnected(1, 0)
    manager.frameConnected(2, 0)
    await manager.setPreset(1, '3g')
    await manager.setPreset(2, '4g')
    await settle()
    await manager.tabRemoved(1)
    expect([...cli.sessionsById.values()].map((s) => s.owner)).toEqual(['owner-2', 'owner-2'])
    expect(Object.keys(store.data.get(PROFILES_KEY) as object)).toEqual(['2'])
  })

  it("deletes a frame's idle sessions when it goes away", async () => {
    const { manager, cli } = setup()
    manager.frameConnected(1, 0)
    manager.frameConnected(1, 3)
    await manager.setPreset(1, '3g')
    await settle()
    manager.frameGone(1, 3)
    expect(cli.sessionsById.size).toBe(2)
  })

  it('renews the lease of every tab with a profile, and drops a tab that closed unseen', async () => {
    const { manager, cli, tick, closed } = setup()
    manager.frameConnected(1, 0)
    manager.frameConnected(2, 0)
    await manager.setPreset(1, '3g')
    await manager.setPreset(2, '3g')
    await settle()
    await tick()
    expect(cli.leases.sort()).toEqual(['owner-1', 'owner-2'])
    closed.add(2)
    cli.leases = []
    await tick()
    expect(cli.leases).toEqual(['owner-1'])
    expect(manager.view(2).preset).toBe('none')
  })

  it('records a failure the page reports, and clears it on reload', async () => {
    const { manager, tabs } = setup()
    manager.frameConnected(1, 0)
    await manager.setPreset(1, '3g')
    manager.fromPage(1, 0, { type: 'impair:failed', failure: 'local-network', url: 'https://relay.example/' })
    expect(tabs.at(-1)).toEqual({ tabId: 1, preset: '3g', failure: 'local-network', poolError: null })
    manager.frameConnected(1, 0)
    expect(manager.view(1).failure).toBeNull()
  })

  it('says the CLI is unreachable and keeps the profile when it goes away', async () => {
    const { manager, cli, last } = setup()
    manager.frameConnected(1, 0)
    await manager.setPreset(1, '3g')
    await settle()
    cli.change(null)
    expect(last(1, 0)).toMatchObject({ on: true, certHash: null, entries: [] })
    expect(manager.view(1)).toMatchObject({ preset: '3g', poolError: 'unreachable' })
    cli.sessionsById.clear()
    cli.change({ ...TARGET, certHash: 'CERT2' })
    await settle()
    await settle()
    expect(last(1, 0)).toMatchObject({ on: true, certHash: 'CERT2' })
    expect(last(1, 0)!.entries).toHaveLength(2)
  })

  it('picks up after a restart: keeps the owner, drops idle leftovers, keeps live ones', async () => {
    const first = setup()
    first.manager.frameConnected(1, 0)
    await first.manager.setPreset(1, '3g')
    await settle()
    const live = first.last(1, 0)!.entries[0]!.id
    first.cli.connect(live)

    const again = setup({ cli: first.cli, store: first.store })
    await again.manager.ready
    expect(again.manager.view(1).preset).toBe('3g')
    expect([...first.cli.sessionsById.keys()]).toEqual([live])
    await again.tick()
    expect(first.cli.leases).toContain('owner-1')
  })
})
