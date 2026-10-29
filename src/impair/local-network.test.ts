import { describe, expect, it } from 'vitest'
import { impairmentProblem } from '@/entrypoints/devtools-panel/cli-copy'
import type { CliView, TabImpairment } from '@/src/cli/messages'
import { routeFailure } from './local-network'

const perms = (states: Record<string, string>) => ({
  query: async ({ name }: { name: string }) => {
    if (!(name in states)) throw new TypeError(`unknown permission ${name}`)
    return { state: states[name]! }
  },
})

describe('routeFailure', () => {
  it('names the local network permission when the browser denied it', async () => {
    expect(await routeFailure(perms({ 'loopback-network': 'denied' }))).toBe('local-network')
    expect(await routeFailure(perms({ 'local-network-access': 'denied' }))).toBe('local-network')
  })

  it('reports any other failure as a CLI session failure', async () => {
    expect(await routeFailure(perms({ 'loopback-network': 'granted' }))).toBe('cli-session')
    expect(await routeFailure(perms({ 'loopback-network': 'prompt' }))).toBe('cli-session')
    expect(await routeFailure(perms({}))).toBe('cli-session')
    expect(await routeFailure(undefined)).toBe('cli-session')
  })
})

describe('the panel says why, with a remedy', () => {
  const connected: CliView = { state: 'connected', identity: 'i', fingerprint: 'f', port: 47310, cliVersion: '1' }
  const tab = (t: Partial<TabImpairment>): TabImpairment => ({
    tabId: 1,
    preset: '3g',
    failure: null,
    poolError: null,
    ...t,
  })

  it('shows the local network remedy', () => {
    expect(impairmentProblem(tab({ failure: 'local-network' }), connected)).toBe(
      'Allow this site to access local network devices, then reload.',
    )
  })

  it("names the page's CSP when it blocks the CLI", () => {
    expect(impairmentProblem(tab({ failure: 'blocked-by-page' }), connected)).toContain('connect-src')
  })

  it('says to switch off a page that offers protocols', () => {
    expect(impairmentProblem(tab({ failure: 'protocols' }), connected)).toContain('Set Impairment to Off')
  })

  it('says nothing when nothing is wrong or the tab is off', () => {
    expect(impairmentProblem(tab({}), connected)).toBeNull()
    expect(impairmentProblem(tab({ preset: 'none', failure: 'local-network' }), connected)).toBeNull()
  })

  it('names the CLI command when no session could be prepared', () => {
    expect(impairmentProblem(tab({ failure: 'no-session' }), { state: 'absent' })).toContain(
      'moqtap intercept --bridge',
    )
    expect(impairmentProblem(tab({ poolError: 'limit' }), connected)).toContain('Close other impaired tabs')
    expect(impairmentProblem(tab({ failure: 'no-session' }), connected)).toContain('Connect again')
  })

  it('says to reload after a connection that opened before the profile applied', () => {
    expect(impairmentProblem(tab({ failure: 'opened-early' }), connected)).toContain('Reload the page')
  })

  it('names the remedy for a worker moqtap cannot instrument', () => {
    expect(impairmentProblem(tab({ failure: 'worker-uninstrumented' }), connected)).toContain('worker-src')
  })
})
