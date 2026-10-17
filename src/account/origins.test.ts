/**
 * Which deployment a build talks to is fixed at build time (wxt.config.ts).
 */

import { describe, expect, it } from 'vitest'
import { APP_ORIGIN, API_ORIGIN } from './config'
import { isOrigin, originsFor, PRODUCTION_ORIGINS } from './origins'

describe('build origins', () => {
  it('a production build talks to app.moqtap.com and api.moqtap.com', () => {
    expect(originsFor('production')).toEqual({
      app: 'https://app.moqtap.com',
      api: 'https://api.moqtap.com',
    })
  })

  it('a non-production build without an override talks to production', () => {
    expect(originsFor('development')).toEqual(PRODUCTION_ORIGINS)
    expect(originsFor('staging')).toEqual(PRODUCTION_ORIGINS)
  })

  it('a production build refuses a dev override instead of shipping it', () => {
    expect(() => originsFor('production', { MOQTAP_APP_ORIGIN: 'http://app.localhost:8787' })).toThrow()
    expect(() => originsFor('production', { MOQTAP_API_ORIGIN: 'http://api.localhost:8787' })).toThrow()
  })

  it('a dev override must be exactly an origin, https or localhost', () => {
    expect(
      originsFor('development', {
        MOQTAP_APP_ORIGIN: 'http://app.localhost:8787',
        MOQTAP_API_ORIGIN: 'http://api.localhost:8787',
      }),
    ).toEqual({ app: 'http://app.localhost:8787', api: 'http://api.localhost:8787' })
    for (const bad of [
      'http://app.example.com',
      'https://app.example.com/',
      'https://app.example.com/path',
      'app.example.com',
      'https://user@app.example.com',
    ]) {
      expect(isOrigin(bad)).toBe(false)
      expect(() =>
        originsFor('development', {
          MOQTAP_APP_ORIGIN: bad,
          MOQTAP_API_ORIGIN: 'http://api.localhost:8787',
        }),
      ).toThrow(/not an origin/)
    }
    expect(() =>
      originsFor('development', {
        MOQTAP_APP_ORIGIN: PRODUCTION_ORIGINS.api,
        MOQTAP_API_ORIGIN: PRODUCTION_ORIGINS.api,
      }),
    ).toThrow(/differ/)
  })

  it('a dev override names both origins or neither', () => {
    expect(() => originsFor('development', { MOQTAP_APP_ORIGIN: 'http://app.localhost:8787' })).toThrow(/together/)
    expect(() => originsFor('development', { MOQTAP_API_ORIGIN: 'http://api.localhost:8787' })).toThrow(/together/)
  })

  it('without the build-time define (unit tests) the constants are production', () => {
    expect({ app: APP_ORIGIN, api: API_ORIGIN }).toEqual(PRODUCTION_ORIGINS)
  })
})
