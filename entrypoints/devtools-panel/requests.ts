/**
 * A session's control messages read as requests: which request each message
 * belongs to, how long each took to answer, what each error code means, and
 * what went wrong. The reading itself is `@moqtap/inspect`'s; this file only
 * feeds it the panel's message entries and shapes the answers for the views.
 */

import {
  codeLabel,
  type InspectEvent,
  messageAliases,
  pairRequests,
  problemDetail,
  problems,
  problemSeverity,
  problemTitle,
  requestIdOf,
} from '@moqtap/inspect'
import { decodeErrorReason, isDecodeError } from '@/src/trace/decode-error'
import type { MessageEntry, SessionEntry, TrackEntry } from './use-inspector'

/** A request with no response this long after it was sent is a problem. */
export const PENDING_MS = 5_000

/** A message entry as `@moqtap/inspect` reads it, with the entry it came from. */
export type MessageEvent = InspectEvent & { readonly entry: MessageEntry }

export interface SessionProblem {
  title: string
  detail: string | null
  severity: 'error' | 'warning'
  atMs: number | null
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** The session's draft as a number, or `null` when none was identified. */
export function sessionDraft(session: Pick<SessionEntry, 'draft'>): number | null {
  if (session.draft == null) return null
  const n = Number(session.draft)
  return Number.isInteger(n) ? n : null
}

/** The session's control messages, in the order they were seen. */
export function messageEvents(messages: readonly MessageEntry[]): MessageEvent[] {
  return messages.map((entry) =>
    isDecodeError(entry.messageType)
      ? {
          kind: 'undecodable',
          reason: decodeErrorReason(entry.decoded),
          direction: entry.direction,
          streamId: entry.streamId,
          atMs: entry.timestamp,
          entry,
        }
      : {
          name: entry.messageType,
          fields: asRecord(entry.decodedPretty) ?? asRecord(entry.decoded),
          direction: entry.direction,
          streamId: entry.streamId,
          atMs: entry.timestamp,
          entry,
        },
  )
}

function ownRequestId(event: MessageEvent): string | null {
  return event.kind === 'undecodable' ? null : requestIdOf(event.name, event.fields)
}

/**
 * The request id each message belongs to: the one it carries, or for a
 * response that carries none (draft-17 on), its request's.
 */
export function requestIds(
  events: readonly MessageEvent[],
  draft: number | null,
): Map<MessageEntry, string> {
  const ids = new Map<MessageEntry, string>()
  for (const event of events) {
    const id = ownRequestId(event)
    if (id !== null) ids.set(event.entry, id)
  }
  for (const { request, response } of pairRequests(events, { draft })) {
    if (response === null || ids.has(response.entry)) continue
    const id = ids.get(request.entry)
    if (id !== undefined) ids.set(response.entry, id)
  }
  return ids
}

export interface RequestTimes {
  /** Each response's time since its request. */
  byResponse: Map<MessageEntry, number>
  /** Each answered request's round trip, keyed by `requestKey`. */
  byRequest: Map<string, number>
}

/** A request as its sender and id name it: `tx|4`. */
export function requestKey(direction: 'tx' | 'rx', id: string): string {
  return `${direction}|${id}`
}

/** How long each request took to answer. */
export function requestTimes(
  events: readonly MessageEvent[],
  draft: number | null,
): RequestTimes {
  const byResponse = new Map<MessageEntry, number>()
  const byRequest = new Map<string, number>()
  for (const { request, response, rttMs } of pairRequests(events, { draft })) {
    if (response === null || rttMs === null) continue
    byResponse.set(response.entry, rttMs)
    const id = ownRequestId(request)
    if (id !== null) byRequest.set(requestKey(request.entry.direction, id), rttMs)
  }
  return { byResponse, byRequest }
}

/** The round trip of the request that registered a track, if it was answered. */
export function trackRoundTrip(track: TrackEntry, times: RequestTimes): number | null {
  return times.byRequest.get(requestKey(track.direction, track.subscribeId)) ?? null
}

/** Each error response's code, named for the session's draft. */
export function errorCodeLabels(
  events: readonly MessageEvent[],
  draft: number | null,
): Map<MessageEntry, string> {
  const labels = new Map<MessageEntry, string>()
  for (const problem of problems(events, { draft, pendingMs: Number.POSITIVE_INFINITY })) {
    if (problem.kind !== 'error') continue
    const label = codeLabel(problem.code, problem.codeName, draft)
    if (label !== '') labels.set(problem.event.entry, label)
  }
  return labels
}

/**
 * What went wrong in the session, worded by `@moqtap/inspect`. `endMs` is
 * the time up to which a missing response counts as missing; the latest
 * message's time when not given.
 */
export function sessionProblems(
  events: readonly MessageEvent[],
  options: {
    draft: number | null
    tracks: Iterable<TrackEntry>
    endMs?: number
  },
): SessionProblem[] {
  const names = new Map<string, string>()
  for (const track of options.tracks) {
    names.set(requestKey(track.direction, track.subscribeId), track.fullName)
  }
  const wording = {
    draft: options.draft,
    pendingMs: PENDING_MS,
    // The page opened the WebTransport session, so it is the client.
    perspective: 'client',
    trackOf: (event: MessageEvent) => {
      const id = ownRequestId(event)
      return id === null ? undefined : names.get(requestKey(event.entry.direction, id))
    },
  }
  return problems(events, {
    draft: options.draft,
    pendingMs: PENDING_MS,
    endMs: options.endMs,
  }).map((problem) => ({
    title: problemTitle(problem, wording),
    detail: problemDetail(problem, wording),
    severity: problemSeverity(problem.kind),
    atMs: problem.atMs,
  }))
}

/**
 * Whether a message's name, or its name in another draft, contains `query`:
 * `announce` finds PUBLISH_NAMESPACE.
 */
export function messageMatches(
  messageType: string,
  query: string,
  draft: number | null,
): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return [messageType, ...messageAliases(messageType, draft)].some((name) =>
    name.toLowerCase().includes(q),
  )
}
