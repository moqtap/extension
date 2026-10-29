import { webcrypto } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { KeyValueArea } from '@/src/account/stores'
import { ImpairManager } from '@/src/impair/manager'
import { serveCliPort, type CliPortLike } from './background'
import type { CliStateMsg, PageCliMsg } from './messages'
import { fromBase64Url, signedMessage, toBase64Url, type Preset } from './protocol'
import { CliBridge, CONSENT_KEY } from './service'

const subtle = webcrypto.subtle as unknown as SubtleCrypto
const PORTS = [47310, 47311, 47312]

interface FakeCli {
  port: number
  keys: CryptoKeyPair
  identity: string
  /** Signs with this key instead, as a squatter without the identity would. */
  signer?: CryptoKey
  sessions: Map<string, { port: number; owner: string; preset: Preset; connected: boolean }>
  posts: { endpoint: string; body: unknown }[]
  deletes: string[]
  nonces: Uint8Array[]
  /** Answers POST session with this status instead. */
  createStatus?: number
}

async function makeCli(port: number, extra: Partial<FakeCli> = {}): Promise<FakeCli> {
  const keys = (await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const pub = new Uint8Array(await subtle.exportKey('raw', keys.publicKey))
  return {
    port,
    keys,
    identity: toBase64Url(pub),
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
        v: 2,
        cli_version: '1.2.3',
        identity_pub: cli.identity,
        cert_hash: toBase64Url(certHash),
        port: cli.port,
        sig: toBase64Url(new Uint8Array(sig)),
      })
    }
    const entry = (id: string) => {
      const e = cli.sessions.get(id)!
      return { id, port: e.port, owner: e.owner, upstream: null, profile: { preset: e.preset }, connected: e.connected }
    }
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
    if (init?.method === 'POST') cli.posts.push({ endpoint, body })
    if (endpoint === 'status') {
      return json({ v: 2, listen: null, cert_hash: toBase64Url(certHash), sessions: [...cli.sessions.keys()].map(entry) })
    }
    if (endpoint === 'session' && init?.method === 'POST') {
      if (cli.createStatus !== undefined) return json({ error: 'no' }, cli.createStatus)
      const id = toBase64Url(webcrypto.getRandomValues(new Uint8Array(16)))
      const port = 50000 + cli.sessions.size
      cli.sessions.set(id, { port, owner: body.owner, preset: body.profile.preset, connected: false })
      const secret = toBase64Url(webcrypto.getRandomValues(new Uint8Array(16)))
      return json({ id, port, secret })
    }
    if (endpoint === 'lease' && init?.method === 'POST') return new Response(null, { status: 204 })
    const m = /^session\/([A-Za-z0-9_-]{22})(\/profile)?$/.exec(endpoint)
    if (m !== null) {
      const id = m[1]!
      if (!cli.sessions.has(id)) return json({ error: 'unknown session' }, 404)
      if (m[2] && init?.method === 'POST') {
        cli.sessions.get(id)!.preset = body.profile.preset
        return json(entry(id))
      }
      if (!m[2] && init?.method === 'DELETE') {
        cli.sessions.delete(id)
        cli.deletes.push(id)
        return new Response(null, { status: 204 })
      }
      return json({ error: 'method' }, 405)
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
    expect(await bridge.createSession('owner', '3g')).toEqual({ error: 'unreachable' })
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

  it('opens, switches and deletes sessions, and renews leases', async () => {
    const { bridge } = bridgeFor([cli])
    await bridge.probe()
    await bridge.allow(cli.identity)
    const created = await bridge.createSession('tab-1', '3g')
    if ('error' in created) throw new Error(created.error)
    expect(created.secret).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(cli.posts[0]).toEqual({ endpoint: 'session', body: { profile: { preset: '3g' }, owner: 'tab-1' } })
    expect(await bridge.setSessionPreset(created.id, '4g')).toBe(true)
    expect(cli.sessions.get(created.id)?.preset).toBe('4g')
    expect((await bridge.sessions())?.map((s) => s.id)).toEqual([created.id])
    expect(await bridge.renewLease('tab-1')).toBe(true)
    await bridge.deleteSession(created.id)
    expect(cli.deletes).toEqual([created.id])
    expect(await bridge.setSessionPreset(created.id, 'none')).toBe(false)
  })

  it('sends only the four presets and valid owners', async () => {
    const { bridge } = bridgeFor([cli])
    await bridge.probe()
    await bridge.allow(cli.identity)
    expect(await bridge.createSession('tab-1', 'slow-4g' as Preset)).toEqual({ error: 'unreachable' })
    expect(await bridge.createSession('tab 1', '3g')).toEqual({ error: 'unreachable' })
    expect(cli.posts).toEqual([])
  })

  it('reports the CLI session limit', async () => {
    cli.createStatus = 429
    const { bridge } = bridgeFor([cli])
    await bridge.probe()
    await bridge.allow(cli.identity)
    expect(await bridge.createSession('tab-1', '3g')).toEqual({ error: 'limit' })
    cli.createStatus = 400
    expect(await bridge.createSession('tab-1', '3g')).toEqual({ error: 'refused' })
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

  it('sets a tab preset only to the four values', async () => {
    const cli = await makeCli(47310)
    const { bridge } = bridgeFor([cli])
    await bridge.probe()
    await bridge.allow(cli.identity)
    const impair = managerFor(bridge)
    const p = fakePort('chrome-extension://abc/devtools-panel.html')
    serveCliPort(bridge, impair, p.port, 'chrome-extension://abc/')
    p.post({ type: 'cli:watch-tab', tabId: 7 })
    p.post({ type: 'cli:set-preset', tabId: 7, preset: 'custom' })
    p.post({ type: 'cli:set-preset', tabId: '7', preset: '3g' })
    p.post({ type: 'cli:set-preset', tabId: 7, preset: '3g' })
    await new Promise((r) => setTimeout(r, 50))
    expect(impair.view(7).preset).toBe('3g')
    expect(p.sent.filter((m) => m.type === 'cli:tab').at(-1)).toEqual({
      type: 'cli:tab',
      tab: { tabId: 7, preset: '3g', failure: null, poolError: null },
    })
    p.close()
  })
})
