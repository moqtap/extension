/**
 * Tests for the MoQT session state machine.
 *
 * The extension delegates session state tracking to @moqtap/codec's FSM,
 * exposed via createExtensionSession(). Phases flow:
 *   idle → setup → ready → draining → closed
 */

import { describe, it, expect } from 'vitest'
import { createExtensionSession } from './state-machine'
import type {
  Draft14ClientSetup,
  Draft14ServerSetup,
  Draft14GoAway,
  Draft14Subscribe,
} from '@moqtap/codec/draft14'

// ═══════════════════════════════════════════════════════════════════════
// Session creation
// ═══════════════════════════════════════════════════════════════════════

describe('createExtensionSession', () => {
  it('creates a draft-14 session starting in idle phase', () => {
    const session = createExtensionSession('14')
    expect(session.phase).toBe('idle')
  })

  it('creates a draft-07 session starting in idle phase', () => {
    const session = createExtensionSession('07')
    expect(session.phase).toBe('idle')
  })

  it('defaults to client role', () => {
    const session = createExtensionSession('14')
    expect(session.role).toBe('client')
  })

  it('accepts an explicit server role', () => {
    const session = createExtensionSession('14', 'server')
    expect(session.role).toBe('server')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Draft-14 setup handshake: idle → setup → ready
// ═══════════════════════════════════════════════════════════════════════

describe('Draft-14 setup handshake', () => {
  const clientSetup: Draft14ClientSetup = {
    type: 'client_setup',
    supported_versions: [0xff00000en],
    parameters: { path: '/moq' },
  }

  const serverSetup: Draft14ServerSetup = {
    type: 'server_setup',
    selected_version: 0xff00000en,
    parameters: {},
  }

  it('sending CLIENT_SETUP transitions idle → setup', () => {
    const session = createExtensionSession('14')
    const result = session.send(clientSetup)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.phase).toBe('setup')
    }
    expect(session.phase).toBe('setup')
  })

  it('receiving SERVER_SETUP transitions setup → ready', () => {
    const session = createExtensionSession('14')
    session.send(clientSetup)

    const result = session.receive(serverSetup)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.phase).toBe('ready')
    }
    expect(session.phase).toBe('ready')
  })

  it('full handshake produces session-ready side effect', () => {
    const session = createExtensionSession('14')
    session.send(clientSetup)
    const result = session.receive(serverSetup)

    expect(result.ok).toBe(true)
    if (result.ok) {
      const readyEffect = result.sideEffects.find(
        (e) => e.type === 'session-ready',
      )
      expect(readyEffect).toBeDefined()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// GOAWAY → draining
// ═══════════════════════════════════════════════════════════════════════

describe('GOAWAY transitions to draining', () => {
  function readySession() {
    const session = createExtensionSession('14')
    const clientSetup: Draft14ClientSetup = {
      type: 'client_setup',
      supported_versions: [0xff00000en],
      parameters: { path: '/moq' },
    }
    const serverSetup: Draft14ServerSetup = {
      type: 'server_setup',
      selected_version: 0xff00000en,
      parameters: {},
    }
    session.send(clientSetup)
    session.receive(serverSetup)
    return session
  }

  it('receiving GOAWAY in ready phase transitions to draining', () => {
    const session = readySession()
    const goaway: Draft14GoAway = {
      type: 'goaway',
      new_session_uri: 'https://example.com/new',
    }

    const result = session.receive(goaway)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.phase).toBe('draining')
    }
    expect(session.phase).toBe('draining')
  })

  it('GOAWAY produces session-draining side effect', () => {
    const session = readySession()
    const goaway: Draft14GoAway = {
      type: 'goaway',
      new_session_uri: 'https://example.com/new',
    }

    const result = session.receive(goaway)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const drainingEffect = result.sideEffects.find(
        (e) => e.type === 'session-draining',
      )
      expect(drainingEffect).toBeDefined()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Protocol violations
// ═══════════════════════════════════════════════════════════════════════

describe('Protocol violations', () => {
  it('sending SUBSCRIBE before setup is a violation', () => {
    const session = createExtensionSession('14')
    const subscribe: Draft14Subscribe = {
      type: 'subscribe',
      request_id: 0n,
      track_namespace: ['example'],
      track_name: 'video',
      subscriber_priority: 128n,
      group_order: 0n,
      forward: 0n,
      filter_type: 1n,
      parameters: {},
    }

    const result = session.send(subscribe)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.violation.code).toBe('MESSAGE_BEFORE_SETUP')
      expect(result.violation.currentPhase).toBe('idle')
    }
  })

  it('receiving SERVER_SETUP in idle phase (before CLIENT_SETUP) is a violation', () => {
    const session = createExtensionSession('14')
    const serverSetup: Draft14ServerSetup = {
      type: 'server_setup',
      selected_version: 0xff00000en,
      parameters: {},
    }

    const result = session.receive(serverSetup)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.violation.currentPhase).toBe('idle')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Legal message sets
// ═══════════════════════════════════════════════════════════════════════

describe('Legal message sets', () => {
  it('idle session has client_setup as legal outgoing', () => {
    const session = createExtensionSession('14')
    expect(session.legalOutgoing.has('client_setup')).toBe(true)
  })

  it('idle session does not allow subscribe as legal outgoing', () => {
    const session = createExtensionSession('14')
    expect(session.legalOutgoing.has('subscribe')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Reset
// ═══════════════════════════════════════════════════════════════════════

describe('Session reset', () => {
  it('reset returns session to idle phase', () => {
    const session = createExtensionSession('14')
    const clientSetup: Draft14ClientSetup = {
      type: 'client_setup',
      supported_versions: [0xff00000en],
      parameters: { path: '/moq' },
    }
    session.send(clientSetup)
    expect(session.phase).toBe('setup')

    session.reset()
    expect(session.phase).toBe('idle')
  })
})
