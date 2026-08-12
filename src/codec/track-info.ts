/**
 * Building the track registry from decoded control messages.
 *
 * Data streams name their track with a numeric alias and nothing else, so
 * labelling a stream in the UI means joining that alias to the namespace and
 * name carried by the control plane. Where the two halves of that join live
 * moved twice in the draft series:
 *
 *   drafts 07–11  SUBSCRIBE carries namespace, name and alias together
 *   drafts 12+    the publisher assigns the alias, so it arrives separately in
 *                 SUBSCRIBE_OK — or all at once in PUBLISH, which a publisher
 *                 sends to offer a track it already holds
 *   drafts 17+    responses carry no request id at all: each request has its
 *                 own bidirectional stream and that stream *is* the
 *                 correlation (draft-19 §3.3), so the join key becomes the
 *                 stream the response arrived on
 *
 * PUBLISH_NAMESPACE never takes part. It announces a namespace and nothing
 * else — no track name, no alias — so a publisher that has only announced has
 * no nameable track yet; the name appears when a SUBSCRIBE for one of its
 * tracks is answered, or when it sends PUBLISH.
 *
 * FETCH is the exception to the alias rule: a fetch has no track alias at all,
 * and its data stream carries the request id in the header instead. Fetches
 * are registered under the same key as everything else, so the join works out
 * the same — the stream just looks itself up by request id.
 *
 * Field names come from the codec verbatim, which is snake_case in every
 * draft. The camelCase spellings are read too, because imported traces may
 * come from other tools.
 */

/** Status of a track's subscription, in the order it progresses. */
export type TrackStatus = 'pending' | 'active' | 'error' | 'done'

/**
 * The request that put a track in the registry. It decides how the track's
 * data streams find their way back to it: a subscription or publication is
 * found by track alias, a fetch by request id.
 */
export type TrackVia = 'subscribe' | 'publish' | 'fetch'

/**
 * The track fields both sides of the extension agree on. The background's
 * registry stores exactly this; the panel's adds display-only fields.
 */
export interface TrackFields {
  /** Request id (subscribe id before draft-11) that identifies the request */
  subscribeId: string
  /** Alias the data streams use for this track, once the draft reveals it */
  trackAlias?: string
  trackNamespace: string[]
  trackName: string
  /** Direction of the message that opened the track (tx = we sent it) */
  direction: 'tx' | 'rx'
  via: TrackVia
  status: TrackStatus
  errorReason?: string
  subscribedAt?: number
  subscribeOkAt?: number
  subscribeErrorAt?: number
  subscribeDoneAt?: number
}

/** What a control message says about a track, stripped of draft differences. */
export type TrackEvent =
  | {
      kind: 'open'
      requestId?: string
      via: TrackVia
      trackNamespace: string[]
      trackName: string
      trackAlias?: string
      /**
       * Request whose track a joining FETCH is fetching. Such a fetch names no
       * track itself — it continues an existing subscription's track.
       */
      joiningRequestId?: string
    }
  | { kind: 'accept'; requestId?: string; trackAlias?: string }
  | { kind: 'reject'; requestId?: string; reason: string }
  | { kind: 'close'; requestId?: string }

/** First defined value among several spellings of one field. */
function pick(msg: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    const value = msg[name]
    if (value != null) return value
  }
  return undefined
}

function id(msg: Record<string, unknown>): string | undefined {
  // subscribe_id through draft-10; request_id from draft-11, when the id space
  // was widened to cover every request type.
  const value = pick(msg, [
    'request_id',
    'requestId',
    'subscribe_id',
    'subscribeId',
  ])
  return value != null ? String(value) : undefined
}

function alias(msg: Record<string, unknown>): string | undefined {
  const value = pick(msg, ['track_alias', 'trackAlias'])
  return value != null ? String(value) : undefined
}

function namespace(msg: Record<string, unknown>): string[] {
  const value = pick(msg, ['track_namespace', 'trackNamespace'])
  return Array.isArray(value) ? value.map(String) : []
}

function name(msg: Record<string, unknown>): string {
  const value = pick(msg, ['track_name', 'trackName'])
  return value != null ? String(value) : ''
}

function reason(msg: Record<string, unknown>): string {
  const value = pick(msg, ['reason_phrase', 'reasonPhrase'])
  return value != null ? String(value) : ''
}

/**
 * Read a decoded control message as a track event, or null if it says nothing
 * about a track.
 *
 * The generic REQUEST_OK / REQUEST_ERROR of draft-17+ answer any request, not
 * just track ones. They are read anyway and land harmlessly: a response to a
 * PUBLISH_NAMESPACE resolves to no track and is dropped.
 */
