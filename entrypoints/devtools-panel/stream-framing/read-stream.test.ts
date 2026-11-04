import { describe, expect, it, vi } from 'vitest'
import { readStream } from './index'

// The codec's stream decoders, replaced while `mode` says so.
const mode = vi.hoisted(() => ({ value: 'real' as 'real' | 'creep' | 'throw' }))

vi.mock('@moqtap/codec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moqtap/codec')>()
  const fake = (data: Uint8Array) => {
    if (mode.value === 'throw') throw new Error('decoder threw')
    // Each failure names the last byte, so the walk cuts one byte a try.
    return {
      ok: false,
      error: { code: 'CONSTRAINT_VIOLATION', message: 'refused', offset: data.length },
    }
  }
  return {
    ...actual,
    createCodec: (options: Parameters<typeof actual.createCodec>[0]) => {
      const codec = actual.createCodec(options) as unknown as Record<string, unknown>
      return new Proxy(codec, {
        get(target, key) {
          if ((key === 'decodeSubgroupStream' || key === 'decodeFetchStream') && mode.value !== 'real')
            return fake
          const value = target[key as string]
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  }
})

describe('a stream whose prefix walk gives up', () => {
  const bytes = new Uint8Array(200).fill(0x10)

  it('names no bytes when the tries run out', () => {
    mode.value = 'creep'
    try {
      expect(readStream(bytes, '22', { complete: true })).toEqual({
        framing: null,
        undecodable: null,
      })
    } finally {
      mode.value = 'real'
    }
  })

  it('names no bytes when the decoder throws', () => {
    mode.value = 'throw'
    try {
      expect(readStream(bytes, '22', { complete: true })).toEqual({
        framing: null,
        undecodable: null,
      })
    } finally {
      mode.value = 'real'
    }
  })
})
