/**
 * What the bridge content script passes from a page to the background.
 *
 * The bridge runs on every origin, so this filter is the only thing between
 * any web page and the background's sign-in state machine. It relays a
 * message only when all of these hold:
 *
 * - the bridge's own document is exactly `APP_ORIGIN`, in the top frame
 * - the message came from this window (`event.source === window`) and its
 *   origin is exactly `APP_ORIGIN`
 * - the message has exactly one of the two shapes, with bounded fields
 *
 * What it relays is a fresh object built from the checked fields, never the
 * page's own object. The background checks the sender's URL again.
 */

import type { BridgeAccountMsg } from './messages'

/** An authorization code: 256 random bits, base64url. */
const CODE = /^[A-Za-z0-9_-]{43}$/
/** RFC 6749 VSCHAR, bounded. Ours are 22 characters. */
const STATE = /^[\x20-\x7e]{1,512}$/
/** RFC 6749 §4.1.2.1 error codes are short snake_case words. */
const ERROR = /^[a-z_]{1,64}$/

export interface RelayContext {
  /** `location.origin` of the document the bridge runs in. */
  readonly selfOrigin: string
  /** `window === window.top` in that document. */
  readonly isTop: boolean
  /** The bridge's `window`, compared with `event.source`. */
  readonly self: unknown
  readonly appOrigin: string
}

export interface MessageEventLike {
  readonly source: unknown
  readonly origin: string
  readonly data: unknown
}

const optional = (v: unknown, re: RegExp): string | null | undefined =>
  v === null || v === undefined ? null : typeof v === 'string' && re.test(v) ? v : undefined

export function accountRelay(
  event: MessageEventLike,
  ctx: RelayContext,
): BridgeAccountMsg | null {
  if (ctx.selfOrigin !== ctx.appOrigin || !ctx.isTop) return null
  if (event.source !== ctx.self || event.origin !== ctx.appOrigin) return null
  const data = event.data
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>

  if (d.type === 'moqtap:oauth-callback') {
    const code = optional(d.code, CODE)
    const state = optional(d.state, STATE)
    const error = optional(d.error, ERROR)
    if (code === undefined || state === undefined || error === undefined) return null
    // A callback without a state cannot be tied to a flow; one with neither a
    // code nor an error says nothing.
    if (state === null || (code === null && error === null)) return null
    return {
      kind: 'moqtap-account',
      message: { type: 'moqtap:oauth-callback', code, state, error },
    }
  }

  if (d.type === 'moqtap:session') {
    if (d.state !== 'signed-in' && d.state !== 'signed-out') return null
    return { kind: 'moqtap-account', message: { type: 'moqtap:session', state: d.state } }
  }

  return null
}
