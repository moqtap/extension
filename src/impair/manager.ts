/**
 * The background's side of tab impairment.
 *
 * Picking a profile opens one tab port at the CLI, kept for the tab's
 * lifetime: profile changes switch it and every session in it live, and Off
 * leaves its sessions running unimpaired while new ones connect directly. A
 * session can have its own profile until the tab's changes. The
 * port and token reach every frame of the tab; a registered MAIN-world script
 * tells documents that start while any tab has a profile to wait for them.
 */

import type { KeyValueArea } from '@/src/account/stores'
import type { ImpairFailure, SessionFailure, SessionImpairment, TabError, TabImpairment } from '@/src/cli/messages'
import { isId16, isOff, isProfile, OFF, sameProfile, type CliTab, type Profile, type Refusal } from '@/src/cli/protocol'
import type { CliTarget, CreateResult, SwitchResult } from '@/src/cli/service'
import type { TabAnswer, TabAnswerMsg } from './messages'

export const PROFILES_KEY = 'moqtap-impair-tabs'
export const LEASE_MS = 10_000
export const OFF_NAME = 'Off'

export interface ImpairCli {
  target(): CliTarget | null
  probe(): Promise<void>
  onChange(fn: () => void): () => void
  createTab(owner: string, profile: Profile): Promise<CreateResult>
  setTabProfile(id: string, profile: Profile): Promise<SwitchResult>
  setSessionProfile(id: string, profile: Profile | null): Promise<SwitchResult>
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

/** A session's own profile and its name. */
type Own = Omit<SessionImpairment, 'session'>

interface TabProfile {
  readonly owner: string
  profile: Profile
  name: string
  held: Held | null
  /** Sessions with their own profile at the CLI, by CLI session id. */
  own: Map<string, Own>
  /** Sessions whose last profile change the CLI did not take. */
  failed: Map<string, Omit<SessionFailure, 'session'>>
  /** Sessions the CLI last listed with a profile that is neither the tab's nor their own. */
  unknown: Set<string>
  /** No tab port yet and none has failed to open; frames wait instead of hearing route null. */
  pending: boolean
}

interface TabState {
  failure: ImpairFailure | null
  error: TabError | null
  refusal: Refusal | null
  refusedName: string | null
}

const sameRefusal = (a: Refusal | null, b: Refusal | null) =>
  a?.error === b?.error && a?.upgrade?.plan === b?.upgrade?.plan && a?.upgrade?.url === b?.upgrade?.url

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
    // A tab port the CLI refused to open impairs nothing.
    const none = p === undefined || (p.held === null && s?.error === 'refused')
    return {
      tabId,
      profile: none ? OFF : p.profile,
      name: none ? OFF_NAME : p.name,
      sessions: [...(p?.own ?? [])].map(([session, o]) => ({ session, ...o })),
      unknown: [...(p?.unknown ?? [])],
      sessionErrors: [...(p?.failed ?? [])].map(([session, f]) => ({ session, ...f })),
      failure: s?.failure ?? null,
      error: s?.error ?? (this.flagFailed && p !== undefined && !isOff(p.profile) ? 'flag' : null),
      refusal: s?.refusal ?? null,
      refusedName: s?.refusedName ?? null,
    }
  }

  onTab(fn: (tab: TabImpairment) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  setProfile(tabId: number, profile: Profile, name: string): Promise<void> {
    return this.serial(() => this.switchTo(tabId, profile, name))
  }

  /** Gives one session in the tab its own profile, or with null the tab's again. */
  setSessionProfile(tabId: number, session: string, own: Own | null): Promise<void> {
    return this.serial(() => this.switchSession(tabId, session, own))
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

  /** The user dismissed the tab's refusal: the notice and the button's warning go. */
  clearError(tabId: number): Promise<void> {
    return this.serial(async () => this.setError(tabId, null))
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
    // A new pick, Off included, replaces whatever the last one ran into.
    const s = this.state(tabId)
    s.failure = null
    s.error = null
    s.refusal = null
    s.refusedName = null
    let p = this.profiles.get(tabId)
    if (p === undefined) {
      if (isOff(profile)) {
        this.emit(tabId)
        return
      }
      p = { owner: this.deps.newOwner(), profile, name, held: null, own: new Map(), failed: new Map(), unknown: new Set(), pending: true }
      this.profiles.set(tabId, p)
      this.ensureLease()
    } else {
      const before = { profile: p.profile, name: p.name }
      p.profile = profile
      p.name = name
      if (p.held !== null) {
        const r = await this.deps.cli.setTabProfile(p.held.id, profile)
        if (r === 'gone') drop(p)
        else if (typeof r === 'object' || r === 'not-allowed' || r === 'protocol') {
          // The CLI keeps the tab's previous profile.
          p.profile = before.profile
          p.name = before.name
          if (typeof r === 'object') this.setError(tabId, 'refused', r.refused, name)
          else this.setError(tabId, r, null, name)
        } else this.setError(tabId, r === 'ok' ? null : r)
        // The CLI drops sessions' own profiles on a tab switch.
        if (r === 'ok') {
          p.own.clear()
          p.failed.clear()
          p.unknown.clear()
        }
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

  private async switchSession(tabId: number, session: string, own: Own | null): Promise<void> {
    const p = this.profiles.get(tabId)
    if (p === undefined || p.held === null) {
      this.emit(tabId)
      return
    }
    const r = await this.deps.cli.setSessionProfile(session, own?.profile ?? null)
    p.failed.delete(session)
    if (r === 'ok') p.unknown.delete(session)
    if (r === 'ok' && own !== null) p.own.set(session, own)
    else if (r === 'ok' || r === 'gone') p.own.delete(session)
    else if (typeof r === 'object') p.failed.set(session, { error: 'refused', refusal: r.refused })
    else p.failed.set(session, { error: r, refusal: null })
    await this.persist()
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
        if (r.error === 'unreachable') {
          this.setError(tabId, 'unreachable')
          return
        }
        // A pick the CLI will not open impairs nothing and is not retried.
        if (this.profiles.get(tabId) === p) this.profiles.delete(tabId)
        this.setError(tabId, r.error, 'refused' in r ? r.refused : null, p.name)
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
        const own = new Map(held === null ? [] : restoreOwn(v.own))
        this.profiles.set(tabId, {
          owner: v.owner,
          profile: v.profile,
          name: v.name,
          held,
          own,
          failed: new Map(),
          unknown: new Set(),
          pending: held === null,
        })
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
      // A lease says nothing about a refused switch: that stays until a profile is taken.
      if (!ok) this.setError(tabId, 'unreachable')
      else if (this.states.get(tabId)?.error === 'unreachable') this.setError(tabId, null)
    }
    const listed = t === null ? null : await this.deps.cli.tabs()
    const changed = new Set<number>()
    for (const [tabId, p] of [...this.profiles]) {
      const held = p.held
      const at = held === null ? undefined : listed?.find((x) => x.id === held.id)
      if (held !== null && listed !== null && at === undefined) drop(p)
      if (at !== undefined && this.reconcile(p, at)) changed.add(tabId)
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
      } else if (changed.has(tabId)) {
        this.emit(tabId)
      }
    }
  }

  /** Matches the sessions to what the CLI lists; true when anything changed. */
  private reconcile(p: TabProfile, at: CliTab): boolean {
    let changed = false
    for (const session of new Set([...p.own.keys(), ...p.failed.keys()])) {
      if (!at.sessions.some((s) => s.id === session)) {
        p.own.delete(session)
        p.failed.delete(session)
        changed = true
      }
    }
    const unknown = new Set<string>()
    for (const s of at.sessions) {
      const own = p.own.get(s.id)
      if (own !== undefined && !sameProfile(s.profile, own.profile)) {
        p.own.delete(s.id)
        changed = true
      }
      if (!p.own.has(s.id) && !sameProfile(s.profile, p.profile)) unknown.add(s.id)
    }
    if (unknown.size !== p.unknown.size || [...unknown].some((s) => !p.unknown.has(s))) changed = true
    p.unknown = unknown
    return changed
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

  private setError(
    tabId: number,
    error: TabError | null,
    refusal: Refusal | null = null,
    refusedName: string | null = null,
  ): void {
    const s = this.state(tabId)
    if (s.error === error && sameRefusal(s.refusal, refusal) && s.refusedName === refusedName) return
    s.error = error
    s.refusal = refusal
    s.refusedName = refusedName
    this.emit(tabId)
  }

  private state(tabId: number): TabState {
    let s = this.states.get(tabId)
    if (s === undefined) {
      s = { failure: null, error: null, refusal: null, refusedName: null }
      this.states.set(tabId, s)
    }
    return s
  }

  private persist(): Promise<void> {
    const out: Record<string, unknown> = {}
    for (const [tabId, p] of this.profiles) {
      out[tabId] = { owner: p.owner, profile: p.profile, name: p.name, held: p.held, own: Object.fromEntries(p.own) }
    }
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
  p.own.clear()
  p.failed.clear()
  p.unknown.clear()
  p.pending = true
}

function restoreOwn(raw: unknown): [string, Own][] {
  if (typeof raw !== 'object' || raw === null) return []
  return Object.entries(raw as Record<string, Record<string, unknown> | null>).flatMap(([session, o]) =>
    isId16(session) && o !== null && typeof o === 'object' && isProfile(o.profile) && typeof o.name === 'string'
      ? [[session, { profile: o.profile, name: o.name }] as [string, Own]]
      : [],
  )
}

const targetKey = (t: CliTarget | null) => (t === null ? '' : `${t.identity} ${t.port} ${t.certHash}`)
