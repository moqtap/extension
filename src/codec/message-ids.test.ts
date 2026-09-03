/**
 * A trace records a control message as a wire type ID and a draft, never a
 * name, so a reader that wants to show "SUBSCRIBE" rather than 0x03 has to
 * resolve the pair through the codec's tables.
 *
 * Whether those tables are right is settled here against @moqtap/test-vectors,
 * the language-agnostic corpus the Rust codec is held to as well — a name the
 * two implementations disagree about is worse than a raw ID, because nothing
 * in a trace says which one wrote it.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getMessageIdMap, getMessageTypeMap } from './message-ids'
import type { SupportedDraft } from '../types/common'

const require_ = createRequire(import.meta.url)
const VECTORS_BASE = dirname(require_.resolve('@moqtap/test-vectors/manifest'))

const DRAFTS: SupportedDraft[] = [
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
  '20',
]

/**
 * `unknown-type.json` is a negative vector: 0x3f is a type no draft assigns,
 * and the file exists to assert that a decoder refuses it. It names no
 * message, so it is not a row of the table.
 */
const UNASSIGNED = 'unknown'

/**
 * Corpus names that are a second name for a wire ID another name already
 * holds. Drafts 18 and 19 folded PUBLISH_OK into REQUEST_OK, and the corpus
 * keeps a `publish-ok.json` at REQUEST_OK's 0x07 — its vectors say "PUBLISH_OK
 * (REQUEST_OK alias, Type 0x07)". One ID can only be displayed under one name,
 * so the codec's table carries the canonical one alone; the alias still has to
 * agree with it about the ID, which the corpus checks below enforce.
 */
const ALIASES: Partial<Record<SupportedDraft, Record<string, string>>> = {
  '18': { publish_ok: 'request_ok' },
  '19': { publish_ok: 'request_ok' },
  '20': { publish_ok: 'request_ok' },
}

/** The `message_type` / `message_type_id` header every vector file carries. */
interface VectorFile {
  message_type: string
  message_type_id: string
}

/** Wire ID by message name, as the corpus assigns them for one draft. */
function corpusMessageIds(draft: SupportedDraft): Map<string, bigint> {
  const dir = resolve(VECTORS_BASE, `transport/draft${draft}/codec/messages`)
  const ids = new Map<string, bigint>()
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const vectors = JSON.parse(
      readFileSync(resolve(dir, file), 'utf-8'),
    ) as VectorFile
    if (vectors.message_type === UNASSIGNED) continue
    ids.set(vectors.message_type, BigInt(vectors.message_type_id))
  }
  return ids
}

describe.each(DRAFTS)('draft-%s message tables', (draft) => {
  const idMap = getMessageIdMap(draft)
  const typeMap = getMessageTypeMap(draft)
  const corpus = corpusMessageIds(draft)
  const aliases = ALIASES[draft] ?? {}

  it('resolves ID to name and name to ID as exact inverses', () => {
    expect(typeMap.size).toBe(idMap.size)
    for (const [id, name] of typeMap) {
      expect(idMap.get(name), name).toBe(id)
    }
    for (const [name, id] of idMap) {
      expect(typeMap.get(id), name).toBe(name)
    }
  })

  it('gives every corpus message the wire ID the corpus assigns it', () => {
    expect(corpus.size).toBeGreaterThan(0)
    for (const [name, id] of corpus) {
      const canonical = aliases[name] ?? name
      expect(idMap.get(canonical), name).toBe(id)
      expect(typeMap.get(id), `0x${id.toString(16)}`).toBe(canonical)
    }
  })

  it('names every message the corpus does, and none it does not', () => {
    const named = [...corpus.keys()].filter((n) => !Object.hasOwn(aliases, n))
    expect([...idMap.keys()].sort()).toEqual(named.sort())
  })
})
