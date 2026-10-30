/**
 * Every track that carried data, the ones no decoded request named included.
 * Data on an alias no track claims (its SUBSCRIBE did not decode, say) still
 * counts: such a track is shown by its alias, with what the data and any
 * decoded response on its request stream say, and no name.
 */

import { controlMessageFields } from '@moqtap/trace'
import type { MessageEntry, SessionEntry, TrackEntry } from './use-inspector'

const DONE = new Set(['publish_done', 'subscribe_done'])

function fieldsOf(m: MessageEntry): Record<string, unknown> | null {
  return controlMessageFields(m.decoded) ?? null
}

function aliasOf(m: MessageEntry): string | null {
  const f = fieldsOf(m)
  const v = f?.track_alias ?? f?.trackAlias
  return typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string' ? String(v) : null
}

/**
 * Which way a track's objects travel, from the request that registered it: a
 * track this page subscribed to or fetched is received, one it published (or
 * was subscribed to) is sent.
 */
export function trackDirection(track: Pick<TrackEntry, 'via' | 'direction'>): 'tx' | 'rx' {
  if (track.via === 'publish') return track.direction
  return track.direction === 'tx' ? 'rx' : 'tx'
}

/** The one way an alias's data streams and datagrams travel, or null when none or both. */
function aliasDataDirection(
  session: Pick<SessionEntry, 'streams' | 'datagramGroups'>,
  alias: string,
): 'tx' | 'rx' | null {
  const seen = new Set<'tx' | 'rx'>()
  for (const s of session.streams.values()) {
    if (!s.isControl && s.trackAlias != null && String(s.trackAlias) === alias) seen.add(s.direction)
  }
  for (const g of session.datagramGroups.values()) {
    if (String(g.trackAlias) === alias) seen.add(g.direction)
  }
  return seen.size === 1 ? [...seen][0] : null
}

/** `Track alias 4`: how a track no request named is shown. */
export function aliasTrackName(alias: string): string {
  return `Track alias ${alias}`
}

/** The tracks known only by the alias their streams and datagrams carry, by alias. */
export function unnamedTracks(
  session: Pick<SessionEntry, 'tracks' | 'streams' | 'datagramGroups' | 'messages' | 'draft'>,
): TrackEntry[] {
  const claimed = new Set<string>()
  let colour = -1
  for (const t of session.tracks.values()) {
    if (t.trackAlias != null && t.via !== 'fetch') claimed.add(t.trackAlias)
    colour = Math.max(colour, t.colorIndex)
  }
  const aliases = new Set<string>()
  for (const s of session.streams.values()) {
    if (!s.isControl && s.trackAlias != null && !claimed.has(String(s.trackAlias))) aliases.add(String(s.trackAlias))
  }
  for (const g of session.datagramGroups.values()) {
    if (!claimed.has(String(g.trackAlias))) aliases.add(String(g.trackAlias))
  }
  if (aliases.size === 0) return []

  // From draft-17 a response comes back on its request's own stream, so the
  // stream that named the alias in a SUBSCRIBE_OK also carries its end.
  const requestStreams = Number(session.draft) >= 17
  return [...aliases]
    .sort((a, b) => Number(a) - Number(b))
    .map((alias, i) => {
      const ok = session.messages.find((m) => m.messageType === 'subscribe_ok' && aliasOf(m) === alias)
      const done =
        ok && requestStreams && ok.streamId !== undefined
          ? session.messages.find((m) => DONE.has(m.messageType) && m.streamId === ok.streamId && m.timestamp >= ok.timestamp)
          : undefined
      const name = aliasTrackName(alias)
      // The data's own direction; else a SUBSCRIBE_OK is sent the way the data goes.
      const data = aliasDataDirection(session, alias) ?? ok?.direction ?? null
      return {
        subscribeId: `alias:${alias}`,
        trackAlias: alias,
        trackNamespace: [],
        trackName: name,
        fullName: name,
        // As the registry keeps it: the side that subscribed, opposite the data.
        direction: data === 'tx' ? 'rx' : 'tx',
        via: 'subscribe',
        status: done ? 'done' : 'active',
        colorIndex: colour + 1 + i,
        ...(ok ? { subscribeOkAt: ok.timestamp } : {}),
        ...(done ? { subscribeDoneAt: done.timestamp } : {}),
        unnamed: { directionKnown: data !== null },
      } satisfies TrackEntry
    })
}

/** The session's tracks, then the ones known only by alias: what the Tracks tab lists. */
export function shownTracks(
  session: Pick<SessionEntry, 'tracks' | 'streams' | 'datagramGroups' | 'messages' | 'draft'>,
): Map<string, TrackEntry> {
  const extra = unnamedTracks(session)
  if (extra.length === 0) return session.tracks
  const all = new Map(session.tracks)
  for (const t of extra) all.set(t.subscribeId, t)
  return all
}
