/**
 * Finds the moqtap CLI's bridge on loopback and opens impaired tabs on it.
 *
 * A CLI is believed only when its `hello` is signed over a nonce made here,
 * and controlled only once the user has allowed its identity. Consent is kept
 * per identity in `storage.local`; a CLI with a new identity asks again.
 */

import type { KeyValueArea } from '@/src/account/stores'
import type { CliView, TrustedCli } from './messages'
import {
  BRIDGE_PORTS,
  bridgeUrl,
  Ed25519UnsupportedError,
  fingerprint,
  isId16,
  isOwner,
  isProfile,
  NONCE_BYTES,
  parseCreatedTab,
  parseHello,
  parseProfiles,
  parseSession,
  parseStatus,
  parseTab,
  toBase64Url,
  verifyHello,
  type CliTab,
  type CreatedTab,
  type Hello,
  type Profile,
  type Profiles,
} from './protocol'

export const CONSENT_KEY = 'moqtap-cli-consent'

export interface CliDeps {
  readonly fetch: typeof fetch
  readonly local: KeyValueArea
  readonly subtle: SubtleCrypto
  readonly randomBytes: (n: number) => Uint8Array
  readonly now: () => number
  readonly timeoutMs?: number
  readonly ports?: readonly number[]
}

interface Found {
  hello: Hello
  fingerprint: string
}

type Consents = Record<string, { fingerprint: string; at: number }>

/** The CLI the bridge is allowed to use: where it is and the certificate its tab ports serve. */
export interface CliTarget {
  readonly identity: string
  readonly port: number
  /** base64url SHA-256 of the tab ports' certificate. */
  readonly certHash: string
}

/**
 * - `limit`: the CLI holds as many tabs as it allows
 * - `refused`: the CLI answered with another error
 * - `unreachable`: no allowed CLI answered
 */
export type CreateError = 'limit' | 'refused' | 'unreachable'

/** How a profile change went: `gone` when the CLI no longer has the tab or session. */
export type SwitchResult = 'ok' | 'gone' | 'refused' | 'unreachable'

export class CliBridge {
  private current: CliView = { state: 'searching' }
  private found: Found | null = null
  private readonly declined = new Set<string>()
  private readonly listeners = new Set<(view: CliView, trusted: TrustedCli[]) => void>()
  private probing: Promise<void> | null = null

  constructor(private readonly deps: CliDeps) {}

  view(): CliView {
    return this.current
  }

  /** The CLI in use, once its identity is allowed. */
  target(): CliTarget | null {
    const f = this.found
    if (f === null || this.current.state !== 'connected') return null
    return { identity: f.hello.identity, port: f.hello.port, certHash: toBase64Url(f.hello.certHash) }
  }

