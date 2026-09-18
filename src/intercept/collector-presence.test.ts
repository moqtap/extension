/**
 * Reading the `@moqtap/collector` presence marker.
 *
 * The shape is owned by the SDK
 * (`moqtap-js/packages/collector/src/transport/presence.ts`) and duplicated
 * here deliberately — see the module comment. These tests are what makes a
 * drift between the two loud.
 */

import { describe, expect, it } from 'vitest'
import { classifyConnection, readCollectorPresence } from './collector-presence'

const SINCE = 1_700_000_000_000
const marker = (over: Record<string, unknown> = {}) => ({
  __moqtapCollector: {
    v: 1,
    version: '0.1.0',
    since: SINCE,
    active: true,
    ...over,
  },
})

describe('readCollectorPresence', () => {
  it('reads the marker the SDK publishes', () => {
    expect(readCollectorPresence(marker())).toEqual({
      v: 1,
      version: '0.1.0',
      since: SINCE,
      active: true,
    })
  })

  it('reports nothing on a page with no SDK', () => {
    expect(readCollectorPresence({})).toBeNull()
  })

  it('refuses anything that is not the shape we know', () => {
    // Any page script can write this property. Trusting the shape would let a
    // page make the panel claim a collector that is not there -- the panel is
    // a diagnostic, and a lying diagnostic is worse than none.
    expect(readCollectorPresence({ __moqtapCollector: 'yes' })).toBeNull()
    expect(readCollectorPresence(marker({ v: 2 }))).toBeNull()
    expect(readCollectorPresence(marker({ since: 'soon' }))).toBeNull()
    expect(readCollectorPresence(marker({ active: 'true' }))).toBeNull()
    expect(readCollectorPresence(marker({ version: 1 }))).toBeNull()
  })
})

describe('classifyConnection', () => {
  it('says nothing when there is no SDK', () => {
    expect(classifyConnection(SINCE + 1, null)).toEqual({ state: 'none' })
  })

  it('marks a connection opened after the SDK attached as collected', () => {
    expect(
      classifyConnection(SINCE + 1, readCollectorPresence(marker())),
    ).toEqual({
      state: 'collected',
      version: '0.1.0',
    })
  })

  it('distinguishes an SDK that is installed but sending nothing', () => {
    // The SDK's hook installs at module eval and stays dormant until a key
    // arrives. "The SDK is on the page but nothing is being collected" is the
    // single most confusing state this product has, and this is the only
    // surface that can name it.
    expect(
      classifyConnection(
        SINCE + 1,
        readCollectorPresence(marker({ active: false })),
      ),
    ).toEqual({ state: 'dormant', version: '0.1.0' })
  })

  it('marks a connection that opened before the SDK attached', () => {
    // A transport opened at module-eval time with `init()` called later is a
    // real ordering bug, and the SDK genuinely never saw this connection.
    expect(
      classifyConnection(SINCE - 1, readCollectorPresence(marker())),
    ).toEqual({
      state: 'predates',
      version: '0.1.0',
    })
  })

  it('under-claims rather than over-claims at the boundary', () => {
    // The rule that matters: it must never say "collected" about a connection
    // the SDK did not see. Equal timestamps are inside the window; anything
    // earlier is not.
    const p = readCollectorPresence(marker())
    expect(classifyConnection(SINCE, p).state).toBe('collected')
    expect(classifyConnection(SINCE - 1, p).state).toBe('predates')
  })
})
