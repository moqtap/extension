import { describe, expect, it } from 'vitest'
import { isSupportedDraft } from '../codec/message-ids'
import { SUPPORTED_DRAFTS } from '../types/common'
import { controlMessageName, draftFromProtocol } from './message-name'

/**
 * The wire IDs asserted here are the shared corpus's, which
 * `src/codec/message-ids.test.ts` holds the tables to for every draft; this
 * file is only about which of a trace's fields gets to name a message.
 */

describe('draftFromProtocol', () => {
  it('reads the draft out of a draft-phase identifier', () => {
    expect(draftFromProtocol('moq-transport-14')).toBe('14')
    expect(draftFromProtocol('moq-transport-07')).toBe('07')
  })

  it('names no draft for the RFC-phase identifier', () => {
    // 9999 is an RFC number, and a table keyed by it as a draft would name
    // messages that draft-99 never had.
    expect(draftFromProtocol('moq-transport-rfc9999')).toBeUndefined()
  })

  it('names no draft for a missing or unrecognised protocol', () => {
    expect(draftFromProtocol(undefined)).toBeUndefined()
    expect(draftFromProtocol('')).toBeUndefined()
    expect(draftFromProtocol('warp-draft-02')).toBeUndefined()
  })
})

describe('controlMessageName', () => {
  it('resolves the name from the wire type the trace carries', () => {
    expect(controlMessageName(0x03, '14', {})).toBe('subscribe')
  })

  it('names a message whose body carries no type key', () => {
    // What a trace from the Rust CLI looks like: the `type` key is an artefact
    // of the JS codec's decoded unions, and mt is the only name in the file.
    expect(controlMessageName(0x18, '14', { request_id: 1 })).toBe('fetch_ok')
  })

  it('lets the wire type outrank the body type when they disagree', () => {
    expect(controlMessageName(0x03, '14', { type: 'nonsense' })).toBe(
      'subscribe',
    )
  })

  it('falls back to the body type for an ID the draft does not assign', () => {
    // 0x3f is the corpus's unassigned type — no draft names it.
    expect(controlMessageName(0x3f, '14', { type: 'subscribe' })).toBe(
      'subscribe',
    )
  })

  it('falls back to hex when neither the ID nor the body names it', () => {
    expect(controlMessageName(0x3f, '14', {})).toBe('0x3f')
    expect(controlMessageName(0x3f, '14', undefined)).toBe('0x3f')
    // A control event with no mt at all reads back as 0, which no draft
    // assigns either.
    expect(controlMessageName(undefined, '14', {})).toBe('0x0')
  })

  it('falls back rather than guessing when the draft is unknown', () => {
    // Both an rfc9999 protocol and an absent one arrive here as no draft.
    expect(controlMessageName(0x03, undefined, { type: 'subscribe' })).toBe(
      'subscribe',
    )
    expect(controlMessageName(0x03, undefined, {})).toBe('0x3')
  })

  it('falls back rather than crashing on a draft outside the tables', () => {
    // A trace from a draft this build has no table for still has to open.
    expect(controlMessageName(0x03, '21', { type: 'subscribe' })).toBe(
      'subscribe',
    )
    expect(controlMessageName(0x03, '06', {})).toBe('0x3')
    expect(controlMessageName(0x03, 'rfc9999', {})).toBe('0x3')
  })

  it('names draft-20’s own message from draft-20’s table', () => {
    // Draft-20's table is draft-19's plus exactly one message, so 0x22 is the
    // only line that can tell them apart — borrowing draft-19's table would
    // look right everywhere else, which is what made it worth pinning.
    expect(isSupportedDraft('20')).toBe(true)
    expect(controlMessageName(0x22, '20', {})).toBe('publish_state_notify')
  })

  it('does not borrow draft-20’s table for draft-19', () => {
    // The same message going the other way: 0x22 is unassigned in draft-19,
    // so a draft-19 trace must fall back rather than name it.
    expect(controlMessageName(0x22, '19', {})).toBe('0x22')
  })

  it('falls back for a draft newer than the tables', () => {
    // Derived, not written down. A literal here names a supported draft the
    // day that draft is added, and the case then asserts the fallback about
    // a table that exists -- it passes for the wrong reason or fails for no
    // real one. The draft after the last is unsupported by construction.
    const newest = SUPPORTED_DRAFTS[SUPPORTED_DRAFTS.length - 1]
    const beyond = String(Number(newest) + 1).padStart(2, '0')
    expect(isSupportedDraft(beyond)).toBe(false)
    expect(controlMessageName(0x22, beyond, {})).toBe('0x22')
  })

  it('gives an aliased wire ID the one name its table carries', () => {
    // Draft-18 folded PUBLISH_OK into REQUEST_OK, so 0x07 is REQUEST_OK there
    // and the corpus keeps its publish-ok vectors at that same ID. A body
    // still calling itself publish_ok does not change what the wire said.
    expect(controlMessageName(0x07, '18', { type: 'publish_ok' })).toBe(
      'request_ok',
    )
  })
})
