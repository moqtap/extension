import { webcrypto } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { KeyValueArea } from '@/src/account/stores'
import { ImpairManager } from '@/src/impair/manager'
import { serveCliPort, type CliPortLike } from './background'
import type { CliStateMsg, PageCliMsg } from './messages'
import { fromBase64Url, signedMessage, toBase64Url, type Profile } from './protocol'
import { CliBridge, CONSENT_KEY } from './service'

const subtle = webcrypto.subtle as unknown as SubtleCrypto
const PORTS = [47310, 47311, 47312]

interface FakeCli {
  port: number
  keys: CryptoKeyPair
  identity: string
  /** Signs with this key instead, as a squatter without the identity would. */
  signer?: CryptoKey
  tabs: Map<string, { port: number; owner: string; profile: Profile }>
  /** Sessions by id: their tab and own profile. */
  sessions: Map<string, { tab: string; own: Profile | null }>
  posts: { endpoint: string; body: unknown }[]
  deletes: string[]
  nonces: Uint8Array[]
  /** Answers POST tab with this status instead. */
  createStatus?: number
  /** Answers GET profiles with this body. */
  profiles?: unknown
}

async function makeCli(port: number, extra: Partial<FakeCli> = {}): Promise<FakeCli> {
  const keys = (await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const pub = new Uint8Array(await subtle.exportKey('raw', keys.publicKey))
  return {
    port,
    keys,
    identity: toBase64Url(pub),
    tabs: new Map(),
    sessions: new Map(),
    posts: [],
    deletes: [],
    nonces: [],
    ...extra,
  }
}

function memoryArea(): KeyValueArea & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    get: async (k) => structuredClone(data.get(k)),
    set: async (k, v) => void data.set(k, structuredClone(v)),
    remove: async (k) => void data.delete(k),
  }
}

const certHash = new Uint8Array(32).fill(7)

function fakeFetch(clis: FakeCli[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const cli = clis.find((c) => c.port === Number(url.port))
    if (cli === undefined) throw new TypeError('Failed to fetch')
    const endpoint = url.pathname.replace('/moqtap/bridge/v1/', '')
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (endpoint === 'hello') {
      const nonce = fromBase64Url(url.searchParams.get('nonce') ?? '')
      if (nonce?.length !== 32) return json({ error: 'nonce must be 32 bytes, base64url' }, 400)
      cli.nonces.push(nonce)
      const sig = await subtle.sign(
        { name: 'Ed25519' },
        cli.signer ?? cli.keys.privateKey,
        signedMessage(nonce, certHash, cli.port) as BufferSource,
      )
      return json({
        v: 3,
        cli_version: '1.2.3',
        identity_pub: cli.identity,
        cert_hash: toBase64Url(certHash),
        port: cli.port,
        sig: toBase64Url(new Uint8Array(sig)),
      })
    }
    const sessionEntry = (id: string) => {
      const s = cli.sessions.get(id)!
      const profile = s.own ?? cli.tabs.get(s.tab)!.profile
      return { id, upstream: 'https://relay.example/moq', profile, connected: true }
    }
    const entry = (id: string) => {
      const e = cli.tabs.get(id)!
      const sessions = [...cli.sessions].filter(([, s]) => s.tab === id).map(([k]) => sessionEntry(k))
      return { id, port: e.port, owner: e.owner, profile: e.profile, sessions }
    }
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
    if (init?.method === 'POST') cli.posts.push({ endpoint, body })
    if (endpoint === 'status') {
      return json({ v: 3, listen: null, cert_hash: toBase64Url(certHash), tabs: [...cli.tabs.keys()].map(entry) })
    }
    if (endpoint === 'profiles') {
      return cli.profiles === undefined ? json({ error: 'no' }, 500) : json(cli.profiles)
    }
    if (endpoint === 'tab' && init?.method === 'POST') {
      if (cli.createStatus !== undefined) return json({ error: 'no' }, cli.createStatus)
      const id = toBase64Url(webcrypto.getRandomValues(new Uint8Array(16)))
      const port = 50000 + cli.tabs.size
      cli.tabs.set(id, { port, owner: body.owner, profile: body.profile })
      const token = toBase64Url(webcrypto.getRandomValues(new Uint8Array(16)))
      return json({ id, port, token })
    }
    if (endpoint === 'lease' && init?.method === 'POST') return new Response(null, { status: 204 })
    const m = /^tab\/([A-Za-z0-9_-]{22})(\/profile)?$/.exec(endpoint)
    if (m !== null) {
      const id = m[1]!
      if (!cli.tabs.has(id)) return json({ error: 'no such tab' }, 404)
      if (m[2] && init?.method === 'POST') {
        cli.tabs.get(id)!.profile = body.profile
        for (const s of cli.sessions.values()) if (s.tab === id) s.own = null
        return json(entry(id))
      }
      if (!m[2] && init?.method === 'DELETE') {
        cli.tabs.delete(id)
        cli.deletes.push(id)
        return new Response(null, { status: 204 })
      }
      return json({ error: 'method' }, 405)
    }
    const s = /^session\/([A-Za-z0-9_-]{22})\/profile$/.exec(endpoint)
    if (s !== null && init?.method === 'POST') {
      const session = cli.sessions.get(s[1]!)
      if (session === undefined) return json({ error: 'no such session' }, 404)
      session.own = body.profile
      return json(sessionEntry(s[1]!))
    }
    return new Response(null, { status: 404 })
  }) as typeof fetch
}

