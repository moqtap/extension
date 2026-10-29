import { describe, expect, it } from 'vitest'
import { impairmentProblem, sessionImpairmentProblem } from '@/entrypoints/devtools-panel/cli-copy'
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
    profile: { preset: '3g' },
    name: '3G',
    sessions: [],
    unknown: [],
    sessionErrors: [],
    failure: null,
    error: null,
    refusal: null,
    refusedName: null,
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

  it('says nothing when nothing is wrong or the tab is off', () => {
    expect(impairmentProblem(tab({}), connected)).toBeNull()
    expect(impairmentProblem(tab({ profile: { preset: 'none' }, failure: 'local-network' }), connected)).toBeNull()
  })

  it('names the CLI command when the CLI is not reachable', () => {
    expect(impairmentProblem(tab({ failure: 'no-cli' }), { state: 'absent' })).toContain('moqtap intercept --bridge')
    expect(impairmentProblem(tab({ error: 'unreachable' }), connected)).toContain('moqtap intercept --bridge')
    expect(impairmentProblem(tab({ error: 'limit' }), connected)).toContain('Set other tabs to Off')
  })

  it('says to reload after the page missed its answer', () => {
    expect(impairmentProblem(tab({ failure: 'no-answer' }), connected)).toContain('Reload the page')
  })

  it('names the remedy for a worker moqtap cannot instrument', () => {
    expect(impairmentProblem(tab({ failure: 'worker-uninstrumented' }), connected)).toContain('worker-src')
  })

  it("says why one connection did not take its profile, and leaves the tab's problem alone", () => {
    const S = 'A'.repeat(21) + 'Q'
    const t = tab({ sessionErrors: [{ session: S, error: 'refused', refusal: null }] })
    expect(sessionImpairmentProblem(t, S, connected)).toContain("Couldn't apply this profile")
    expect(sessionImpairmentProblem(t, 'B'.repeat(21) + 'Q', connected)).toBeNull()
    expect(impairmentProblem(t, connected)).toBeNull()
    const lost = tab({ sessionErrors: [{ session: S, error: 'unreachable', refusal: null }] })
    expect(sessionImpairmentProblem(lost, S, connected)).toContain('moqtap intercept --bridge')
    expect(sessionImpairmentProblem(lost, S, { state: 'absent' })).toContain("isn't running")
  })
})
