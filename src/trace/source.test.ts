import { afterEach, describe, expect, it } from 'vitest'
import { traceSource } from './source'

/**
 * `browser` is a global in an extension build but is absent under vitest's
 * node environment, so each test installs and removes its own stub.
 */
const globals = globalThis as { browser?: unknown }

function stubManifest(version: string): void {
  globals.browser = { runtime: { getManifest: () => ({ version }) } }
}

afterEach(() => {
  delete globals.browser
})

describe('traceSource', () => {
  it('reports the version the manifest carries', () => {
    stubManifest('0.3.3')
    expect(traceSource()).toBe('moqtap-extension/0.3.3')
  })

  it('follows the manifest rather than a baked-in constant', () => {
    // The point of reading the manifest is that a release bump reaches the
    // trace without anyone editing this code, so a second version must give a
    // second answer.
    stubManifest('0.3.3')
    const before = traceSource()
    stubManifest('9.9.9')
    expect(traceSource()).toBe('moqtap-extension/9.9.9')
    expect(traceSource()).not.toBe(before)
  })

  it('falls back to dev outside an extension context', () => {
    // No `browser` global at all — a bare property access would throw here.
    expect(traceSource()).toBe('moqtap-extension/dev')
  })

  it('falls back to dev when the manifest has no version', () => {
    globals.browser = { runtime: { getManifest: () => ({}) } }
    expect(traceSource()).toBe('moqtap-extension/dev')
  })
})
