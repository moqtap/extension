/**
 * The background's account state machine, on in-memory storage and a scripted moqtap.
 */

import { describe, expect, it } from 'vitest'
import { challengeFor } from './pkce'
import {
  ACCESS_KEY,
  ACCESS_SKEW_MS,
  META_KEY,
  PENDING_KEY,
  PENDING_TTL_MS,
  SILENT_BACKOFF_MS,
  SignedOutError,
  UnreachableError,
} from './service'
import {
  API,
  APP,
  appSender,
  callbackMsg,
  hintMsg,
  json,
  ORGS,
  signIn,
  tokenBody,
  World,
} from './test-fakes'

describe('sign-in through the bridge', () => {
  it('opens the authorize page on app. with the extension client, its /ext/cb redirect and an S256 challenge', async () => {
    const w = new World()
    await w.service().beginSignIn(false)
    const tab = w.opened[0]!
    expect(tab.active).toBe(true)
    const url = new URL(tab.url)
    expect(`${url.origin}${url.pathname}`).toBe(`${APP}/oauth/authorize`)
    const p = url.searchParams
    expect(p.get('client_id')).toBe('moqtap-extension')
    expect(p.get('redirect_uri')).toBe(`${APP}/ext/cb`)
    expect(p.get('response_type')).toBe('code')
    expect(p.get('code_challenge_method')).toBe('S256')
    expect(p.get('prompt')).toBeNull()
    const pending = (await w.session.get(PENDING_KEY)) as { state: string; verifier: string }[]
    expect(pending).toHaveLength(1)
    expect(p.get('state')).toBe(pending[0]!.state)
    expect(p.get('code_challenge')).toBe(await challengeFor(pending[0]!.verifier))
  })

  it('redeems the code at api./oauth/token with the stored verifier and the exact redirect', async () => {
    const w = new World()
    const svc = w.service()
    await svc.beginSignIn(false)
    const { verifier } = ((await w.session.get(PENDING_KEY)) as { verifier: string }[])[0]!
    const outcome = await svc.handleBridge(
      callbackMsg(w.lastAuthorize().get('state'), 'K'.repeat(43)),
      appSender(w.opened[0]!.id),
    )
    expect(outcome).toBe('signed-in')
    const [redeem] = w.net.callsTo('/oauth/token')
    expect(Object.fromEntries(redeem!.form!)).toEqual({
      grant_type: 'authorization_code',
      code: 'K'.repeat(43),
      redirect_uri: `${APP}/ext/cb`,
      code_verifier: verifier,
      client_id: 'moqtap-extension',
      device_label: 'Chrome extension',
    })
    expect(w.secrets.refresh).toBe('mqt_rt_refresh1')
    expect(await w.session.get(PENDING_KEY)).toEqual([])
    expect(w.closed).toEqual([w.opened[0]!.id])
    expect(await svc.view()).toEqual({
      status: 'signed-in',
      handle: 'alice',
      orgs: ORGS.orgs,
      unreachable: false,
    })
  })

  it('a callback whose state matches no pending flow is rejected and spends nothing', async () => {
    const w = new World()
    const svc = w.service()
    await svc.beginSignIn(false)
    const outcome = await svc.handleBridge(
      callbackMsg('an-attacker-chosen-state'),
      appSender(w.opened[0]!.id),
    )
    expect(outcome).toBe('state-mismatch')
    expect(w.net.calls).toHaveLength(0)
    expect(w.secrets.refresh).toBeNull()
    // The real flow is still waiting for its own callback.
    expect(await w.session.get(PENDING_KEY)).toHaveLength(1)
  })

  it('a state is single use: replaying a completed callback is a mismatch', async () => {
    const w = new World()
    const svc = w.service()
    const tab = await signIn(w, svc)
    const state = w.lastAuthorize().get('state')
    expect(await svc.handleBridge(callbackMsg(state), appSender(tab))).toBe('state-mismatch')
    expect(w.net.callsTo('/oauth/token')).toHaveLength(1)
  })

  it('the PKCE verifier and state survive a background restart', async () => {
    const w = new World()
    await w.service().beginSignIn(false)
    const state = w.lastAuthorize().get('state')
    // The worker is killed while the user is on the login page; a new one
    // is started by the bridge's message and knows nothing in memory.
    const restarted = w.service()
    const outcome = await restarted.handleBridge(callbackMsg(state), appSender(w.opened[0]!.id))
    expect(outcome).toBe('signed-in')
    const redeem = w.net.callsTo('/oauth/token')[0]!
    const verifier = redeem.form!.get('code_verifier')!
    expect(await challengeFor(verifier)).toBe(w.lastAuthorize().get('code_challenge'))
  })

  it('two copies of one callback arriving together spend the code once', async () => {
    const w = new World()
    const svc = w.service()
    await svc.beginSignIn(false)
    const msg = callbackMsg(w.lastAuthorize().get('state'))
    const sender = appSender(w.opened[0]!.id)
    const outcomes = await Promise.all([svc.handleBridge(msg, sender), svc.handleBridge(msg, sender)])
    expect(outcomes.sort()).toEqual(['signed-in', 'state-mismatch'])
    expect(w.net.callsTo('/oauth/token')).toHaveLength(1)
  })

  it('a flow older than ten minutes is forgotten', async () => {
    const w = new World()
    await w.service().beginSignIn(false)
    const state = w.lastAuthorize().get('state')
    w.now += PENDING_TTL_MS
    const outcome = await w.service().handleBridge(callbackMsg(state), appSender(w.opened[0]!.id))
    expect(outcome).toBe('state-mismatch')
  })

  it('a sender that is not the top frame of an app. tab is refused before its state is read', async () => {
    const w = new World()
    const svc = w.service()
    await svc.beginSignIn(false)
    const state = w.lastAuthorize().get('state')
    const good = appSender(w.opened[0]!.id)
    for (const sender of [
      { ...good, url: 'https://evil.example/ext/cb' },
      { ...good, url: 'https://app.moqtap.com.evil.example/ext/cb' },
      { ...good, url: 'http://app.moqtap.com/ext/cb' },
      { ...good, frameId: 3 },
      { ...good, tab: undefined },
      { ...good, id: 'some-other-extension' },
      { ...good, url: undefined },
    ]) {
      expect(await svc.handleBridge(callbackMsg(state), sender)).toBe('bad-sender')
    }
    expect(w.net.calls).toHaveLength(0)
    expect(await svc.handleBridge(callbackMsg(state), good)).toBe('signed-in')
  })

  it('an error callback ends an interactive flow with a notice and no token request', async () => {
    const w = new World()
    const svc = w.service()
    await svc.beginSignIn(false)
    const outcome = await svc.handleBridge(
      callbackMsg(w.lastAuthorize().get('state'), null, 'access_denied'),
      appSender(w.opened[0]!.id),
    )
    expect(outcome).toBe('flow-error')
    expect(w.net.calls).toHaveLength(0)
    expect(await svc.view()).toEqual({ status: 'signed-out', signingIn: false, notice: 'sign-in-failed' })
  })

  it('a code the server refuses leaves the extension signed out', async () => {
    const w = new World()
    w.net.token = () => json({ error: 'invalid_grant' }, 400)
    const svc = w.service()
    await svc.beginSignIn(false)
    const outcome = await svc.handleBridge(
      callbackMsg(w.lastAuthorize().get('state')),
      appSender(w.opened[0]!.id),
    )
    expect(outcome).toBe('redeem-failed')
    expect(w.secrets.refresh).toBeNull()
    expect((await svc.view()).status).toBe('signed-out')
  })

  it('signing in again revokes the family it replaces', async () => {
    const w = new World()
    const svc = w.service()
    await signIn(w, svc)
    w.net.token = () => json(tokenBody(2))
    await signIn(w, svc)
    expect(w.secrets.refresh).toBe('mqt_rt_refresh2')
    const revoked = w.net.callsTo('/oauth/revoke').map((c) => c.form!.get('token'))
    expect(revoked).toEqual(['mqt_rt_refresh1'])
  })
})

