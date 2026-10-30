/**
 * The worker origin exclusion list: origins where wrapping a page's workers
 * failed (a CSP that blocks blob workers), so the MAIN-world script leaves
 * their workers alone.
 *
 * The list is kept in `browser.storage.local` under one key, and it says
 * which sites the user has visited. Two rules follow, and this module is
 * where both are enforced:
 *
 * - **Out:** a page learns only whether its own origin is listed, never the
 *   list ({@link exclusionNotice}). The bridge runs in every frame of every
 *   page, and whatever it posts to its window, every script in that window
 *   can read.
 * - **In:** a content-script message is whatever the page wanted it to be,
 *   since the page can post the same message the MAIN-world script does. A
 *   `worker:csp-recovered` therefore writes only the sender frame's own
 *   origin, as the browser reports it, and only when the message names that
 *   same origin ({@link acceptAutoExclusion}). Entries and their fields are
 *   bounded, so no sender can grow the list without limit.
 */

import type { ExclusionEntry } from '@/src/messaging/types'

/** The one storage key this list owns. */
export const EXCLUSIONS_KEY = 'moqtap-worker-exclusions'

/** The most entries kept; the oldest automatic ones go first. */
export const MAX_EXCLUSIONS = 200
/** Longest origin accepted. Real ones are far shorter. */
export const MAX_ORIGIN_LENGTH = 256
/** Longest error text kept with an entry. */
export const MAX_ERROR_LENGTH = 300

export interface ExclusionNotice {
  readonly source: 'moqtap-exclusions'
  readonly excluded: true
}

/** The browser's account of who sent a port message. */
export interface ExclusionSender {
  readonly url?: string
  readonly origin?: string
}

/**
 * `scheme://host[:port]` when `value` is exactly an http(s) origin, else
 * null. A path, query, userinfo or anything unparseable is not an origin.
 */
export function bareOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ORIGIN_LENGTH) {
    return null
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.origin === value ? value : null
}

/** The sender frame's origin, from the browser, never from the message. */
export function senderOrigin(sender: ExclusionSender | undefined): string | null {
  if (sender?.origin !== undefined) return bareOrigin(sender.origin)
  if (typeof sender?.url !== 'string') return null
  try {
    return bareOrigin(new URL(sender.url).origin)
  } catch {
    return null
  }
}

/** The stored list, with anything that is not a well-formed entry dropped. */
export function readExclusions(stored: unknown): Record<string, ExclusionEntry> {
  const out: Record<string, ExclusionEntry> = {}
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return out
  for (const [origin, entry] of Object.entries(stored as Record<string, unknown>)) {
    if (bareOrigin(origin) === null) continue
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    if (typeof e.blockedAt !== 'number') continue
    if (e.source !== 'auto' && e.source !== 'manual') continue
    out[origin] = {
      blockedAt: e.blockedAt,
      source: e.source,
      ...(typeof e.error === 'string' ? { error: e.error.slice(0, MAX_ERROR_LENGTH) } : {}),
    }
  }
  return out
}

/**
 * What the bridge posts to the page in `origin`: a notice when that origin is
 * listed, else nothing.
 */
export function exclusionNotice(stored: unknown, origin: string): ExclusionNotice | null {
  if (bareOrigin(origin) === null) return null
  return Object.prototype.hasOwnProperty.call(readExclusions(stored), origin)
    ? { source: 'moqtap-exclusions', excluded: true }
    : null
}

/**
 * The list with `origin` added, kept within {@link MAX_EXCLUSIONS} by
 * dropping the oldest automatic entries. Manual ones are the user's own
 * choice and stay.
 */
export function withExclusion(
  stored: unknown,
  origin: string,
  entry: ExclusionEntry,
): Record<string, ExclusionEntry> {
  const list = readExclusions(stored)
  list[origin] = {
    blockedAt: entry.blockedAt,
    source: entry.source,
    ...(entry.error !== undefined ? { error: entry.error.slice(0, MAX_ERROR_LENGTH) } : {}),
  }
  const auto = Object.entries(list)
    .filter(([o, e]) => e.source === 'auto' && o !== origin)
    .sort(([, a], [, b]) => a.blockedAt - b.blockedAt)
  let excess = Object.keys(list).length - MAX_EXCLUSIONS
  for (const [o] of auto) {
    if (excess <= 0) break
    delete list[o]
    excess--
  }
  return list
}

/** The list without `origin`, as Settings' Remove leaves it. */
export function withoutExclusion(stored: unknown, origin: string): Record<string, ExclusionEntry> {
  const list = readExclusions(stored)
  delete list[origin]
  return list
}

/**
 * The origin a `worker:csp-recovered` message may write, or null to ignore
 * it: the sender frame's own origin, when the message is well formed and
 * names exactly that origin.
 */
export function acceptAutoExclusion(
  message: unknown,
  sender: ExclusionSender | undefined,
): { origin: string; error?: string } | null {
  if (typeof message !== 'object' || message === null) return null
  const m = message as Record<string, unknown>
  if (m.type !== 'worker:csp-recovered') return null
  const origin = senderOrigin(sender)
  if (origin === null || m.origin !== origin) return null
  return typeof m.error === 'string'
    ? { origin, error: m.error.slice(0, MAX_ERROR_LENGTH) }
    : { origin }
}
