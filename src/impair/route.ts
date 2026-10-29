/**
 * Where an impaired WebTransport session connects instead of the page's URL:
 * `https://127.0.0.1:<port>/moqtap/u/<TOKEN>/<SESSION>/<URL>[/<HASHES>]`, with
 * `TOKEN` the tab's token, `SESSION` 16 random bytes, `URL` the page's
 * absolute `https` URL and `HASHES` its `serverCertificateHashes` as JSON
 * `[{"algorithm": "sha-256", "value": <32 bytes>}]`, each base64url. The CLI
 * dials `URL` upstream with the page's protocols; the browser verifies the CLI
 * by `certHash`.
 *
 * Every function here is self-contained: the worker hook embeds their source,
 * so none may reference anything outside its own body.
 */

import type { RouteState, TabRoute } from './messages'

export interface Refused {
  readonly refused: string
  /** The DOMException name to throw; NetworkError when absent. */
  readonly name?: 'SyntaxError'
  /** Set when the panel should say why. */
  readonly failure?: 'no-cli' | 'no-answer'
}

export type Routed = { readonly url: string; readonly options: Record<string, unknown> }

export type Route = Routed | Refused

/** Why the real constructor would refuse this URL, or null when it would not. */
export function checkUrl(target: unknown, base: string): string | null {
  let url: URL
  try {
    url = new URL(String(target), base)
  } catch {
    return 'The URL is invalid.'
  }
  if (url.protocol !== 'https:') return "The URL's scheme must be 'https'."
  if (url.href.includes('#')) return 'The URL contains a fragment identifier.'
  return null
}

/**
 * The page's WebTransportOptions as they are now, so a session that starts
 * later uses what the page passed. Throws what reading them throws, and what
 * the real constructor throws synchronously for them.
 */
export function snapshotOptions(options: unknown): unknown {
  if (options === undefined || options === null) return options
  if (typeof options !== 'object' && typeof options !== 'function') {
    throw new TypeError("Failed to construct 'WebTransport': The provided value is not of type 'WebTransportOptions'.")
  }
  const o = options as Record<string, unknown>
  const copy: Record<string, unknown> = Object.assign({}, o)
  const members = [
    'allowPooling',
    'congestionControl',
    'requireUnreliable',
    'anticipatedConcurrentIncomingUnidirectionalStreams',
    'anticipatedConcurrentIncomingBidirectionalStreams',
    'datagramsReadableType',
  ]
  for (const k of members) {
    const v = o[k]
    if (v !== undefined) copy[k] = v
  }
  const bytes = (v: unknown): unknown => {
    if (v instanceof ArrayBuffer) return v.slice(0)
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice()
    return v
  }
  // WebIDL sequence conversion: a string or other primitive is a TypeError, not a sequence of characters.
  const sequence = (v: unknown, name: string): unknown[] => {
    const iter = (v as { [Symbol.iterator]?: unknown } | null)?.[Symbol.iterator]
    if ((typeof v !== 'object' && typeof v !== 'function') || v === null || typeof iter !== 'function') {
      throw new TypeError(`Failed to construct 'WebTransport': ${name} is not iterable.`)
    }
    return Array.from(v as Iterable<unknown>)
  }
  let protocols: string[] = []
  if (o.protocols !== undefined) {
    protocols = sequence(o.protocols, 'protocols').map((p) => `${p}`)
    copy.protocols = protocols
  }
  let hashes: unknown[] = []
  if (o.serverCertificateHashes !== undefined) {
    hashes = sequence(o.serverCertificateHashes, 'serverCertificateHashes').map((h) => {
      if (h === undefined || h === null) return {}
      if (typeof h !== 'object' && typeof h !== 'function') {
        throw new TypeError("Failed to construct 'WebTransport': a server certificate hash is not of type 'WebTransportHash'.")
      }
      return { algorithm: (h as { algorithm?: unknown }).algorithm, value: bytes((h as { value?: unknown }).value) }
    })
    copy.serverCertificateHashes = hashes
  }
  if (copy.allowPooling && hashes.length > 0) {
    throw new DOMException(
      "Failed to construct 'WebTransport': serverCertificateHashes cannot be used with allowPooling.",
      'NotSupportedError',
    )
  }
  const seen = new Set<string>()
  for (const p of protocols) {
    if (p.length === 0 || p.length > 512 || seen.has(p)) {
      throw new DOMException("Failed to construct 'WebTransport': protocols must be unique and 1-512 characters.", 'SyntaxError')
    }
    seen.add(p)
  }
  return copy
}

