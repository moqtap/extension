import { describe, expect, it } from 'vitest'
import { toBase64Url } from '@/src/cli/protocol'
import type { ImpairPageMsg, PoolEntry, PoolMsg, WorkerImpairMsg } from './messages'
import { PagePool, type WorkerLink } from './page-pool'
import type { Routed } from './route'

const CERT = toBase64Url(new Uint8Array(32).fill(1))
const BASE = 'https://player.example/'
const SECRET = toBase64Url(new Uint8Array(16).fill(5))
const entry = (n: number): PoolEntry => ({ id: `id-${n}`, port: 50000 + n, secret: SECRET })
const snapshot = (entries: PoolEntry[], extra: Partial<PoolMsg> = {}): PoolMsg => ({
  type: 'impair:pool',
  on: true,
  certHash: CERT,
  entries,
  want: 2,
  ...extra,
})

function make(reserve = 2) {
  const posted: ImpairPageMsg[] = []
  return { pool: new PagePool(reserve, (m) => posted.push(m)), posted }
}

function worker() {
  const got: WorkerImpairMsg[] = []
  const link: WorkerLink = { post: (m) => got.push(m) }
  return { link, got }
}

const secretOf = (r: ReturnType<PagePool['route']>) =>
  r !== null && 'url' in r ? new URL(r.url).pathname.split('/')[3] : null

const portOf =(r: ReturnType<PagePool['route']>) =>
  r !== null && 'url' in r ? Number(new URL(r.url).port) : null

