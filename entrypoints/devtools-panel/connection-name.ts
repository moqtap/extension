import { formatClock, plural, shortSessionId } from './format'

/** A connection's host and port. */
export function connectionHost(url: string): string {
  try {
    const u = new URL(url)
    return u.port ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    // Not a URL: show it as it is.
    return url
  }
}

/** A connection in one line: its host and port, then its short id. */
export function connectionName(session: { url: string; sessionId: string }): string {
  return `${connectionHost(session.url)} ${shortSessionId(session.sessionId)}`
}

export interface ConnectionFacts {
  url: string
  protocol: string
  draft?: number | string | null
  closed: boolean
  imported?: boolean
  frameId?: number | string
  createdAt: number
  streams: number
}

/** A connection row's tooltip: what the one-line row leaves out. */
export function connectionTitle(c: ConnectionFacts): string {
  const protocol =
    c.protocol === 'moqt'
      ? c.draft
        ? `MoQT draft-${c.draft}`
        : 'MoQT'
      : c.protocol === 'moqt-unknown-draft'
        ? 'MoQT, draft not identified'
        : c.protocol === 'detecting'
          ? 'Detecting the protocol'
          : 'WebTransport'
  const state = c.imported ? 'imported' : c.closed ? 'closed' : 'open'
  const lines = [c.url, `${protocol} · ${state}`, `Opened ${formatClock(c.createdAt)} · ${plural(c.streams, 'stream')}`]
  if (c.frameId) lines.push('In an iframe')
  return lines.join('\n')
}
