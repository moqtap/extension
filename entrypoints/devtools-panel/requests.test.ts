/**
 * The panel's requests view over `@moqtap/inspect`, fed message entries the
 * way the panel builds them: bytes a draft's own codec wrote, decoded and
 * made readable.
 */

import { displayFields } from '@moqtap/inspect'
import { describe, expect, it } from 'vitest'
import { decodeControlMessage, encodeControlMessage } from '@/src/codec/control-message'
import { DECODE_ERROR_MESSAGE_TYPE } from '@/src/trace/decode-error'
import type { SupportedDraft } from '@/src/types/common'
import {
  errorCodeLabels,
  messageEvents,
  messageMatches,
  PENDING_MS,
  requestIds,
  requestTimes,
  sessionDraft,
  sessionProblems,
  trackRoundTrip,
} from './requests'
import type { MessageEntry, TrackEntry } from './use-inspector'

const SUBSCRIBE = {
  type: 'subscribe',
  request_id: 4n,
  track_alias: 77n,
  track_namespace: ['live', 'ch4'],
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
  track_alias: 77n,
  expires: 0n,
  group_order: 1,
  content_exists: 0,
  forward: 1n,
  parameters: {},
  track_properties: { expires: 0n, group_order: 1, content_exists: 0 },
}

/** A message as the panel holds it, from bytes `draft`'s codec wrote. */
function entry(
  draft: SupportedDraft,
  msg: Record<string, unknown>,
  direction: 'tx' | 'rx',
  timestamp: number,
  streamId?: number,
): MessageEntry {
  const bytes = encodeControlMessage(msg, draft)
  const result = decodeControlMessage(bytes, draft)
  if (!result.ok) throw new Error(`draft-${draft} could not decode its own ${msg.type}`)
  const type = String(result.value.type)
  return {
    timestamp,
    direction,
    messageType: type,
    ...(streamId !== undefined ? { streamId } : {}),
    decoded: result.value,
    decodedPretty: displayFields(type, result.value),
    raw: bytes,
  }
}

function track(subscribeId: string, direction: 'tx' | 'rx' = 'tx'): TrackEntry {
  return {
    subscribeId,
    trackNamespace: ['live', 'ch4'],
    trackName: 'video',
    fullName: 'live/ch4 / video',
    direction,
    via: 'subscribe',
    status: 'pending',
    colorIndex: 0,
  }
}

describe('sessionDraft', () => {
  it('reads the draft as a number', () => {
    expect(sessionDraft({ draft: '14' })).toBe(14)
    expect(sessionDraft({ draft: undefined })).toBeNull()
  })
})

describe('requestIds', () => {
  it('reads the request id each draft-14 message carries', () => {
    const sub = entry('14', SUBSCRIBE, 'tx', 0, 0)
    const ok = entry('14', SUBSCRIBE_OK, 'rx', 40, 0)
    const ids = requestIds(messageEvents([sub, ok]), 14)
    expect(ids.get(sub)).toBe('4')
    expect(ids.get(ok)).toBe('4')
  })

  it("gives a draft-17 response its request's id, from the stream it came back on", () => {
    const sub = entry('17', SUBSCRIBE, 'tx', 0, 4)
    const other = entry('17', { ...SUBSCRIBE, request_id: 6n }, 'tx', 5, 8)
    const ok = entry('17', SUBSCRIBE_OK, 'rx', 40, 4)
    expect(ok.decoded).not.toHaveProperty('request_id')
    const ids = requestIds(messageEvents([sub, other, ok]), 17)
    expect(ids.get(ok)).toBe('4')
  })
})

describe('requestTimes', () => {
  it("times each response from its request, and each track's request", () => {
    const sub = entry('17', SUBSCRIBE, 'tx', 1_000, 4)
    const ok = entry('17', SUBSCRIBE_OK, 'rx', 1_212, 4)
    const times = requestTimes(messageEvents([sub, ok]), 17)
    expect(times.byResponse.get(ok)).toBe(212)
    expect(trackRoundTrip(track('4'), times)).toBe(212)
    // A request id is only unique per sender.
    expect(trackRoundTrip(track('4', 'rx'), times)).toBeNull()
  })

  it('has no round trip for a request still waiting', () => {
    const sub = entry('14', SUBSCRIBE, 'tx', 0, 0)
    const times = requestTimes(messageEvents([sub]), 14)
    expect(trackRoundTrip(track('4'), times)).toBeNull()
  })
})

