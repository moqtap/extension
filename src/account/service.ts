/**
 * The extension's account, owned by the background.
 *
 * **Sign-in.** `beginSignIn` persists a PKCE verifier and a `state`
 * in `storage.session`, then opens `APP_ORIGIN/oauth/authorize` in a tab. The
 * server ends the flow on `APP_ORIGIN/ext/cb`, which posts `{code, state}` to
 * its own window; the bridge content script relays that, from exactly
 * `APP_ORIGIN`, to {@link AccountService.handleBridge}. The background takes
 * the pending flow whose `state` matches (single use), and redeems the code at
 * `API_ORIGIN/oauth/token` with the verifier. Because the flow lives in
 * `storage.session`, a service worker or event page killed while the user is
 * on the login page resumes when the callback wakes it.
 *
 * **Silent pickup.** An `app.` page with a session posts a `signed-in` hint;
 * when the extension is signed out (and the user has not disconnected it), the
 * same flow runs in a background tab with `prompt=none`. A silent attempt
 * that does not end signed in holds further hints off for
 * `SILENT_BACKOFF_MS`; a successful one, or a `signed-out` hint, lifts that,
 * since the next login on `app.` is a new one. A `signed-out` hint signs the
 * extension out as well.
 *
 * **Refresh.** Lazily, through one in-flight promise. `invalid_grant` means
 * the family is gone: credentials are deleted and the panel says "Signed out
 * from another device". Silent pickup stops as after "Disconnect this
 * browser": the server does not say why the family ended, and removing this
 * browser under Devices must not be undone by the next `app.` page load.
 * A network error, 429 or 5xx keeps every credential and marks the account unreachable.
 *
 * **Tokens leave this object only through {@link AccountService.accessToken}.**
 * The view it publishes and everything it writes to `storage.local` are
 * token-free; the background hands an access token only to the panel's port.
 */

import { API_ORIGIN, APP_ORIGIN, CLIENT_ID, redirectUri } from './config'
import type {
  AccountNotice,
  AccountView,
  BridgeAccountMsg,
  OAuthCallbackPageMsg,
  OrgSummary,
} from './messages'
import { challengeFor, newState, newVerifier, randomBytes } from './pkce'
import type { KeyValueArea, SecretStore } from './stores'

/** `storage.session`: the flows waiting for their callback. */
export const PENDING_KEY = 'moqtap-account-pending'
/** `storage.session`: the current access token. */
export const ACCESS_KEY = 'moqtap-account-access'
/** `storage.local`: who is signed in (no secrets). */
export const META_KEY = 'moqtap-account'
/** `storage.local`: the last notice for the panel. */
export const NOTICE_KEY = 'moqtap-account-notice'
/** `storage.session`: when the last silent attempt that has not succeeded started. */
export const SILENT_AT_KEY = 'moqtap-account-silent-at'
/** `storage.local`: false after "Disconnect this browser" or a revocation, until "Sign in". */
export const AUTO_KEY = 'moqtap-account-auto'

/** A flow the user abandoned is forgotten after the server's own login window. */
export const PENDING_TTL_MS = 10 * 60 * 1000
/** At most this many flows wait at once; the oldest is dropped. */
const MAX_PENDING = 4
/** An access token this close to expiry is refreshed instead of used. */
export const ACCESS_SKEW_MS = 60 * 1000
/** After a silent attempt that did not sign in, hints are ignored for this long. */
export const SILENT_BACKOFF_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 15 * 1000

interface PendingFlow {
  readonly state: string
  readonly verifier: string
  readonly silent: boolean
  readonly createdAt: number
  readonly tabId?: number
}

interface AccessEntry {
  readonly token: string
  readonly expiresAt: number
}

interface AccountMeta {
  readonly handle: string | null
  readonly orgs: readonly OrgSummary[]
}

/** What the bridge's sender looked like, as `runtime.MessageSender` gives it. */
export interface SenderLike {
  readonly id?: string
  readonly url?: string
  readonly frameId?: number
  readonly tab?: { readonly id?: number }
}

