import { describe, expect, it } from 'vitest'
import { fromBase64Url, toBase64Url } from '@/src/cli/protocol'
import { routeThroughCli } from './route'

const CERT = toBase64Url(new Uint8Array(32).fill(9))
const SECRET = toBase64Url(new Uint8Array(16).fill(7))
const BASE = 'https://player.example/watch/'
const decode = (s: string) => new TextDecoder().decode(fromBase64Url(s)!)

function routed(target: unknown, options?: unknown) {
  const r = routeThroughCli(target, BASE, options, 50123, SECRET, CERT)
  if ('refused' in r) throw new Error(r.refused)
  return r
}

describe('routeThroughCli', () => {
  it('encodes the page URL into the CONNECT path, keeping its path and query', () => {
    const r = routed('https://relay.example:4443/moq/live?token=a%20b&x=1')
    const u = new URL(r.url)
    expect(u.origin).toBe('https://127.0.0.1:50123')
    expect(u.search).toBe('')
    const [, moqtap, kind, secret, url, ...rest] = u.pathname.split('/')
    expect([moqtap, kind, secret, rest]).toEqual(['moqtap', 'u', SECRET, []])
    expect(url).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decode(url!)).toBe('https://relay.example:4443/moq/live?token=a%20b&x=1')
  })

  it('resolves a relative URL against the page and accepts a URL object', () => {
    expect(decode(new URL(routed('/moq').url).pathname.split('/')[4]!)).toBe('https://player.example/moq')
    expect(decode(new URL(routed(new URL('https://relay.example/a')).url).pathname.split('/')[4]!)).toBe(
      'https://relay.example/a',
    )
  })

  it('pins the CLI certificate and keeps the page options', () => {
    const r = routed('https://relay.example/moq', {
      protocols: [],
      congestionControl: 'low-latency',
      allowPooling: true,
    })
    expect(r.options.protocols).toEqual([])
    expect(r.options.congestionControl).toBe('low-latency')
    expect('allowPooling' in r.options).toBe(false)
    const hashes = r.options.serverCertificateHashes as { algorithm: string; value: Uint8Array }[]
    expect(hashes).toHaveLength(1)
    expect(hashes[0]!.algorithm).toBe('sha-256')
    expect(Array.from(hashes[0]!.value)).toEqual(new Array(32).fill(9))
  })

  it("carries the page's own certificate hashes as a second segment", () => {
    const value = new Uint8Array(32).fill(3)
    const r = routed('https://relay.example/moq', {
      serverCertificateHashes: [{ algorithm: 'SHA-256', value }, { algorithm: 'sha-256', value: value.buffer }],
    })
    const segments = new URL(r.url).pathname.split('/')
    expect(segments).toHaveLength(6)
    expect(JSON.parse(decode(segments[5]!))).toEqual([
      { algorithm: 'sha-256', value: toBase64Url(value) },
      { algorithm: 'sha-256', value: toBase64Url(value) },
    ])
  })

  it('adds no hash segment for an empty list', () => {
    expect(new URL(routed('https://relay.example/moq', { serverCertificateHashes: [] }).url).pathname.split('/'))
      .toHaveLength(5)
  })

  it('refuses what the CLI would refuse', () => {
    const refused = (target: unknown, options?: unknown) =>
      'refused' in routeThroughCli(target, BASE, options, 50123, SECRET, CERT)
    expect(refused('http://relay.example/moq')).toBe(true)
    expect(refused('https://user:pw@relay.example/moq')).toBe(true)
    expect(refused('https://relay.example/moq#x')).toBe(true)
    expect(refused('https://relay.example/moq#')).toBe(true)
    expect(refused('https://relay.example/' + 'a'.repeat(7000))).toBe(true)
    const hash = { algorithm: 'sha-256', value: new Uint8Array(32) }
    expect(refused('https://relay.example/moq', { serverCertificateHashes: [{ ...hash, algorithm: 'sha-1' }] })).toBe(true)
    expect(refused('https://relay.example/moq', { serverCertificateHashes: [{ ...hash, value: new Uint8Array(31) }] }))
      .toBe(true)
    expect(refused('https://relay.example/moq', { serverCertificateHashes: new Array(17).fill(hash) })).toBe(true)
    expect(refused('https://relay.example/moq', { serverCertificateHashes: [hash] })).toBe(false)
  })

  it('refuses a session that offers WebTransport protocols, which the CLI cannot carry', () => {
    const r = routeThroughCli('https://relay.example/moq', BASE, { protocols: ['moqt-16'] }, 1, SECRET, CERT)
    expect(r).toMatchObject({ failure: 'protocols' })
    expect('refused' in r && r.refused).toContain('Set Impairment to Off')
    expect(routeThroughCli('https://relay.example/moq', BASE, { protocols: new Set(['moqt-16']) }, 1, SECRET, CERT))
      .toMatchObject({ failure: 'protocols' })
    expect('url' in routeThroughCli('https://relay.example/moq', BASE, { protocols: new Set() }, 1, SECRET, CERT))
      .toBe(true)
  })

  it('counts the secret in the length the CLI allows', () => {
    const at = (n: number) => routeThroughCli('https://r.example/' + 'a'.repeat(n), BASE, undefined, 1, SECRET, CERT)
    let n = 5000
    while (!('refused' in at(n + 1))) n++
    const r = at(n)
    if ('refused' in r) throw new Error(r.refused)
    expect(new URL(r.url).pathname.length).toBeLessThanOrEqual(8192)
    expect(new URL(r.url).pathname.length).toBeGreaterThan(8192 - 4)
  })

  it('needs nothing from outside its own body', () => {
    const fn = new Function(`return (${routeThroughCli.toString()})`)() as typeof routeThroughCli
    expect(fn('https://relay.example/moq', BASE, undefined, 1, SECRET, CERT)).toEqual(
      routeThroughCli('https://relay.example/moq', BASE, undefined, 1, SECRET, CERT),
    )
  })
})
