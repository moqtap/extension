/**
 * Tests for the alias → track-name join.
 *
 * Every case runs against bytes the draft's own codec produced, because the
 * bug these guard against was reading a field that no draft emits: the join
 * looked correct and silently produced nothing. Encoding first means a draft
 * that moves the alias, renames a field or drops a request id fails here.
 */

import { describe, expect, it } from 'vitest'
import {
  decodeControlMessage,
  encodeControlMessage,
  getCodec,
} from './control-message'
import { getMessageIdMap } from './message-ids'
import { TrackRegistry, trackEventFrom, type TrackFields } from './track-info'
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
 * Message fixtures carrying every field any draft asks for; each draft's
 * encoder writes the ones it defines and ignores the rest. Both id spellings
 * are present for the same reason — SUBSCRIBE carried a subscribe_id through
 * draft-10 and a request_id after it.
 */
const SUBSCRIBE = {
  type: 'subscribe',
  request_id: 4n,
  subscribe_id: 4n,
  track_alias: 77n,
  track_namespace: ['ns', 'sub'],
  track_name: 'video',
  subscriber_priority: 128,
  group_order: 1,
  forward: 1n,
  filter_type: 2n,
  start_group: 0n,
  start_object: 0n,
  end_group: 0n,
  required_request_id_delta: 0n,
  parameters: {},
}

const SUBSCRIBE_OK = {
  type: 'subscribe_ok',
  request_id: 4n,
  subscribe_id: 4n,
  track_alias: 77n,
  expires: 0n,
  group_order: 1,
  content_exists: 0,
  forward: 1n,
  parameters: {},
  track_properties: { expires: 0n, group_order: 1, content_exists: 0 },
}

const PUBLISH = {
  type: 'publish',
  request_id: 5n,
  track_namespace: ['ns', 'pub'],
  track_name: 'audio',
  track_alias: 99n,
  group_order: 1,
  content_exists: 0,
  forward: 1n,
  required_request_id_delta: 0n,
  parameters: {},
  track_properties: { expires: 0n, group_order: 1, content_exists: 0 },
}

/**
 * A standalone FETCH. Most drafts nest the track under `standalone`; draft-07
 * and draft-14 keep the same fields flat, so both spellings are present.
 */
const STANDALONE_FETCH_TRACK = {
  track_namespace: ['ns', 'fetch'],
  track_name: 'archive',
  start_group: 0n,
  start_object: 0n,
  end_group: 1n,
  end_object: 0n,
}

const FETCH = {
  type: 'fetch',
  request_id: 7n,
  subscribe_id: 7n,
  subscriber_priority: 128,
  group_order: 1,
  fetch_type: 1n,
  required_request_id_delta: 0n,
  ...STANDALONE_FETCH_TRACK,
  standalone: STANDALONE_FETCH_TRACK,
  parameters: {},
}

/**
 * A joining FETCH — it names no track, only the request whose track it
 * continues. Every field name the drafts have used for that request is
 * present; each encoder writes the one it defines.
 */
const JOINING_FETCH = {
  type: 'fetch',
  request_id: 9n,
  subscribe_id: 9n,
  subscriber_priority: 128,
  group_order: 1,
  fetch_type: 2n,
  required_request_id_delta: 0n,
  joining_request_id: 4n,
  joining_start: 0n,
  joining: {
    joining_request_id: 4n,
    joining_subscribe_id: 4n,
    joining_start: 0n,
    preceding_group_offset: 0n,
  },
  parameters: {},
}

/** ANNOUNCE through draft-13, renamed PUBLISH_NAMESPACE from draft-14. */
const NAMESPACE_ONLY = {
  request_id: 6n,
  track_namespace: ['ns', 'pub'],
  required_request_id_delta: 0n,
  parameters: {},
}

/** Encode with a draft's own codec and read it back, as the extension does. */
function roundTrip(
  draft: SupportedDraft,
  msg: Record<string, unknown>,
): Record<string, unknown> {
  const bytes = encodeControlMessage(msg, draft)
  const result = decodeControlMessage(bytes, draft)
  if (!result.ok) {
    throw new Error(`draft-${draft} could not decode its own ${msg.type}`)
  }
  return result.value
}

