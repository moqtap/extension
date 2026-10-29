/**
 * A frame's answer to "does this tab's next session go through the CLI?",
 * held in the MAIN world so the WebTransport hook can decide synchronously,
 * and passed on to the frame's instrumented workers.
 *
 * Until the background answers, a frame waits only when some tab had a
 * profile as the document started; otherwise it connects directly.
 */

import type { ImpairFailure } from '@/src/cli/messages'
import type { ImpairPageMsg, RouteState, TabAnswer, WorkerImpairMsg } from './messages'
import { checkUrl, decide, routeThroughCli, type Refused, type Route } from './route'

/** How long a frame waits for its tab's answer before refusing what waits. */
export const ANSWER_WAIT_MS = 10_000

export interface WorkerLink {
  post(msg: WorkerImpairMsg): void
}

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/** Failure reports held before the answer; the rest are dropped. */
const MAX_EARLY = 16

export class PageRoute {
  private answer: TabAnswer | 'unanswered' | null = null
  private waiters: (() => void)[] = []
  private early: { failure: ImpairFailure; url: string }[] = []
  private readonly workers = new Set<WorkerLink>()
  private timer: unknown = null

  /** @param any whether some tab had a profile as this document started */
  constructor(
    private readonly any: () => boolean,
    private readonly post: (msg: ImpairPageMsg) => void,
    private readonly timers: Timers = {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
  ) {}

  state(): RouteState {
    return { any: this.any(), answer: this.answer }
  }

  apply(answer: TabAnswer): void {
    if (this.timer !== null) {
      this.timers.clear(this.timer)
      this.timer = null
    }
    this.answer = answer
    const early = this.early
    this.early = []
    for (const f of early) this.report(f.failure, f.url)
    this.settled()
  }

  route(target: unknown, base: string, options: unknown): Route | null | 'wait' {
    const d = decide(this.state(), target, base, options, routeThroughCli)
    if (d === 'wait') {
      const bad = checkUrl(target, base)
      if (bad !== null) return { refused: bad, name: 'SyntaxError' } satisfies Refused
      this.timer ??= this.timers.set(() => this.unanswered(), ANSWER_WAIT_MS)
      return 'wait'
    }
    if (d !== null && 'refused' in d && d.failure !== undefined) this.report(d.failure, String(target))
    return d
  }

  /** Runs `fn` once {@link route} answers without waiting. */
  wait(fn: () => void): void {
    if (this.answer !== null) fn()
    else this.waiters.push(fn)
  }

  threw(url: string, err: unknown): void {
    if ((err as { name?: unknown } | null)?.name === 'SecurityError') this.report('blocked-by-page', url)
  }

  /**
   * Tells the panel why a session in this frame is not impaired. Dropped once
   * the tab is known to have no profile.
   */
  report(failure: ImpairFailure, url: string): void {
    const a = this.answer
    if (a === null) {
      if (this.early.length < MAX_EARLY) this.early.push({ failure, url })
    } else if (a === 'unanswered' || a.on) {
      this.post({ type: 'impair:failed', failure, url })
    }
  }

  /** A new worker; the message to start it with. */
  addWorker(link: WorkerLink): WorkerImpairMsg {
    this.workers.add(link)
    return this.forWorker()
  }

  removeWorker(link: WorkerLink): void {
    this.workers.delete(link)
  }

  private unanswered(): void {
    this.timer = null
    if (this.answer !== null) return
    this.answer = 'unanswered'
    this.settled()
  }

  private settled(): void {
    const msg = this.forWorker()
    for (const w of this.workers) {
      try {
        w.post(msg)
      } catch {
        // The worker is gone.
      }
    }
    const waiters = this.waiters
    this.waiters = []
    for (const fn of waiters) fn()
  }

  private forWorker(): WorkerImpairMsg {
    return { source: 'moqtap-impair-worker', ...this.state() }
  }
}
