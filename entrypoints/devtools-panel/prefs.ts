/**
 * Persistent preferences for the DevTools panel.
 * Uses chrome.storage.local for persistence across sessions.
 */

const STORAGE_KEY = 'moqtap-prefs'

export type DirectionFilter = 'all' | 'tx' | 'rx'

interface Prefs {
  payloadViewMode: 'decoded' | 'hex' | 'stack'
  streamViewMode: 'hex' | 'json'
  sidebarCollapsed: boolean
  /** True once the user has manually toggled the sidebar (overrides auto-collapse) */
  sidebarManual: boolean
  trackActiveOnly: boolean
  trackGroupByNs: boolean
  trackDirectionFilter: DirectionFilter
}

const defaults: Prefs = {
  payloadViewMode: 'decoded',
  streamViewMode: 'json',
  sidebarCollapsed: false,
  sidebarManual: false,
  trackActiveOnly: false,
  trackGroupByNs: false,
  trackDirectionFilter: 'all',
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