function has(draft: SupportedDraft, messageType: string): boolean {
  return getMessageIdMap(draft).has(messageType)
}

/**
 * Encode a subgroup stream and read its header back, which is how a data
 * stream tells the panel which track it carries.
 */
function subgroupHeader(
  draft: SupportedDraft,
  trackAlias: bigint,
): { trackAlias: bigint } {
  const codec = getCodec(draft) as unknown as {
    encodeSubgroupStream(stream: Record<string, unknown>): Uint8Array
    decodeSubgroupStream(bytes: Uint8Array): {
      ok: boolean
      value: { trackAlias: bigint }
    }
  }
  const bytes = codec.encodeSubgroupStream({
    type: 'subgroup',
    // 0x14: explicit subgroup id, no extensions — valid from draft-12 on.
    // Spelled twice because the codec renamed the field in draft-14.
    streamTypeId: 0x14,
    headerType: 0x14,
    trackAlias,
    groupId: 3n,
    subgroupId: 0n,
    publisherPriority: 128,
    objects: [
      {
        objectId: 0n,
        payloadLength: 3,
        payload: new Uint8Array([1, 2, 3]),
        extensionData: new Uint8Array(0),
        byteOffset: 0,
        payloadByteOffset: 0,
      },
    ],
  })
  const result = codec.decodeSubgroupStream(bytes)
  if (!result.ok) {
    throw new Error(`draft-${draft} could not decode its own subgroup header`)
  }
  return result.value
}

/**
 * Encode a fetch stream and read its header back. A fetch stream names its
 * track with the request id of the FETCH, not with a track alias.
 */
function fetchHeader(
  draft: SupportedDraft,
  requestId: bigint,
): { requestId: bigint } {
  const codec = getCodec(draft) as unknown as {
    encodeFetchStream(stream: Record<string, unknown>): Uint8Array
    decodeFetchStream(bytes: Uint8Array): {
      ok: boolean
      value: { requestId?: bigint; subscribeId?: bigint }
    }
  }
  const bytes = codec.encodeFetchStream({
    type: 'fetch',
    requestId,
    subscribeId: requestId,
    objects: [
      {
        // Field-presence flags, draft-16+ only; earlier drafts write every
        // field unconditionally and ignore this.
        serializationFlags: 0x3c,
        groupId: 1n,
        subgroupId: 0n,
        objectId: 0n,
        publisherPriority: 128,
        payloadLength: 3,
        payload: new Uint8Array([1, 2, 3]),
        // Drafts 08-10 write an explicit extension length ahead of the bytes,
        // counted two different ways.
        extensionCount: 0,
        extensionHeadersLength: 0,
        extensionData: new Uint8Array(0),
        byteOffset: 0,
        payloadByteOffset: 0,
      },
    ],
  })
  const result = codec.decodeFetchStream(bytes)
  if (!result.ok) {
    throw new Error(`draft-${draft} could not decode its own fetch header`)
  }
  const id = result.value.requestId ?? result.value.subscribeId
  if (id == null) throw new Error(`draft-${draft} fetch header has no id`)
  return { requestId: id }
}

/** A registry storing the shared fields unchanged, as the background does. */
function registry() {
  const tracks = new Map<string, TrackFields>()
  return {
    tracks,
    registry: new TrackRegistry(tracks, (fields) => ({ ...fields })),
  }
}

