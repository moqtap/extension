import { describe, expect, it } from 'vitest'
import {
  acceptAutoExclusion,
  bareOrigin,
  exclusionNotice,
  MAX_ERROR_LENGTH,
  MAX_EXCLUSIONS,
  readExclusions,
  withExclusion,
} from './worker-exclusions'

const stored = {
  'https://blocked.example': { blockedAt: 1, source: 'auto' },
  'https://elsewhere.example': { blockedAt: 2, source: 'manual' },
}

describe('what a page learns about the exclusion list', () => {
  it('a listed origin gets a bare verdict naming no origin at all', () => {
    const notice = exclusionNotice(stored, 'https://blocked.example')
    expect(notice).toEqual({ source: 'moqtap-exclusions', excluded: true })
    expect(JSON.stringify(notice)).not.toContain('example')
  })

  it('an unlisted origin gets nothing, so most pages see no message', () => {
    expect(exclusionNotice(stored, 'https://other.example')).toBeNull()
    expect(exclusionNotice(stored, 'null')).toBeNull()
    expect(exclusionNotice(undefined, 'https://blocked.example')).toBeNull()
  })

  it('an inherited key on the stored object is not a listing', () => {
    const inherited = Object.create({ 'https://blocked.example': { blockedAt: 1, source: 'auto' } })
    expect(exclusionNotice(inherited, 'https://blocked.example')).toBeNull()
    expect(exclusionNotice(stored, 'constructor')).toBeNull()
  })

  it('a polluted Object.prototype does not list an origin', () => {
    const key = 'https://polluted.example'
    Object.defineProperty(Object.prototype, key, {
      value: { blockedAt: 1, source: 'auto' },
      configurable: true,
    })
    try {
      expect(exclusionNotice({}, key)).toBeNull()
    } finally {
      delete (Object.prototype as Record<string, unknown>)[key]
    }
  })
})

describe('what a content-script message may write', () => {
  const sender = { url: 'https://victim.example/app?x=1', origin: 'https://victim.example' }

  it("a message naming the sender frame's own origin is accepted for that origin", () => {
    const msg = { type: 'worker:csp-recovered', origin: 'https://victim.example', workerUrl: 'x', error: 'csp' }
    expect(acceptAutoExclusion(msg, sender)).toEqual({ origin: 'https://victim.example', error: 'csp' })
  })

  it('a page cannot exclude another origin', () => {
    const forged = { type: 'worker:csp-recovered', origin: 'https://bank.example', workerUrl: '', error: '' }
    expect(acceptAutoExclusion(forged, sender)).toBeNull()
  })

  it('the origin comes from the browser: a sender without one is refused', () => {
    const msg = { type: 'worker:csp-recovered', origin: 'https://victim.example' }
    expect(acceptAutoExclusion(msg, undefined)).toBeNull()
    expect(acceptAutoExclusion(msg, {})).toBeNull()
    expect(acceptAutoExclusion(msg, { url: 'https://victim.example/page' })).toEqual({
      origin: 'https://victim.example',
    })
    expect(acceptAutoExclusion(msg, { origin: 'null', url: 'about:blank' })).toBeNull()
  })

  it('a malformed message is refused', () => {
    for (const m of [null, 'worker:csp-recovered', { type: 'other', origin: 'https://victim.example' }, { type: 'worker:csp-recovered', origin: 42 }]) {
      expect(acceptAutoExclusion(m, sender)).toBeNull()
    }
  })

  it('error text is bounded', () => {
    const msg = { type: 'worker:csp-recovered', origin: 'https://victim.example', error: 'e'.repeat(1_000_000) }
    expect(acceptAutoExclusion(msg, sender)?.error).toHaveLength(MAX_ERROR_LENGTH)
  })

  it('only bare http(s) origins are origins', () => {
    expect(bareOrigin('https://a.example:8443')).toBe('https://a.example:8443')
    for (const v of ['https://a.example/', 'https://a.example/path', 'chrome-extension://abc', 'null', `https://${'a'.repeat(300)}.example`, 7]) {
      expect(bareOrigin(v)).toBeNull()
    }
  })
})

describe('the stored list stays bounded and well formed', () => {
  it('the oldest automatic entries go first past the cap; manual ones stay', () => {
    let list: unknown = { 'https://manual.example': { blockedAt: 0, source: 'manual' } }
    for (let i = 0; i < MAX_EXCLUSIONS + 50; i++) {
      list = withExclusion(list, `https://s${i}.example`, { blockedAt: i + 1, source: 'auto' })
    }
    const keys = Object.keys(list as object)
    expect(keys).toHaveLength(MAX_EXCLUSIONS)
    expect(keys).toContain('https://manual.example')
    expect(keys).toContain(`https://s${MAX_EXCLUSIONS + 49}.example`)
    expect(keys).not.toContain('https://s0.example')
  })

  it('junk already in storage is dropped on read', () => {
    expect(
      readExclusions({
        'https://ok.example': { blockedAt: 1, source: 'auto' },
        'not an origin': { blockedAt: 1, source: 'auto' },
        'https://bad.example': { blockedAt: 'x', source: 'auto' },
        'https://worse.example': 'string',
      }),
    ).toEqual({ 'https://ok.example': { blockedAt: 1, source: 'auto' } })
    expect(readExclusions(['https://ok.example'])).toEqual({})
  })
})
