import { webcrypto } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { KeyValueArea } from '@/src/account/stores'
import { serveCliPort, type CliPortLike } from './background'
import type { CliStateMsg, PageCliMsg } from './messages'
import { fromBase64Url, signedMessage, toBase64Url, type Link } from './protocol'
import { CliBridge, CONSENT_KEY } from './service'

const subtle = webcrypto.subtle as unknown as SubtleCrypto
const PORTS = [47310, 47311, 47312]

interface FakeCli {
  port: number
  keys: CryptoKeyPair
  identity: string
  /** Signs with this key instead, as a squatter without the identity would. */
  signer?: CryptoKey
  scenario?: boolean
  link: Link
  posts: unknown[]
  nonces: Uint8Array[]
}

async function makeCli(port: number, extra: Partial<FakeCli> = {}): Promise<FakeCli> {
  const keys = (await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const pub = new Uint8Array(await subtle.exportKey('raw', keys.publicKey))
  return { port, keys, identity: toBase64Url(pub), link: 'none', posts: [], nonces: [], ...extra }
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
        v: 1,
        cli_version: '1.2.3',
        identity_pub: cli.identity,
        cert_hash: toBase64Url(certHash),
        port: cli.port,
        sig: toBase64Url(new Uint8Array(sig)),
      })
    }
    // The CLI's status shape, from cli src/bridge.rs.
    const status = () => ({
      v: 1,
      link: cli.scenario ? null : cli.link,
      scenario: cli.scenario ?? false,
      client_connected: true,
      listen: '127.0.0.1:4443',
    })
    if (endpoint === 'status') return json(status())
    if (endpoint === 'link' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { link: Link }
      cli.posts.push(body)
      if (cli.scenario) return json({ error: 'restart it without -s to set the link' }, 409)
      cli.link = body.link
      return json(status())
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
    await bridge.setLink('3g')
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
    const v = again.view()
    expect(v.state).toBe('connected')
    if (v.state === 'connected') expect(v.status).toEqual({
        link: 'none',
        scenario: false,
        clientConnected: true,
        listen: '127.0.0.1:4443',
      })
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

  it('sends only the four link values', async () => {
    const { bridge } = bridgeFor([cli])
    await bridge.probe()
    await bridge.allow(cli.identity)
    for (const l of ['none', 'offline', '3g', '4g'] as const) await bridge.setLink(l)
    await bridge.setLink('slow-4g' as Link)
    await bridge.setLink({ profile: 'x' } as unknown as Link)
    expect(cli.posts).toEqual([{ link: 'none' }, { link: 'offline' }, { link: '3g' }, { link: '4g' }])
    const v = bridge.view()
    expect(v.state === 'connected' && v.status?.link).toBe('4g')
  })

  it('reports a scenario run on 409', async () => {
    cli.scenario = true
    const { bridge } = bridgeFor([cli])
    await bridge.probe()
    await bridge.allow(cli.identity)
    const before = bridge.view()
    expect(before.state === 'connected' && before.status).toEqual({
      link: null,
      scenario: true,
      clientConnected: true,
      listen: '127.0.0.1:4443',
    })
    await bridge.setLink('3g')
    const v = bridge.view()
    expect(v.state === 'connected' && v.error).toBe('scenario')
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
    expect(serveCliPort(bridge, p.port, 'chrome-extension://abc/')).toBe(false)
    expect(p.isDisconnected()).toBe(true)
  })

  it('passes on only the four link values', async () => {
    const cli = await makeCli(47310)
    const { bridge } = bridgeFor([cli])
    await bridge.probe()
    await bridge.allow(cli.identity)
    const p = fakePort('chrome-extension://abc/devtools-panel.html')
    serveCliPort(bridge, p.port, 'chrome-extension://abc/')
    p.post({ type: 'cli:set-link', link: 'custom' })
    p.post({ type: 'cli:set-link', link: '3g' })
    await new Promise((r) => setTimeout(r, 50))
    expect(cli.posts).toEqual([{ link: '3g' }])
    p.close()
  })
})
