import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  UNI_CONTROL_STREAM_PREFIX,
  opensUniControlStream,
} from './uni-control-prefix'

const require_ = createRequire(import.meta.url)
const VECTORS_BASE = dirname(require_.resolve('@moqtap/test-vectors/manifest'))

/** Drafts whose control stream is a pair of unidirectional streams. */
const UNI_CONTROL_DRAFTS = ['17', '18', '19', '20', '21', '22'] as const

function setupVectors(draft: string): { id: string; hex: string }[] {
  const path = join(
    VECTORS_BASE,
    'transport',
    `draft${draft}`,
    'codec',
    'messages',
    'setup.json',
  )
  return JSON.parse(readFileSync(path, 'utf8')).vectors
}

function bufferOf(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(
    (hex.match(/../g) ?? []).map((b) => Number.parseInt(b, 16)),
  )
  // Copy into a standalone ArrayBuffer so byteOffset is 0.
  return bytes.slice().buffer
}

describe('UNI_CONTROL_STREAM_PREFIX', () => {
  /*
   * Pinned against the corpus SETUP vectors rather than against another
   * hand-written constant. A hand-written copy can encode 0x2F00 the RFC 9000
   * way (`6f 00`) where draft-17+ writes MoQT's varint (`af 00`), and nothing
   * about that failure is loud: nothing matches, SETUP is filed as bulk media,
   * and a busy session evicts it.
   */
  it.each(UNI_CONTROL_DRAFTS)(
    'matches the real first bytes of every draft-%s SETUP vector',
    (draft) => {
      const vectors = setupVectors(draft)
      expect(vectors.length).toBeGreaterThan(0)

      for (const v of vectors) {
        // Malformed-input vectors are not required to carry the type intact.
        if (!v.hex.toLowerCase().startsWith('af00')) continue
        expect(
          opensUniControlStream(bufferOf(v.hex)),
          `draft-${draft} setup vector "${v.id}" must be seen as a control stream`,
        ).toBe(true)
      }
    },
  )

  it('is the MoQT varint for SETUP, not the RFC 9000 one', () => {
    // 0x2F00 under MoQT's leading-ones varint is 0x8000 | 0x2F00 = 0xAF00.
    // Under RFC 9000 it would be 0x4000 | 0x2F00 = 0x6F00.
    expect([...UNI_CONTROL_STREAM_PREFIX]).toEqual([0xaf, 0x00])

    const rfc9000 = new Uint8Array([0x6f, 0x00]).buffer
    expect(opensUniControlStream(rfc9000)).toBe(false)
  })

  it('ignores string payloads and buffers too short to carry the type', () => {
    expect(opensUniControlStream('af00')).toBe(false)
    expect(opensUniControlStream(new Uint8Array([0xaf]).buffer)).toBe(false)
    expect(opensUniControlStream(new ArrayBuffer(0))).toBe(false)
  })
})