export interface AccountDeps {
  readonly session: KeyValueArea
  readonly local: KeyValueArea
  readonly secrets: SecretStore
  readonly fetch: typeof fetch
  readonly openTab: (url: string, active: boolean) => Promise<number | undefined>
  readonly closeTab: (tabId: number) => Promise<void>
  readonly extensionId: string
  /** Shown under Devices; the server accepts `[A-Za-z0-9 ._()-]{1,64}`. */
  readonly deviceLabel: string
  readonly now?: () => number
  readonly random?: (n: number) => Uint8Array
  readonly appOrigin?: string
  readonly apiOrigin?: string
}

export class SignedOutError extends Error {
  constructor() {
    super('signed out')
    this.name = 'SignedOutError'
  }
}

export class UnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnreachableError'
  }
}

export type BridgeOutcome =
  | 'ignored'
  | 'bad-sender'
  | 'state-mismatch'
  | 'signed-in'
  | 'flow-error'
  | 'redeem-failed'
  | 'silent-started'
  | 'signed-out'

const originOf = (url: string | undefined): string | null => {
  if (url === undefined) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function isOrgSummary(v: unknown): v is OrgSummary {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.slug === 'string' &&
    typeof o.name === 'string' &&
    (o.kind === 'personal' || o.kind === 'team') &&
    (o.role === 'owner' || o.role === 'admin' || o.role === 'member' || o.role === 'viewer')
  )
}

export class AccountService {
  private readonly now: () => number
  private readonly random: (n: number) => Uint8Array
  private readonly appOrigin: string
  private readonly apiOrigin: string
  private refreshing: Promise<string> | null = null
  /**
   * Bumped whenever the stored credentials are replaced or cleared. A refresh
   * runs outside `serial` (a sign-in step itself asks for tokens), so its
   * answer may arrive for a family that is no longer this browser's; it
   * checks this before writing anything back.
   */
  private generation = 0
  private unreachable = false
  private readonly listeners = new Set<(view: AccountView) => void>()
  /**
   * Flow bookkeeping runs one step at a time: two copies of one callback
   * (a reload of `/ext/cb`) must not both find the flow and both spend it.
   */
  private queue: Promise<unknown> = Promise.resolve()

  private serial<T>(step: () => Promise<T>): Promise<T> {
    const run = this.queue.then(step, step)
    this.queue = run.catch(() => {})
    return run
  }

  constructor(private readonly deps: AccountDeps) {
    this.now = deps.now ?? Date.now
    this.random = deps.random ?? randomBytes
    this.appOrigin = deps.appOrigin ?? APP_ORIGIN
    this.apiOrigin = deps.apiOrigin ?? API_ORIGIN
  }

  // ── state ────────────────────────────────────────────────────────────

