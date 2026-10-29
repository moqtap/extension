/**
 * The background's side of tab impairment.
 *
 * Picking a profile opens one tab port at the CLI, kept for the tab's
 * lifetime: profile changes switch it and every session in it live, and Off
 * leaves its sessions running unimpaired while new ones connect directly. The
 * port and token reach every frame of the tab; a registered MAIN-world script
 * tells documents that start while any tab has a profile to wait for them.
 */

import type { KeyValueArea } from '@/src/account/stores'
import type { ImpairFailure, TabError, TabImpairment } from '@/src/cli/messages'
import { isOff, isProfile, OFF, type CliTab, type CreatedTab, type Profile } from '@/src/cli/protocol'
import type { CliTarget, CreateError, SwitchResult } from '@/src/cli/service'
import type { TabAnswer, TabAnswerMsg } from './messages'

export const PROFILES_KEY = 'moqtap-impair-tabs'
export const LEASE_MS = 10_000
export const OFF_NAME = 'Off'

export interface ImpairCli {
  target(): CliTarget | null
  probe(): Promise<void>
  onChange(fn: () => void): () => void
  createTab(owner: string, profile: Profile): Promise<CreatedTab | { error: CreateError }>
  setTabProfile(id: string, profile: Profile): Promise<SwitchResult>
  deleteTab(id: string): Promise<void>
  renewLease(owner: string): Promise<boolean>
  tabs(): Promise<CliTab[] | null>
}

export interface ImpairDeps {
  readonly cli: ImpairCli
  /** `storage.session`, so profiles outlive a restart of the background. */
  readonly store: KeyValueArea
  readonly sendToFrame: (tabId: number, frameId: number, msg: TabAnswerMsg) => void
  readonly tabExists: (tabId: number) => Promise<boolean>
  readonly newOwner: () => string
  readonly every: (ms: number, fn: () => void) => () => void
  /** Registers the script that makes new documents wait for their tab's answer, or removes it. */
  readonly setFlag: (any: boolean) => Promise<void>
}

/** The tab port a tab holds at the CLI. */
interface Held {
  readonly id: string
  readonly port: number
  readonly token: string
  readonly certHash: string
  /** The CLI identity that opened it. */
  readonly cli: string
}

interface TabProfile {
  readonly owner: string
  profile: Profile
  name: string
  held: Held | null
  /** No tab port yet and none has failed to open; frames wait instead of hearing route null. */
  pending: boolean
}

interface TabState {
  failure: ImpairFailure | null
  error: TabError | null
}

const isHeld = (v: unknown): v is Held => {
  if (typeof v !== 'object' || v === null) return false
  const h = v as Record<string, unknown>
  return (
    typeof h.id === 'string' &&
    Number.isInteger(h.port) &&
    typeof h.token === 'string' &&
    typeof h.certHash === 'string' &&
    typeof h.cli === 'string'
  )
}

export class ImpairManager {
  private readonly profiles = new Map<number, TabProfile>()
  private readonly frames = new Map<number, Set<number>>()
  private readonly states = new Map<number, TabState>()
  private readonly listeners = new Set<(tab: TabImpairment) => void>()
  private stopLease: (() => void) | null = null
  private flagged: boolean | null = null
  private flagFailed = false
  private readonly deferred = new Set<number>()
  private chain: Promise<unknown> = Promise.resolve()
  private ticking = false
  private target: string
  readonly ready: Promise<void>

  constructor(private readonly deps: ImpairDeps) {
    this.target = targetKey(deps.cli.target())
    deps.cli.onChange(() => this.cliChanged())
    this.ready = this.restore()
  }

  view(tabId: number): TabImpairment {
    const p = this.profiles.get(tabId)
    const s = this.states.get(tabId)
    return {
      tabId,
      profile: p?.profile ?? OFF,
      name: p?.name ?? OFF_NAME,
      failure: s?.failure ?? null,
      error: s?.error ?? (this.flagFailed && p !== undefined && !isOff(p.profile) ? 'flag' : null),
    }
  }

