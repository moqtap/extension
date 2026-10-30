import { describe, expect, it } from 'vitest'
import {
  acceptAutoExclusion,
  exclusionNotice,
  withExclusion,
  withoutExclusion,
} from '@/src/storage/worker-exclusions'
import { LEGACY_PAGE_KEYS, PageExclusion } from './page-exclusion'

const ORIGIN = 'https://blocked.example'
const SENDER = { origin: ORIGIN }

/** A page's own localStorage, as an older build left it. */
function pageStorage(): Map<string, string> & Pick<Storage, 'removeItem'> {
  const m = new Map<string, string>([
    ['__moqtap_excluded_origins', JSON.stringify([ORIGIN])],
    ['__moqtap_csp_blocked', String(Date.now())],
    ['site-key', 'kept'],
  ]) as Map<string, string> & Pick<Storage, 'removeItem'>
  m.removeItem = (k: string) => void m.delete(k)
  return m
}

/** One page load: the bridge posts its verdict for the origin, if any. */
function load(list: unknown, storage = pageStorage()): PageExclusion {
  const page = new PageExclusion(ORIGIN, storage)
  const notice = exclusionNotice(list, ORIGIN)
  if (notice) page.onMessage(notice)
  return page
}

/** A worker the page's CSP blocks: what reaches the extension's list. */
function cspBlocks(page: PageExclusion, list: unknown): unknown {
  const msg = page.record(`${ORIGIN}/worker.js`, 'blocked by worker-src')
  const accepted = acceptAutoExclusion(msg, SENDER)
  return accepted ? withExclusion(list, accepted.origin, { blockedAt: 2, source: 'auto', error: accepted.error }) : list
}

describe('worker exclusion: the extension list is the only record', () => {
  it('a listed site leaves its workers alone once the verdict arrives', () => {
    const list = withExclusion({}, ORIGIN, { blockedAt: 1, source: 'auto' })
    expect(load(list).excluded).toBe(true)
  })

  it('removing the site brings worker capture back on the next load, whatever the page stored', () => {
    const list = withoutExclusion(withExclusion({}, ORIGIN, { blockedAt: 1, source: 'auto' }), ORIGIN)
    const storage = pageStorage()
    expect(load(list, storage).excluded).toBe(false)
    for (const key of LEGACY_PAGE_KEYS) expect(storage.has(key)).toBe(false)
    expect(storage.get('site-key')).toBe('kept')
  })

  it('a site whose CSP still blocks its workers is listed again automatically', () => {
    let list: unknown = withExclusion({}, ORIGIN, { blockedAt: 1, source: 'auto' })
    list = withoutExclusion(list, ORIGIN)
    const page = load(list)
    expect(page.excluded).toBe(false)
    list = cspBlocks(page, list)
    expect(page.excluded).toBe(true)
    expect(exclusionNotice(list, ORIGIN)).not.toBeNull()
    expect(load(list).excluded).toBe(true)
  })

  it('a removed site that no longer blocks stays off the list', () => {
    const list = withoutExclusion(withExclusion({}, ORIGIN, { blockedAt: 1, source: 'manual' }), ORIGIN)
    expect(list).toEqual({})
    expect(load(list).excluded).toBe(false)
  })

  it('removing one site keeps the others', () => {
    const list = withExclusion(withExclusion({}, ORIGIN, { blockedAt: 1, source: 'auto' }), 'https://other.example', {
      blockedAt: 2,
      source: 'manual',
    })
    expect(Object.keys(withoutExclusion(list, ORIGIN))).toEqual(['https://other.example'])
  })

  it('another message posted to the page is no verdict', () => {
    const page = new PageExclusion(ORIGIN, null)
    page.onMessage({ source: 'moqtap-exclusions', excluded: false })
    page.onMessage({ source: 'something-else', excluded: true })
    expect(page.excluded).toBe(false)
  })

  it('an opaque origin skips its workers after a failure but asks nothing of the extension', () => {
    const page = new PageExclusion('', null)
    expect(page.record('blob:x', 'blocked')).toBeNull()
    expect(page.excluded).toBe(true)
  })
})
