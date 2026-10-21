import { displayFields, setupImplementation } from '@moqtap/inspect'
import { describe, expect, it } from 'vitest'
import { reviveTagged, untagDecoded } from './decoded'

/** What the background posts for a decoded message: tagged JSON. */
function tag(obj: unknown): unknown {
  return JSON.parse(
    JSON.stringify(obj, (_key, value) => {
      if (typeof value === 'bigint') return { __t: 'n', v: value.toString() }
      if (value instanceof Uint8Array) {
        return {
          __t: 'b',
          v: Array.from(value, (b) => b.toString(16).padStart(2, '0')).join(''),
        }
      }
      return value
    }),
  )
}

const ascii = (s: string) => new TextEncoder().encode(s)

describe('reviveTagged', () => {
  it('restores bigints and byte strings at any depth', () => {
    const decoded = {
      type: 'subscribe',
      request_id: 4n,
      track_namespace: [ascii('live'), new Uint8Array([0, 0xff])],
      parameters: { big: 2n ** 64n },
    }
    expect(reviveTagged(tag(decoded))).toEqual(decoded)
  })

  it('leaves plain values alone', () => {
    expect(reviveTagged({ a: 1, b: 'x', c: null, d: [true] })).toEqual({
      a: 1,
      b: 'x',
      c: null,
      d: [true],
    })
  })
})

describe('untagDecoded', () => {
  it('flattens tags to JSON values', () => {
    const tagged = tag({ id: 4n, huge: 2n ** 64n, token: new Uint8Array([1, 2]) })
    expect(untagDecoded(tagged)).toEqual({
      id: 4,
      huge: '18446744073709551616',
      token: '0102',
    })
  })
})

describe('a posted message read for display', () => {
  it('names setup versions by draft', () => {
    const fields = reviveTagged(
      tag({ type: 'client_setup', supported_versions: [0xff00000en, 0xff000010n] }),
    ) as Record<string, unknown>
    const shown = displayFields('client_setup', fields)
    expect(shown.supported_versions).toEqual([
      { $shown: 'version', text: 'draft-14', raw: '0xff00000e' },
      { $shown: 'version', text: 'draft-16', raw: '0xff000010' },
    ])
  })

  it('shows printable bytes as text and the rest as hex', () => {
    const fields = reviveTagged(
      tag({ type: 'subscribe', track_name: ascii('video'), auth: new Uint8Array([0xde, 0xad]) }),
    ) as Record<string, unknown>
    const shown = displayFields('subscribe', fields)
    expect(shown.track_name).toEqual({
      $shown: 'text',
      text: 'video',
      raw: '0x766964656f',
    })
    expect(shown.auth).toEqual({
      $shown: 'bytes',
      text: '0xdead (2 bytes)',
      raw: '0xdead',
    })
  })

  it('reads an implementation sent as bytes', () => {
    const fields = reviveTagged(
      tag({
        type: 'server_setup',
        selected_version: 0xff00000en,
        parameters: { moqt_implementation: ascii('moxygen') },
      }),
    ) as Record<string, unknown>
    expect(setupImplementation('server_setup', fields)).toEqual({
      side: 'server',
      implementation: 'moxygen',
    })
  })
})
