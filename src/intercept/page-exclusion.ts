/**
 * A frame's view of the worker exclusion list. The extension's list
 * (src/storage/worker-exclusions.ts) is the only record: a frame learns
 * whether its own origin is listed from the bridge's verdict, and keeps
 * nothing of its own across loads, so a site removed in Settings has its
 * workers captured again on the next load.
 */

import type { WorkerCspRecoveredMsg } from '@/src/messaging/types'

/** Keys older builds wrote to the page's own localStorage. */
export const LEGACY_PAGE_KEYS = ['__moqtap_excluded_origins', '__moqtap_csp_blocked'] as const

export class PageExclusion {
  private listed = false

  constructor(
    private readonly origin: string,
    storage: Pick<Storage, 'removeItem'> | null,
  ) {
    try {
      for (const key of LEGACY_PAGE_KEYS) storage?.removeItem(key)
    } catch {
      /* localStorage may be disabled */
    }
  }

  /** Workers in this frame are left alone. */
  get excluded(): boolean {
    return this.listed
  }

  /** A message posted to this window: the bridge's verdict, when it is one. */
  onMessage(data: unknown): void {
    const d = data as { source?: unknown; excluded?: unknown } | null
    if (this.origin && d?.source === 'moqtap-exclusions' && d.excluded === true) this.listed = true
  }

  /**
   * A worker this frame could not instrument: the rest are left alone for
   * this load, and the extension is asked to list the origin.
   */
  record(workerUrl: string, error: string): WorkerCspRecoveredMsg | null {
    this.listed = true
    if (!this.origin) return null
    return { type: 'worker:csp-recovered', origin: this.origin, workerUrl, error }
  }
}