describe('silent pickup of an app. login', () => {
  it('a signed-in hint runs the flow in a background tab with prompt=none', async () => {
    const w = new World()
    const svc = w.service()
    expect(await svc.handleBridge(hintMsg('signed-in'), appSender(7, `${APP}/`))).toBe('silent-started')
    expect(w.opened[0]!.active).toBe(false)
    expect(w.lastAuthorize().get('prompt')).toBe('none')
    const outcome = await svc.handleBridge(
      callbackMsg(w.lastAuthorize().get('state')),
      appSender(w.opened[0]!.id),
    )
    expect(outcome).toBe('signed-in')
    expect(w.closed).toEqual([w.opened[0]!.id])
  })

  it('a silent login_required closes the tab quietly and is not retried on every page load', async () => {
    const w = new World()
    const svc = w.service()
    await svc.handleBridge(hintMsg('signed-in'), appSender(7, `${APP}/`))
    await svc.handleBridge(
      callbackMsg(w.lastAuthorize().get('state'), null, 'login_required'),
      appSender(w.opened[0]!.id),
    )
    expect(await svc.view()).toEqual({ status: 'signed-out', signingIn: false, notice: null })
    expect(await svc.handleBridge(hintMsg('signed-in'), appSender(7, `${APP}/`))).toBe('ignored')
    // Nor after the background restarts.
    expect(await w.service().handleBridge(hintMsg('signed-in'), appSender(7, `${APP}/`))).toBe('ignored')
    expect(w.opened).toHaveLength(1)
    // It tries again once the back-off has passed.
    w.now += SILENT_BACKOFF_MS
    expect(await svc.handleBridge(hintMsg('signed-in'), appSender(7, `${APP}/`))).toBe('silent-started')
  })

  it('a silent pickup that succeeded does not hold back the next one: sign out then in on app. within minutes', async () => {
    const w = new World()
    const svc = w.service()
    await svc.handleBridge(hintMsg('signed-in'), appSender(7, `${APP}/`))
    await svc.handleBridge(callbackMsg(w.lastAuthorize().get('state')), appSender(w.opened[0]!.id))
    expect((await svc.view()).status).toBe('signed-in')
    w.now += 2 * 60 * 1000
    expect(await svc.handleBridge(hintMsg('signed-out'), appSender(7, `${APP}/`))).toBe('signed-out')
    w.now += 60 * 1000
    expect(await svc.handleBridge(hintMsg('signed-in'), appSender(7, `${APP}/`))).toBe('silent-started')
  })

  it('a signed-out hint lifts the back-off of a failed silent attempt, since the next login on app. is new', async () => {
    const w = new World()
    const svc = w.service()
    await svc.handleBridge(hintMsg('signed-in'), appSender(7, `${APP}/`))
    await svc.handleBridge(
      callbackMsg(w.lastAuthorize().get('state'), null, 'login_required'),
      appSender(w.opened[0]!.id),
    )
    await svc.handleBridge(hintMsg('signed-out'), appSender(7, `${APP}/`))
    expect(await svc.handleBridge(hintMsg('signed-in'), appSender(7, `${APP}/`))).toBe('silent-started')
  })

  it('a signed-in hint does nothing when the extension is already signed in', async () => {
    const w = new World()
    const svc = w.service()
    await signIn(w, svc)
    const tabs = w.opened.length
    expect(await svc.handleBridge(hintMsg('signed-in'), appSender(7, `${APP}/`))).toBe('ignored')
    expect(w.opened).toHaveLength(tabs)
  })

  it('after "Disconnect this browser" a signed-in hint does not sign the extension back in', async () => {
    const w = new World()
    const svc = w.service()
    await signIn(w, svc)
    await svc.disconnect()
    w.now += 24 * 60 * 60 * 1000
    expect(await svc.handleBridge(hintMsg('signed-in'), appSender(7, `${APP}/`))).toBe('ignored')
    // Until the user asks for it.
    await signIn(w, svc)
    expect((await svc.view()).status).toBe('signed-in')
  })

  it('a signed-out hint signs the extension out and revokes its family', async () => {
    const w = new World()
    const svc = w.service()
    await signIn(w, svc)
    expect(await svc.handleBridge(hintMsg('signed-out'), appSender(7, `${APP}/`))).toBe('signed-out')
    expect(w.net.callsTo('/oauth/revoke').map((c) => c.form!.get('token'))).toEqual(['mqt_rt_refresh1'])
    expect(w.secrets.refresh).toBeNull()
    expect(await w.session.get(ACCESS_KEY)).toBeUndefined()
    expect(await svc.view()).toEqual({ status: 'signed-out', signingIn: false, notice: 'app-signed-out' })
  })
})

