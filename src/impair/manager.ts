/**
 * The background's side of tab impairment.
 *
 * A tab with a profile has an owner id at the CLI. Each of its frames gets a
 * few idle CLI sessions ahead of use, since `new WebTransport()` cannot wait;
 * the page reports each one it takes and the frame is topped up again. The
 * owner's lease is renewed while the profile is set. Profile changes go to
 * every session the CLI lists for the owner; Off and closing the tab delete
 * them.
 */

import type { KeyValueArea } from '@/src/account/stores'
import type { ImpairFailure, PoolError, TabImpairment } from '@/src/cli/messages'
import { isPreset, type CliSession, type CreatedSession, type Preset } from '@/src/cli/protocol'
import type { CliTarget, CreateError } from '@/src/cli/service'
import type { ImpairPageMsg, PoolEntry, PoolMsg } from './messages'
import { MAX_WANT, RESERVE_SUBFRAME, RESERVE_TOP } from './page-pool'

export const PROFILES_KEY = 'moqtap-impair-tabs'
export const LEASE_MS = 10_000

export interface ImpairCli {
  target(): CliTarget | null
  probe(): Promise<void>
  onChange(fn: () => void): () => void
  createSession(owner: string, preset: Preset): Promise<CreatedSession | { error: CreateError }>
  setSessionPreset(id: string, preset: Preset): Promise<boolean>
  deleteSession(id: string): Promise<void>
  renewLease(owner: string): Promise<boolean>
  sessions(): Promise<CliSession[] | null>
}

export interface ImpairDeps {
  readonly cli: ImpairCli
  /** `storage.session`, so profiles outlive a restart of the background. */
  readonly store: KeyValueArea
  readonly sendToFrame: (tabId: number, frameId: number, msg: PoolMsg) => void
  readonly tabExists: (tabId: number) => Promise<boolean>
  readonly newOwner: () => string
  readonly every: (ms: number, fn: () => void) => () => void
}

interface Profile {
  owner: string
  preset: Preset
}

interface Frame {
  want: number
  /** Idle sessions handed to the frame and not reported used. */
  readonly idle: Map<string, PoolEntry>
  pending: number
}

interface TabState {
  failure: ImpairFailure | null
  poolError: PoolError | null
}

const targetKey = (t: CliTarget | null) => (t === null ? '' : `${t.identity} ${t.port} ${t.certHash}`)

export class ImpairManager {
  private readonly profiles = new Map<number, Profile>()
  private readonly frames = new Map<number, Map<number, Frame>>()
  private readonly states = new Map<number, TabState>()
  private readonly listeners = new Set<(tab: TabImpairment) => void>()
  private stopLease: (() => void) | null = null
  private target: string
  /** Bumped when the CLI changes; replies for an older CLI are dropped. */
  private generation = 0
  readonly ready: Promise<void>

  constructor(private readonly deps: ImpairDeps) {
    this.target = targetKey(deps.cli.target())
    deps.cli.onChange(() => this.cliChanged())
    this.ready = this.restore()
  }

  view(tabId: number): TabImpairment {
    const s = this.states.get(tabId)
    return {
      tabId,
      preset: this.profiles.get(tabId)?.preset ?? 'none',
      failure: s?.failure ?? null,
      poolError: s?.poolError ?? null,
    }
  }

