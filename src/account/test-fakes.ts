/**
 * In-memory stand-ins for the browser storage areas, the IndexedDB secret
 * store, tabs and the network, so the account tests run in Node. The fake
 * network answers only the moqtap endpoints the tests script; any other URL
 * throws, so no test reaches a real service.
 */

import { vi } from 'vitest'
import type { BridgeAccountMsg } from './messages'
import { type AccountDeps, AccountService, type SenderLike } from './service'
import type { KeyValueArea, SecretStore } from './stores'

export const APP = 'https://app.moqtap.com'
export const API = 'https://api.moqtap.com'
export const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop'

export class MemoryArea implements KeyValueArea {
  readonly data = new Map<string, unknown>()
  async get(key: string) {
    // Structured clone, as the real areas do: nobody shares a reference.
    const v = this.data.get(key)
    return v === undefined ? undefined : structuredClone(v)
  }
  async set(key: string, value: unknown) {
    this.data.set(key, structuredClone(value))
  }
  async remove(key: string) {
    this.data.delete(key)
  }
}

export class MemorySecrets implements SecretStore {
  refresh: string | null = null
  async getRefresh() {
    return this.refresh
  }
  async setRefresh(token: string) {
    this.refresh = token
  }
  async clear() {
    this.refresh = null
  }
}

export interface Call {
  readonly url: string
  readonly form: URLSearchParams | null
  readonly headers: Record<string, string>
}

export type Handler = (call: Call) => Response | Promise<Response>

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export function tokenBody(n: number, extra: Record<string, unknown> = {}) {
  return {
    access_token: `mqt_at_access${n}`,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: `mqt_rt_refresh${n}`,
    scope: 'profile traces:write shares:write',
    org_ids: ['ORGPERSONAL'],
    ent: 'e.s',
    ...extra,
  }
}

export const ORGS = {
  orgs: [
    { id: 'ORGPERSONAL', slug: 'p-0123456789ab', name: 'Personal', kind: 'personal', role: 'owner' },
    { id: 'ORGTEAM', slug: 'acme', name: 'Acme', kind: 'team', role: 'member' },
  ],
  user: { id: 'USERALICE', name: 'Alice Liddell', email: 'alice@example.com' },
}

/** A scripted moqtap: `/oauth/token`, `/oauth/revoke` and `/v1/orgs`. */
export class FakeNet {
  readonly calls: Call[] = []
  token: Handler = () => json(tokenBody(1))
  revoke: Handler = () => new Response(null, { status: 200 })
  orgs: Handler = () => json(ORGS)

  readonly fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string> | undefined) ?? {}).map(
        ([k, v]) => [k.toLowerCase(), v],
      ),
    )
    const form =
      typeof init?.body === 'string' ? new URLSearchParams(init.body) : null
    const call: Call = { url, form, headers }
    this.calls.push(call)
    if (url === `${API}/oauth/token`) return this.token(call)
    if (url === `${API}/oauth/revoke`) return this.revoke(call)
    if (url === `${API}/v1/orgs`) return this.orgs(call)
    throw new Error(`unexpected fetch: ${url}`)
  })

  callsTo(path: string): Call[] {
    return this.calls.filter((c) => c.url === `${API}${path}`)
  }
}

/** Everything that survives a background restart, and what does not. */
export class World {
  readonly session = new MemoryArea()
  readonly local = new MemoryArea()
  readonly secrets = new MemorySecrets()
  readonly net = new FakeNet()
  readonly opened: { url: string; active: boolean; id: number }[] = []
  readonly closed: number[] = []
  now = 1_000_000
  private nextTab = 100
  private seed = 1

  deps(): AccountDeps {
    return {
      session: this.session,
      local: this.local,
      secrets: this.secrets,
      fetch: this.net.fetch as unknown as typeof fetch,
      openTab: async (url, active) => {
        const id = this.nextTab++
        this.opened.push({ url, active, id })
        return id
      },
      closeTab: async (id) => {
        this.closed.push(id)
      },
      extensionId: EXT_ID,
      deviceLabel: 'Chrome extension',
      now: () => this.now,
      // Distinct, deterministic bytes per call.
      random: (n) => {
        const seed = this.seed++
        return Uint8Array.from({ length: n }, (_, i) => (seed * 31 + i * 7) & 0xff)
      },
      appOrigin: APP,
      apiOrigin: API,
    }
  }

  /** A fresh background: new isolate, same storage. */
  service(): AccountService {
    return new AccountService(this.deps())
  }

  /** The last authorize URL's parameters. */
  lastAuthorize(): URLSearchParams {
    const last = this.opened.at(-1)
    if (last === undefined) throw new Error('no tab opened')
    return new URL(last.url).searchParams
  }
}

export const appSender = (tabId: number, url = `${APP}/ext/cb`): SenderLike => ({
  id: EXT_ID,
  url,
  frameId: 0,
  tab: { id: tabId },
})

export const callbackMsg = (
  state: string | null,
  code: string | null = 'C'.repeat(43),
  error: string | null = null,
): BridgeAccountMsg => ({
  kind: 'moqtap-account',
  message: { type: 'moqtap:oauth-callback', code, state, error },
})

export const hintMsg = (state: 'signed-in' | 'signed-out'): BridgeAccountMsg => ({
  kind: 'moqtap-account',
  message: { type: 'moqtap:session', state },
})

/** Signs `svc` in through the bridge and returns the tab the flow used. */
export async function signIn(world: World, svc: AccountService): Promise<number> {
  await svc.beginSignIn(false)
  const tab = world.opened.at(-1)!
  const outcome = await svc.handleBridge(
    callbackMsg(world.lastAuthorize().get('state')),
    appSender(tab.id),
  )
  if (outcome !== 'signed-in') throw new Error(`sign-in ended ${outcome}`)
  return tab.id
}
