/** The `session:opened` a page sends and what the background keeps and tells the panel of it. */

import { isId16 } from '../cli/protocol'
import type { CollectorStatus } from '../intercept/collector-presence'
import type { InterceptedSession } from '../intercept/webtransport-hook'
import type { PanelSessionOpenedMsg, SessionOpenedMsg, WebTransportOptionsInfo } from './types'

/** A session the main-world hook opened. */
export function sessionOpened(session: InterceptedSession, collector: CollectorStatus): SessionOpenedMsg {
  return {
    type: 'session:opened',
    sessionId: session.id,
    url: session.url,
    createdAt: session.createdAt,
    options: session.options,
    collector,
    ...(session.cli ? { cli: true } : {}),
    ...(session.cliSession ? { cliSession: session.cliSession } : {}),
  }
}

/** The CLI fields of a page's `session:opened` worth keeping: an id only for a session through the CLI. */
export function cliFields(msg: { readonly cli?: unknown; readonly cliSession?: unknown }): {
  cli?: true
  cliSession?: string
} {
  if (msg.cli !== true) return {}
  return isId16(msg.cliSession) ? { cli: true, cliSession: msg.cliSession } : { cli: true }
}

export interface OpenedSession {
  readonly sessionId: string
  readonly url: string
  readonly createdAt: number
  readonly options?: WebTransportOptionsInfo
  readonly frameId: number
  readonly collector?: CollectorStatus
  readonly cli?: true
  readonly cliSession?: string
}

/** What the background keeps of a page's `session:opened` from `frameId`. */
export function openedSession(msg: SessionOpenedMsg, frameId: number): OpenedSession {
  return {
    sessionId: msg.sessionId,
    url: msg.url,
    createdAt: msg.createdAt,
    options: msg.options,
    frameId,
    ...(msg.collector ? { collector: msg.collector } : {}),
    ...cliFields(msg),
  }
}

/** What the panel hears of a session, when it opens and when a panel connects later. */
export function panelSessionOpened(s: OpenedSession): PanelSessionOpenedMsg {
  return {
    type: 'panel:session:opened',
    sessionId: s.sessionId,
    url: s.url,
    createdAt: s.createdAt,
    ...(s.options ? { options: s.options } : {}),
    ...(s.frameId !== 0 ? { frameId: s.frameId } : {}),
    ...(s.collector ? { collector: s.collector } : {}),
    ...cliFields(s),
  }
}
