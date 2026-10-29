/**
 * Finds the moqtap CLI's bridge on loopback and drives its link preset.
 *
 * A CLI is believed only when its `hello` is signed over a nonce made here,
 * and controlled only once the user has allowed its identity. Consent is kept
 * per identity in `storage.local`; a CLI with a new identity asks again.
 */

import type { KeyValueArea } from '@/src/account/stores'
import type { CliError, CliView, TrustedCli } from './messages'
import {
  BRIDGE_PORTS,
  bridgeUrl,
  Ed25519UnsupportedError,
  fingerprint,
  isLink,
  NONCE_BYTES,
  parseHello,
  parseStatus,
  toBase64Url,
  verifyHello,
  type Hello,
  type Link,
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
    await this.pullStatus(null)
  }

  async allow(identity: string): Promise<void> {
    const f = this.found
    if (f === null || f.hello.identity !== identity) return
    if (this.current.state !== 'confirm' && this.current.state !== 'declined') return
    const c = await this.consents()
    c[identity] = { fingerprint: f.fingerprint, at: this.deps.now() }
    await this.deps.local.set(CONSENT_KEY, c)
    this.declined.delete(identity)
    await this.pullStatus(null)
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

  async setLink(link: Link): Promise<void> {
    if (!isLink(link)) return
    const f = this.found
    if (f === null || this.current.state !== 'connected') return
    let res: Response
    try {
      res = await this.request(bridgeUrl(f.hello.port, 'link'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ link }),
      })
    } catch {
      await this.probe()
      if (this.current.state === 'connected') this.setError('unreachable')
      return
    }
    if (res.ok) await this.pullStatus(null)
    else await this.pullStatus(res.status === 409 ? 'scenario' : 'refused')
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
    if (pick.identity in consents) await this.pullStatus(null)
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

  private async pullStatus(error: CliError | null): Promise<void> {
    const f = this.found
    if (f === null) return
    let status = null
    try {
      const res = await this.request(bridgeUrl(f.hello.port, 'status'))
      if (res.ok) status = parseStatus(await res.json())
    } catch {
      error ??= 'unreachable'
    }
    this.set({ state: 'connected', ...this.summary(f), status, error })
  }

  private setError(error: CliError): void {
    if (this.current.state === 'connected') this.set({ ...this.current, error })
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
