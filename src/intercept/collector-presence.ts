/**
 * Is `@moqtap/collector` running on this page?
 *
 * The SDK publishes a frozen marker on the page global when its WebTransport
 * hook attaches. We run in MAIN world, so we share that global and can simply
 * read it — see `moqtap-js/packages/collector/src/transport/presence.ts`, which
 * owns the contract and pins this shape in its own suite.
 *
 * **The duplication of the shape is deliberate.** The extension does not depend
 * on `@moqtap/collector` — it is source-available where the extension's other
 * moqtap dependencies are MIT, and taking a dependency on the SDK to read four
 * fields would be the tail wagging the dog. The cost is that a change there
 * must be mirrored here; the `v` field is what makes that failure loud instead
 * of silent.
 */

/** The property the SDK publishes. Changing this breaks the feature. */
const PRESENCE_KEY = '__moqtapCollector'

export interface CollectorPresence {
  readonly v: 1
  readonly version: string
  /** Wall-clock ms when the SDK's hook attached to the page. */
  readonly since: number
  /** False means installed but dormant — no key, transmitting nothing. */
  readonly active: boolean
}

/** What the panel shows for one connection. */
export type CollectorStatus =
  /** No moqtap SDK on the page. */
  | { readonly state: 'none' }
  /** SDK present and transmitting, and this connection is inside its window. */
  | { readonly state: 'collected'; readonly version: string }
  /** SDK present but no key supplied — a common and confusing misconfiguration. */
  | { readonly state: 'dormant'; readonly version: string }
  /**
   * SDK present, but this connection opened before its hook attached, so the
   * SDK never saw it. Worth showing rather than hiding: a connection made at
   * module-eval time and an `init()` called late is a real ordering bug, and
   * this is the only place a developer would ever see it.
   */
  | { readonly state: 'predates'; readonly version: string }

/**
 * Read the marker. Returns `null` for anything that is not the shape we know —
 * any page script can write this property, and a reader that trusted it would
 * let a page make the panel report a collector that is not there.
 */
export function readCollectorPresence(
  target: unknown = globalThis,
): CollectorPresence | null {
  const value = (target as Record<string, unknown> | undefined)?.[PRESENCE_KEY]
  if (value === null || typeof value !== 'object') return null
  const p = value as Partial<CollectorPresence>
  if (p.v !== 1) return null
  if (typeof p.since !== 'number' || typeof p.active !== 'boolean') return null
  if (typeof p.version !== 'string') return null
  return p as CollectorPresence
}

/**
 * Classify one connection against the marker.
 *
 * `createdAt` and `since` are both wall-clock ms taken in the same realm, so
 * they are directly comparable. The SDK only observes what its own patch sees,
 * which is why a connection older than `since` is reported as uncollected —
 * an approximation that can only ever under-claim, never over-claim.
 */
export function classifyConnection(
  createdAt: number,
  presence: CollectorPresence | null = readCollectorPresence(),
): CollectorStatus {
  if (presence === null) return { state: 'none' }
  if (createdAt < presence.since)
    return { state: 'predates', version: presence.version }
  if (!presence.active) return { state: 'dormant', version: presence.version }
  return { state: 'collected', version: presence.version }
}