  onChange(listener: (view: AccountView) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async view(): Promise<AccountView> {
    const meta = (await this.deps.local.get(META_KEY)) as AccountMeta | undefined
    if (meta !== undefined) {
      return {
        status: 'signed-in',
        handle: meta.handle,
        orgs: meta.orgs,
        unreachable: this.unreachable,
      }
    }
    const notice = ((await this.deps.local.get(NOTICE_KEY)) as AccountNotice | undefined) ?? null
    const signingIn = (await this.pending()).some((p) => !p.silent)
    return { status: 'signed-out', signingIn, notice }
  }

  private async publish(): Promise<void> {
    const v = await this.view()
    for (const l of this.listeners) l(v)
  }

  private async setNotice(notice: AccountNotice | null): Promise<void> {
    if (notice === null) await this.deps.local.remove(NOTICE_KEY)
    else await this.deps.local.set(NOTICE_KEY, notice)
  }

  private async isSignedIn(): Promise<boolean> {
    return (await this.deps.local.get(META_KEY)) !== undefined
  }

  // ── sign-in ──────────────────────────────────────────────────────────

  private async pending(): Promise<PendingFlow[]> {
    const raw = (await this.deps.session.get(PENDING_KEY)) as PendingFlow[] | undefined
    const now = this.now()
    return (raw ?? []).filter((p) => now - p.createdAt < PENDING_TTL_MS)
  }

  /** Starts sign-in. `silent` uses a background tab and `prompt=none`. */
  beginSignIn(silent: boolean): Promise<void> {
    return this.serial(() => this.startFlow(silent))
  }

  private async startFlow(silent: boolean): Promise<void> {
    const verifier = newVerifier(this.random)
    const state = newState(this.random)
    const flow: PendingFlow = { state, verifier, silent, createdAt: this.now() }
    // Persisted before the tab exists, so a restart in between still knows it.
    const flows = [...(await this.pending()), flow].slice(-MAX_PENDING)
    await this.deps.session.set(PENDING_KEY, flows)
    if (silent) await this.deps.session.set(SILENT_AT_KEY, this.now())
    else {
      await this.deps.local.set(AUTO_KEY, true)
      await this.setNotice(null)
      await this.publish()
    }
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: redirectUri(this.appOrigin),
      code_challenge: await challengeFor(verifier),
      code_challenge_method: 'S256',
      state,
    })
    if (silent) params.set('prompt', 'none')
    const tabId = await this.deps.openTab(
      `${this.appOrigin}/oauth/authorize?${params.toString()}`,
      !silent,
    )
    if (tabId !== undefined) {
      const now = await this.pending()
      await this.deps.session.set(
        PENDING_KEY,
        now.map((p) => (p.state === state ? { ...p, tabId } : p)),
      )
    }
  }

  /** A sign-in tab the user closed: its flow can no longer complete. */
  forgetTab(tabId: number): Promise<void> {
    return this.serial(() => this.dropTab(tabId))
  }

  private async dropTab(tabId: number): Promise<void> {
    const flows = await this.pending()
    const left = flows.filter((p) => p.tabId !== tabId)
    if (left.length === flows.length) return
    await this.deps.session.set(PENDING_KEY, left)
    await this.publish()
  }

  /** The bridge's sender must be the top frame of a tab on exactly `APP_ORIGIN`. */
  private senderOk(sender: SenderLike): boolean {
    return (
      sender.id === this.deps.extensionId &&
      originOf(sender.url) === this.appOrigin &&
      (sender.frameId ?? 0) === 0 &&
      sender.tab?.id !== undefined
    )
  }

  async handleBridge(msg: BridgeAccountMsg, sender: SenderLike): Promise<BridgeOutcome> {
    if (!this.senderOk(sender)) return 'bad-sender'
    return this.serial(() => this.bridgeStep(msg, sender))
  }

  private async bridgeStep(msg: BridgeAccountMsg, sender: SenderLike): Promise<BridgeOutcome> {
    const m = msg.message
    if (m.type === 'moqtap:oauth-callback') return this.callback(m, sender.tab?.id)
    if (m.type === 'moqtap:session') {
      return m.state === 'signed-in' ? this.signedInHint() : this.signedOutHint()
    }
    return 'ignored'
  }

  private async callback(m: OAuthCallbackPageMsg, tabId: number | undefined): Promise<BridgeOutcome> {
    const flows = await this.pending()
    const flow = flows.find((p) => p.state === m.state)
    if (flow === undefined) return 'state-mismatch'
    // Single use: the flow is gone before the code is spent, whatever happens next.
    await this.deps.session.set(
      PENDING_KEY,
      flows.filter((p) => p !== flow),
    )
    // The tab that finished our flow is done; its page only says "you can
    // close this tab".
    if (tabId !== undefined) void this.deps.closeTab(tabId).catch(() => {})

    if (m.code === null) {
      // `login_required` / `consent_required` on a silent attempt is the
      // ordinary answer of a browser with no session; only an interactive
      // failure is news.
      if (!flow.silent) {
        await this.setNotice('sign-in-failed')
        await this.publish()
      }
      return 'flow-error'
    }

    try {
      await this.redeem(m.code, flow.verifier)
    } catch {
      if (!flow.silent) {
        await this.setNotice('sign-in-failed')
        await this.publish()
      }
      return 'redeem-failed'
    }
    await this.deps.session.remove(SILENT_AT_KEY)
    await this.publish()
    return 'signed-in'
  }

  private async signedInHint(): Promise<BridgeOutcome> {
    if (await this.isSignedIn()) return 'ignored'
    if ((await this.deps.local.get(AUTO_KEY)) === false) return 'ignored'
    // Kept across restarts, so a flow that keeps failing cannot open a
    // background tab on every app. page load.
    const lastSilentAt = (await this.deps.session.get(SILENT_AT_KEY)) as number | undefined
    if (lastSilentAt !== undefined && this.now() - lastSilentAt < SILENT_BACKOFF_MS) return 'ignored'
    if ((await this.pending()).length > 0) return 'ignored'
    await this.startFlow(true)
    return 'silent-started'
  }

  private async signedOutHint(): Promise<BridgeOutcome> {
    await this.deps.session.remove(SILENT_AT_KEY)
    if (!(await this.isSignedIn())) return 'ignored'
    await this.revokeAndClear()
    await this.setNotice('app-signed-out')
    await this.publish()
    return 'signed-out'
  }

  // ── token endpoint ──────────────────────────────────────────────────

  private async post(path: string, form: Record<string, string>): Promise<Response> {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
    try {
      return await this.deps.fetch(`${this.apiOrigin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        signal: ctl.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      })
    } finally {
      clearTimeout(timer)
    }
  }

  private async redeem(code: string, verifier: string): Promise<void> {
    const res = await this.post('/oauth/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(this.appOrigin),
      code_verifier: verifier,
      client_id: CLIENT_ID,
      device_label: this.deps.deviceLabel,
    })
    if (!res.ok) throw new Error(`token endpoint answered ${res.status}`)
    const body = (await res.json()) as Record<string, unknown>
    const access = body.access_token
    const refresh = body.refresh_token
    const expiresIn = body.expires_in
    if (typeof access !== 'string' || typeof refresh !== 'string' || typeof expiresIn !== 'number') {
      throw new Error('token response is missing fields')
    }
    this.generation++
    const previous = await this.deps.secrets.getRefresh()
    await this.deps.secrets.setRefresh(refresh)
    await this.storeAccess(access, expiresIn)
    // Signing in again over a live sign-in leaves one family per install.
    if (previous !== null && previous !== refresh) {
      void this.post('/oauth/revoke', { token: previous, client_id: CLIENT_ID }).catch(() => {})
    }
    const meta: AccountMeta = { handle: null, orgs: [] }
    await this.deps.local.set(META_KEY, meta)
    await this.setNotice(null)
    this.unreachable = false
    // Names for the chip and the share dialog; signed in either way.
    await this.refreshOrgs(access).catch(() => {})
  }

  private async storeAccess(token: string, expiresInS: number): Promise<void> {
    const entry: AccessEntry = { token, expiresAt: this.now() + expiresInS * 1000 }
    await this.deps.session.set(ACCESS_KEY, entry)
  }

  /** `GET /v1/orgs`: the granted orgs the user still holds. */
  async refreshOrgs(token?: string): Promise<void> {
    const bearer = token ?? (await this.accessToken())
    const res = await this.deps.fetch(`${this.apiOrigin}/v1/orgs`, {
      headers: { authorization: `Bearer ${bearer}` },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    if (!res.ok) throw new Error(`orgs answered ${res.status}`)
    const body = (await res.json()) as { orgs?: unknown }
    const orgs = Array.isArray(body.orgs) ? body.orgs.filter(isOrgSummary) : []
    const meta = (await this.deps.local.get(META_KEY)) as AccountMeta | undefined
    if (meta === undefined) return
    const personal = orgs.find((o) => o.kind === 'personal')
    // A personal org's slug is the user's handle.
    await this.deps.local.set(META_KEY, { ...meta, orgs, handle: personal?.slug ?? null })
    await this.publish()
  }

  // ── access tokens ───────────────────────────────────────────────────

  /**
   * A live access token, refreshing at most once however many callers ask at
   * the same moment. `force` skips the cached one (the API refused it).
   */
  async accessToken(opts: { force?: boolean } = {}): Promise<string> {
    if (opts.force !== true) {
      const cached = await this.cachedAccess()
      if (cached !== null) return cached
    }
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  /** The stored access token while it is live and a sign-in stands behind it. */
  private async cachedAccess(): Promise<string | null> {
    if (!(await this.isSignedIn())) throw new SignedOutError()
    const cached = (await this.deps.session.get(ACCESS_KEY)) as AccessEntry | undefined
    if (cached !== undefined && cached.expiresAt - ACCESS_SKEW_MS > this.now()) return cached.token
    return null
  }

  private async refresh(): Promise<string> {
    const generation = this.generation
    const refresh = await this.deps.secrets.getRefresh()
    if (refresh === null) throw new SignedOutError()
    try {
      return await this.refreshWith(refresh, generation)
    } catch (err) {
      if (generation === this.generation) throw err
      return this.superseded()
    }
  }

  /**
   * What a refresh answers when the credentials it started from were cleared
   * or replaced while it waited: the current sign-in's token, or signed out.
   */
  private async superseded(): Promise<string> {
    const cached = await this.cachedAccess()
    if (cached === null) throw new SignedOutError()
    return cached
  }

  private async refreshWith(refresh: string, generation: number): Promise<string> {
    let res: Response
    try {
      res = await this.post('/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: CLIENT_ID,
      })
    } catch (err) {
      return this.markUnreachable(`network: ${String(err)}`)
    }
    if (res.status === 429 || res.status >= 500) {
      return this.markUnreachable(`token endpoint answered ${res.status}`)
    }
    let body: Record<string, unknown> = {}
    try {
      body = (await res.json()) as Record<string, unknown>
    } catch {
      return this.markUnreachable(`token endpoint answered ${res.status} without JSON`)
    }
    if (generation !== this.generation) {
      // The family this answer belongs to was given up while it was on its
      // way; a rotated token left unrevoked would be a live one nobody holds.
      if (typeof body.refresh_token === 'string') {
        void this.post('/oauth/revoke', { token: body.refresh_token, client_id: CLIENT_ID }).catch(
          () => {},
        )
      }
      return this.superseded()
    }
    if (res.ok && typeof body.access_token === 'string' && typeof body.expires_in === 'number') {
      // An answer without a new refresh token keeps ours.
      if (typeof body.refresh_token === 'string') await this.deps.secrets.setRefresh(body.refresh_token)
      await this.storeAccess(body.access_token, body.expires_in)
      if (this.unreachable) {
        this.unreachable = false
        await this.publish()
      }
      return body.access_token
    }
    if (body.error === 'invalid_grant') {
      await this.deps.local.set(AUTO_KEY, false)
      await this.clearCredentials()
      await this.setNotice('revoked')
      await this.publish()
      throw new SignedOutError()
    }
    // Anything else (a malformed request, an unknown client) is our defect or
    // the server's, not a verdict on this browser's sign-in.
    return this.markUnreachable(`token endpoint answered ${res.status} ${String(body.error)}`)
  }

  private async markUnreachable(reason: string): Promise<never> {
    if (!this.unreachable) {
      this.unreachable = true
      await this.publish()
    }
    throw new UnreachableError(reason)
  }

  // ── sign-out ────────────────────────────────────────────────────────

  private async clearCredentials(): Promise<void> {
    this.generation++
    await this.deps.secrets.clear()
    await this.deps.session.remove(ACCESS_KEY)
    await this.deps.local.remove(META_KEY)
    this.unreachable = false
  }

  /** Revokes the family (RFC 7009) and forgets it here. False when the server was not reached. */
  private async revokeAndClear(): Promise<boolean> {
    const refresh = await this.deps.secrets.getRefresh()
    let reached = true
    if (refresh !== null) {
      try {
        const res = await this.post('/oauth/revoke', { token: refresh, client_id: CLIENT_ID })
        reached = res.status < 500
      } catch {
        reached = false
      }
    }
    await this.clearCredentials()
    return reached
  }

  /**
   * "Disconnect this browser": revokes this install's family without signing
   * out of `app.`, and stops silent pickup until the user signs in again.
   */
  async disconnect(): Promise<void> {
    await this.deps.local.set(AUTO_KEY, false)
    const reached = await this.revokeAndClear()
    await this.setNotice(reached ? null : 'disconnect-unconfirmed')
    await this.publish()
  }
}