describe('errorCodeLabels', () => {
  it("names a SUBSCRIBE_ERROR's code for draft-14", () => {
    const err = entry(
      '14',
      { type: 'subscribe_error', request_id: 4n, error_code: 4n, reason_phrase: 'gone' },
      'rx',
      10,
      0,
    )
    expect(errorCodeLabels(messageEvents([err]), 14).get(err)).toBe(
      'TRACK_DOES_NOT_EXIST (0x4)',
    )
  })

  it("names a REQUEST_ERROR's code for draft-22, and says when the draft has none", () => {
    const named = entry(
      '22',
      { type: 'request_error', error_code: 0x10n, retry_interval: 0n, reason_phrase: '' },
      'rx',
      10,
      4,
    )
    const unnamed = entry(
      '22',
      { type: 'request_error', error_code: 0x7777n, retry_interval: 0n, reason_phrase: '' },
      'rx',
      20,
      8,
    )
    const labels = errorCodeLabels(messageEvents([named, unnamed]), 22)
    expect(labels.get(named)).toBe('DOES_NOT_EXIST (0x10)')
    expect(labels.get(unnamed)).toBe('0x7777, unknown for draft-22')
  })
})

describe('sessionProblems', () => {
  it('words an error with the request it answers', () => {
    const sub = entry('22', SUBSCRIBE, 'tx', 0, 4)
    const err = entry(
      '22',
      {
        type: 'request_error',
        error_code: 0x10n,
        retry_interval: 0n,
        reason_phrase: 'no such track',
      },
      'rx',
      212,
      4,
    )
    const found = sessionProblems(messageEvents([sub, err]), {
      draft: 22,
      tracks: [track('4')],
    })
    expect(found).toHaveLength(1)
    expect(found[0].severity).toBe('error')
    expect(found[0].title).toBe('REQUEST_ERROR DOES_NOT_EXIST (0x10) "no such track"')
    expect(found[0].detail).toContain('SUBSCRIBE #4 live/ch4 / video')
  })

  it('reports a request left without a response, named by its track', () => {
    const sub = entry('14', SUBSCRIBE, 'tx', 0, 0)
    const found = sessionProblems(messageEvents([sub]), {
      draft: 14,
      tracks: [track('4')],
      endMs: PENDING_MS + 1,
    })
    expect(found).toHaveLength(1)
    expect(found[0].severity).toBe('warning')
    expect(found[0].title).toMatch(/^SUBSCRIBE #4: no response after 5/)
    expect(found[0].detail).toBe('live/ch4 / video')
    expect(found[0].atMs).toBe(PENDING_MS)
  })

  it('reports nothing for a request answered in time', () => {
    const sub = entry('14', SUBSCRIBE, 'tx', 0, 0)
    const ok = entry('14', SUBSCRIBE_OK, 'rx', 40, 0)
    expect(
      sessionProblems(messageEvents([sub, ok]), { draft: 14, tracks: [], endMs: 60_000 }),
    ).toEqual([])
  })

  it('reports blocked requests, the request ID limit, GOAWAY and undecodable bytes', () => {
    const limit = entry('14', { type: 'max_request_id', request_id: 6n }, 'rx', 0, 0)
    const first = entry('14', { ...SUBSCRIBE, request_id: 4n }, 'tx', 1, 0)
    const blocked = entry('14', { type: 'requests_blocked', request_id: 6n }, 'tx', 2, 0)
    const goaway = entry('14', { type: 'goaway', new_session_uri: 'moqt://b.example' }, 'rx', 3, 0)
    const garbage: MessageEntry = {
      timestamp: 4,
      direction: 'rx',
      messageType: DECODE_ERROR_MESSAGE_TYPE,
      decoded: { code: 'UNKNOWN_MESSAGE_TYPE', reason: 'type 0x7f' },
      decodedPretty: null,
      raw: new Uint8Array([0x7f]),
    }
    const found = sessionProblems(
      messageEvents([limit, first, blocked, goaway, garbage]),
      { draft: 14, tracks: [] },
    )
    expect(found.map((p) => [p.severity, p.title])).toEqual([
      ['warning', 'Request ID limit 6 reached by SUBSCRIBE #4'],
      ['warning', 'REQUESTS_BLOCKED at request ID 6'],
      ['warning', 'GOAWAY from relay → moqt://b.example'],
      ['error', 'Undecodable bytes: UNKNOWN_MESSAGE_TYPE: type 0x7f'],
    ])
  })
})

describe('messageMatches', () => {
  it('matches a message by any part of its name, in any case', () => {
    expect(messageMatches('subscribe_ok', 'sub', 14)).toBe(true)
    expect(messageMatches('subscribe_ok', 'SUBSCRIBE_OK', 14)).toBe(true)
    expect(messageMatches('subscribe_ok', 'fetch', 14)).toBe(false)
    expect(messageMatches('subscribe_ok', '  ', 14)).toBe(true)
  })

  it('matches a message by its name in other drafts', () => {
    expect(messageMatches('publish_namespace', 'announce', 14)).toBe(true)
    expect(messageMatches('announce', 'publish_namespace', 8)).toBe(true)
    expect(messageMatches('publish_done', 'subscribe_done', 14)).toBe(true)
    expect(messageMatches('setup', 'client_setup', 17)).toBe(true)
  })
})
