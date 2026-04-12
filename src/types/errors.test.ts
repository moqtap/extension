/**
 * Tests for error code enumerations per draft-14 §13.1.
 * Validates all error codes match spec values.
 */

import { describe, it, expect } from 'vitest'
import {
  SessionTerminationError,
  SubscribeErrorCode,
  PublishDoneCode,
  PublishErrorCode,
  FetchErrorCode,
  AnnounceErrorCode,
  SubscribeNamespaceErrorCode,
  DataStreamResetError,
} from './errors'

// ═══════════════════════════════════════════════════════════════════════
// Session Termination Error Codes (§13.1.1, Table 8)
// ═══════════════════════════════════════════════════════════════════════

describe('Session Termination Error Codes (Table 8)', () => {
  const expected: [string, number][] = [
    ['NO_ERROR', 0x0],
    ['INTERNAL_ERROR', 0x1],
    ['UNAUTHORIZED', 0x2],
    ['PROTOCOL_VIOLATION', 0x3],
    ['INVALID_REQUEST_ID', 0x4],
    ['DUPLICATE_TRACK_ALIAS', 0x5],
    ['KEY_VALUE_FORMATTING_ERROR', 0x6],
    ['TOO_MANY_REQUESTS', 0x7],
    ['INVALID_PATH', 0x8],
    ['MALFORMED_PATH', 0x9],
    ['GOAWAY_TIMEOUT', 0x10],
    ['CONTROL_MESSAGE_TIMEOUT', 0x11],
    ['DATA_STREAM_TIMEOUT', 0x12],
    ['AUTH_TOKEN_CACHE_OVERFLOW', 0x13],
    ['DUPLICATE_AUTH_TOKEN_ALIAS', 0x14],
    ['VERSION_NEGOTIATION_FAILED', 0x15],
    ['MALFORMED_AUTH_TOKEN', 0x16],
    ['UNKNOWN_AUTH_TOKEN_ALIAS', 0x17],
    ['EXPIRED_AUTH_TOKEN', 0x18],
    ['INVALID_AUTHORITY', 0x19],
    ['MALFORMED_AUTHORITY', 0x1a],
  ]

  for (const [name, code] of expected) {
    it(`${name} = 0x${code.toString(16)}`, () => {
      expect(
        SessionTerminationError[name as keyof typeof SessionTerminationError],
      ).toBe(code)
    })
  }

  it('has exactly 21 error codes', () => {
    const values = Object.values(SessionTerminationError).filter(
      (v) => typeof v === 'number',
    )
    expect(values).toHaveLength(21)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// SUBSCRIBE_ERROR Codes (§13.1.2, Table 9)
// ═══════════════════════════════════════════════════════════════════════

describe('SUBSCRIBE_ERROR Codes (Table 9)', () => {
  const expected: [string, number][] = [
    ['INTERNAL_ERROR', 0x0],
    ['UNAUTHORIZED', 0x1],
    ['TIMEOUT', 0x2],
    ['NOT_SUPPORTED', 0x3],
    ['TRACK_DOES_NOT_EXIST', 0x4],
    ['INVALID_RANGE', 0x5],
    ['MALFORMED_AUTH_TOKEN', 0x10],
    ['EXPIRED_AUTH_TOKEN', 0x12],
  ]

  for (const [name, code] of expected) {
    it(`${name} = 0x${code.toString(16)}`, () => {
      expect(SubscribeErrorCode[name as keyof typeof SubscribeErrorCode]).toBe(
        code,
      )
    })
  }

  it('has exactly 8 error codes', () => {
    const values = Object.values(SubscribeErrorCode).filter(
      (v) => typeof v === 'number',
    )
    expect(values).toHaveLength(8)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// PUBLISH_DONE Codes (§13.1.3, Table 10)
// ═══════════════════════════════════════════════════════════════════════

describe('PUBLISH_DONE Codes (Table 10)', () => {
  const expected: [string, number][] = [
    ['INTERNAL_ERROR', 0x0],
    ['UNAUTHORIZED', 0x1],
    ['TRACK_ENDED', 0x2],
    ['SUBSCRIPTION_ENDED', 0x3],
    ['GOING_AWAY', 0x4],
    ['EXPIRED', 0x5],
    ['TOO_FAR_BEHIND', 0x6],
    ['MALFORMED_TRACK', 0x7],
  ]

  for (const [name, code] of expected) {
    it(`${name} = 0x${code.toString(16)}`, () => {
      expect(PublishDoneCode[name as keyof typeof PublishDoneCode]).toBe(code)
    })
  }

  it('has exactly 8 status codes', () => {
    const values = Object.values(PublishDoneCode).filter(
      (v) => typeof v === 'number',
    )
    expect(values).toHaveLength(8)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// PUBLISH_ERROR Codes (§13.1.4, Table 11)
// ═══════════════════════════════════════════════════════════════════════

describe('PUBLISH_ERROR Codes (Table 11)', () => {
  const expected: [string, number][] = [
    ['INTERNAL_ERROR', 0x0],
    ['UNAUTHORIZED', 0x1],
    ['TIMEOUT', 0x2],
    ['NOT_SUPPORTED', 0x3],
    ['UNINTERESTED', 0x4],
  ]

  for (const [name, code] of expected) {
    it(`${name} = 0x${code.toString(16)}`, () => {
      expect(PublishErrorCode[name as keyof typeof PublishErrorCode]).toBe(code)
    })
  }

  it('has exactly 5 error codes', () => {
    const values = Object.values(PublishErrorCode).filter(
      (v) => typeof v === 'number',
    )
    expect(values).toHaveLength(5)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// FETCH_ERROR Codes (§13.1.5, Table 12)
// ═══════════════════════════════════════════════════════════════════════

describe('FETCH_ERROR Codes (Table 12)', () => {
  const expected: [string, number][] = [
    ['INTERNAL_ERROR', 0x0],
    ['UNAUTHORIZED', 0x1],
    ['TIMEOUT', 0x2],
    ['NOT_SUPPORTED', 0x3],
    ['TRACK_DOES_NOT_EXIST', 0x4],
    ['INVALID_RANGE', 0x5],
    ['NO_OBJECTS', 0x6],
    ['INVALID_JOINING_REQUEST_ID', 0x7],
    ['UNKNOWN_STATUS_IN_RANGE', 0x8],
    ['MALFORMED_TRACK', 0x9],
    ['MALFORMED_AUTH_TOKEN', 0x10],
    ['EXPIRED_AUTH_TOKEN', 0x12],
  ]

  for (const [name, code] of expected) {
    it(`${name} = 0x${code.toString(16)}`, () => {
      expect(FetchErrorCode[name as keyof typeof FetchErrorCode]).toBe(code)
    })
  }

  it('has exactly 12 error codes', () => {
    const values = Object.values(FetchErrorCode).filter(
      (v) => typeof v === 'number',
    )
    expect(values).toHaveLength(12)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// ANNOUNCE_ERROR / PUBLISH_NAMESPACE_ERROR Codes (§13.1.6, Table 13)
// ═══════════════════════════════════════════════════════════════════════

describe('ANNOUNCE_ERROR Codes (Table 13)', () => {
  const expected: [string, number][] = [
    ['INTERNAL_ERROR', 0x0],
    ['UNAUTHORIZED', 0x1],
    ['TIMEOUT', 0x2],
    ['NOT_SUPPORTED', 0x3],
    ['UNINTERESTED', 0x4],
    ['MALFORMED_AUTH_TOKEN', 0x10],
    ['EXPIRED_AUTH_TOKEN', 0x12],
  ]

  for (const [name, code] of expected) {
    it(`${name} = 0x${code.toString(16)}`, () => {
      expect(AnnounceErrorCode[name as keyof typeof AnnounceErrorCode]).toBe(
        code,
      )
    })
  }

  it('has exactly 7 error codes', () => {
    const values = Object.values(AnnounceErrorCode).filter(
      (v) => typeof v === 'number',
    )
    expect(values).toHaveLength(7)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// SUBSCRIBE_NAMESPACE_ERROR Codes (§13.1.7, Table 14)
// ═══════════════════════════════════════════════════════════════════════

describe('SUBSCRIBE_NAMESPACE_ERROR Codes (Table 14)', () => {
  const expected: [string, number][] = [
    ['INTERNAL_ERROR', 0x0],
    ['UNAUTHORIZED', 0x1],
    ['TIMEOUT', 0x2],
    ['NOT_SUPPORTED', 0x3],
    ['NAMESPACE_PREFIX_UNKNOWN', 0x4],
    ['NAMESPACE_PREFIX_OVERLAP', 0x5],
    ['MALFORMED_AUTH_TOKEN', 0x10],
    ['EXPIRED_AUTH_TOKEN', 0x12],
  ]

  for (const [name, code] of expected) {
    it(`${name} = 0x${code.toString(16)}`, () => {
      expect(
        SubscribeNamespaceErrorCode[
          name as keyof typeof SubscribeNamespaceErrorCode
        ],
      ).toBe(code)
    })
  }

  it('has exactly 8 error codes', () => {
    const values = Object.values(SubscribeNamespaceErrorCode).filter(
      (v) => typeof v === 'number',
    )
    expect(values).toHaveLength(8)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Data Stream Reset Error Codes (§13.1.8, Table 15)
// ═══════════════════════════════════════════════════════════════════════

describe('Data Stream Reset Error Codes (Table 15)', () => {
  const expected: [string, number][] = [
    ['INTERNAL_ERROR', 0x0],
    ['CANCELLED', 0x1],
    ['DELIVERY_TIMEOUT', 0x2],
    ['SESSION_CLOSED', 0x3],
  ]

  for (const [name, code] of expected) {
    it(`${name} = 0x${code.toString(16)}`, () => {
      expect(
        DataStreamResetError[name as keyof typeof DataStreamResetError],
      ).toBe(code)
    })
  }

  it('has exactly 4 error codes', () => {
    const values = Object.values(DataStreamResetError).filter(
      (v) => typeof v === 'number',
    )
    expect(values).toHaveLength(4)
  })
})