export function trackEventFrom(
  msg: Record<string, unknown>,
): TrackEvent | null {
  switch (String(msg.type ?? '')) {
    case 'subscribe':
    case 'publish': {
      const via = msg.type === 'publish' ? 'publish' : 'subscribe'
      return {
        kind: 'open',
        requestId: id(msg),
        via,
        trackNamespace: namespace(msg),
        trackName: name(msg),
        trackAlias: alias(msg),
      }
    }

    case 'fetch': {
      // A standalone fetch names its track; a joining fetch points at the
      // subscription whose track it continues. Most drafts nest the two in
      // `standalone` / `joining` sub-structures, draft-14 keeps them flat, so
      // read through the nesting when it is there.
      const standalone = (msg.standalone ?? msg) as Record<string, unknown>
      const joining = (msg.joining ?? msg) as Record<string, unknown>
      const joiningId = pick(joining, [
        'joining_request_id',
        'joiningRequestId',
        'joining_subscribe_id',
        'joiningSubscribeId',
      ])
      return {
        kind: 'open',
        requestId: id(msg),
        via: 'fetch',
        trackNamespace: namespace(standalone),
        trackName: name(standalone),
        ...(joiningId != null ? { joiningRequestId: String(joiningId) } : {}),
      }
    }

    case 'subscribe_ok':
    case 'publish_ok':
    case 'fetch_ok':
    case 'request_ok':
      return { kind: 'accept', requestId: id(msg), trackAlias: alias(msg) }

    case 'subscribe_error':
    case 'publish_error':
    case 'fetch_error':
    case 'request_error':
      return { kind: 'reject', requestId: id(msg), reason: reason(msg) }

    case 'subscribe_done':
    case 'publish_done':
    case 'unsubscribe':
    case 'fetch_cancel':
      return { kind: 'close', requestId: id(msg) }

    default:
      return null
  }
}

/** Where a control message came from, as far as the join is concerned. */
export interface TrackMessageContext {
  direction: 'tx' | 'rx'
  /**
   * Control stream the message arrived on. Required to follow a draft-17+
   * request, whose responses identify themselves only by their stream.
   */
  streamId?: number
  timestamp?: number
}

/**
 * A session's tracks, kept up to date from its control messages.
 *
 * Generic over the stored record so both sides can use it: the background
 * stores {@link TrackFields} as-is, the panel stores it plus display fields.
 * The map passed in is mutated in place, so existing readers of it keep
 * working.
 */
export class TrackRegistry<T extends TrackFields> {
  /**
   * Request id owning each request stream, so draft-17+ responses can be
   * matched to the request that opened their stream.
   */
  private readonly requestIdByStream = new Map<number, string>()

  constructor(
    private readonly tracks: Map<string, T>,
    private readonly create: (fields: TrackFields) => T,
  ) {}

  /**
   * Apply one decoded control message. Returns the track it affected, or null
   * if the message was not about a track we can identify.
   */
  apply(msg: Record<string, unknown>, ctx: TrackMessageContext): T | null {
    const event = trackEventFrom(msg)
    if (!event) return null

    const key = this.keyFor(event, ctx.streamId)
    if (key == null) return null

    switch (event.kind) {
      case 'open': {
        const named = this.nameFor(event)
        const track = this.create({
          subscribeId: key,
          trackAlias: event.trackAlias,
          trackNamespace: named.trackNamespace,
          trackName: named.trackName,
          direction: ctx.direction,
          via: event.via,
          status: 'pending',
          subscribedAt: ctx.timestamp,
        })
        this.tracks.set(key, track)
        return track
      }

      case 'accept': {
        const track = this.tracks.get(key)
        if (!track) return null
        // From draft-12 this is where the subscription learns which data
        // streams are its own, so it is the half of the join that matters.
        if (event.trackAlias != null) track.trackAlias = event.trackAlias
        track.status = 'active'
        track.subscribeOkAt = ctx.timestamp
        return track
      }

      case 'reject': {
        const track = this.tracks.get(key)
        if (!track) return null
        track.status = 'error'
        track.errorReason = event.reason
        track.subscribeErrorAt = ctx.timestamp
        return track
      }

      case 'close': {
        const track = this.tracks.get(key)
        if (!track) return null
        track.status = 'done'
        track.subscribeDoneAt = ctx.timestamp
        return track
      }
    }
  }

  /**
   * The namespace and name to file an opening request under.
   *
   * A joining FETCH carries neither: it continues the track of an existing
   * subscription, named by that subscription's request. Borrowing the name
   * from it is what keeps a joining fetch's streams from showing up nameless.
   */
  private nameFor(event: Extract<TrackEvent, { kind: 'open' }>): {
    trackNamespace: string[]
    trackName: string
  } {
    if (event.trackName || event.trackNamespace.length) return event
    const parent = event.joiningRequestId
      ? this.tracks.get(event.joiningRequestId)
      : undefined
    if (!parent) return event
    return {
      trackNamespace: parent.trackNamespace,
      trackName: parent.trackName,
    }
  }

  /**
   * The key a message's track is filed under: its own request id when it has
   * one, otherwise the id of the request that opened its stream.
   */
  private keyFor(event: TrackEvent, streamId?: number): string | null {
    if (event.requestId != null) {
      if (event.kind === 'open' && streamId != null) {
        this.requestIdByStream.set(streamId, event.requestId)
      }
      return event.requestId
    }
    if (streamId == null) return null
    return this.requestIdByStream.get(streamId) ?? null
  }
}
