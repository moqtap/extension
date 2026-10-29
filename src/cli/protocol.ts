/**
 * The moqtap CLI's local control server (`moqtap intercept --bridge`), as the
 * extension speaks to it.
 *
 * HTTP/1.1 on the first free port of 127.0.0.1:47310-47319, under
 * `/moqtap/bridge/v1/`, JSON bodies. Binary fields are base64url without
 * padding.
 *
 * `GET hello?nonce=N` answers `{v: 3, cli_version, identity_pub, cert_hash, port, sig}`,
 * where `sig` is Ed25519 by `identity_pub` over
 *
 * | bytes | content |
 * | --- | --- |
 * | 16 | ASCII `moqtap-bridge-v1` |
 * | 32 | the nonce, decoded |
 * | 32 | `cert_hash`, decoded (SHA-256 of the tab ports' certificate DER) |
 * | 2 | `port`, big-endian |
 *
 * The identity's fingerprint, as `moqtap cert` prints it, is the first 10
 * bytes of SHA-256(`identity_pub`) as upper-case hex in groups of four:
 * `21FE-31DF-A154-A261-626B`.
 */

export const BRIDGE_PORTS: readonly number[] = Array.from({ length: 10 }, (_, i) => 47310 + i)
export const BRIDGE_PATH = '/moqtap/bridge/v1/'

export const PROTOCOL_VERSION = 3

/** The impairment presets the bridge accepts. */
export const PRESETS = ['none', 'offline', '3g', '4g'] as const
export type Preset = (typeof PRESETS)[number]

export const isPreset = (v: unknown): v is Preset =>
  typeof v === 'string' && (PRESETS as readonly string[]).includes(v)

/** A profile as the bridge takes and lists it. */
export type Profile = { readonly preset: Preset } | { readonly scenario: string }

export const OFF: Profile = { preset: 'none' }

export function isProfile(v: unknown): v is Profile {
  if (typeof v !== 'object' || v === null) return false
  const keys = Object.keys(v)
  if (keys.length !== 1) return false
  const o = v as Record<string, unknown>
  if (keys[0] === 'preset') return isPreset(o.preset)
  return keys[0] === 'scenario' && typeof o.scenario === 'string' && o.scenario.length > 0
}

export const isOff = (p: Profile): boolean => 'preset' in p && p.preset === 'none'

export const sameProfile = (a: Profile, b: Profile): boolean =>
  'preset' in a ? 'preset' in b && a.preset === b.preset : 'scenario' in b && a.scenario === b.scenario

/** `owner` in `POST tab` and `POST lease`. */
export const isOwner = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v)

/** 16 bytes, base64url: tab ids, tokens and session ids. */
export const isId16 = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{22}$/.test(v) && fromBase64Url(v)?.length === 16

const isPort = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 0xffff

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
  if (o.v !== PROTOCOL_VERSION || typeof o.cli_version !== 'string') return null
  if (typeof o.identity_pub !== 'string' || typeof o.cert_hash !== 'string') return null
  if (typeof o.sig !== 'string' || !isPort(o.port)) return null
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

/** A session in a tab, as `GET status` lists it. */
export interface CliSession {
  /** The SESSION segment the page chose. */
  readonly id: string
  readonly upstream: string
  /** The profile in effect: its own, else the tab's. */
  readonly profile: Profile
  readonly connected: boolean
}

/** A tab, as `GET status` lists it. */
export interface CliTab {
  readonly id: string
  readonly port: number
  readonly owner: string
  readonly profile: Profile
  readonly sessions: readonly CliSession[]
}

/** A session object, as `GET status` and `POST session/:id/profile` answer it. */
export function parseSession(raw: unknown): CliSession | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (!isId16(o.id) || typeof o.upstream !== 'string' || !isProfile(o.profile)) return null
  if (typeof o.connected !== 'boolean') return null
  return { id: o.id, upstream: o.upstream, profile: o.profile, connected: o.connected }
}

/** A tab object, as `GET status` and `POST tab/:id/profile` answer it. */
export function parseTab(raw: unknown): CliTab | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (!isId16(o.id) || !isPort(o.port) || !isOwner(o.owner) || !isProfile(o.profile)) return null
  if (!Array.isArray(o.sessions)) return null
  const sessions = o.sessions.map(parseSession)
  if (!sessions.every((s) => s !== null)) return null
  return { id: o.id, port: o.port, owner: o.owner, profile: o.profile, sessions: sessions as CliSession[] }
}

/** `GET status`: `{v, listen, cert_hash, tabs}`. */
export function parseStatus(raw: unknown): CliTab[] | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o.v !== PROTOCOL_VERSION || !Array.isArray(o.tabs)) return null
  const tabs = o.tabs.map(parseTab)
  return tabs.every((t) => t !== null) ? (tabs as CliTab[]) : null
}

