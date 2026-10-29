import { describe, expect, it } from 'vitest'
import { fromBase64Url, toBase64Url } from '@/src/cli/protocol'
import type { RouteState } from './messages'
import { checkUrl, decide, routeThroughCli, snapshotOptions } from './route'

const CERT = toBase64Url(new Uint8Array(32).fill(9))
const TOKEN = toBase64Url(new Uint8Array(16).fill(7))
const BASE = 'https://player.example/watch/'
const decode = (s: string) => new TextDecoder().decode(fromBase64Url(s)!)

function routed(target: unknown, options?: unknown) {
  const r = routeThroughCli(target, BASE, options, 50123, TOKEN, CERT)
  if ('refused' in r) throw new Error(r.refused)
  return r
}

describe('routeThroughCli', () => {
  it('puts the token, a fresh session id and the page URL in the CONNECT path', () => {
    const r = routed('https://relay.example:4443/moq/live?token=a%20b&x=1')
    const u = new URL(r.url)
    expect(u.origin).toBe('https://127.0.0.1:50123')
    expect(u.search).toBe('')
    const [, moqtap, kind, token, session, url, ...rest] = u.pathname.split('/')
    expect([moqtap, kind, token, rest]).toEqual(['moqtap', 'u', TOKEN, []])
    expect(fromBase64Url(session!)).toHaveLength(16)
    expect(decode(url!)).toBe('https://relay.example:4443/moq/live?token=a%20b&x=1')
  })

  it('picks a new session id for every session', () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => new URL(routed('https://relay.example/moq').url).pathname.split('/')[4]),
    )
    expect(ids.size).toBe(50)
  })

  it('resolves a relative URL against the page and accepts a URL object', () => {
    expect(decode(new URL(routed('/moq').url).pathname.split('/')[5]!)).toBe('https://player.example/moq')
    expect(decode(new URL(routed(new URL('https://relay.example/a')).url).pathname.split('/')[5]!)).toBe(
      'https://relay.example/a',
    )
  })

  it('pins the CLI certificate and keeps the page options, protocols included', () => {
    const r = routed('https://relay.example/moq', {
      protocols: ['moqt-16', 'moqt-15'],
      congestionControl: 'low-latency',
      allowPooling: true,
    })
    expect(r.options.protocols).toEqual(['moqt-16', 'moqt-15'])
    expect(r.options.congestionControl).toBe('low-latency')
    expect('allowPooling' in r.options).toBe(false)
    const hashes = r.options.serverCertificateHashes as { algorithm: string; value: Uint8Array }[]
    expect(hashes).toHaveLength(1)
    expect(hashes[0]!.algorithm).toBe('sha-256')
    expect(Array.from(hashes[0]!.value)).toEqual(new Array(32).fill(9))
  })

  it("carries the page's own certificate hashes as a last segment", () => {
    const value = new Uint8Array(32).fill(3)
    const r = routed('https://relay.example/moq', {
      serverCertificateHashes: [{ algorithm: 'SHA-256', value }, { algorithm: 'sha-256', value: value.buffer }],
    })
    const segments = new URL(r.url).pathname.split('/')
    expect(segments).toHaveLength(7)
    expect(JSON.parse(decode(segments[6]!))).toEqual([
      { algorithm: 'sha-256', value: toBase64Url(value) },
      { algorithm: 'sha-256', value: toBase64Url(value) },
    ])
  })

  it('adds no hash segment for an empty list', () => {
    expect(new URL(routed('https://relay.example/moq', { serverCertificateHashes: [] }).url).pathname.split('/'))
      .toHaveLength(6)
  })

  it('refuses what the real constructor or the CLI would refuse', () => {
    const r = (target: unknown, options?: unknown) => routeThroughCli(target, BASE, options, 50123, TOKEN, CERT)
    expect(r('http://relay.example/moq')).toMatchObject({ name: 'SyntaxError' })
    expect(r('https://relay.example/moq#x')).toMatchObject({ name: 'SyntaxError' })
    expect(r('https://relay.example/moq#')).toMatchObject({ name: 'SyntaxError' })
    expect(r('https://user:pw@relay.example/moq')).toHaveProperty('refused')
    expect(r('https://user:pw@relay.example/moq')).not.toHaveProperty('name')
    expect(r('https://relay.example/' + 'a'.repeat(7000))).toHaveProperty('refused')
    const hash = { algorithm: 'sha-256', value: new Uint8Array(32) }
    expect(r('https://relay.example/moq', { serverCertificateHashes: [{ ...hash, algorithm: 'sha-1' }] }))
      .toHaveProperty('refused')
    expect(r('https://relay.example/moq', { serverCertificateHashes: [{ ...hash, value: new Uint8Array(31) }] }))
      .toHaveProperty('refused')
    expect(r('https://relay.example/moq', { serverCertificateHashes: new Array(17).fill(hash) }))
      .toHaveProperty('refused')
    expect(r('https://relay.example/moq', { serverCertificateHashes: [hash] })).toHaveProperty('url')
  })

  it('counts the token and session in the length the CLI allows', () => {
    const at = (n: number) => routeThroughCli('https://r.example/' + 'a'.repeat(n), BASE, undefined, 1, TOKEN, CERT)
    let n = 5000
    while (!('refused' in at(n + 1))) n++
    const r = at(n)
    if ('refused' in r) throw new Error(r.refused)
    expect(new URL(r.url).pathname.length).toBeLessThanOrEqual(8192)
    expect(new URL(r.url).pathname.length).toBeGreaterThan(8192 - 4)
  })
})

