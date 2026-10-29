import { describe, expect, it } from 'vitest'
import type { ImpairPageMsg, TabAnswer, WorkerImpairMsg } from './messages'
import { ANSWER_WAIT_MS, PageRoute, type Timers } from './page-route'

const ROUTE = { port: 50123, token: 'BwcHBwcHBwcHBwcHBwcHBw', certHash: 'C'.repeat(43) }
const ON: TabAnswer = { on: true, route: ROUTE }
const OFF: TabAnswer = { on: false, route: null }
const BASE = 'https://player.example/'
const URL1 = 'https://relay.example/moq'

function setup(any: boolean) {
  const posted: ImpairPageMsg[] = []
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
  const fake: Timers = {
    set: (fn, ms) => {
      const t = { fn, ms, cleared: false }
      timers.push(t)
      return t
    },
    clear: (h) => void ((h as { cleared: boolean }).cleared = true),
  }
  const route = new PageRoute(() => any, (m) => void posted.push(m), fake)
  const expire = () => {
    for (const t of timers) if (!t.cleared) t.fn()
  }
  return { route, posted, timers, expire }
}

describe('PageRoute', () => {
  it('connects directly at once when no tab has a profile, and starts no timer', () => {
    const { route, timers } = setup(false)
    expect(route.route(URL1, BASE, undefined)).toBeNull()
    expect(timers).toEqual([])
  })

  it('waits while some tab has a profile, then routes everything waiting', () => {
    const { route, timers } = setup(true)
    expect(route.route(URL1, BASE, undefined)).toBe('wait')
    expect(timers.map((t) => t.ms)).toEqual([ANSWER_WAIT_MS])
    const ran: unknown[] = []
    route.wait(() => ran.push(route.route(URL1, BASE, undefined)))
    route.wait(() => ran.push(route.route(URL1, BASE, undefined)))
    expect(ran).toEqual([])
    route.apply(ON)
    expect(ran).toHaveLength(2)
    expect(ran.every((r) => typeof r === 'object' && r !== null && 'url' in r)).toBe(true)
    expect(timers[0]!.cleared).toBe(true)
  })

  it('decides synchronously once it has the answer', () => {
    const { route } = setup(true)
    route.apply(OFF)
    expect(route.route(URL1, BASE, undefined)).toBeNull()
    route.apply(ON)
    expect(route.route(URL1, BASE, undefined)).toHaveProperty('url')
    let ran = false
    route.wait(() => void (ran = true))
    expect(ran).toBe(true)
  })

  it('refuses a malformed URL at once rather than waiting', () => {
    const { route } = setup(true)
    expect(route.route('http://relay.example/', BASE, undefined)).toMatchObject({ name: 'SyntaxError' })
  })

  it('refuses what waits when the answer never comes, and says so', () => {
    const { route, posted, expire } = setup(true)
    expect(route.route(URL1, BASE, undefined)).toBe('wait')
    let after: unknown
    route.wait(() => void (after = route.route(URL1, BASE, undefined)))
    expire()
    expect(after).toMatchObject({ failure: 'no-answer' })
    expect(posted).toEqual([{ type: 'impair:failed', failure: 'no-answer', url: URL1 }])
    route.apply(OFF)
    expect(route.route(URL1, BASE, undefined)).toBeNull()
  })

  it('refuses while the tab has a profile but no CLI port, and says so', () => {
    const { route, posted } = setup(true)
    route.apply({ on: true, route: null })
    expect(route.route(URL1, BASE, undefined)).toMatchObject({ failure: 'no-cli' })
    expect(posted).toEqual([{ type: 'impair:failed', failure: 'no-cli', url: URL1 }])
  })

  it('holds reports until the answer, and drops them for a tab without a profile', () => {
    const a = setup(true)
    a.route.report('worker-uninstrumented', 'https://player.example/w.js')
    expect(a.posted).toEqual([])
    a.route.apply(ON)
    expect(a.posted).toEqual([{ type: 'impair:failed', failure: 'worker-uninstrumented', url: 'https://player.example/w.js' }])
    const b = setup(true)
    b.route.report('worker-uninstrumented', 'https://player.example/w.js')
    b.route.apply(OFF)
    expect(b.posted).toEqual([])
  })

  it("names a CSP block from the constructor's SecurityError", () => {
    const { route, posted } = setup(true)
    route.apply(ON)
    route.threw(URL1, new DOMException('csp', 'SecurityError'))
    route.threw(URL1, new TypeError('other'))
    expect(posted).toEqual([{ type: 'impair:failed', failure: 'blocked-by-page', url: URL1 }])
  })

  it('starts workers with the state it has and tells them each change', () => {
    const { route, expire } = setup(true)
    const got: WorkerImpairMsg[] = []
    const init = route.addWorker({ post: (m) => void got.push(m) })
    expect(init).toEqual({ source: 'moqtap-impair-worker', any: true, answer: null })
    route.route(URL1, BASE, undefined)
    expire()
    route.apply(ON)
    expect(got.map((m) => m.answer)).toEqual(['unanswered', ON])
    const link = { post: (m: WorkerImpairMsg) => void got.push(m) }
    route.addWorker(link)
    route.removeWorker(link)
    route.apply(OFF)
    expect(got.map((m) => m.answer)).toEqual(['unanswered', ON, OFF])
  })
})
