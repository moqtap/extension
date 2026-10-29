import { webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  fingerprint,
  fromBase64Url,
  isProfile,
  parseCreatedTab,
  parseHello,
  parseProfiles,
  parseStatus,
  parseTab,
  signedMessage,
  toBase64Url,
  verifyHello,
} from './protocol'

const subtle = webcrypto.subtle as unknown as SubtleCrypto

// RFC 8032 test 1 key, signed by the CLI's ring 0.17 signer.
const VECTOR = {
  identity_pub: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
  nonce: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  cert_hash: 'ERERERERERERERERERERERERERERERERERERERERERE',
  port: 47310,
  message:
    '6d6f717461702d6272696467652d7631' +
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' +
    '1111111111111111111111111111111111111111111111111111111111111111b8ce',
  sig: 'DpebW1hPz9wUew37BFq9VN-KAHCOBwLS6Pgsr8m436z3Wl0NnHlSQc_zZ91DgDJQOi1nmKDeBdKrQ_xkwFqZDw',
  fingerprint: '21FE-31DF-A154-A261-626B',
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

describe('bridge protocol', () => {
  it('builds the signed message byte for byte', () => {
    const m = signedMessage(
      fromBase64Url(VECTOR.nonce)!,
      fromBase64Url(VECTOR.cert_hash)!,
      VECTOR.port,
    )
    expect(m.length).toBe(82)
    expect(hex(m)).toBe(VECTOR.message)
  })

  it('derives the CLI fingerprint vector', async () => {
    expect(await fingerprint(subtle, new Uint8Array(32))).toBe('6668-7AAD-F862-BD77-6C8F')
  })

  it('verifies the fixed vector and derives its fingerprint', async () => {
    const hello = parseHello({ v: 3, cli_version: '0.0.0', ...VECTOR })!
    expect(hello).not.toBeNull()
    expect(await verifyHello(subtle, hello, fromBase64Url(VECTOR.nonce)!, VECTOR.port)).toBe(true)
    expect(await fingerprint(subtle, hello.identityPub)).toBe(VECTOR.fingerprint)
  })

  it('rejects the vector on another port or nonce', async () => {
    const hello = parseHello({ v: 3, cli_version: '0.0.0', ...VECTOR })!
    const nonce = fromBase64Url(VECTOR.nonce)!
    expect(await verifyHello(subtle, hello, nonce, 47311)).toBe(false)
    const other = nonce.slice()
    other[0] ^= 1
    expect(await verifyHello(subtle, hello, other, VECTOR.port)).toBe(false)
  })

  it('round-trips base64url and refuses bad input', () => {
    const b = new Uint8Array([0, 251, 255, 1, 2])
    expect(fromBase64Url(toBase64Url(b))).toEqual(b)
    expect(toBase64Url(b)).not.toMatch(/[+/=]/)
    expect(fromBase64Url('a+b/')).toBeNull()
    expect(fromBase64Url('abcde')).toBeNull()
  })

  it('refuses malformed hellos', () => {
    const base = { v: 3, cli_version: '0.0.0', ...VECTOR }
    expect(parseHello({ ...base, v: 1 })).toBeNull()
    expect(parseHello({ ...base, sig: VECTOR.sig.slice(4) })).toBeNull()
    expect(parseHello({ ...base, identity_pub: VECTOR.cert_hash.slice(2) })).toBeNull()
    expect(parseHello({ ...base, port: '47310' })).toBeNull()
  })

  it('reads status as the CLI sends it', () => {
    const session = {
      id: 'AQEBAQEBAQEBAQEBAQEBAQ',
      upstream: 'https://relay.example/moq',
      profile: { preset: '3g' },
      connected: true,
    }
    const tab = {
      id: 'AAAAAAAAAAAAAAAAAAAAAA',
      port: 50123,
      owner: 'tab-owner_1',
      profile: { preset: '3g' },
      sessions: [session],
    }
    const base = { v: 3, listen: null, cert_hash: VECTOR.cert_hash, tabs: [tab] }
    expect(parseStatus(base)).toEqual([tab])
    expect(parseStatus({ ...base, tabs: [] })).toEqual([])
    expect(parseStatus({ ...base, v: 2 })).toBeNull()
    expect(parseStatus({ ...base, tabs: [{ ...tab, profile: { preset: 'slow-4g' } }] })).toBeNull()
    expect(parseStatus({ ...base, tabs: [{ ...tab, id: 'short' }] })).toBeNull()
    expect(parseStatus({ ...base, tabs: [{ ...tab, sessions: [{ ...session, connected: 'yes' }] }] })).toBeNull()
    expect(parseStatus({ ...base, tabs: [{ ...tab, sessions: [{ ...session, upstream: null }] }] })).toBeNull()
    expect(parseTab({ ...tab, sessions: [] })).toEqual({ ...tab, sessions: [] })
  })

  it('reads a created tab', () => {
    const token = 'BwcHBwcHBwcHBwcHBwcHBw'
    const id = 'AAAAAAAAAAAAAAAAAAAAAA'
    expect(parseCreatedTab({ id, port: 50123, token })).toEqual({ id, port: 50123, token })
    expect(parseCreatedTab({ id, port: 0, token })).toBeNull()
    expect(parseCreatedTab({ id: 'AAAA', port: 50123, token })).toBeNull()
    expect(parseCreatedTab({ id, port: 50123 })).toBeNull()
    expect(parseCreatedTab({ id, port: 50123, token: 'BwcHBwcHBwcHBwcHBwcH' })).toBeNull()
    expect(parseCreatedTab({ id, port: 50123, token: 'BwcHBwcHBwcHBwcHBwcHB/' })).toBeNull()
  })

  it('takes presets and named scenarios as profiles, and nothing else', () => {
    expect(isProfile({ preset: '4g' })).toBe(true)
    expect(isProfile({ scenario: 'lossy' })).toBe(true)
    expect(isProfile({ preset: 'slow' })).toBe(false)
    expect(isProfile({ preset: '3g', scenario: 'x' })).toBe(false)
    expect(isProfile({ scenario: '' })).toBe(false)
    expect(isProfile(null)).toBe(false)
  })

  it('reads the profiles the CLI offers', () => {
    const raw = {
      account: { signed_in: true, org: 'acme', plan: 'Free' },
      profiles: [
        { name: 'Off', profile: { preset: 'none' } },
        { name: '3G', profile: { preset: '3g' } },
      ],
      more: true,
    }
    expect(parseProfiles(raw)).toEqual({
      account: { signedIn: true, org: 'acme', plan: 'Free', error: null },
      profiles: [
        { name: 'Off', profile: { preset: 'none' } },
        { name: '3G', profile: { preset: '3g' } },
      ],
      more: true,
    })
    expect(parseProfiles({ ...raw, account: { signed_in: false, org: null, plan: null } })?.account).toEqual({
      signedIn: false,
      org: null,
      plan: null,
      error: null,
    })
    const unread = { signed_in: null, org: null, plan: null, error: 'Delete it and run `moqtap login`.' }
    expect(parseProfiles({ ...raw, account: unread })?.account).toEqual({
      signedIn: null,
      org: null,
      plan: null,
      error: 'Delete it and run `moqtap login`.',
    })
    expect(parseProfiles({ ...raw, account: { ...unread, error: 1 } })).toBeNull()
    expect(parseProfiles({ ...raw, account: { ...unread, signed_in: 'no' } })).toBeNull()
    expect(parseProfiles({ ...raw, more: 'yes' })).toBeNull()
    expect(parseProfiles({ ...raw, profiles: [{ name: 'Slow', profile: { preset: 'slow' } }] })).toBeNull()
    expect(parseProfiles({ ...raw, profiles: [{ name: '', profile: { preset: 'none' } }] })).toBeNull()
  })
})
