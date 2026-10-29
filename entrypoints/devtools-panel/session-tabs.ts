/** The views of a connection, as the tab strip lists them. */

export type SessionTab = 'messages' | 'streams' | 'tracks' | 'problems' | 'details'

export const SESSION_TABS: readonly SessionTab[] = ['messages', 'streams', 'tracks', 'problems', 'details']

/** What a panel opened for the first time shows. */
export const FIRST_TAB: SessionTab = 'streams'

export function isSessionTab(v: unknown): v is SessionTab {
  return SESSION_TABS.includes(v as SessionTab)
}

export interface TabCounts {
  messages: number
  streams: number
  /** null when the connection has no tracks view (not MoQT) */
  tracks: number | null
  problems: number
}

export function tabList(c: TabCounts): { id: SessionTab; label: string; count: number | null }[] {
  const list: { id: SessionTab; label: string; count: number | null }[] = [
    { id: 'messages', label: 'Messages', count: c.messages },
    { id: 'streams', label: 'Streams', count: c.streams },
  ]
  if (c.tracks !== null) list.push({ id: 'tracks', label: 'Tracks', count: c.tracks })
  list.push({ id: 'problems', label: 'Problems', count: c.problems })
  list.push({ id: 'details', label: 'Details', count: null })
  return list
}

/** The remembered tab, or Streams when this connection has no such view. */
export function shownTab(wanted: SessionTab, hasTracks: boolean): SessionTab {
  return wanted === 'tracks' && !hasTracks ? 'streams' : wanted
}

/** Whether the toolbar filter applies to a view. */
export function filters(tab: SessionTab): boolean {
  return tab !== 'details'
}