  onTab(fn: (tab: TabImpairment) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  async setPreset(tabId: number, preset: Preset): Promise<void> {
    await this.ready
    const current = this.profiles.get(tabId)
    this.state(tabId).failure = null
    if (preset === 'none') {
      if (current !== undefined) await this.drop(tabId)
      this.emit(tabId)
      return
    }
    if (current === undefined) {
      if (this.deps.cli.target() === null) await this.deps.cli.probe().catch(() => {})
      this.profiles.set(tabId, { owner: this.deps.newOwner(), preset })
      await this.persist()
      this.ensureLease()
      this.pushAll(tabId)
      this.refillAll(tabId)
    } else if (current.preset !== preset) {
      current.preset = preset
      await this.persist()
      const owned = (await this.deps.cli.sessions())?.filter((s) => s.owner === current.owner) ?? []
      await Promise.all(owned.map((s) => this.deps.cli.setSessionPreset(s.id, preset)))
    }
    this.emit(tabId)
  }

  /** A frame's bridge connected: a new document, or a reconnect. */
  frameConnected(tabId: number, frameId: number): void {
    const frames = this.framesOf(tabId)
    const old = frames.get(frameId)
    if (old !== undefined) this.release(old)
    frames.set(frameId, {
      want: frameId === 0 ? RESERVE_TOP : RESERVE_SUBFRAME,
      idle: new Map(),
      pending: 0,
    })
    if (frameId === 0 && this.states.get(tabId)?.failure) {
      this.state(tabId).failure = null
      this.emit(tabId)
    }
    this.push(tabId, frameId)
    this.refill(tabId, frameId)
  }

  frameGone(tabId: number, frameId: number): void {
    const frames = this.frames.get(tabId)
    const frame = frames?.get(frameId)
    if (frames === undefined || frame === undefined) return
    frames.delete(frameId)
    if (frames.size === 0) this.frames.delete(tabId)
    this.release(frame)
  }

  fromPage(tabId: number, frameId: number, msg: ImpairPageMsg): void {
    const frame = this.frames.get(tabId)?.get(frameId)
    switch (msg.type) {
      case 'impair:took':
        if (frame?.idle.delete(msg.id)) this.refill(tabId, frameId)
        break
      case 'impair:release':
        if (frame?.idle.delete(msg.id)) {
          void this.deps.cli.deleteSession(msg.id)
          this.refill(tabId, frameId)
        }
        break
      case 'impair:want':
        if (frame === undefined) break
        frame.want = Math.max(1, Math.min(MAX_WANT, msg.count))
        this.push(tabId, frameId)
        this.refill(tabId, frameId)
        break
      case 'impair:failed':
        if (!this.profiles.has(tabId)) break
        this.state(tabId).failure = msg.failure
        this.emit(tabId)
        break
    }
  }

  async tabRemoved(tabId: number): Promise<void> {
    await this.ready
    this.frames.delete(tabId)
    this.states.delete(tabId)
    if (this.profiles.has(tabId)) await this.drop(tabId)
  }

  private async restore(): Promise<void> {
    const raw = await this.deps.store.get(PROFILES_KEY).catch(() => undefined)
    if (typeof raw === 'object' && raw !== null) {
      for (const [k, v] of Object.entries(raw as Record<string, Profile>)) {
        const tabId = Number(k)
        if (Number.isInteger(tabId) && typeof v?.owner === 'string' && isPreset(v?.preset) && v.preset !== 'none') {
          this.profiles.set(tabId, { owner: v.owner, preset: v.preset })
        }
      }
    }
    if (this.profiles.size > 0) {
      this.ensureLease()
      if (this.target !== '') await this.reconcile()
      else void this.deps.cli.probe().catch(() => {})
    }
  }

  /** Deletes the owners' idle sessions that no frame holds, as after a restart. */
  private async reconcile(): Promise<void> {
    const sessions = await this.deps.cli.sessions()
    if (sessions === null) return
    const held = new Set<string>()
    for (const frames of this.frames.values()) {
      for (const f of frames.values()) for (const id of f.idle.keys()) held.add(id)
    }
    const owners = new Set([...this.profiles.values()].map((p) => p.owner))
    await Promise.all(
      sessions
        .filter((s) => owners.has(s.owner) && !s.connected && !held.has(s.id))
        .map((s) => this.deps.cli.deleteSession(s.id)),
    )
  }

  private cliChanged(): void {
    const key = targetKey(this.deps.cli.target())
    if (key === this.target) return
    this.target = key
    this.generation++
    for (const frames of this.frames.values()) {
      for (const f of frames.values()) {
        f.idle.clear()
        f.pending = 0
      }
    }
    const refillEverything = () => {
      for (const tabId of this.profiles.keys()) {
        this.pushAll(tabId)
        this.refillAll(tabId)
      }
    }
    if (key === '') refillEverything()
    else void this.reconcile().finally(refillEverything)
  }

  private async drop(tabId: number): Promise<void> {
    const profile = this.profiles.get(tabId)
    if (profile === undefined) return
    this.profiles.delete(tabId)
    await this.persist()
    if (this.profiles.size === 0) {
      this.stopLease?.()
      this.stopLease = null
    }
    for (const f of this.frames.get(tabId)?.values() ?? []) {
      f.idle.clear()
      f.pending = 0
    }
    const s = this.states.get(tabId)
    if (s) s.poolError = null
    this.pushAll(tabId)
    const owned = (await this.deps.cli.sessions())?.filter((x) => x.owner === profile.owner) ?? []
    await Promise.all(owned.map((x) => this.deps.cli.deleteSession(x.id)))
  }

  private release(frame: Frame): void {
    for (const id of frame.idle.keys()) void this.deps.cli.deleteSession(id)
    frame.idle.clear()
  }

  private refillAll(tabId: number): void {
    for (const frameId of this.frames.get(tabId)?.keys() ?? []) this.refill(tabId, frameId)
  }

  private refill(tabId: number, frameId: number): void {
    const profile = this.profiles.get(tabId)
    const frame = this.frames.get(tabId)?.get(frameId)
    if (profile === undefined || frame === undefined) return
    if (this.deps.cli.target() === null) {
      this.setPoolError(tabId, 'unreachable')
      return
    }
    const generation = this.generation
    for (let n = frame.want - frame.idle.size - frame.pending; n > 0; n--) {
      frame.pending++
      const preset = profile.preset
      void this.deps.cli.createSession(profile.owner, preset).then((r) => {
        const stale =
          generation !== this.generation ||
          this.profiles.get(tabId) !== profile ||
          this.frames.get(tabId)?.get(frameId) !== frame
        if (!stale) frame.pending--
        if ('error' in r) {
          if (!stale) this.setPoolError(tabId, r.error)
          return
        }
        if (stale) {
          void this.deps.cli.deleteSession(r.id)
          return
        }
        frame.idle.set(r.id, { id: r.id, port: r.port, secret: r.secret })
        if (profile.preset !== preset) void this.deps.cli.setSessionPreset(r.id, profile.preset)
        this.setPoolError(tabId, null)
        this.push(tabId, frameId)
      })
    }
  }

  private ensureLease(): void {
    this.stopLease ??= this.deps.every(LEASE_MS, () => void this.leaseTick())
  }

  private async leaseTick(): Promise<void> {
    if (this.deps.cli.target() === null) await this.deps.cli.probe().catch(() => {})
    for (const [tabId, profile] of [...this.profiles]) {
      if (!(await this.deps.tabExists(tabId).catch(() => false))) {
        await this.tabRemoved(tabId)
        continue
      }
      const ok = await this.deps.cli.renewLease(profile.owner)
      if (!ok) this.setPoolError(tabId, 'unreachable')
      else if (this.states.get(tabId)?.poolError) this.refillAll(tabId)
    }
  }

  private pushAll(tabId: number): void {
    for (const frameId of this.frames.get(tabId)?.keys() ?? []) this.push(tabId, frameId)
  }

  private push(tabId: number, frameId: number): void {
    const frame = this.frames.get(tabId)?.get(frameId)
    if (frame === undefined) return
    const on = this.profiles.has(tabId)
    this.deps.sendToFrame(tabId, frameId, {
      type: 'impair:pool',
      on,
      certHash: this.deps.cli.target()?.certHash ?? null,
      entries: on ? [...frame.idle.values()] : [],
      want: frame.want,
    })
  }

  private setPoolError(tabId: number, error: PoolError | null): void {
    const s = this.state(tabId)
    if (s.poolError === error) return
    s.poolError = error
    this.emit(tabId)
  }

  private state(tabId: number): TabState {
    let s = this.states.get(tabId)
    if (s === undefined) {
      s = { failure: null, poolError: null }
      this.states.set(tabId, s)
    }
    return s
  }

  private framesOf(tabId: number): Map<number, Frame> {
    let f = this.frames.get(tabId)
    if (f === undefined) {
      f = new Map()
      this.frames.set(tabId, f)
    }
    return f
  }

  private persist(): Promise<void> {
    const out: Record<string, Profile> = {}
    for (const [tabId, p] of this.profiles) out[tabId] = { owner: p.owner, preset: p.preset }
    return this.deps.store.set(PROFILES_KEY, out).catch(() => {})
  }

  private emit(tabId: number): void {
    const v = this.view(tabId)
    for (const fn of this.listeners) fn(v)
  }
}
