import type { DirectionFilter } from './prefs'

/**
 * A track row's name in two parts: the namespace, which gives way first when
 * the column is narrow, and the track name. Grouped rows sit under their
 * namespace, so they carry the name alone.
 */
export function trackNameParts(
  track: { trackNamespace: readonly string[]; trackName: string },
  grouped: boolean,
): { namespace: string | null; name: string } {
  const namespace = !grouped && track.trackNamespace.length > 0 ? `${track.trackNamespace.join('/')} / ` : null
  return { namespace, name: track.trackName }
}

/** The Tracks view menu's button: which tracks show, in a few words. */
export function trackViewLabel(v: { activeOnly: boolean; direction: DirectionFilter; grouped: boolean }): string {
  const dir = v.direction === 'tx' ? 'outgoing' : v.direction === 'rx' ? 'incoming' : ''
  const words = [v.activeOnly ? 'Active' : dir ? '' : 'All', dir, 'tracks'].filter((w) => w)
  const text = words.join(' ')
  const label = text.charAt(0).toUpperCase() + text.slice(1)
  return v.grouped ? `${label} by namespace` : label
}
