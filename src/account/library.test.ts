/** The panel's upload and share calls against `api.`. */

import { describe, expect, it, vi } from 'vitest'
import { MAX_TRACE_BYTES } from './config'
import { LibraryError, libraryClient } from './library'
import { API, json } from './test-fakes'

function harness(answers: ((url: string, init: RequestInit) => Response)[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init! })
    const next = answers.shift()
    if (next === undefined) throw new Error(`unexpected fetch: ${url}`)
    return next(url, init!)
  })
  const tokens: boolean[] = []
  const getToken = async (force: boolean) => {
    tokens.push(force)
    return force ? 'mqt_at_fresh' : 'mqt_at_cached'
  }
  const client = libraryClient(getToken, { fetch: fetch as unknown as typeof globalThis.fetch, apiOrigin: API })
  return { client, calls, tokens }
}

const TRACE = {
  id: 'TRACE1',
  orgId: 'ORG1',
  bytes: 3,
  detail: 'headers',
  expiresAt: 5,
}

describe('library client', () => {
  it('uploads the bytes to the org with the bearer token and the title', async () => {
    const h = harness([() => json({ trace: TRACE }, 201)])
    const out = await h.client.upload('ORG1', new Uint8Array([1, 2, 3]), 'relay · draft-20')
    expect(out).toEqual(TRACE)
    const [c] = h.calls
    expect(c!.url).toBe(`${API}/v1/orgs/ORG1/traces?title=relay%20%C2%B7%20draft-20`)
    expect(c!.init.method).toBe('POST')
    expect(c!.init.headers).toMatchObject({
      'content-type': 'application/octet-stream',
      authorization: 'Bearer mqt_at_cached',
    })
    expect(c!.init.credentials).toBe('omit')
  })

  it('a 401 asks the background once for a fresh token and retries', async () => {
    const h = harness([() => json({ error: 'unauthorized' }, 401), () => json({ trace: TRACE }, 201)])
    await h.client.upload('ORG1', new Uint8Array([1]), null)
    expect(h.tokens).toEqual([false, true])
    expect(h.calls[1]!.init.headers).toMatchObject({ authorization: 'Bearer mqt_at_fresh' })
  })

  it('a second 401 is an error, not a loop', async () => {
    const h = harness([() => json({}, 401), () => json({ error: 'unauthorized', message: 'no' }, 401)])
    await expect(h.client.upload('ORG1', new Uint8Array([1]), null)).rejects.toMatchObject({ status: 401 })
    expect(h.calls).toHaveLength(2)
  })

  it('a trace over 25 MiB is refused before anything is sent', async () => {
    const h = harness([])
    await expect(h.client.upload('ORG1', new Uint8Array(MAX_TRACE_BYTES + 1), null)).rejects.toMatchObject({
      code: 'too_large',
    })
    expect(h.calls).toHaveLength(0)
  })

  it('server errors carry their code', async () => {
    const h = harness([() => json({ error: 'storage_quota', message: 'this library is full' }, 413)])
    const err = await h.client.upload('ORG1', new Uint8Array([1]), null).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LibraryError)
    expect(err).toMatchObject({ status: 413, code: 'storage_quota' })
  })

  it('creates a link share with its expiry and returns the URL', async () => {
    const h = harness([
      () => json({ share: { id: 'S1', audience: 'link', url: 'https://app.moqtap.com/t/S1#k=mqt_shr_x', expiresAt: 9 } }, 201),
    ])
    const share = await h.client.createLink('TRACE1', 30)
    expect(share).toEqual({ id: 'S1', audience: 'link', url: 'https://app.moqtap.com/t/S1#k=mqt_shr_x', expiresAt: 9 })
    expect(h.calls[0]!.url).toBe(`${API}/v1/traces/TRACE1/links`)
    expect(JSON.parse(h.calls[0]!.init.body as string)).toEqual({ expiresInDays: 30 })
  })

  it('shares with the org through the shares route', async () => {
    const h = harness([() => json({ share: { id: 'S2', audience: 'org' } }, 201)])
    expect(await h.client.shareWithOrg('TRACE1')).toEqual({ id: 'S2', audience: 'org', url: null, expiresAt: null })
    expect(h.calls[0]!.url).toBe(`${API}/v1/traces/TRACE1/shares`)
    expect(JSON.parse(h.calls[0]!.init.body as string)).toEqual({ audience: 'org' })
  })
})
