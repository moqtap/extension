/**
 * The moqtap CLI's local control server (`moqtap intercept --bridge`), as the
 * extension speaks to it.
 *
 * HTTP/1.1 on the first free port of 127.0.0.1:47310-47319, under
 * `/moqtap/bridge/v1/`, JSON bodies. Binary fields are base64url without
 * padding.
 *
 * `GET hello?nonce=N` answers `{v, cli_version, identity_pub, cert_hash, port, sig}`,
 * where `sig` is Ed25519 by `identity_pub` over
 *
 * | bytes | content |
 * | --- | --- |
 * | 16 | ASCII `moqtap-bridge-v1` |
 * | 32 | the nonce, decoded |
 * | 32 | `cert_hash`, decoded (SHA-256 of the listen certificate's DER) |
 * | 2 | `port`, big-endian |
 *
 * The identity's fingerprint, as `moqtap cert` prints it, is the first 10
 * bytes of SHA-256(`identity_pub`) as upper-case hex in groups of four:
 * `21FE-31DF-A154-A261-626B`.
 */

export const BRIDGE_PORTS: readonly number[] = Array.from({ length: 10 }, (_, i) => 47310 + i)
export const BRIDGE_PATH = '/moqtap/bridge/v1/'

/** The link presets the bridge accepts. Nothing else is ever sent. */
export const LINKS = ['none', 'offline', '3g', '4g'] as const
export type Link = (typeof LINKS)[number]

export const isLink = (v: unknown): v is Link =>
  typeof v === 'string' && (LINKS as readonly string[]).includes(v)

const DOMAIN = new TextEncoder().encode('moqtap-bridge-v1')
export const NONCE_BYTES = 32
const KEY_BYTES = 32
const HASH_BYTES = 32
const SIG_BYTES = 64

export function bridgeUrl(port: number, endpoint: string): string {
  return `http://127.0.0.1:${port}${BRIDGE_PATH}${endpoint}`
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  try {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

export function signedMessage(nonce: Uint8Array, certHash: Uint8Array, port: number): Uint8Array {
  const out = new Uint8Array(DOMAIN.length + nonce.length + certHash.length + 2)
  out.set(DOMAIN, 0)
  out.set(nonce, DOMAIN.length)
  out.set(certHash, DOMAIN.length + nonce.length)
  out[out.length - 2] = (port >> 8) & 0xff
  out[out.length - 1] = port & 0xff
  return out
}

export async function fingerprint(subtle: SubtleCrypto, identityPub: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await subtle.digest('SHA-256', identityPub as BufferSource))
  const hex = Array.from(digest.subarray(0, 10), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
  return hex.match(/.{4}/g)!.join('-')
}

export interface Hello {
  readonly cliVersion: string
  /** base64url, as sent; the key the consent is pinned to. */
  readonly identity: string
  readonly identityPub: Uint8Array
  readonly certHash: Uint8Array
  readonly port: number
  readonly sig: Uint8Array
}

export function parseHello(raw: unknown): Hello | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o.v !== 1 || typeof o.cli_version !== 'string') return null
  if (typeof o.identity_pub !== 'string' || typeof o.cert_hash !== 'string') return null
  if (typeof o.sig !== 'string' || typeof o.port !== 'number') return null
  const identityPub = fromBase64Url(o.identity_pub)
  const certHash = fromBase64Url(o.cert_hash)
  const sig = fromBase64Url(o.sig)
  if (identityPub?.length !== KEY_BYTES || certHash?.length !== HASH_BYTES) return null
  if (sig?.length !== SIG_BYTES) return null
  return {
    cliVersion: o.cli_version,
    identity: o.identity_pub,
    identityPub,
    certHash,
    port: o.port,
    sig,
  }
}

export class Ed25519UnsupportedError extends Error {
  constructor() {
    super('This browser has no Ed25519 in WebCrypto.')
    this.name = 'Ed25519UnsupportedError'
  }
}

/**
 * True when `hello` came from `port` and is signed over `nonce` by its own
 * identity. Throws {@link Ed25519UnsupportedError} when the browser cannot
 * check.
 */
export async function verifyHello(
  subtle: SubtleCrypto,
  hello: Hello,
  nonce: Uint8Array,
  port: number,
): Promise<boolean> {
  if (hello.port !== port) return false
  let key: CryptoKey
  try {
    key = await subtle.importKey('raw', hello.identityPub as BufferSource, { name: 'Ed25519' }, false, [
      'verify',
    ])
  } catch (err) {
    if (err instanceof Error && err.name === 'NotSupportedError') throw new Ed25519UnsupportedError()
    return false
  }
  try {
    return await subtle.verify(
      { name: 'Ed25519' },
      key,
      hello.sig as BufferSource,
      signedMessage(nonce, hello.certHash, port) as BufferSource,
    )
  } catch {
    return false
  }
}

export interface CliStatus {
  /** Null exactly when `scenario` is set. */
  readonly link: Link | null
  /** The run plays a scenario (`-s`), so the link cannot be set. */
  readonly scenario: boolean
  readonly clientConnected: boolean
  readonly listen: string
}

/** `GET status`: `{v, link, scenario, client_connected, listen}`. */
export function parseStatus(raw: unknown): CliStatus | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o.v !== 1 || typeof o.scenario !== 'boolean') return null
  if (o.scenario ? o.link !== null : !isLink(o.link)) return null
  if (typeof o.client_connected !== 'boolean' || typeof o.listen !== 'string') return null
  return { link: o.link as Link | null, scenario: o.scenario, clientConnected: o.client_connected, listen: o.listen }
}