describe('decide', () => {
  const ROUTE = { port: 50123, token: TOKEN, certHash: CERT }
  const d = (state: RouteState) => decide(state, 'https://relay.example/moq', BASE, undefined, routeThroughCli)

  it('connects directly at once while no tab has a profile', () => {
    expect(d({ any: false, answer: null })).toBeNull()
  })

  it('waits for the answer while some tab has a profile', () => {
    expect(d({ any: true, answer: null })).toBe('wait')
  })

  it('follows the answer once known', () => {
    expect(d({ any: true, answer: { on: false, route: null } })).toBeNull()
    expect(d({ any: false, answer: { on: true, route: ROUTE } })).toHaveProperty('url')
    expect(d({ any: true, answer: { on: true, route: null } })).toMatchObject({ failure: 'no-cli' })
    expect(d({ any: true, answer: 'unanswered' })).toMatchObject({ failure: 'no-answer' })
  })
})

describe('checkUrl', () => {
  it('names what the real constructor refuses with a SyntaxError', () => {
    expect(checkUrl('https://relay.example/moq', BASE)).toBeNull()
    expect(checkUrl('/moq', BASE)).toBeNull()
    expect(checkUrl('http://relay.example/moq', BASE)).not.toBeNull()
    expect(checkUrl('https://relay.example/#', BASE)).not.toBeNull()
    expect(checkUrl('::', 'about:blank')).not.toBeNull()
  })
})

describe('snapshotOptions', () => {
  it('copies what the page passed, so later changes do not leak in', () => {
    const value = new Uint8Array(32).fill(1)
    const protocols = ['moqt-16']
    const options = { protocols, serverCertificateHashes: [{ algorithm: 'sha-256', value }], requireUnreliable: true }
    const snap = snapshotOptions(options) as typeof options
    protocols.push('moqt-15')
    value.fill(2)
    options.requireUnreliable = false
    expect(snap.protocols).toEqual(['moqt-16'])
    expect(Array.from(snap.serverCertificateHashes[0]!.value)).toEqual(new Array(32).fill(1))
    expect(snap.requireUnreliable).toBe(true)
  })

  it('reads inherited members and passes non-objects through', () => {
    const proto = { congestionControl: 'throughput' }
    expect((snapshotOptions(Object.create(proto)) as { congestionControl: string }).congestionControl).toBe(
      'throughput',
    )
    expect(snapshotOptions(undefined)).toBeUndefined()
    expect(snapshotOptions(null)).toBeNull()
  })

  it('throws what the real constructor throws synchronously for the options', () => {
    const name = (options: unknown) => {
      try {
        snapshotOptions(options)
        return null
      } catch (e) {
        return (e as Error).name
      }
    }
    const hash = { algorithm: 'sha-256', value: new Uint8Array(32) }
    expect(name(5)).toBe('TypeError')
    expect(name({ protocols: 'moqt-16' })).toBe('TypeError')
    expect(name({ protocols: { length: 1, 0: 'moqt-16' } })).toBe('TypeError')
    expect(name({ protocols: null })).toBe('TypeError')
    expect(name({ serverCertificateHashes: 'x' })).toBe('TypeError')
    expect(name({ serverCertificateHashes: [5] })).toBe('TypeError')
    expect(name({ allowPooling: true, serverCertificateHashes: [hash] })).toBe('NotSupportedError')
    expect(name({ allowPooling: true, serverCertificateHashes: [] })).toBeNull()
    expect(name({ protocols: ['moqt-16', 'moqt-16'] })).toBe('SyntaxError')
    expect(name({ protocols: [''] })).toBe('SyntaxError')
    expect(name({ protocols: ['x'.repeat(513)] })).toBe('SyntaxError')
    expect((snapshotOptions({ protocols: new Set(['moqt-16']) }) as { protocols: string[] }).protocols).toEqual([
      'moqt-16',
    ])
  })

  it('throws what reading the options throws, as the real constructor does', () => {
    const options = {
      get protocols(): string[] {
        throw new TypeError('nope')
      },
    }
    expect(() => snapshotOptions(options)).toThrow('nope')
  })
})

describe('self-contained', () => {
  it('needs nothing from outside each function body', () => {
    const load = <T>(fn: T): T => new Function(`return (${String(fn)})`)() as T
    const route = load(routeThroughCli)
    const r = route('https://relay.example/moq', BASE, undefined, 1, TOKEN, CERT)
    expect('url' in r && r.url.startsWith('https://127.0.0.1:1/moqtap/u/' + TOKEN + '/')).toBe(true)
    expect(load(decide)({ any: true, answer: null }, 'x', BASE, undefined, route)).toBe('wait')
    expect(load(checkUrl)('http://x/', BASE)).not.toBeNull()
    expect(load(snapshotOptions)({ protocols: ['a'] })).toEqual({ protocols: ['a'] })
    expect(() => load(snapshotOptions)({ protocols: 'a' })).toThrow(TypeError)
  })
})