describe('access tokens and refresh', () => {
  async function signedInWorld() {
    const w = new World()
    const svc = w.service()
    await signIn(w, svc)
    return { w, svc }
  }

  it('a cached access token is used until a minute before it expires', async () => {
    const { w, svc } = await signedInWorld()
    expect(await svc.accessToken()).toBe('mqt_at_access1')
    w.now += 3600 * 1000 - ACCESS_SKEW_MS - 1
    expect(await svc.accessToken()).toBe('mqt_at_access1')
    expect(w.net.callsTo('/oauth/token')).toHaveLength(1)
  })

  it('single-flight: concurrent callers past expiry share one refresh', async () => {
    const { w, svc } = await signedInWorld()
    w.now += 3600 * 1000
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    w.net.token = async () => {
      await gate
      return json(tokenBody(2))
    }
    const all = Promise.all(Array.from({ length: 8 }, () => svc.accessToken()))
    // Let every caller reach the refresh before the server answers.
    await new Promise((r) => setTimeout(r, 0))
    release()
    expect(new Set(await all)).toEqual(new Set(['mqt_at_access2']))
    const refreshes = w.net.callsTo('/oauth/token').filter((c) => c.form!.get('grant_type') === 'refresh_token')
    expect(refreshes).toHaveLength(1)
    expect(refreshes[0]!.form!.get('refresh_token')).toBe('mqt_rt_refresh1')
    expect(w.secrets.refresh).toBe('mqt_rt_refresh2')
  })

  it('a refresh after the first one completes is a new request with the rotated token', async () => {
    const { w, svc } = await signedInWorld()
    w.net.token = () => json(tokenBody(2))
    await svc.accessToken({ force: true })
    w.net.token = () => json(tokenBody(3))
    await svc.accessToken({ force: true })
    const presented = w.net
      .callsTo('/oauth/token')
      .filter((c) => c.form!.get('grant_type') === 'refresh_token')
      .map((c) => c.form!.get('refresh_token'))
    expect(presented).toEqual(['mqt_rt_refresh1', 'mqt_rt_refresh2'])
  })

  for (const [name, answer] of [
    ['a 500', () => json({ error: 'server_error' }, 500)],
    ['a 503 temporarily_unavailable', () => json({ error: 'temporarily_unavailable' }, 503)],
    ['a 429', () => json({ error: 'rate_limited' }, 429)],
    ['a 502 without JSON', () => new Response('<html>bad gateway</html>', { status: 502 })],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
  ] as const) {
    it(`${name} on refresh keeps every credential and reports unreachable`, async () => {
      const { w, svc } = await signedInWorld()
      w.now += 3600 * 1000
      w.net.token = answer
      await expect(svc.accessToken()).rejects.toBeInstanceOf(UnreachableError)
      expect(w.secrets.refresh).toBe('mqt_rt_refresh1')
      expect(await w.local.get(META_KEY)).toBeDefined()
      expect(await svc.view()).toMatchObject({ status: 'signed-in', unreachable: true })
      // And it recovers when the server is back.
      w.net.token = () => json(tokenBody(2))
      expect(await svc.accessToken()).toBe('mqt_at_access2')
      expect(await svc.view()).toMatchObject({ status: 'signed-in', unreachable: false })
    })
  }

  for (const [name, answer] of [
    ['a 400 invalid_request', () => json({ error: 'invalid_request' }, 400)],
    ['a 401 invalid_client', () => json({ error: 'invalid_client' }, 401)],
  ] as const) {
    it(`${name} on refresh is not a verdict on the sign-in: credentials are kept`, async () => {
      const { w, svc } = await signedInWorld()
      w.now += 3600 * 1000
      w.net.token = answer
      await expect(svc.accessToken()).rejects.toBeInstanceOf(UnreachableError)
      expect(w.secrets.refresh).toBe('mqt_rt_refresh1')
      expect((await svc.view()).status).toBe('signed-in')
    })
  }

  it('invalid_grant deletes the credentials and says "Signed out from another device"', async () => {
    const { w, svc } = await signedInWorld()
    w.now += 3600 * 1000
    w.net.token = () => json({ error: 'invalid_grant', error_description: 'invalid refresh token' }, 400)
    await expect(svc.accessToken()).rejects.toBeInstanceOf(SignedOutError)
    expect(w.secrets.refresh).toBeNull()
    expect(await w.session.get(ACCESS_KEY)).toBeUndefined()
    expect(await svc.view()).toEqual({ status: 'signed-out', signingIn: false, notice: 'revoked' })
  })

  it('after invalid_grant (the browser removed under Devices) a signed-in hint does not sign it back in', async () => {
    const { w, svc } = await signedInWorld()
    w.now += 3600 * 1000
    w.net.token = () => json({ error: 'invalid_grant', error_description: 'invalid refresh token' }, 400)
    await expect(svc.accessToken()).rejects.toBeInstanceOf(SignedOutError)
    w.net.token = () => json(tokenBody(2))
    const tabs = w.opened.length
    w.now += 24 * 60 * 60 * 1000
    expect(await svc.handleBridge(hintMsg('signed-in'), appSender(7, `${APP}/`))).toBe('ignored')
    expect(w.opened).toHaveLength(tabs)
    // Until the user asks for it.
    await signIn(w, svc)
    expect((await svc.view()).status).toBe('signed-in')
  })

  it('degraded mode (no refresh_token in the answer) keeps the stored refresh token', async () => {
    const { w, svc } = await signedInWorld()
    w.now += 3600 * 1000
    const { refresh_token: _drop, ...degraded } = tokenBody(2)
    w.net.token = () => json(degraded)
    expect(await svc.accessToken()).toBe('mqt_at_access2')
    expect(w.secrets.refresh).toBe('mqt_rt_refresh1')
  })

  /** A refresh held at the server until `release()`, for racing it. */
  function holdRefresh(w: World, answer: () => Response) {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const signIn = w.net.token
    w.net.token = async (call) => {
      if (call.form!.get('grant_type') !== 'refresh_token') return signIn(call)
      await gate
      return answer()
    }
    return () => release()
  }
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const revoked = (w: World) => w.net.callsTo('/oauth/revoke').map((c) => c.form!.get('token'))

  for (const [name, signOut] of [
    ['Disconnect', (svc: ReturnType<World['service']>) => svc.disconnect()],
    [
      'a signed-out hint',
      (svc: ReturnType<World['service']>) => svc.handleBridge(hintMsg('signed-out'), appSender(7, `${APP}/`)),
    ],
  ] as const) {
    it(`a refresh in flight when ${name} lands writes nothing back, so nothing can upload afterwards`, async () => {
      const { w, svc } = await signedInWorld()
      w.now += 3600 * 1000
      const release = holdRefresh(w, () => json(tokenBody(2)))
      const inFlight = svc.accessToken()
      await tick()
      await signOut(svc)
      release()
      await expect(inFlight).rejects.toBeInstanceOf(SignedOutError)
      expect(w.secrets.refresh).toBeNull()
      expect(await w.session.get(ACCESS_KEY)).toBeUndefined()
      await expect(svc.accessToken()).rejects.toBeInstanceOf(SignedOutError)
      // The family the late answer rotated to is ended, not left live.
      expect(revoked(w)).toContain('mqt_rt_refresh2')
    })
  }

  it("a refresh racing a new sign-in cannot put the old family's token over the new one", async () => {
    const { w, svc } = await signedInWorld()
    w.now += 3600 * 1000
    w.net.token = () => json(tokenBody(2))
    const release = holdRefresh(w, () => json(tokenBody(9)))
    const inFlight = svc.accessToken()
    await tick()
    await signIn(w, svc)
    release()
    expect(await inFlight).toBe('mqt_at_access2')
    expect(w.secrets.refresh).toBe('mqt_rt_refresh2')
    expect(await svc.accessToken()).toBe('mqt_at_access2')
    expect(revoked(w)).toEqual(expect.arrayContaining(['mqt_rt_refresh1', 'mqt_rt_refresh9']))
    expect(revoked(w)).not.toContain('mqt_rt_refresh2')
  })

  it("the old family's invalid_grant, answered after a new sign-in, does not sign the new one out", async () => {
    const { w, svc } = await signedInWorld()
    w.now += 3600 * 1000
    w.net.token = () => json(tokenBody(2))
    const release = holdRefresh(w, () => json({ error: 'invalid_grant' }, 400))
    const inFlight = svc.accessToken()
    await tick()
    await signIn(w, svc)
    release()
    await inFlight.catch(() => {})
    expect(w.secrets.refresh).toBe('mqt_rt_refresh2')
    expect(await svc.view()).toMatchObject({ status: 'signed-in' })
    expect(await svc.accessToken()).toBe('mqt_at_access2')
  })

  it('a cached access token is not handed out without a sign-in to go with it', async () => {
    const w = new World()
    await w.session.set(ACCESS_KEY, { token: 'mqt_at_orphan', expiresAt: w.now + 3600 * 1000 })
    await expect(w.service().accessToken()).rejects.toBeInstanceOf(SignedOutError)
  })

  it('signed out, there is nothing to refresh', async () => {
    const w = new World()
    await expect(w.service().accessToken()).rejects.toBeInstanceOf(SignedOutError)
    expect(w.net.calls).toHaveLength(0)
  })
})