  onChange(fn: (view: CliView, trusted: TrustedCli[]) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  async trusted(): Promise<TrustedCli[]> {
    const c = await this.consents()
    return Object.entries(c).map(([identity, v]) => ({ identity, ...v }))
  }

  /** Scans the port range and settles on one CLI, if any answers. */
  probe(): Promise<void> {
    this.probing ??= this.scan().finally(() => {
      this.probing = null
    })
    return this.probing
  }

  /** Re-checks the CLI in use (identity and status), or scans again. */
  async refresh(): Promise<void> {
    if (this.current.state !== 'connected' || this.found === null) return this.probe()
    const again = await this.hello(this.found.hello.port).catch(() => null)
    if (again === null || again.identity !== this.found.hello.identity) return this.probe()
    if (toBase64Url(again.certHash) !== toBase64Url(this.found.hello.certHash)) {
      this.found = { ...this.found, hello: again }
      this.set({ state: 'connected', ...this.summary(this.found) })
    }
  }

  async allow(identity: string): Promise<void> {
    const f = this.found
    if (f === null || f.hello.identity !== identity) return
    if (this.current.state !== 'confirm' && this.current.state !== 'declined') return
    const c = await this.consents()
    c[identity] = { fingerprint: f.fingerprint, at: this.deps.now() }
    await this.deps.local.set(CONSENT_KEY, c)
    this.declined.delete(identity)
    this.set({ state: 'connected', ...this.summary(f) })
  }

  decline(identity: string): void {
    const f = this.found
    if (f === null || f.hello.identity !== identity || this.current.state !== 'confirm') return
    this.declined.add(identity)
    this.set({ state: 'declined', ...this.summary(f) })
  }

  /** Asks again for a CLI the user declined. */
  reconsider(): void {
    const f = this.found
    if (f === null || this.current.state !== 'declined') return
    this.declined.delete(f.hello.identity)
    this.set({ state: 'confirm', ...this.summary(f) })
  }

  async forget(identity: string): Promise<void> {
    const c = await this.consents()
    if (!(identity in c)) return
    delete c[identity]
    await this.deps.local.set(CONSENT_KEY, c)
    if (this.found?.hello.identity === identity) {
      this.set({ state: 'confirm', ...this.summary(this.found) })
    } else {
      this.emit()
    }
  }

  /** Opens a tab port for `owner`, impaired with `profile`. */
  async createTab(owner: string, profile: Profile): Promise<CreatedTab | { error: CreateError }> {
    const t = this.target()
    if (t === null || !isOwner(owner) || !isProfile(profile)) return { error: 'unreachable' }
    const res = await this.post(t, 'tab', { profile, owner })
    if (res === null) return { error: 'unreachable' }
    if (res.status === 429) return { error: 'limit' }
    if (!res.ok) return { error: 'refused' }
    const created = parseCreatedTab(await res.json().catch(() => null))
    return created ?? { error: 'refused' }
  }

  /** Switches a tab and every session in it, live. */
  async setTabProfile(id: string, profile: Profile): Promise<SwitchResult> {
    const t = this.target()
    if (t === null || !isId16(id) || !isProfile(profile)) return 'unreachable'
    const res = await this.post(t, `tab/${id}/profile`, { profile })
    if (res === null) return 'unreachable'
    if (res.status === 404) return 'gone'
    if (!res.ok || parseTab(await res.json().catch(() => null)) === null) return 'refused'
    return 'ok'
  }

  /** Gives one session its own profile, live, or with null the tab's again. */
  async setSessionProfile(id: string, profile: Profile | null): Promise<SwitchResult> {
    const t = this.target()
    if (t === null || !isId16(id) || (profile !== null && !isProfile(profile))) return 'unreachable'
    const res = await this.post(t, `session/${id}/profile`, { profile })
    if (res === null) return 'unreachable'
    if (res.status === 404) return 'gone'
    if (!res.ok || parseSession(await res.json().catch(() => null)) === null) return 'refused'
    return 'ok'
  }

  async deleteTab(id: string): Promise<void> {
    const t = this.target()
    if (t === null || !isId16(id)) return
    await this.send(t, `tab/${id}`, { method: 'DELETE' })
  }

  /** Renews `owner`'s lease. False when the CLI did not answer. */
  async renewLease(owner: string): Promise<boolean> {
    const t = this.target()
    if (t === null || !isOwner(owner)) return false
    const res = await this.post(t, 'lease', { owner })
    return res?.ok === true
  }

  /** The CLI's tabs, or null when it does not answer. */
  async tabs(): Promise<CliTab[] | null> {
    const t = this.target()
    if (t === null) return null
    const res = await this.send(t, 'status', {})
    if (res === null || !res.ok) return null
    return parseStatus(await res.json().catch(() => null))
  }

  /** The profiles the CLI offers for its account, or null when it does not answer. */
  async profiles(): Promise<Profiles | null> {
    const t = this.target()
    if (t === null) return null
    const res = await this.send(t, 'profiles', {})
    if (res === null || !res.ok) return null
    return parseProfiles(await res.json().catch(() => null))
  }

  private post(t: CliTarget, endpoint: string, body: unknown): Promise<Response | null> {
    return this.send(t, endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  /** A reply from the CLI in use, or null when it stopped answering, which starts a new scan. */
  private async send(t: CliTarget, endpoint: string, init: RequestInit): Promise<Response | null> {
    try {
      return await this.request(bridgeUrl(t.port, endpoint), init)
    } catch {
      void this.probe().catch(() => {})
      return null
    }
  }

  private async scan(): Promise<void> {
    const ports = this.deps.ports ?? BRIDGE_PORTS
    let answers: (Hello | null)[]
    try {
      answers = await Promise.all(ports.map((p) => this.hello(p)))
    } catch (err) {
      if (err instanceof Ed25519UnsupportedError) {
        this.found = null
        this.set({ state: 'unsupported' })
        return
      }
      throw err
    }
    const consents = await this.consents()
    const valid = answers.filter((h): h is Hello => h !== null)
    const pick = valid.find((h) => h.identity in consents) ?? valid[0]
    if (pick === undefined) {
      this.found = null
      this.set({ state: 'absent' })
      return
    }
    this.found = { hello: pick, fingerprint: await fingerprint(this.deps.subtle, pick.identityPub) }
    if (pick.identity in consents) this.set({ state: 'connected', ...this.summary(this.found) })
    else if (this.declined.has(pick.identity)) this.set({ state: 'declined', ...this.summary(this.found) })
    else this.set({ state: 'confirm', ...this.summary(this.found) })
  }

  /**
   * A verified hello from `port`, or null for silence or a bad signature.
   * Throws {@link Ed25519UnsupportedError} out of the scan.
   */
  private async hello(port: number): Promise<Hello | null> {
    const nonce = this.deps.randomBytes(NONCE_BYTES)
    let raw: unknown
    try {
      const res = await this.request(bridgeUrl(port, `hello?nonce=${toBase64Url(nonce)}`))
      if (!res.ok) return null
      raw = await res.json()
    } catch {
      return null
    }
    const hello = parseHello(raw)
    if (hello === null) return null
    return (await verifyHello(this.deps.subtle, hello, nonce, port)) ? hello : null
  }

  private request(url: string, init: RequestInit = {}): Promise<Response> {
    return this.deps.fetch(url, {
      ...init,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(this.deps.timeoutMs ?? 1500),
    })
  }

  private summary(f: Found) {
    return {
      identity: f.hello.identity,
      fingerprint: f.fingerprint,
      port: f.hello.port,
      cliVersion: f.hello.cliVersion,
    }
  }

  private async consents(): Promise<Consents> {
    const raw = await this.deps.local.get(CONSENT_KEY)
    return typeof raw === 'object' && raw !== null ? { ...(raw as Consents) } : {}
  }

  private set(view: CliView): void {
    this.current = view
    this.emit()
  }

  private emit(): void {
    if (this.listeners.size === 0) return
    void this.trusted().then((t) => {
      for (const fn of this.listeners) fn(this.current, t)
    })
  }
}