/**
 * The page's arguments rewritten for the tab's CLI port, or why they cannot
 * be. Each call picks a new session id.
 */
export function routeThroughCli(
  target: unknown,
  base: string,
  options: unknown,
  port: number,
  token: string,
  certHash: string,
): Route {
  const toB64 = (bytes: Uint8Array): string => {
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  const fromB64 = (s: string): Uint8Array => {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  const bytesOf = (v: unknown): Uint8Array | null => {
    if (v instanceof ArrayBuffer) return new Uint8Array(v)
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
    return null
  }
  const REFUSED_CREDENTIALS =
    'moqtap impairment: a URL with credentials cannot go through the moqtap CLI. Set Impairment to Off in the moqtap panel to connect.'
  const REFUSED_HASHES =
    'moqtap impairment: serverCertificateHashes must be 1-16 sha-256 hashes of 32 bytes to go through the moqtap CLI.'

  let url: URL
  try {
    url = new URL(String(target), base)
  } catch {
    return { refused: 'The URL is invalid.', name: 'SyntaxError' }
  }
  if (url.protocol !== 'https:') return { refused: "The URL's scheme must be 'https'.", name: 'SyntaxError' }
  if (url.href.includes('#')) return { refused: 'The URL contains a fragment identifier.', name: 'SyntaxError' }
  if (url.hostname === '' || url.username !== '' || url.password !== '') return { refused: REFUSED_CREDENTIALS }

  let copy: Record<string, unknown>
  const hashes: { algorithm: string; value: string }[] = []
  try {
    copy = options && typeof options === 'object' ? (Object.assign({}, options) as Record<string, unknown>) : {}
    const given = copy.serverCertificateHashes
    if (given !== undefined && given !== null) {
      if (!Array.isArray(given) || given.length > 16) return { refused: REFUSED_HASHES }
      for (const h of given) {
        const algorithm = h && typeof h === 'object' ? (h as { algorithm?: unknown }).algorithm : undefined
        const value = h && typeof h === 'object' ? bytesOf((h as { value?: unknown }).value) : null
        if (typeof algorithm !== 'string' || algorithm.toLowerCase() !== 'sha-256') {
          return { refused: REFUSED_HASHES }
        }
        if (value === null || value.length !== 32) return { refused: REFUSED_HASHES }
        hashes.push({ algorithm: 'sha-256', value: toB64(value) })
      }
    }
  } catch {
    return { refused: REFUSED_HASHES }
  }

  const utf8 = new TextEncoder()
  const session = toB64(crypto.getRandomValues(new Uint8Array(16)))
  let path = '/moqtap/u/' + token + '/' + session + '/' + toB64(utf8.encode(url.href))
  if (hashes.length > 0) path += '/' + toB64(utf8.encode(JSON.stringify(hashes)))
  if (path.length > 8192) {
    return { refused: 'moqtap impairment: this URL is too long to go through the moqtap CLI.' }
  }

  // Pooling cannot be combined with serverCertificateHashes.
  delete copy.allowPooling
  copy.serverCertificateHashes = [{ algorithm: 'sha-256', value: fromB64(certHash) }]
  return { url: 'https://127.0.0.1:' + port + path, options: copy }
}

/**
 * Where a new session goes: `wait` until the frame knows its tab's answer
 * (only when some tab had a profile as the document started), null to connect
 * as the page asked, or the CLI route through `route`.
 */
export function decide(
  state: RouteState,
  target: unknown,
  base: string,
  options: unknown,
  route: (target: unknown, base: string, options: unknown, port: number, token: string, certHash: string) => Route,
): Route | 'wait' | null {
  const answer = state.answer
  if (answer === null) return state.any ? 'wait' : null
  if (answer === 'unanswered') {
    return {
      refused:
        'moqtap impairment: this page did not hear whether its tab is impaired, so this connection was not opened. Reload the page.',
      failure: 'no-answer',
    }
  }
  if (!answer.on) return null
  const r: TabRoute | null = answer.route
  if (r === null) {
    return {
      refused:
        'moqtap impairment: the moqtap CLI is not reachable, so this connection was not opened. The moqtap panel says what to do.',
      failure: 'no-cli',
    }
  }
  return route(target, base, options, r.port, r.token, r.certHash)
}
