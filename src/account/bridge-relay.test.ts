/** The bridge runs on every origin; this filter decides what a page can say to the background's sign-in: only what comes from exactly APP_ORIGIN. */

import { describe, expect, it } from 'vitest'
import { accountRelay, type MessageEventLike, type RelayContext } from './bridge-relay'

const APP = 'https://app.moqtap.com'
const self = { name: 'the bridge window' }
const ctx: RelayContext = { selfOrigin: APP, isTop: true, self, appOrigin: APP }

const CODE = 'a'.repeat(43)
const callback = { type: 'moqtap:oauth-callback', code: CODE, state: 'st8', error: null }
const event = (data: unknown, over: Partial<MessageEventLike> = {}): MessageEventLike => ({
  source: self,
  origin: APP,
  data,
  ...over,
})

describe('the bridge relays account messages only from exactly APP_ORIGIN', () => {
  it('relays the /ext/cb callback posted by app. to its own window', () => {
    expect(accountRelay(event(callback), ctx)).toEqual({
      kind: 'moqtap-account',
      message: { type: 'moqtap:oauth-callback', code: CODE, state: 'st8', error: null },
    })
  })

  // The literal app. posts; a type spelled any other way is dropped below.
  it("relays the signed-in and signed-out hints app. posts as 'moqtap:session'", () => {
    for (const state of ['signed-in', 'signed-out'] as const) {
      expect(accountRelay(event({ type: 'moqtap:session', state }), ctx)).toEqual({
        kind: 'moqtap-account',
        message: { type: 'moqtap:session', state },
      })
    }
  })

  for (const origin of [
    'https://evil.example',
    'https://app.moqtap.com.evil.example',
    'https://evil.app.moqtap.com',
    'http://app.moqtap.com',
    'https://app.moqtap.com:8443',
    'https://moqtap.com',
    'https://moqtapusercontent.com',
    'null',
  ]) {
    it(`ignores a bridge running on ${origin}, even when the message claims app.`, () => {
      expect(accountRelay(event(callback), { ...ctx, selfOrigin: origin })).toBeNull()
    })
    it(`ignores a message whose origin is ${origin}`, () => {
      expect(accountRelay(event(callback, { origin }), ctx)).toBeNull()
    })
  }

  it('ignores a message from another window (a frame or an opener)', () => {
    expect(accountRelay(event(callback, { source: { other: true } }), ctx)).toBeNull()
    expect(accountRelay(event(callback, { source: null }), ctx)).toBeNull()
  })

  it('ignores everything in a frame, even on app.', () => {
    expect(accountRelay(event(callback), { ...ctx, isTop: false })).toBeNull()
  })

  it('ignores shapes it does not know and fields out of bounds', () => {
    for (const data of [
      null,
      'moqtap:oauth-callback',
      { type: 'moqtap:other', state: 'st8' },
      { ...callback, state: null },
      { ...callback, state: '' },
      { ...callback, state: 'x'.repeat(513) },
      { ...callback, state: 'tab\there' },
      { ...callback, code: 'short' },
      { ...callback, code: `${CODE}=` },
      { ...callback, code: 42 },
      { ...callback, code: null, error: null },
      { ...callback, error: 'Not An Error Code' },
      { type: 'moqtap:session', state: 'maybe' },
      { type: 'moqtap:session' },
    ]) {
      expect(accountRelay(event(data), ctx)).toBeNull()
    }
  })

  it('relays a fresh object with only the checked fields', () => {
    const relay = accountRelay(
      event({ ...callback, access_token: 'mqt_at_x', extra: { deep: 1 } }),
      ctx,
    )
    expect(relay?.message).toEqual({ type: 'moqtap:oauth-callback', code: CODE, state: 'st8', error: null })
  })

  it('relays an error callback (login_required on a silent attempt)', () => {
    expect(
      accountRelay(event({ ...callback, code: null, error: 'login_required' }), ctx)?.message,
    ).toEqual({ type: 'moqtap:oauth-callback', code: null, state: 'st8', error: 'login_required' })
  })
})
