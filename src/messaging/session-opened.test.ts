import { describe, expect, it } from 'vitest'
import { cliFields, openedSession, panelSessionOpened, sessionOpened } from './session-opened'
import type { SessionOpenedMsg } from './types'

const CLI_SESSION = 'A'.repeat(21) + 'Q'
const NONE = { state: 'none' } as const

const record = (msg: SessionOpenedMsg, frameId = 0) => openedSession(msg, frameId)

describe("a session's CLI id from the page to the panel", () => {
  const routed = {
    id: 's1',
    url: 'https://relay.example/moq',
    createdAt: 5,
    cli: true as const,
    cliSession: CLI_SESSION,
  }

  it('is sent by the main-world hook', () => {
    expect(sessionOpened(routed, NONE)).toEqual({
      type: 'session:opened',
      sessionId: 's1',
      url: 'https://relay.example/moq',
      createdAt: 5,
      options: undefined,
      collector: NONE,
      cli: true,
      cliSession: CLI_SESSION,
    })
    expect(sessionOpened({ id: 's2', url: 'https://relay.example/moq', createdAt: 5 }, NONE)).not.toHaveProperty('cli')
  })

  it('reaches the panel when the session opens and when a panel connects later', () => {
    const msg = panelSessionOpened(record(sessionOpened(routed, NONE)))
    expect(msg).toEqual(expect.objectContaining({ type: 'panel:session:opened', cli: true, cliSession: CLI_SESSION }))
    expect(panelSessionOpened(record(sessionOpened(routed, NONE), 4))).toEqual(
      expect.objectContaining({ frameId: 4, cliSession: CLI_SESSION }),
    )
  })

  it('is dropped without cli, or when it is not a CLI session id', () => {
    const page = sessionOpened(routed, NONE)
    expect(openedSession({ ...page, cliSession: 'short' }, 0)).toEqual(expect.objectContaining({ cli: true }))
    expect(openedSession({ ...page, cliSession: 'short' }, 0)).not.toHaveProperty('cliSession')
    expect(openedSession({ ...page, cli: undefined }, 0)).not.toHaveProperty('cliSession')
    expect(cliFields({ cliSession: CLI_SESSION })).toEqual({})
    expect(cliFields({ cli: 'yes', cliSession: CLI_SESSION })).toEqual({})
    expect(cliFields({ cli: true, cliSession: 'short' })).toEqual({ cli: true })
    expect(cliFields({ cli: true, cliSession: 7 })).toEqual({ cli: true })
    expect(cliFields({ cli: true })).toEqual({ cli: true })
    expect(panelSessionOpened({ ...record(sessionOpened(routed, NONE)), cliSession: 'short' })).not.toHaveProperty(
      'cliSession',
    )
  })
})
