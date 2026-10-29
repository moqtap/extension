import { describe, expect, it } from 'vitest'
import { connectionHost, connectionName, connectionTitle } from './connection-name'
import { formatClock } from './format'

describe('connectionName', () => {
  it('names a connection by host, port and short id', () => {
    expect(connectionName({ url: 'https://relay.example:8245/moq?x=1', sessionId: 'wt-1730000000-1' })).toBe(
      'relay.example:8245 #1',
    )
    expect(connectionName({ url: 'https://relay.example/moq', sessionId: 'wt-1730000000-12' })).toBe(
      'relay.example #12',
    )
  })

  it('keeps a value that is not a URL', () => {
    expect(connectionName({ url: 'relay', sessionId: 'imp-abcdef12' })).toBe('relay #abcd')
  })
})

describe('connectionHost', () => {
  it('is the host and port alone, for a slot that ellipsizes it before the short id', () => {
    expect(connectionHost('https://relay.example:8245/moq')).toBe('relay.example:8245')
    expect(connectionHost('https://relay.example/moq')).toBe('relay.example')
    expect(connectionHost('relay')).toBe('relay')
  })
})

describe('connectionTitle', () => {
  const base = { url: 'https://relay.example/moq', closed: false, createdAt: 1_730_000_000_000, streams: 3 }

  it('spells out the protocol, state, start and streams', () => {
    expect(connectionTitle({ ...base, protocol: 'moqt', draft: 14 })).toBe(
      `https://relay.example/moq\nMoQT draft-14 · open\nOpened ${formatClock(base.createdAt)} · 3 streams`,
    )
  })

  it('names imports, closed connections, other protocols and iframes', () => {
    const t = connectionTitle({ ...base, protocol: 'webtransport', closed: true, imported: true, frameId: 7, streams: 1 })
    expect(t.split('\n').slice(1)).toEqual([
      'WebTransport · imported',
      `Opened ${formatClock(base.createdAt)} · 1 stream`,
      'In an iframe',
    ])
  })
})