describe('Disconnect this browser', () => {
  it('revokes the family with the refresh token and the client id, then forgets it', async () => {
    const w = new World()
    const svc = w.service()
    await signIn(w, svc)
    await svc.disconnect()
    const [revoke] = w.net.callsTo('/oauth/revoke')
    expect(Object.fromEntries(revoke!.form!)).toEqual({
      token: 'mqt_rt_refresh1',
      client_id: 'moqtap-extension',
    })
    expect(w.secrets.refresh).toBeNull()
    expect(await svc.view()).toEqual({ status: 'signed-out', signingIn: false, notice: null })
  })

  it('when moqtap cannot be reached it still forgets the tokens and says the device may still be listed', async () => {
    const w = new World()
    const svc = w.service()
    await signIn(w, svc)
    w.net.revoke = () => Promise.reject(new TypeError('Failed to fetch'))
    await svc.disconnect()
    expect(w.secrets.refresh).toBeNull()
    expect(await svc.view()).toEqual({
      status: 'signed-out',
      signingIn: false,
      notice: 'disconnect-unconfirmed',
    })
  })
})

describe('where the tokens are', () => {
  it('nothing in storage.local or the published view holds a token', async () => {
    const w = new World()
    const svc = w.service()
    const views: unknown[] = []
    svc.onChange((v) => views.push(v))
    await signIn(w, svc)
    w.now += 3600 * 1000
    w.net.token = () => json(tokenBody(2))
    await svc.accessToken()
    const local = JSON.stringify([...w.local.data.entries()])
    expect(local).not.toContain('mqt_')
    expect(JSON.stringify(views)).not.toContain('mqt_')
    expect(JSON.stringify(await svc.view())).not.toContain('mqt_')
    // The refresh token is only in the secret store; the access token only in
    // storage.session.
    expect(JSON.stringify([...w.session.data.entries()])).not.toContain('mqt_rt_')
    expect(w.secrets.refresh).toBe('mqt_rt_refresh2')
  })

  it('every request carries no cookie and goes to api.', async () => {
    const w = new World()
    await signIn(w, w.service())
    for (const [, init] of w.net.fetch.mock.calls) {
      expect(init?.credentials).toBe('omit')
    }
    expect(w.net.calls.every((c) => c.url.startsWith(`${API}/`))).toBe(true)
  })
})
