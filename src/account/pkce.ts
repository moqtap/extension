/**
 * PKCE S256 (RFC 7636) and the OAuth `state`, from Web Crypto.
 */

export function base64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const randomBytes = (n: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(n))

/** 256 bits: 43 base64url characters, the RFC 7636 §4.1 minimum length. */
export const newVerifier = (random = randomBytes): string => base64url(random(32))

/** 128 bits. */
export const newState = (random = randomBytes): string => base64url(random(16))

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}