describe('TrackRegistry', () => {
  it('joins alias to track name in every draft', () => {
    // The two halves live in different messages from draft-12 on, and in one
    // message before that. Both regimes have to end in the same place.
    for (const draft of ALL_DRAFTS) {
      const { tracks, registry: reg } = registry()
      const ctx = { streamId: 8, timestamp: 1000 }

      reg.apply(roundTrip(draft, SUBSCRIBE), { ...ctx, direction: 'rx' })
      reg.apply(roundTrip(draft, SUBSCRIBE_OK), { ...ctx, direction: 'tx' })

      expect(tracks.size, `draft-${draft}`).toBe(1)
      const track = [...tracks.values()][0]
      expect(track.trackAlias, `draft-${draft} alias`).toBe('77')
      expect(track.trackName, `draft-${draft} name`).toBe('video')
      expect(track.trackNamespace, `draft-${draft} namespace`).toEqual([
        'ns',
        'sub',
      ])
      expect(track.status, `draft-${draft} status`).toBe('active')
    }
  })

  it('takes namespace, name and alias from a single PUBLISH', () => {
    // A publisher offering a track it already holds sends all three at once,
    // which is the only naming a publish-side session ever gets.
    const drafts = ALL_DRAFTS.filter((d) => has(d, 'publish'))
    expect(drafts.length).toBeGreaterThan(0)

    for (const draft of drafts) {
      const { tracks, registry: reg } = registry()
      reg.apply(roundTrip(draft, PUBLISH), {
        direction: 'tx',
        streamId: 8,
        timestamp: 1000,
      })

      expect(tracks.size, `draft-${draft}`).toBe(1)
      const track = [...tracks.values()][0]
      expect(track.trackAlias, `draft-${draft} alias`).toBe('99')
      expect(track.trackName, `draft-${draft} name`).toBe('audio')
      expect(track.trackNamespace, `draft-${draft} namespace`).toEqual([
        'ns',
        'pub',
      ])
    }
  })

  it('matches a response with no request id to its own request stream', () => {
    // Draft-17 dropped request ids from responses: the request stream is the
    // correlation. A response arriving on some other stream must not be
    // credited to the request.
    const idless = ALL_DRAFTS.filter((draft) => {
      const ok = roundTrip(draft, SUBSCRIBE_OK)
      return ok.request_id == null && ok.subscribe_id == null
    })
    expect(
      idless.length,
      'no draft answers without a request id',
    ).toBeGreaterThan(0)

    for (const draft of idless) {
      const ok = roundTrip(draft, SUBSCRIBE_OK)
      const { tracks, registry: reg } = registry()
      reg.apply(roundTrip(draft, SUBSCRIBE), {
        direction: 'tx',
        streamId: 8,
        timestamp: 1000,
      })
      reg.apply(ok, { direction: 'rx', streamId: 12, timestamp: 1001 })

      const track = [...tracks.values()][0]
      expect(track.trackAlias, `draft-${draft} wrong stream`).toBeUndefined()
      expect(track.status, `draft-${draft} wrong stream`).toBe('pending')

      reg.apply(ok, { direction: 'rx', streamId: 8, timestamp: 1002 })
      expect(track.trackAlias, `draft-${draft} own stream`).toBe('77')
    }
  })

  it('reports no track for a namespace announcement', () => {
    // ANNOUNCE / PUBLISH_NAMESPACE carries a namespace and nothing else — no
    // track name, no alias — so there is nothing to register.
    for (const draft of ALL_DRAFTS) {
      const type = has(draft, 'publish_namespace')
        ? 'publish_namespace'
        : 'announce'
      const msg = roundTrip(draft, { ...NAMESPACE_ONLY, type })

      expect(trackEventFrom(msg), `draft-${draft}`).toBeNull()

      const { tracks, registry: reg } = registry()
      reg.apply(msg, { direction: 'tx', streamId: 8, timestamp: 1000 })
      expect(tracks.size, `draft-${draft}`).toBe(0)
    }
  })

  it('registers the alias a subgroup header will ask for', () => {
    // The point of the whole join: the number a data stream puts in its header
    // has to be the number the registry filed the track under, or the stream
    // list shows "alias:77" where a track name belongs. Drafts 12+ only —
    // that is where the alias arrives on its own message, and where earlier
    // subgroup framing would need its own header fixture.
    const drafts = ALL_DRAFTS.filter((d) => Number(d) >= 12)

    for (const draft of drafts) {
      const { tracks, registry: reg } = registry()
      const ctx = { streamId: 8, timestamp: 1000 }
      reg.apply(roundTrip(draft, SUBSCRIBE), { ...ctx, direction: 'tx' })
      reg.apply(roundTrip(draft, SUBSCRIBE_OK), { ...ctx, direction: 'rx' })

      const header = subgroupHeader(draft, 77n)
      const byAlias = new Map(
        [...tracks.values()].map((t) => [t.trackAlias, t]),
      )

      // Exactly the lookup the stream list performs.
      const track = byAlias.get(String(header.trackAlias))
      expect(track?.trackName, `draft-${draft}`).toBe('video')
    }
  })

  it('names a standalone FETCH and the stream that answers it', () => {
    // A fetch never gets a track alias. Its data stream carries the request id
    // of the FETCH instead, which is the key the track is filed under.
    for (const draft of ALL_DRAFTS) {
      const { tracks, registry: reg } = registry()
      reg.apply(roundTrip(draft, FETCH), {
        direction: 'tx',
        streamId: 8,
        timestamp: 1000,
      })

      const header = fetchHeader(draft, 7n)
      const track = tracks.get(String(header.requestId))

      expect(track?.trackName, `draft-${draft}`).toBe('archive')
      expect(track?.trackNamespace, `draft-${draft}`).toEqual(['ns', 'fetch'])
      expect(track?.via, `draft-${draft}`).toBe('fetch')
      expect(track?.trackAlias, `draft-${draft}`).toBeUndefined()
    }
  })

  it('borrows the name of the subscription a joining FETCH continues', () => {
    // A joining fetch carries no track name at all — it continues the track of
    // an existing subscription, so the name has to come from that request.
    // Draft-07's FETCH is standalone-only, so it cannot even encode one.
    const joining = ALL_DRAFTS.filter((draft) => {
      try {
        const event = trackEventFrom(roundTrip(draft, JOINING_FETCH))
        return event?.kind === 'open' && event.joiningRequestId != null
      } catch {
        return false
      }
    })
    expect(joining.length, 'no draft encodes a joining fetch').toBeGreaterThan(
      0,
    )

    for (const draft of joining) {
      const { tracks, registry: reg } = registry()
      const ctx = { direction: 'tx' as const, streamId: 8, timestamp: 1000 }

      // SUBSCRIBE is request 4; the joining fetch below points at it.
      reg.apply(roundTrip(draft, SUBSCRIBE), ctx)
      reg.apply(roundTrip(draft, JOINING_FETCH), { ...ctx, streamId: 12 })

      const fetched = tracks.get('9')
      expect(fetched?.trackName, `draft-${draft}`).toBe('video')
      expect(fetched?.trackNamespace, `draft-${draft}`).toEqual(['ns', 'sub'])
      expect(fetched?.via, `draft-${draft}`).toBe('fetch')
    }
  })

  it('leaves a joining FETCH nameless when its subscription is unknown', () => {
    // Attaching mid-session: the SUBSCRIBE it joins happened before capture
    // started. Better a nameless fetch than one named from a guess.
    const { tracks, registry: reg } = registry()
    reg.apply(roundTrip('14', JOINING_FETCH), {
      direction: 'tx',
      streamId: 8,
      timestamp: 1000,
    })

    expect(tracks.get('9')?.trackName).toBe('')
    expect(tracks.get('9')?.trackNamespace).toEqual([])
  })

  it('does not invent a track for a response it cannot place', () => {
    const { tracks, registry: reg } = registry()

    // No request was seen, so there is nothing for this to update.
    const applied = reg.apply(roundTrip('14', SUBSCRIBE_OK), {
      direction: 'rx',
      streamId: 8,
      timestamp: 1000,
    })

    expect(applied).toBeNull()
    expect(tracks.size).toBe(0)
  })
})

describe('trackEventFrom', () => {
  it('reads camelCase fields from imported traces', () => {
    // Traces written by other tools use their own spelling; the codec's own
    // output is snake_case and is covered by every test above.
    const event = trackEventFrom({
      type: 'subscribe',
      requestId: 3,
      trackNamespace: ['ns'],
      trackName: 'video',
      trackAlias: 9,
    })

    expect(event).toEqual({
      kind: 'open',
      requestId: '3',
      via: 'subscribe',
      trackNamespace: ['ns'],
      trackName: 'video',
      trackAlias: '9',
    })
  })

  it('ignores messages that say nothing about a track', () => {
    expect(trackEventFrom({ type: 'goaway' })).toBeNull()
    expect(trackEventFrom({})).toBeNull()
  })
})
