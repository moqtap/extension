import { webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  fingerprint,
  fromBase64Url,
  parseHello,
  parseStatus,
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
    const hello = parseHello({ v: 1, cli_version: '0.0.0', ...VECTOR })!
    expect(hello).not.toBeNull()
    expect(await verifyHello(subtle, hello, fromBase64Url(VECTOR.nonce)!, VECTOR.port)).toBe(true)
    expect(await fingerprint(subtle, hello.identityPub)).toBe(VECTOR.fingerprint)
  })

  it('rejects the vector on another port or nonce', async () => {
    const hello = parseHello({ v: 1, cli_version: '0.0.0', ...VECTOR })!
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
    const base = { v: 1, cli_version: '0.0.0', ...VECTOR }
    expect(parseHello({ ...base, v: 2 })).toBeNull()
    expect(parseHello({ ...base, sig: VECTOR.sig.slice(4) })).toBeNull()
    expect(parseHello({ ...base, identity_pub: VECTOR.cert_hash.slice(2) })).toBeNull()
    expect(parseHello({ ...base, port: '47310' })).toBeNull()
  })

  it('reads status as the CLI sends it', () => {
    const base = { v: 1, link: '3g', scenario: false, client_connected: true, listen: '127.0.0.1:4443' }
    expect(parseStatus(base)).toEqual({
      link: '3g',
      scenario: false,
      clientConnected: true,
      listen: '127.0.0.1:4443',
    })
    expect(parseStatus({ ...base, link: null, scenario: true })?.scenario).toBe(true)
    expect(parseStatus({ ...base, link: 'none', scenario: true })).toBeNull()
    expect(parseStatus({ ...base, link: 'slow-4g' })).toBeNull()
    expect(parseStatus({ ...base, link: null })).toBeNull()
    expect(parseStatus({ ...base, scenario: 'yes' })).toBeNull()
    expect(parseStatus({ ...base, scenario: undefined })).toBeNull()
    expect(parseStatus({ ...base, v: 2 })).toBeNull()
  })
})