  onTab(fn: (tab: TabImpairment) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  setProfile(tabId: number, profile: Profile, name: string): Promise<void> {
    return this.serial(() => this.switchTo(tabId, profile, name))
  }

  /** A frame's bridge connected: a new document, or a reconnect. */
  frameConnected(tabId: number, frameId: number): void {
    let frames = this.frames.get(tabId)
    if (frames === undefined) {
      frames = new Set()
      this.frames.set(tabId, frames)
    }
    frames.add(frameId)
    if (frameId === 0 && this.states.get(tabId)?.failure) {
      this.state(tabId).failure = null
      this.emit(tabId)
    }
    void this.ready.then(() => this.push(tabId, frameId))
  }

  frameGone(tabId: number, frameId: number): void {
    const frames = this.frames.get(tabId)
    if (frames === undefined) return
    frames.delete(frameId)
    if (frames.size === 0) this.frames.delete(tabId)
  }

  failed(tabId: number, failure: ImpairFailure): void {
    const p = this.profiles.get(tabId)
    if (p === undefined || isOff(p.profile)) return
    this.state(tabId).failure = failure
    this.emit(tabId)
  }

  tabRemoved(tabId: number): Promise<void> {
    return this.serial(() => this.remove(tabId))
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(() => this.ready).then(fn)
    this.chain = run.catch(() => {})
    return run
  }

  private async switchTo(tabId: number, profile: Profile, name: string): Promise<void> {
    this.state(tabId).failure = null
    let p = this.profiles.get(tabId)
    if (p === undefined) {
      if (isOff(profile)) {
        this.emit(tabId)
        return
      }
      p = { owner: this.deps.newOwner(), profile, name, held: null, pending: true }
      this.profiles.set(tabId, p)
      this.ensureLease()
    } else {
      p.profile = profile
      p.name = name
      if (p.held !== null) {
        const r = await this.deps.cli.setTabProfile(p.held.id, profile)
        if (r === 'gone') drop(p)
        else this.setError(tabId, r === 'ok' ? null : r)
      }
    }
    if (p.held === null) {
      if (isOff(profile)) this.profiles.delete(tabId)
      else {
        await this.syncFlag()
        await this.open(tabId, p)
      }
    }
    await this.persist()
    await this.syncFlag()
    this.pushAll(tabId)
    this.emit(tabId)
  }

  private async open(tabId: number, p: TabProfile): Promise<void> {
    try {
      if (this.deps.cli.target() === null) await this.deps.cli.probe().catch(() => {})
      const t = this.deps.cli.target()
      if (t === null) {
        this.setError(tabId, 'unreachable')
        return
      }
      const r = await this.deps.cli.createTab(p.owner, p.profile)
      if ('error' in r) {
        this.setError(tabId, r.error)
        return
      }
      p.held = { id: r.id, port: r.port, token: r.token, certHash: t.certHash, cli: t.identity }
      this.setError(tabId, null)
    } finally {
      p.pending = false
    }
  }

  private async remove(tabId: number): Promise<void> {
    this.frames.delete(tabId)
    this.states.delete(tabId)
    this.deferred.delete(tabId)
    const p = this.profiles.get(tabId)
    if (p === undefined) return
    this.profiles.delete(tabId)
    await this.persist()
    await this.syncFlag()
    if (this.profiles.size === 0) {
      this.stopLease?.()
      this.stopLease = null
    }
    if (p.held !== null) await this.deps.cli.deleteTab(p.held.id)
  }

  private async restore(): Promise<void> {
    const raw = await this.deps.store.get(PROFILES_KEY).catch(() => undefined)
    if (typeof raw === 'object' && raw !== null) {
      for (const [k, v] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
        const tabId = Number(k)
        if (!Number.isInteger(tabId) || typeof v !== 'object' || v === null) continue
        if (typeof v.owner !== 'string' || !isProfile(v.profile) || typeof v.name !== 'string') continue
        const held = isHeld(v.held) ? v.held : null
        if (held === null && isOff(v.profile)) continue
        this.profiles.set(tabId, { owner: v.owner, profile: v.profile, name: v.name, held, pending: held === null })
      }
    }
    await this.syncFlag()
    if (this.profiles.size > 0) {
      this.ensureLease()
      void this.serial(() => this.tick())
    }
  }

  private cliChanged(): void {
    const key = targetKey(this.deps.cli.target())
    if (key === this.target) return
    this.target = key
    if (this.profiles.size > 0) void this.serial(() => this.tick())
  }

  private ensureLease(): void {
    this.stopLease ??= this.deps.every(LEASE_MS, () => {
      if (this.ticking) return
      this.ticking = true
      void this.serial(() => this.tick()).finally(() => {
        this.ticking = false
      })
    })
  }

  /** Renews leases, drops closed tabs, and reopens tab ports the CLI no longer has. */
  private async tick(): Promise<void> {
    if (this.deps.cli.target() === null) await this.deps.cli.probe().catch(() => {})
    const t = this.deps.cli.target()
    const before = new Map([...this.profiles].map(([tabId, p]) => [tabId, p.held]))
    for (const [tabId, p] of [...this.profiles]) {
      if (!(await this.deps.tabExists(tabId).catch(() => false))) {
        await this.remove(tabId)
        continue
      }
      if (p.held === null) continue
      if (t !== null && p.held.cli !== t.identity) {
        drop(p)
        continue
      }
      const ok = await this.deps.cli.renewLease(p.owner)
      this.setError(tabId, ok ? null : 'unreachable')
    }
    const listed = t === null ? null : await this.deps.cli.tabs()
    for (const [tabId, p] of [...this.profiles]) {
      const held = p.held
      if (held !== null && listed !== null && !listed.some((x) => x.id === held.id)) drop(p)
      if (p.held !== null) continue
      if (isOff(p.profile)) this.profiles.delete(tabId)
      else await this.open(tabId, p)
    }
    if (this.profiles.size === 0) {
      this.stopLease?.()
      this.stopLease = null
    }
    await this.persist()
    await this.syncFlag()
    for (const [tabId, held] of before) {
      if (this.profiles.get(tabId)?.held !== held || this.deferred.has(tabId)) {
        this.pushAll(tabId)
        this.emit(tabId)
      }
    }
  }

  private answer(tabId: number): TabAnswer {
    const p = this.profiles.get(tabId)
    if (p === undefined || isOff(p.profile)) return { on: false, route: null }
    const h = p.held
    return { on: true, route: h === null ? null : { port: h.port, token: h.token, certHash: h.certHash } }
  }

  private pushAll(tabId: number): void {
    this.deferred.delete(tabId)
    for (const frameId of this.frames.get(tabId) ?? []) this.push(tabId, frameId)
  }

  private push(tabId: number, frameId: number): void {
    if (!this.frames.get(tabId)?.has(frameId)) return
    const p = this.profiles.get(tabId)
    if (p !== undefined && p.pending && p.held === null && !isOff(p.profile)) {
      this.deferred.add(tabId)
      return
    }
    this.deps.sendToFrame(tabId, frameId, { type: 'impair:tab', answer: this.answer(tabId) })
  }

  /** Retried by every tick until the browser takes it. */
  private async syncFlag(): Promise<void> {
    const any = [...this.profiles.values()].some((p) => !isOff(p.profile))
    if (any !== this.flagged) {
      try {
        await this.deps.setFlag(any)
        this.flagged = any
      } catch (err) {
        console.warn('[moqtap impair]', err)
        this.setFlagFailed(true)
        return
      }
    }
    this.setFlagFailed(false)
  }

  private setFlagFailed(failed: boolean): void {
    if (this.flagFailed === failed) return
    this.flagFailed = failed
    for (const tabId of this.profiles.keys()) this.emit(tabId)
  }

  private setError(tabId: number, error: TabError | null): void {
    const s = this.state(tabId)
    if (s.error === error) return
    s.error = error
    this.emit(tabId)
  }

  private state(tabId: number): TabState {
    let s = this.states.get(tabId)
    if (s === undefined) {
      s = { failure: null, error: null }
      this.states.set(tabId, s)
    }
    return s
  }

  private persist(): Promise<void> {
    const out: Record<string, Omit<TabProfile, 'pending'>> = {}
    for (const [tabId, p] of this.profiles) out[tabId] = { owner: p.owner, profile: p.profile, name: p.name, held: p.held }
    return this.deps.store.set(PROFILES_KEY, out).catch(() => {})
  }

  private emit(tabId: number): void {
    const v = this.view(tabId)
    for (const fn of this.listeners) fn(v)
  }
}

/** Forgets a tab port the CLI no longer has; frames wait while it reopens. */
function drop(p: TabProfile): void {
  p.held = null
  p.pending = true
}

const targetKey = (t: CliTarget | null) => (t === null ? '' : `${t.identity} ${t.port} ${t.certHash}`)
