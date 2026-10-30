/**
 * How the panel reads a track's objects: as LOC, CMAF or a timeline when the
 * session's catalogs agree on that packaging. Nothing else picks a reader:
 * a track whose packaging the data does not give is shown as bytes.
 */

import { type ShallowRef, shallowRef, toRaw } from 'vue'
import { agreedPackaging, type TrackKey, type TrackPackaging } from './catalogs'
import type { SessionEntry } from './use-inspector'

/** The tracks of one session the user views as bytes rather than with their packaging's reader. */
export class TrackViews {
  private readonly hex = new Set<TrackKey>()
  /** Bumped on every change */
  readonly revision: ShallowRef<number> = shallowRef(0)

  isHex(key: TrackKey): boolean {
    return this.hex.has(key)
  }

  setHex(key: TrackKey, on: boolean): void {
    if (on === this.hex.has(key)) return
    if (on) this.hex.add(key)
    else this.hex.delete(key)
    this.revision.value++
  }
}

/** How a track's objects are read; null when as neither LOC nor CMAF. */
export interface MediaPackaging {
  packaging: 'loc' | 'cmaf'
  via: 'catalog'
}

/** LOC and CMAF come from the catalogs only. */
export function mediaPackaging(described: TrackPackaging | undefined): MediaPackaging | null {
  const agreed = agreedPackaging(described)
  if (agreed === 'loc' || agreed === 'cmaf') return { packaging: agreed, via: 'catalog' }
  return null
}

/** The timeline packaging the catalogs agree on. */
export function timelinePackaging(
  described: TrackPackaging | undefined,
): 'mediatimeline' | 'eventtimeline' | null {
  const agreed = agreedPackaging(described)
  return agreed === 'mediatimeline' || agreed === 'eventtimeline' ? agreed : null
}

const sessions = new WeakMap<SessionEntry, TrackViews>()

/** The track views of a session; they last as long as the panel keeps the session. */
export function sessionViews(session: SessionEntry): TrackViews {
  const raw = toRaw(session)
  let views = sessions.get(raw)
  if (!views) {
    views = new TrackViews()
    sessions.set(raw, views)
  }
  return views
}
