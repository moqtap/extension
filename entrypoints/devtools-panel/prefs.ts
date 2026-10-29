/**
 * Persistent preferences for the DevTools panel.
 * Uses chrome.storage.local for persistence across sessions.
 */

import type { GridPrefs } from './grid'
import { FIRST_TAB, type SessionTab } from './session-tabs'

const STORAGE_KEY = 'moqtap-prefs'

export type DirectionFilter = 'all' | 'tx' | 'rx'

interface Prefs {
  payloadViewMode: 'decoded' | 'hex' | 'stack'
  streamViewMode: 'hex' | 'json'
  /** The view last picked, shown for the next connection and the next DevTools */
  sessionTab: SessionTab
  trackActiveOnly: boolean
  trackGroupByNs: boolean
  trackDirectionFilter: DirectionFilter
  /** Each grid's column widths, shown columns and sort, by grid */
  grids: Record<string, GridPrefs>
  /** Each split's first pane, by split and orientation */
  splits: Record<string, number>
  /** The connections sidebar is down to its buttons' width */
  sidebarCollapsed: boolean
}

const defaults: Prefs = {
  payloadViewMode: 'decoded',
  streamViewMode: 'json',
  sessionTab: FIRST_TAB,
  trackActiveOnly: false,
  trackGroupByNs: false,
  trackDirectionFilter: 'all',
  grids: {},
  splits: {},
  sidebarCollapsed: false,
}

let cached: Prefs | null = null

export async function loadPrefs(): Promise<Prefs> {
  if (cached) return cached
  try {
    const result = await browser.storage.local.get(STORAGE_KEY)
    cached = { ...defaults, ...(result[STORAGE_KEY] ?? {}) } as Prefs
  } catch {
    cached = { ...defaults }
  }
  return cached!
}

export async function savePref<K extends keyof Prefs>(
  key: K,
  value: Prefs[K],
): Promise<void> {
  if (!cached) await loadPrefs()
  cached![key] = value
  try {
    await browser.storage.local.set({ [STORAGE_KEY]: cached })
  } catch {
    // Storage not available
  }
}

export function getCachedPref<K extends keyof Prefs>(key: K): Prefs[K] {
  return cached?.[key] ?? defaults[key]
}
