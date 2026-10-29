/**
 * Track Properties read from control messages the way the panel holds them:
 * bytes a draft's own codec wrote, decoded, in the codec's form and in the
 * plain JSON form the background sends.
 */

import { describe, expect, it } from 'vitest'
import { decodeControlMessage, encodeControlMessage } from '@/src/codec/control-message'
import type { SupportedDraft } from '@/src/types/common'
import { trackKey } from './catalogs'
import { untagDecoded } from './decoded'
import { trackPropertyInputs, trackPropertyLists } from './track-properties'
import type { MessageEntry, SessionEntry, TrackEntry } from './use-inspector'

function entry(
  draft: SupportedDraft,
  msg: Record<string, unknown>,
  direction: 'tx' | 'rx',
  streamId: number,
  plain = false,
): MessageEntry {
  const bytes = encodeControlMessage(msg, draft)
  const result = decodeControlMessage(bytes, draft)
  if (!result.ok) throw new Error(`draft-${draft} could not decode its own ${msg.type}`)
  const tagged = JSON.parse(
    JSON.stringify(result.value, (_k, v) =>
      typeof v === 'bigint'
        ? { __t: 'n', v: v.toString() }
        : v instanceof Uint8Array
          ? { __t: 'b', v: Buffer.from(v).toString('hex') }
          : v,
    ),
  )
  return {
    timestamp: 0,
    direction,
    messageType: String(result.value.type),
    streamId,
    decoded: plain ? untagDecoded(tagged) : result.value,
    decodedPretty: null,
    raw: bytes,
  }
}

// 90000 as a 3-byte vi64 (draft-22 Section 8.1).
const TIMESCALE = { id: '0x8', length: 3, raw_hex: 'c15f90' }
// Immutable Properties holding Timescale 1000 (0x08, 2-byte vi64 0x83e8).
const IMMUTABLE = new Uint8Array([0x08, 0x83, 0xe8])

const SUBSCRIBE = {
  type: 'subscribe',
  request_id: 4n,
  required_request_id_delta: 0n,
  track_namespace: ['live'],
  track_name: 'video',
  parameters: {},
}

const SUBSCRIBE_OK = {
  type: 'subscribe_ok',
  track_alias: 7n,
  parameters: {},
  track_properties: { unknown: [TIMESCALE], immutable_properties: IMMUTABLE },
}

function sessionOf(messages: MessageEntry[], tracks: TrackEntry[] = []) {
  return {
    draft: '22',
    messages,
    tracks: new Map(tracks.map((t) => [t.subscribeId, t])),
  } as unknown as SessionEntry
}

const VIDEO = trackKey('live', 'video')

describe('trackPropertyLists', () => {
  for (const plain of [false, true]) {
    it(`places a SUBSCRIBE_OK's properties on its request's track${plain ? ', from plain JSON' : ''}`, () => {
      const ok = entry('22', SUBSCRIBE_OK, 'rx', 4, plain)
      const lists = trackPropertyLists(sessionOf([entry('22', SUBSCRIBE, 'tx', 4, plain), ok]))
      expect([...lists.keys()]).toEqual([VIDEO])
      const [list] = lists.get(VIDEO)!
      expect(list!.message).toBe(ok)
      expect(list!.properties).toEqual([
        { type: 0x08n, value: 90000n },
        {
          type: 0x0bn,
          bytes: IMMUTABLE,
          properties: [expect.objectContaining({ type: 0x08n, value: 1000n })],
        },
      ])
    })
  }

  it("reads a PUBLISH's own namespace and name", () => {
    const publish = entry(
      '22',
      {
        type: 'publish',
        request_id: 2n,
        track_namespace: ['live'],
        track_name: 'video',
        track_alias: 9n,
        parameters: {},
        track_properties: { unknown: [TIMESCALE] },
      },
      'rx',
      2,
    )
    const lists = trackPropertyLists(sessionOf([publish]))
    expect(lists.get(VIDEO)?.[0]?.properties).toEqual([{ type: 0x08n, value: 90000n }])
  })

  it('places a REQUEST_OK by its TRACK_STATUS', () => {
    const status = entry(
      '22',
      {
        type: 'track_status',
        request_id: 6n,
        required_request_id_delta: 0n,
        track_namespace: ['live'],
        track_name: 'video',
        parameters: {},
      },
      'tx',
      6,
    )
    const ok = entry(
      '22',
      { type: 'request_ok', parameters: {}, track_properties: { unknown: [TIMESCALE] } },
      'rx',
      6,
    )
    const lists = trackPropertyLists(sessionOf([status, ok]))
    expect(lists.get(VIDEO)?.[0]?.message).toBe(ok)
  })

  it('leaves out messages whose Track Properties are all named by the codec', () => {
    const ok = entry(
      '22',
      { ...SUBSCRIBE_OK, track_properties: { max_cache_duration: 5n } },
      'rx',
      4,
    )
    expect(trackPropertyLists(sessionOf([entry('22', SUBSCRIBE, 'tx', 4), ok])).size).toBe(0)
  })
})

describe('trackPropertyInputs', () => {
  it('reads the contents of draft-16 Immutable Extensions, which the codec leaves unnamed', () => {
    // Timescale 1000 (0x08, 2-byte QUIC varint 0x43e8, RFC 9000 16).
    const field = { unknown: [{ id: '0xb', length: 3, raw_hex: '0843e8' }] }
    expect(trackPropertyInputs(field, '16')).toEqual([
      {
        type: 0x0bn,
        bytes: new Uint8Array([0x08, 0x43, 0xe8]),
        properties: [expect.objectContaining({ type: 0x08n, value: 1000n })],
      },
    ])
  })
})
