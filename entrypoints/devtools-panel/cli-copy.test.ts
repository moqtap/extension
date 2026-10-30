import { describe, expect, it } from 'vitest'
import type { CliView, TabImpairment } from '@/src/cli/messages'
import type { Refusal } from '@/src/cli/protocol'
import { impairmentProblem, PRO_URL, refusalAction, refusalUpgrade, sessionImpairmentProblem } from './cli-copy'

const connected: CliView = { state: 'connected', identity: 'i', fingerprint: 'f', port: 47310, cliVersion: '1' }
const S = 'A'.repeat(21) + 'Q'
const tab = (t: Partial<TabImpairment>): TabImpairment => ({
  tabId: 1,
  profile: { scenario: 'lte' },
  name: 'lte',
  sessions: [],
  unknown: [],
  sessionErrors: [],
  failure: null,
  error: null,
  refusal: null,
  refusedName: null,
  ...t,
})
const plan: Refusal = {
  error: 'Pro plan is required to run this scenario. acme is on Free: upgrade at https://moqtap.com/up.',
  reason: 'plan_required',
  plan: 'Pro',
  upgrade: { plan: 'Pro', url: 'https://moqtap.com/up' },
}
const invalid: Refusal = { error: 'lte.json: transport cannot apply', reason: 'invalid_scenario', plan: null, upgrade: null }
const missing: Refusal = { error: 'There is no scenario named "harbour-fog".', reason: 'unknown_scenario', plan: null, upgrade: null }

describe('a refused profile', () => {
  it('names the plan that runs it, with where to upgrade', () => {
    const t = tab({ error: 'refused', refusal: plan })
    expect(impairmentProblem(t, connected)).toBe('Pro plan is required to run this scenario.')
    expect(refusalUpgrade(t, connected)).toEqual(plan.upgrade)
    expect(refusalAction(t, connected)).toBe('upgrade')
  })

  it('links a plan refusal with no upgrade page to pricing', () => {
    const signedOut: Refusal = { error: 'run moqtap login', reason: 'plan_required', plan: 'Business', upgrade: null }
    const t = tab({ error: 'refused', refusal: signedOut, refusedName: 'shaped' })
    expect(impairmentProblem(t, connected)).toBe('Business plan is required to run this scenario.')
    expect(refusalUpgrade(t, connected)).toEqual({ plan: 'Business', url: PRO_URL })
  })

  it('says why in its own words, never the CLI text, and offers another pick', () => {
    const t = tab({ error: 'refused', refusal: missing, refusedName: 'harbour-fog' })
    expect(impairmentProblem(t, connected)).toBe(`Couldn't apply "harbour-fog": there's no scenario with that name.`)
    expect(refusalAction(t, connected)).toBe('choose')
    expect(refusalUpgrade(t, connected)).toBeNull()
    const bad = tab({ error: 'refused', refusal: invalid })
    expect(impairmentProblem(bad, connected)).toBe(`Couldn't apply this profile: its scenario file can't run in the browser.`)
  })

  it("passes on the CLI's own remedy for an account refusal", () => {
    const account: Refusal = { error: 'Your sign-in has ended. Run moqtap login.', reason: 'account', plan: null, upgrade: null }
    const t = tab({ error: 'refused', refusal: account, refusedName: 'lte' })
    expect(impairmentProblem(t, connected)).toBe(`Couldn't apply "lte". Your sign-in has ended. Run moqtap login.`)
  })

  it("passes on the CLI's words when it gave no reason it names", () => {
    const unnamed: Refusal = { error: 'Something went wrong.', reason: null, plan: null, upgrade: null }
    expect(impairmentProblem(tab({ error: 'refused', refusal: unnamed, refusedName: 'Offline' }), connected)).toBe(
      'Couldn\'t apply "Offline". Something went wrong.',
    )
  })

  it('asks for a CLI update when its reply did not read', () => {
    expect(impairmentProblem(tab({ error: 'protocol', refusedName: 'Offline' }), connected)).toBe(
      'The moqtap CLI can\'t run "Offline". Update the moqtap CLI, then pick it again.',
    )
  })

  it('names the setting that lets the CLI take this build', () => {
    const view = { ...connected, state: 'not-allowed', extensionId: 'iobechkloegdiabacdgelepncfojggpe' } as const
    expect(impairmentProblem(tab({ error: 'not-allowed', refusedName: 'Offline' }), view)).toBe(
      "The moqtap CLI doesn't accept this build of the extension. Restart it with MOQTAP_BRIDGE_EXTENSION_IDS=iobechkloegdiabacdgelepncfojggpe.",
    )
  })

  it('offers nothing for a problem that is not a refusal', () => {
    expect(refusalAction(tab({ error: 'refused', refusal: missing }), { state: 'absent' })).toBeNull()
    expect(refusalAction(tab({ failure: 'local-network' }), connected)).toBeNull()
  })

  it('offers no upgrade while the CLI itself is the problem', () => {
    const t = tab({ error: 'refused', refusal: plan })
    expect(refusalUpgrade(t, { state: 'absent' })).toBeNull()
    expect(refusalUpgrade({ ...t, failure: 'local-network' }, connected)).toBeNull()
  })

  it('names the refused pick while the tab stays on what was in force, Off included', () => {
    const t = tab({ profile: { preset: '4g' }, name: '4G', error: 'refused', refusal: invalid, refusedName: 'stepper' })
    expect(impairmentProblem(t, connected)).toBe(`Couldn't apply "stepper": its scenario file can't run in the browser.`)
    const off = tab({ profile: { preset: 'none' }, name: 'Off', error: 'refused', refusal: plan, refusedName: 'lte' })
    expect(impairmentProblem(off, connected)).toBe('Pro plan is required to run this scenario.')
    expect(refusalUpgrade(off, connected)).toEqual(plan.upgrade)
  })

  it('says the same for one connection', () => {
    const t = tab({ sessionErrors: [{ session: S, error: 'refused', refusal: plan }] })
    expect(sessionImpairmentProblem(t, S, connected)).toBe('Pro plan is required to run this scenario.')
    expect(refusalUpgrade(t, connected, S)).toEqual(plan.upgrade)
    expect(refusalUpgrade(t, connected)).toBeNull()
    const why = tab({ sessionErrors: [{ session: S, error: 'refused', refusal: invalid }] })
    expect(sessionImpairmentProblem(why, S, connected)).toBe(
      "Couldn't apply this profile: its scenario file can't run in the browser.",
    )
  })
})
