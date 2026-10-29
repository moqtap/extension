/**
 * Where an impaired WebTransport session connects instead of the page's URL:
 * `https://127.0.0.1:<port>/moqtap/u/<SECRET>/<URL>[/<HASHES>]`, with `SECRET`
 * the session's secret, `URL` the page's absolute `https` URL and `HASHES` its
 * `serverCertificateHashes` as JSON
 * `[{"algorithm": "sha-256", "value": <32 bytes>}]`, each base64url. The CLI
 * dials `URL` upstream; the browser verifies the CLI by `certHash`.
 */

export interface Refused {
  readonly refused: string
  /** Set when the panel should say why. */
  readonly failure?: 'protocols'
}

export type Route = { readonly url: string; readonly options: Record<string, unknown> } | Refused

/** A route that holds one of the frame's CLI sessions. */
export type Routed = Extract<Route, { url: string }> & { readonly id: string }

/**
 * The page's arguments rewritten for the CLI session on `port`, or why they
 * cannot be.
 *
 * Self-contained: the worker hook embeds this function's source, so it must
 * not reference anything outside its own body.
 */
export function routeThroughCli(
  target: unknown,
  base: string,
  options: unknown,
  port: number,
  secret: string,
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
  const REFUSED_URL =
    'moqtap impairment: only https URLs without credentials or a fragment can go through the moqtap CLI.'
  const REFUSED_PROTOCOLS =
    "moqtap impairment: the moqtap CLI can't impair a connection that offers WebTransport protocols. Set Impairment to Off in the moqtap panel to connect."
  const REFUSED_HASHES =
    'moqtap impairment: serverCertificateHashes must be 1-16 sha-256 hashes of 32 bytes to go through the moqtap CLI.'

  let url: URL
  try {
    url = new URL(String(target), base)
  } catch {
    return { refused: REFUSED_URL }
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname === '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.href.includes('#')
  ) {
    return { refused: REFUSED_URL }
  }

  let copy: Record<string, unknown>
  const hashes: { algorithm: string; value: string }[] = []
  try {
    copy = options && typeof options === 'object' ? (Object.assign({}, options) as Record<string, unknown>) : {}
    const protocols = copy.protocols
    if (protocols !== undefined) {
      let offered = 1
      try {
        offered = Array.from(protocols as Iterable<unknown>).length
      } catch {
        // Not iterable: the real constructor throws on it.
      }
      if (offered > 0) return { refused: REFUSED_PROTOCOLS, failure: 'protocols' }
    }
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
  let path = '/moqtap/u/' + secret + '/' + toB64(utf8.encode(url.href))
  if (hashes.length > 0) path += '/' + toB64(utf8.encode(JSON.stringify(hashes)))
  if (path.length > 8192) {
    return { refused: 'moqtap impairment: this URL is too long to go through the moqtap CLI.' }
  }

  // Pooling cannot be combined with serverCertificateHashes.
  delete copy.allowPooling
  copy.serverCertificateHashes = [{ algorithm: 'sha-256', value: fromB64(certHash) }]
  return { url: 'https://127.0.0.1:' + port + path, options: copy }
}