describe('PagePool', () => {
  it('connects directly while the tab has no profile', () => {
    const { pool, posted } = make()
    expect(pool.route('https://relay.example/moq', BASE, undefined)).toBeNull()
    pool.apply(snapshot([entry(1)], { on: false }))
    expect(pool.route('https://relay.example/moq', BASE, undefined)).toBeNull()
    expect(posted).toEqual([])
  })

  it('takes idle sessions in order and reports each one', () => {
    const { pool, posted } = make()
    pool.apply(snapshot([entry(1), entry(2)]))
    const first = pool.route('https://relay.example/a', BASE, undefined)
    expect(portOf(first)).toBe(50001)
    expect(secretOf(first)).toBe(SECRET)
    expect(posted).toEqual([])
    pool.opened(first as Routed)
    const second = pool.route('https://relay.example/b', BASE, undefined)
    expect(portOf(second)).toBe(50002)
    pool.opened(second as Routed)
    expect(posted).toEqual([
      { type: 'impair:took', id: 'id-1' },
      { type: 'impair:took', id: 'id-2' },
    ])
  })

  it('keeps the session when the constructor throws, and names a CSP block', () => {
    const { pool, posted } = make()
    pool.apply(snapshot([entry(1), entry(2)]))
    const r = pool.route('https://relay.example/a', BASE, undefined) as Routed
    pool.threw(r, 'https://relay.example/a', new DOMException('Refused to connect', 'SecurityError'))
    expect(posted).toEqual([{ type: 'impair:failed', failure: 'blocked-by-page', url: 'https://relay.example/a' }])
    const again = pool.route('https://relay.example/a', BASE, undefined) as Routed
    expect(portOf(again)).toBe(50001)
    pool.threw(again, 'https://relay.example/a', new TypeError('bad congestionControl'))
    expect(posted).toHaveLength(1)
    expect(portOf(pool.route('https://relay.example/a', BASE, undefined))).toBe(50001)
  })

  it('fails visibly when the pool is empty, and never connects directly', () => {
    const { pool, posted } = make()
    pool.apply(snapshot([entry(1)]))
    pool.route('https://relay.example/a', BASE, undefined)
    const r = pool.route('https://relay.example/b', BASE, undefined)
    expect(r !== null && 'refused' in r).toBe(true)
    expect(posted.at(-1)).toEqual({ type: 'impair:failed', failure: 'no-session', url: 'https://relay.example/b' })
  })

  it('fails visibly without a CLI certificate', () => {
    const { pool } = make()
    pool.apply(snapshot([entry(1)], { certHash: null }))
    const r = pool.route('https://relay.example/a', BASE, undefined)
    expect(r !== null && 'refused' in r).toBe(true)
  })

  it('keeps the session when the URL itself is refused', () => {
    const { pool, posted } = make()
    pool.apply(snapshot([entry(1)]))
    const r = pool.route('http://relay.example/a', BASE, undefined)
    expect(r !== null && 'refused' in r).toBe(true)
    expect(posted).toEqual([])
    expect(portOf(pool.route('https://relay.example/a', BASE, undefined))).toBe(50001)
  })

  it('keeps the session and tells the panel when the page offers protocols', () => {
    const { pool, posted } = make()
    pool.apply(snapshot([entry(1)]))
    const r = pool.route('https://relay.example/a', BASE, { protocols: ['moqt-16'] })
    expect(r !== null && 'refused' in r).toBe(true)
    expect(posted).toEqual([{ type: 'impair:failed', failure: 'protocols', url: 'https://relay.example/a' }])
    expect(portOf(pool.route('https://relay.example/a', BASE, undefined))).toBe(50001)
  })

  it('never hands out a taken session again when a refill crosses the report', () => {
    const { pool } = make()
    pool.apply(snapshot([entry(1)]))
    pool.route('https://relay.example/a', BASE, undefined)
    pool.apply(snapshot([entry(1), entry(2)]))
    expect(portOf(pool.route('https://relay.example/b', BASE, undefined))).toBe(50002)
  })

  it('gives each worker a session of its own and refills it after use', () => {
    const { pool, posted } = make()
    pool.apply(snapshot([entry(1), entry(2), entry(3)]))
    const w = worker()
    expect(pool.addWorker(w.link)).toEqual({
      source: 'moqtap-impair-worker',
      on: true,
      known: true,
      certHash: CERT,
      entry: entry(1),
    })
    expect(posted).toContainEqual({ type: 'impair:want', count: 3 })
    pool.workerTook(w.link, 'id-1')
    expect(posted).toContainEqual({ type: 'impair:took', id: 'id-1' })
    expect(w.got.at(-1)?.entry).toEqual(entry(2))
    expect(portOf(pool.route('https://relay.example/a', BASE, undefined))).toBe(50003)
  })

  it('does not give a worker-held session to the page', () => {
    const { pool } = make()
    pool.apply(snapshot([entry(1)]))
    const w = worker()
    pool.addWorker(w.link)
    pool.apply(snapshot([entry(1), entry(2)]))
    expect(w.got.at(-1)?.entry).toEqual(entry(1))
    expect(portOf(pool.route('https://relay.example/a', BASE, undefined))).toBe(50002)
  })

  it('releases the session of a terminated worker', () => {
    const { pool, posted } = make()
    pool.apply(snapshot([entry(1)]))
    const w = worker()
    pool.addWorker(w.link)
    pool.removeWorker(w.link)
    expect(posted).toContainEqual({ type: 'impair:release', id: 'id-1' })
    expect(posted.at(-1)).toEqual({ type: 'impair:want', count: 2 })
  })

  it('switches workers off with the tab', () => {
    const { pool } = make()
    pool.apply(snapshot([entry(1)]))
    const w = worker()
    pool.addWorker(w.link)
    pool.apply(snapshot([], { on: false, certHash: null }))
    expect(w.got.at(-1)).toEqual({ source: 'moqtap-impair-worker', on: false, known: true, certHash: null, entry: null })
  })

  describe('before the first message', () => {
    function early(marked: boolean) {
      const posted: ImpairPageMsg[] = []
      const remembered: boolean[] = []
      const pool = new PagePool(2, (m) => posted.push(m), marked, (on) => remembered.push(on))
      return { pool, posted, remembered }
    }

    it('refuses when the tab had a profile, and reports once the bridge answers', () => {
      const { pool, posted } = early(true)
      const r = pool.route('https://relay.example/a', BASE, undefined)
      expect(r !== null && 'refused' in r).toBe(true)
      expect(posted).toEqual([])
      pool.apply(snapshot([entry(1)]))
      expect(posted).toContainEqual({ type: 'impair:failed', failure: 'no-session', url: 'https://relay.example/a' })
    })

    it('gives a worker a refusing state when the tab had a profile', () => {
      const { pool } = early(true)
      expect(pool.addWorker(worker().link)).toMatchObject({ on: true, known: false, entry: null })
    })

    it('connects directly otherwise, and reports it if the tab turns out to have a profile', () => {
      const { pool, posted } = early(false)
      expect(pool.route('https://relay.example/a', BASE, undefined)).toBeNull()
      pool.apply(snapshot([entry(1)]))
      expect(posted).toContainEqual({ type: 'impair:failed', failure: 'opened-early', url: 'https://relay.example/a' })
    })

    it('drops its reports when the tab has no profile', () => {
      const { pool, posted } = early(true)
      pool.route('https://relay.example/a', BASE, undefined)
      pool.report('worker-uninstrumented', 'https://player.example/w.js')
      pool.apply(snapshot([], { on: false }))
      expect(posted.filter((m) => m.type === 'impair:failed')).toEqual([])
    })

    it('records the answer for the next document', () => {
      const { pool, remembered } = early(false)
      pool.apply(snapshot([entry(1)]))
      pool.apply(snapshot([], { on: false }))
      expect(remembered).toEqual([true, false])
    })
  })

  it('reports an uninstrumented worker only while the tab has a profile', () => {
    const { pool, posted } = make()
    pool.apply(snapshot([], { on: false }))
    pool.report('worker-uninstrumented', 'https://player.example/w.js')
    expect(posted).toEqual([])
    pool.apply(snapshot([entry(1)]))
    pool.report('worker-uninstrumented', 'https://player.example/w.js')
    expect(posted).toContainEqual({
      type: 'impair:failed',
      failure: 'worker-uninstrumented',
      url: 'https://player.example/w.js',
    })
  })
})
