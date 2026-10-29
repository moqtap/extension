/**
 * How the panel reads a track's objects: as LOC, CMAF or a timeline when the
 * session's catalogs agree on that packaging, or as LOC when the user pins a
 * LOC profile in the Tracks tab.
 */

import type { LocProfile } from '@moqtap/media/loc'
import { type ShallowRef, shallowRef, toRaw } from 'vue'
import { agreedPackaging, type TrackKey, type TrackPackaging } from './catalogs'
import type { SessionEntry } from './use-inspector'

/** One session's LOC profile pins, shared by the LOC, CMAF and timeline readers. */
export class PackagingPins {
  private readonly pins = new Map<TrackKey, LocProfile>()
  /** Bumped on every change */
  readonly revision: ShallowRef<number> = shallowRef(0)

  get(key: TrackKey): LocProfile | undefined {
    return this.pins.get(key)
  }

  /** Pin a profile on a track, or clear its pin with undefined. */
  set(key: TrackKey, pin: LocProfile | undefined): void {
    if (pin === undefined) this.pins.delete(key)
    else this.pins.set(key, pin)
    this.revision.value++
  }
}

/** How a track's objects are read, and why; null when as neither LOC nor CMAF. */
export interface MediaPackaging {
  packaging: 'loc' | 'cmaf'
  via: 'catalog' | 'pin'
}

/**
 * A LOC pin wins over the catalogs; on a track the catalogs agree is LOC it
 * keeps `via` "catalog". CMAF comes from the catalogs only.
 */
export function mediaPackaging(
  described: TrackPackaging | undefined,
  pin: LocProfile | undefined,
): MediaPackaging | null {
  const agreed = agreedPackaging(described)
  if (pin) return { packaging: 'loc', via: agreed === 'loc' ? 'catalog' : 'pin' }
  if (agreed === 'loc' || agreed === 'cmaf') return { packaging: agreed, via: 'catalog' }
  return null
}

/** The timeline packaging the catalogs agree on; null under a LOC pin. */
export function timelinePackaging(
  described: TrackPackaging | undefined,
  pin: LocProfile | undefined,
): 'mediatimeline' | 'eventtimeline' | null {
  if (pin) return null
  const agreed = agreedPackaging(described)
  return agreed === 'mediatimeline' || agreed === 'eventtimeline' ? agreed : null
}

const sessions = new WeakMap<SessionEntry, PackagingPins>()

/** The pins of a session; they last as long as the panel keeps the session. */
export function sessionPins(session: SessionEntry): PackagingPins {
  const raw = toRaw(session)
  let pins = sessions.get(raw)
  if (!pins) {
    pins = new PackagingPins()
    sessions.set(raw, pins)
  }
  return pins
}