function bridgeFor(clis: FakeCli[], local = memoryArea()) {
  const bridge = new CliBridge({
    fetch: fakeFetch(clis),
    local,
    subtle,
    randomBytes: (n) => webcrypto.getRandomValues(new Uint8Array(n)),
    now: () => 1000,
    ports: PORTS,
  })
  return { bridge, local }
}

describe('CliBridge', () => {
  let cli: FakeCli
  beforeEach(async () => {
    cli = await makeCli(47311)
  })

  it('finds nothing when no port answers', async () => {
    const { bridge } = bridgeFor([])
    await bridge.probe()
    expect(bridge.view().state).toBe('absent')
  })

  it('sends a fresh 32-byte nonce in each hello', async () => {
    const { bridge } = bridgeFor([cli])
    await bridge.probe()
    await bridge.probe()
    expect(bridge.view().state).toBe('confirm')
    expect(cli.nonces.map((n) => n.length)).toEqual([32, 32])
    expect(cli.nonces[0]).not.toEqual(cli.nonces[1])
  })

  it('ignores a hello with a bad signature', async () => {
    const squatter = await makeCli(47310)
    squatter.signer = (await makeCli(0)).keys.privateKey
    const { bridge } = bridgeFor([squatter])
    await bridge.probe()
    expect(bridge.view().state).toBe('absent')
  })

  it('ignores a hello signed for another port', async () => {
    const elsewhere = fakeFetch([await makeCli(47312)])
    const relay: typeof fetch = (input, init) =>
      elsewhere(String(input).replace(':47310/', ':47312/'), init)
    const bridge = new CliBridge({
      fetch: relay,
      local: memoryArea(),
      subtle,
      randomBytes: (n) => webcrypto.getRandomValues(new Uint8Array(n)),
      now: () => 0,
      ports: [47310],
    })
    await bridge.probe()
    expect(bridge.view().state).toBe('absent')
  })

  it('says so when the browser has no Ed25519', async () => {
    const noEd: SubtleCrypto = Object.create(subtle, {
      importKey: {
        value: async () => {
          throw new DOMException('Ed25519', 'NotSupportedError')
        },
      },
    })
    const bridge = new CliBridge({
      fetch: fakeFetch([cli]),
      local: memoryArea(),
      subtle: noEd,
      randomBytes: (n) => webcrypto.getRandomValues(new Uint8Array(n)),
      now: () => 0,
      ports: PORTS,
    })
    await bridge.probe()
    expect(bridge.view().state).toBe('unsupported')
  })

  it('prompts for an unknown identity and controls nothing before consent', async () => {
    const { bridge } = bridgeFor([cli])
    await bridge.probe()
    const v = bridge.view()
    expect(v.state).toBe('confirm')
    if (v.state !== 'confirm') return
    expect(v.identity).toBe(cli.identity)
    expect(v.fingerprint).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){4}$/)
    expect(await bridge.createTab('owner', { preset: '3g' })).toEqual({ error: 'unreachable' })
    expect(cli.posts).toEqual([])
  })

  it('remembers consent per identity and skips the prompt next time', async () => {
    const { bridge, local } = bridgeFor([cli])
    await bridge.probe()
    await bridge.allow(cli.identity)
    expect(bridge.view().state).toBe('connected')
    expect(Object.keys(local.data.get(CONSENT_KEY) as object)).toEqual([cli.identity])

    const { bridge: again } = bridgeFor([cli], local)
    await again.probe()
    expect(again.view().state).toBe('connected')
    expect(again.target()).toEqual({ identity: cli.identity, port: 47311, certHash: toBase64Url(certHash) })
  })

  it('prompts again for a new identity on the same port', async () => {
    const { bridge, local } = bridgeFor([cli])
    await bridge.probe()
    await bridge.allow(cli.identity)
    const replaced = await makeCli(47311)
    const { bridge: next } = bridgeFor([replaced], local)
    await next.probe()
    expect(next.view().state).toBe('confirm')
  })

  it('allows only the identity it is showing', async () => {
    const { bridge, local } = bridgeFor([cli])
    await bridge.probe()
    await bridge.allow((await makeCli(1)).identity)
    expect(bridge.view().state).toBe('confirm')
    expect(local.data.get(CONSENT_KEY)).toBeUndefined()
  })

  it('prefers a trusted CLI over an unknown one', async () => {
    const other = await makeCli(47310)
    const local = memoryArea()
    local.data.set(CONSENT_KEY, { [cli.identity]: { fingerprint: 'x', at: 1 } })
    const { bridge } = bridgeFor([other, cli], local)
    await bridge.probe()
    const v = bridge.view()
    expect(v.state === 'connected' && v.port).toBe(47311)
  })

  it('opens, switches and deletes tabs, and renews leases', async () => {
    const { bridge } = bridgeFor([cli])
    await bridge.probe()
    await bridge.allow(cli.identity)
    const created = await bridge.createTab('tab-1', { preset: '3g' })
    if ('error' in created) throw new Error(created.error)
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(cli.posts[0]).toEqual({ endpoint: 'tab', body: { profile: { preset: '3g' }, owner: 'tab-1' } })
    expect(await bridge.setTabProfile(created.id, { preset: '4g' })).toBe('ok')
    expect(cli.tabs.get(created.id)?.profile).toEqual({ preset: '4g' })
    expect((await bridge.tabs())?.map((t) => t.id)).toEqual([created.id])
    expect(await bridge.renewLease('tab-1')).toBe(true)
    await bridge.deleteTab(created.id)
    expect(cli.deletes).toEqual([created.id])
    expect(await bridge.setTabProfile(created.id, { preset: 'none' })).toBe('gone')
  })

  it('gives a session its own profile and returns it to the tab', async () => {
    const { bridge } = bridgeFor([cli])
    await bridge.probe()
    await bridge.allow(cli.identity)
    const created = await bridge.createTab('tab-1', { preset: '3g' })
    if ('error' in created) throw new Error(created.error)
    const session = toBase64Url(new Uint8Array(16).fill(1))
    cli.sessions.set(session, { tab: created.id, own: null })
    expect(await bridge.setSessionProfile(session, { preset: '4g' })).toBe('ok')
    expect(cli.posts.at(-1)).toEqual({ endpoint: `session/${session}/profile`, body: { profile: { preset: '4g' } } })
    expect((await bridge.tabs())?.[0]?.sessions.map((s) => s.profile)).toEqual([{ preset: '4g' }])
    expect(await bridge.setSessionProfile(session, null)).toBe('ok')
    expect(cli.posts.at(-1)).toEqual({ endpoint: `session/${session}/profile`, body: { profile: null } })
    expect((await bridge.tabs())?.[0]?.sessions.map((s) => s.profile)).toEqual([{ preset: '3g' }])
    cli.sessions.delete(session)
    expect(await bridge.setSessionProfile(session, { preset: '4g' })).toBe('gone')
    const posts = cli.posts.length
    expect(await bridge.setSessionProfile('short', { preset: '4g' })).toBe('unreachable')
    expect(cli.posts).toHaveLength(posts)
  })

  it('sends only valid profiles and owners', async () => {
    const { bridge } = bridgeFor([cli])
    await bridge.probe()
    await bridge.allow(cli.identity)
    expect(await bridge.createTab('tab-1', { preset: 'slow-4g' } as unknown as Profile)).toEqual({
      error: 'unreachable',
    })
    expect(await bridge.createTab('tab 1', { preset: '3g' })).toEqual({ error: 'unreachable' })
    expect(cli.posts).toEqual([])
  })

  it('reports the CLI tab limit', async () => {
    cli.createStatus = 429
    const { bridge } = bridgeFor([cli])
    await bridge.probe()
    await bridge.allow(cli.identity)
    expect(await bridge.createTab('tab-1', { preset: '3g' })).toEqual({ error: 'limit' })
    cli.createStatus = 400
    expect(await bridge.createTab('tab-1', { preset: '3g' })).toEqual({ error: 'refused' })
  })

  it('reads the profiles the CLI offers, or null when it fails', async () => {
    const { bridge } = bridgeFor([cli])
    await bridge.probe()
    await bridge.allow(cli.identity)
    expect(await bridge.profiles()).toBeNull()
    cli.profiles = {
      account: { signed_in: false, org: null, plan: null, error: null },
      profiles: [{ name: 'Off', profile: { preset: 'none' } }],
      more: true,
    }
    expect(await bridge.profiles()).toEqual({
      account: { signedIn: false, org: null, plan: null, error: null },
      profiles: [{ name: 'Off', profile: { preset: 'none' } }],
      more: true,
    })
  })

  it('forgets consent and asks again', async () => {
    const { bridge, local } = bridgeFor([cli])
    await bridge.probe()
    await bridge.allow(cli.identity)
    await bridge.forget(cli.identity)
    expect(bridge.view().state).toBe('confirm')
    expect(local.data.get(CONSENT_KEY)).toEqual({})
  })

  it('keeps a declined CLI declined across probes until reconsidered', async () => {
    const { bridge } = bridgeFor([cli])
    await bridge.probe()
    bridge.decline(cli.identity)
    await bridge.probe()
    expect(bridge.view().state).toBe('declined')
    bridge.reconsider()
    expect(bridge.view().state).toBe('confirm')
  })
})

