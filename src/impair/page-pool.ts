/**
 * A frame's share of its tab's idle CLI sessions, held in the MAIN world so
 * the WebTransport hook can take one synchronously. Each instrumented worker
 * holds one more, handed to it by this pool.
 *
 * Until the background's first message the pool does not know whether the
 * tab has a profile. It assumes what the tab's previous document in this
 * origin recorded, and holds its failure reports until it knows.
 */

import type { ImpairFailure } from '@/src/cli/messages'
import type { ImpairPageMsg, PoolEntry, PoolMsg, WorkerImpairMsg } from './messages'
import { routeThroughCli, type Refused, type Routed } from './route'

/** Idle sessions a frame keeps for itself: the top frame opens most sessions. */
export const RESERVE_TOP = 2
export const RESERVE_SUBFRAME = 1
/** Upper bound on what a frame asks for, workers included. */
export const MAX_WANT = 8

export interface WorkerLink {
  post(msg: WorkerImpairMsg): void
}

export const NO_SESSION_MESSAGE =
  'moqtap impairment: no moqtap CLI session was ready, so this connection was not opened. The DevTools panel says why.'

/** Failure reports held before the first message; the rest are dropped. */
const MAX_EARLY = 16

export class PagePool {
  private on: boolean
  private known = false
  private early: { failure: ImpairFailure; url: string }[] = []
  private certHash: string | null = null
  private entries: PoolEntry[] = []
  /** Taken here or by a worker: never handed out again. */
  private readonly used = new Set<string>()
  /** Routed, waiting for the constructor's verdict. */
  private readonly held = new Map<string, PoolEntry>()
  private readonly workers = new Map<WorkerLink, PoolEntry | null>()
  private asked: number | null = null

  /**
   * @param marked the tab had a profile when this origin's previous document
   *   in it last heard; `remember` records the current answer for the next.
   */
  constructor(
    private readonly reserve: number,
    private readonly post: (msg: ImpairPageMsg) => void,
    marked = false,
    private readonly remember: (on: boolean) => void = () => {},
  ) {
    this.on = marked
  }

  apply(msg: PoolMsg): void {
    this.on = msg.on
    this.certHash = msg.certHash
    this.remember(msg.on)
    if (!this.known) {
      this.known = true
      const early = this.early
      this.early = []
      for (const f of early) this.report(f.failure, f.url)
    }
    const held = new Set<string>()
    for (const e of this.workers.values()) if (e !== null) held.add(e.id)
    this.entries = msg.on ? msg.entries.filter((e) => !this.used.has(e.id) && !held.has(e.id)) : []
    if (!msg.on) {
      for (const w of this.workers.keys()) this.workers.set(w, null)
    }
    for (const w of this.workers.keys()) this.feed(w)
    this.asked = msg.want
    this.askIfNeeded()
  }

  /**
   * Where a new session goes: null to connect directly (no profile), or the
   * CLI route. Holds an idle session only when the route is usable; the
   * caller settles it with {@link opened} or {@link threw}.
   */
  route(target: unknown, base: string, options: unknown): Routed | Refused | null {
    if (!this.on) {
      if (!this.known) this.report('opened-early', String(target))
      return null
    }
    const entry = this.entries[0]
    if (entry === undefined || this.certHash === null) {
      this.report('no-session', String(target))
      return { refused: NO_SESSION_MESSAGE }
    }
    const route = routeThroughCli(target, base, options, entry.port, entry.secret, this.certHash)
    if ('refused' in route) {
      if (route.failure !== undefined) this.report(route.failure, String(target))
      return route
    }
    this.entries.shift()
    this.used.add(entry.id)
    this.held.set(entry.id, entry)
    return { ...route, id: entry.id }
  }

  opened(route: Routed): void {
    if (!this.held.delete(route.id)) return
    this.post({ type: 'impair:took', id: route.id })
  }

  /** The session never reached the CLI: its entry goes back for the next one. */
  threw(route: Routed, url: string, err: unknown): void {
    const entry = this.held.get(route.id)
    if (entry === undefined) return
    this.held.delete(route.id)
    this.used.delete(route.id)
    if (this.on) this.entries.unshift(entry)
    if ((err as { name?: unknown } | null)?.name === 'SecurityError') this.report('blocked-by-page', url)
  }

  /**
   * Tells the panel why a session in this frame is not impaired. Dropped once
   * the tab is known to have no profile.
   */
  report(failure: ImpairFailure, url: string): void {
    if (!this.known) {
      if (this.early.length < MAX_EARLY) this.early.push({ failure, url })
    } else if (this.on) {
      this.post({ type: 'impair:failed', failure, url })
    }
  }

  /** A new worker; the message to start it with. */
  addWorker(link: WorkerLink): WorkerImpairMsg {
    const entry = this.on ? (this.entries.shift() ?? null) : null
    this.workers.set(link, entry)
    this.askIfNeeded()
    return this.stateFor(entry)
  }

  /** The worker's hook used its session. */
  workerTook(link: WorkerLink, id: string): void {
    this.used.add(id)
    if (this.workers.get(link)?.id === id) this.workers.set(link, null)
    this.post({ type: 'impair:took', id })
    this.feed(link)
  }

  removeWorker(link: WorkerLink): void {
    if (!this.workers.has(link)) return
    const entry = this.workers.get(link)
    this.workers.delete(link)
    if (entry) {
      this.used.add(entry.id)
      this.post({ type: 'impair:release', id: entry.id })
    }
    this.askIfNeeded()
  }

  private feed(link: WorkerLink): void {
    let entry = this.workers.get(link) ?? null
    if (entry === null && this.on) {
      entry = this.entries.shift() ?? null
      this.workers.set(link, entry)
    }
    try {
      link.post(this.stateFor(entry))
    } catch {
      // The worker is gone.
    }
  }

  private stateFor(entry: PoolEntry | null): WorkerImpairMsg {
    return { source: 'moqtap-impair-worker', on: this.on, known: this.known, certHash: this.certHash, entry }
  }

  private askIfNeeded(): void {
    const want = Math.min(this.reserve + this.workers.size, MAX_WANT)
    if (this.asked === want) return
    this.asked = want
    this.post({ type: 'impair:want', count: want })
  }
}
