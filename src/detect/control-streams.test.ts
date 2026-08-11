/**
 * Tests for control-plane stream recognition.
 *
 * These matter because the shape of the control plane changed twice in the
 * draft series and we have no draft-17+ relay to test against: the wire ids
 * come from the codec's own per-draft maps, so a draft that renumbers its
 * messages fails here rather than silently in the field.
 */

import { describe, it, expect } from 'vitest'
import {
  classifyStreamOpener,
  hasRequestStreams,
  streamOpeners,
  REQUEST_STREAM_OPENERS,
} from './control-streams'
import { getMessageIdMap } from '../codec/message-ids'
import { encodeVarintForDraft } from '../codec/varint'
import type { SupportedDraft } from '../types/common'

const ALL_DRAFTS: SupportedDraft[] = [
  '07',
  '08',
  '09',
  '10',
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
]

/**
 * Wire bytes that open a stream with the named message, in the varint encoding
 * that draft actually writes — draft-17 replaced the RFC 9000 one, so encoding
 * these the old way would let the test agree with a decoder that is wrong.
 */
function opener(draft: SupportedDraft, name: string): Uint8Array {
  const id = getMessageIdMap(draft).get(name)
  if (id == null) throw new Error(`draft-${draft} has no message "${name}"`)
  return encodeVarintForDraft(draft, Number(id))
}

describe('hasRequestStreams', () => {
  it('is false through draft-16, true from draft-17', () => {
    // Draft-17 moved requests onto their own bidirectional streams (#1389).
    for (const draft of ALL_DRAFTS) {
      expect(hasRequestStreams(draft)).toBe(Number(draft) >= 17)
    }
  })
})

describe('streamOpeners', () => {
  it('finds a SETUP opener in every draft', () => {
    for (const draft of ALL_DRAFTS) {
      expect(streamOpeners(draft).control.size).toBeGreaterThan(0)
    }
  })

  it('resolves every request opener the draft defines', () => {
    // A rename in a future draft silently shrinks this set and stops request
    // streams being recognised, so pin the expected count per era.
    // Draft-17 §3.3 lists six openers; draft-18 added SUBSCRIBE_TRACKS.
    const expected: Record<string, number> = { '17': 6, '18': 7, '19': 7 }
    for (const draft of ALL_DRAFTS.filter(hasRequestStreams)) {
      const map = getMessageIdMap(draft)
      const found = REQUEST_STREAM_OPENERS.filter((n) => map.get(n) != null)
      expect(found.length, `draft-${draft} openers: ${found.join()}`).toBe(
        expected[draft],
      )
      expect(streamOpeners(draft).request.size).toBe(expected[draft])
    }
  })

  it('has no request openers before draft-17', () => {
    for (const draft of ALL_DRAFTS.filter((d) => !hasRequestStreams(d))) {
      expect(streamOpeners(draft).request.size).toBe(0)
    }
  })

  it('keeps control and request openers disjoint', () => {
    for (const draft of ALL_DRAFTS) {
      const { control, request } = streamOpeners(draft)
      for (const id of request) expect(control.has(id)).toBe(false)
    }
  })
})

describe('classifyStreamOpener', () => {
  it('recognises the SETUP that opens a control stream, every draft', () => {
    for (const draft of ALL_DRAFTS) {
      const names = ['setup', 'client_setup'].filter(
        (n) => getMessageIdMap(draft).get(n) != null,
      )
      for (const name of names) {
        expect(
          classifyStreamOpener(opener(draft, name), draft),
          `draft-${draft} ${name}`,
        ).toBe('control')
      }
    }
  })

  it('recognises each request opener in the draft-17+ era', () => {
    for (const draft of ALL_DRAFTS.filter(hasRequestStreams)) {
      const defined = REQUEST_STREAM_OPENERS.filter(
        (n) => getMessageIdMap(draft).get(n) != null,
      )
      for (const name of defined) {
        expect(
          classifyStreamOpener(opener(draft, name), draft),
          `draft-${draft} ${name}`,
        ).toBe('request')
      }
    }
  })

  it('treats data stream types as data', () => {
    // FETCH_HEADER (0x05) and a SUBGROUP_HEADER (0b0XX1XXXX), draft-19 §3.4
    expect(classifyStreamOpener(new Uint8Array([0x05]), '19')).toBe('data')
    expect(classifyStreamOpener(new Uint8Array([0x10]), '19')).toBe('data')
    expect(classifyStreamOpener(new Uint8Array([0x1f]), '19')).toBe('data')
  })

  it('treats an Annex-B video chunk as data', () => {
    const nal = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x09, 0x10])
    for (const draft of ALL_DRAFTS) {
      expect(classifyStreamOpener(nal, draft)).toBe('data')
    }
  })

  it('stays pending on an incomplete leading varint', () => {
    // 0xaf opens a two-byte MoQT varint; one byte is not yet a verdict.
    expect(classifyStreamOpener(new Uint8Array([0xaf]), '19')).toBe('pending')
    expect(classifyStreamOpener(new Uint8Array(), '19')).toBe('pending')
  })

  it('reads the opener with the draft-17+ varint, not RFC 9000', () => {
    // SETUP is 0x2F00, which is `af 00` under MoQT's encoding and `6f 00`
    // under RFC 9000. Reading the wrong way round yields a plausible number
    // rather than an error, so a draft-17+ control stream would be filed as
    // media and never decoded.
    expect(classifyStreamOpener(new Uint8Array([0xaf, 0x00]), '19')).toBe(
      'control',
    )
    expect(classifyStreamOpener(new Uint8Array([0x6f, 0x00]), '19')).toBe(
      'data',
    )
  })

  it('does not treat request openers as request streams before draft-17', () => {
    // Through draft-16 requests ride the control stream, so no stream opens
    // with SUBSCRIBE. Treating one as control-plane would start decoding media
    // as control messages — SUBSCRIBE is 0x03, a plausible first media byte.
    for (const draft of ALL_DRAFTS.filter((d) => !hasRequestStreams(d))) {
      expect(classifyStreamOpener(opener(draft, 'subscribe'), draft)).toBe(
        'data',
      )
    }
  })

  it('SUBSCRIBE_NAMESPACE moved wire id between draft-17 and draft-18', () => {
    // 0x11 -> 0x50, which is why openers are resolved per draft rather than
    // hardcoded. Cross-applying the ids misclassifies both.
    expect(
      classifyStreamOpener(opener('17', 'subscribe_namespace'), '17'),
    ).toBe('request')
    expect(
      classifyStreamOpener(opener('19', 'subscribe_namespace'), '19'),
    ).toBe('request')
    expect(
      classifyStreamOpener(opener('17', 'subscribe_namespace'), '19'),
    ).not.toBe('request')
  })
})