function managerFor(bridge: CliBridge) {
  return new ImpairManager({
    cli: bridge,
    store: memoryArea(),
    sendToFrame: () => {},
    tabExists: async () => true,
    newOwner: () => 'owner-1',
    every: () => () => {},
    setFlag: async () => {},
  })
}

describe('serveCliPort', () => {
  function fakePort(url: string) {
    const sent: CliStateMsg[] = []
    let onMsg: (m: unknown) => void = () => {}
    let onDisc: () => void = () => {}
    let disconnected = false
    const port: CliPortLike = {
      name: 'moqtap-cli',
      sender: { url },
      postMessage: (m) => void sent.push(m),
      disconnect: () => void (disconnected = true),
      onMessage: { addListener: (fn) => void (onMsg = fn) },
      onDisconnect: { addListener: (fn) => void (onDisc = fn) },
    }
    return { port, sent, post: (m: PageCliMsg | unknown) => onMsg(m), close: () => onDisc(), isDisconnected: () => disconnected }
  }

  it('disconnects a port that is not an extension page', async () => {
    const cli = await makeCli(47310)
    const { bridge } = bridgeFor([cli])
    const p = fakePort('https://evil.example/')
    expect(serveCliPort(bridge, managerFor(bridge), p.port, 'chrome-extension://abc/')).toBe(false)
    expect(p.isDisconnected()).toBe(true)
  })

  it('sets a tab profile only to valid profiles', async () => {
    const cli = await makeCli(47310)
    const { bridge } = bridgeFor([cli])
    await bridge.probe()
    await bridge.allow(cli.identity)
    const impair = managerFor(bridge)
    const p = fakePort('chrome-extension://abc/devtools-panel.html')
    serveCliPort(bridge, impair, p.port, 'chrome-extension://abc/')
    p.post({ type: 'cli:watch-tab', tabId: 7 })
    p.post({ type: 'cli:set-profile', tabId: 7, profile: { preset: 'custom' }, name: 'Custom' })
    p.post({ type: 'cli:set-profile', tabId: '7', profile: { preset: '3g' }, name: '3G' })
    p.post({ type: 'cli:set-profile', tabId: 7, profile: { preset: '3g' }, name: '' })
    p.post({ type: 'cli:set-profile', tabId: 7, profile: { preset: '3g' }, name: '3G' })
    await new Promise((r) => setTimeout(r, 50))
    expect(impair.view(7).profile).toEqual({ preset: '3g' })
    expect(p.sent.filter((m) => m.type === 'cli:tab').at(-1)).toEqual({
      type: 'cli:tab',
      tab: { tabId: 7, profile: { preset: '3g' }, name: '3G', sessions: [], unknown: [], sessionErrors: [], failure: null, error: null },
    })
    p.close()
  })

  it('sets a session profile, and shows it cleared when the tab profile changes', async () => {
    const cli = await makeCli(47310)
    const { bridge } = bridgeFor([cli])
    await bridge.probe()
    await bridge.allow(cli.identity)
    const impair = managerFor(bridge)
    const p = fakePort('chrome-extension://abc/devtools-panel.html')
    serveCliPort(bridge, impair, p.port, 'chrome-extension://abc/')
    p.post({ type: 'cli:watch-tab', tabId: 7 })
    p.post({ type: 'cli:set-profile', tabId: 7, profile: { preset: '3g' }, name: '3G' })
    await new Promise((r) => setTimeout(r, 50))
    const session = toBase64Url(new Uint8Array(16).fill(1))
    cli.sessions.set(session, { tab: [...cli.tabs.keys()][0]!, own: null })
    const lastTab = () => p.sent.filter((m) => m.type === 'cli:tab').at(-1)
    p.post({ type: 'cli:set-session-profile', tabId: 7, session: 'bad', profile: { preset: '4g' }, name: '4G' })
    p.post({ type: 'cli:set-session-profile', tabId: 7, session, profile: { preset: '4g' }, name: '' })
    p.post({ type: 'cli:set-session-profile', tabId: 7, session, profile: { preset: '4g' }, name: '4G' })
    await new Promise((r) => setTimeout(r, 50))
    expect(cli.posts.filter((x) => x.endpoint.startsWith('session/'))).toHaveLength(1)
    expect(lastTab()).toEqual({
      type: 'cli:tab',
      tab: expect.objectContaining({ name: '3G', sessions: [{ session, profile: { preset: '4g' }, name: '4G' }] }),
    })
    expect(cli.sessions.get(session)?.own).toEqual({ preset: '4g' })
    p.post({ type: 'cli:set-profile', tabId: 7, profile: { preset: 'offline' }, name: 'Offline' })
    await new Promise((r) => setTimeout(r, 50))
    expect(lastTab()).toEqual({ type: 'cli:tab', tab: expect.objectContaining({ name: 'Offline', sessions: [] }) })
    expect(cli.sessions.get(session)?.own).toBeNull()
    p.post({ type: 'cli:set-session-profile', tabId: 7, session, profile: { preset: '4g' }, name: '4G' })
    p.post({ type: 'cli:set-session-profile', tabId: 7, session, profile: null, name: null })
    await new Promise((r) => setTimeout(r, 50))
    expect(lastTab()).toEqual({ type: 'cli:tab', tab: expect.objectContaining({ sessions: [] }) })
    expect(cli.sessions.get(session)?.own).toBeNull()
    p.close()
  })

  it('answers a profiles request', async () => {
    const cli = await makeCli(47310)
    cli.profiles = {
      account: { signed_in: true, org: 'acme', plan: 'Pro', error: null },
      profiles: [{ name: 'Off', profile: { preset: 'none' } }],
      more: false,
    }
    const { bridge } = bridgeFor([cli])
    await bridge.probe()
    await bridge.allow(cli.identity)
    const p = fakePort('chrome-extension://abc/devtools-panel.html')
    serveCliPort(bridge, managerFor(bridge), p.port, 'chrome-extension://abc/')
    p.post({ type: 'cli:profiles' })
    await new Promise((r) => setTimeout(r, 20))
    expect(p.sent.find((m) => m.type === 'cli:profiles')).toEqual({
      type: 'cli:profiles',
      profiles: {
        account: { signedIn: true, org: 'acme', plan: 'Pro', error: null },
        profiles: [{ name: 'Off', profile: { preset: 'none' } }],
        more: false,
      },
    })
    p.close()
  })
})