/** The kinds of profile refusal the CLI names; anything else reads as unnamed. */
export const REFUSAL_REASONS = ['unknown_scenario', 'invalid_scenario', 'plan_required', 'account'] as const
export type RefusalReason = (typeof REFUSAL_REASONS)[number]

/** Why the CLI refused a profile, and for a plan refusal the plan that runs it and where to upgrade. */
export interface Refusal {
  readonly error: string
  readonly reason: RefusalReason | null
  /** The cheapest plan that runs it, for `plan_required`. */
  readonly plan: string | null
  readonly upgrade: { readonly plan: string; readonly url: string } | null
}

const MAX_REFUSAL = 600
const MAX_PLAN = 40

function httpsUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null
  try {
    return new URL(v).protocol === 'https:' ? v : null
  } catch {
    return null
  }
}

/** A refusal's body, `{error, reason?, plan?, upgrade?: {plan, url}}`; null without an error to show. */
export function parseRefusal(raw: unknown): Refusal | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.error !== 'string' || o.error.trim() === '') return null
  const error = o.error.length > MAX_REFUSAL ? `${o.error.slice(0, MAX_REFUSAL)}…` : o.error
  const u = o.upgrade as Record<string, unknown> | null | undefined
  const plan = typeof u === 'object' && u !== null ? u.plan : undefined
  const url = typeof u === 'object' && u !== null ? httpsUrl(u.url) : null
  const upgrade = planName(plan) !== null && url !== null ? { plan: plan as string, url } : null
  const reason = REFUSAL_REASONS.find((r) => r === o.reason) ?? null
  return { error, reason, plan: planName(o.plan) ?? upgrade?.plan ?? null, upgrade }
}

function planName(v: unknown): string | null {
  return typeof v === 'string' && v !== '' && v.length <= MAX_PLAN ? v : null
}

/** A tab `POST tab` opened: where its sessions connect and the token their paths carry. */
export interface CreatedTab {
  readonly id: string
  readonly port: number
  readonly token: string
}

/** `POST tab`: `{id, token, port}`. */
export function parseCreatedTab(raw: unknown): CreatedTab | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  return isId16(o.id) && isPort(o.port) && isId16(o.token) ? { id: o.id, port: o.port, token: o.token } : null
}

export interface ProfileChoice {
  readonly name: string
  readonly profile: Profile
  /** A scenario's own short name, 1-4 letters or digits, when its file sets one. */
  readonly shortLabel?: string
  /** The folders a scenario sits in, outermost first, when it is not at the top. */
  readonly folder?: readonly string[]
}

const SHORT_LABEL = /^[A-Za-z0-9]{1,4}$/

/** `GET profiles`. */
export interface Profiles {
  /** `signedIn` is null when the sign-in could not be read; `error` then says what to do. */
  readonly account: {
    readonly signedIn: boolean | null
    readonly org: string | null
    readonly plan: string | null
    readonly error: string | null
  }
  readonly profiles: readonly ProfileChoice[]
  /** The plan has more profiles to offer. */
  readonly more: boolean
}

const isFolder = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length > 0)

const isNullableString = (v: unknown): v is string | null => v === null || typeof v === 'string'

export function parseProfiles(raw: unknown): Profiles | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const a = o.account as Record<string, unknown> | null | undefined
  if (typeof a !== 'object' || a === null) return null
  const signedIn = a.signed_in
  if (signedIn !== null && typeof signedIn !== 'boolean') return null
  if (!isNullableString(a.org) || !isNullableString(a.plan)) return null
  const error = a.error ?? null
  if (!isNullableString(error)) return null
  if (!Array.isArray(o.profiles) || typeof o.more !== 'boolean') return null
  const profiles: ProfileChoice[] = []
  for (const p of o.profiles as unknown[]) {
    const e = p as Record<string, unknown> | null
    if (typeof e !== 'object' || e === null || typeof e.name !== 'string' || e.name === '') return null
    if (!isProfile(e.profile)) return null
    const choice: { name: string; profile: Profile; shortLabel?: string; folder?: string[] } = {
      name: e.name,
      profile: e.profile,
    }
    if (e.short_label !== undefined) {
      if (typeof e.short_label !== 'string' || !SHORT_LABEL.test(e.short_label)) return null
      choice.shortLabel = e.short_label
    }
    if (e.folder !== undefined) {
      if (!isFolder(e.folder)) return null
      if (e.folder.length > 0) choice.folder = [...e.folder]
    }
    profiles.push(choice)
  }
  return { account: { signedIn, org: a.org, plan: a.plan, error }, profiles, more: o.more }
}
