import { describe, expect, it } from 'vitest'
import {
  formatBitrate,
  formatBytes,
  formatCount,
  formatDuration,
  formatOffset,
  messageTypeName,
  plural,
  shortId,
  shortSessionId,
} from './format'

const t = (s: string) => s.replaceAll('\u2009', ' ')

describe('format', () => {
  it('writes sizes in decimal units, one decimal below 100', () => {
    expect(t(formatBytes(812))).toBe('812 B')
    expect(t(formatBytes(999))).toBe('999 B')
    expect(t(formatBytes(1434))).toBe('1.4 kB')
    expect(t(formatBytes(376_600))).toBe('377 kB')
    expect(t(formatBytes(999_960))).toBe('1.0 MB')
    expect(t(formatBytes(12_000_000))).toBe('12.0 MB')
    expect(t(formatBytes(3e9))).toBe('3.0 GB')
  })

  it('writes durations at the scale that reads', () => {
    expect(t(formatDuration(0.42))).toBe('0.42 ms')
    expect(t(formatDuration(18))).toBe('18 ms')
    expect(t(formatDuration(1250))).toBe('1.25 s')
    expect(t(formatDuration(999.7))).toBe('1.00 s')
    expect(t(formatDuration(192_000))).toBe('3.2 min')
    expect(t(formatDuration(450_000))).toBe('7.5 min')
    expect(t(formatDuration(59.99 * 60_000))).toBe('1.0 h')
    expect(t(formatDuration(5_400_000))).toBe('1.5 h')
  })

  it('writes times relative to the session start', () => {
    expect(formatOffset(1_284, 0)).toBe('+00:01.284')
    expect(formatOffset(1000 + 61_005, 1000)).toBe('+01:01.005')
    expect(formatOffset(0, 50)).toBe('+00:00.000')
  })

  it('separates thousands and pluralises', () => {
    expect(formatCount(12480)).toBe('12,480')
    expect(plural(12480, 'object')).toBe('12,480 objects')
    expect(plural(1, 'stream')).toBe('1 stream')
  })

  it('writes bit rates in decimal units', () => {
    expect(t(formatBitrate(2_500_000))).toBe('2.5 Mbps')
    expect(t(formatBitrate(64_000))).toBe('64 kbps')
    expect(t(formatBitrate(12))).toBe('12 bps')
  })

  it('derives a short connection ID', () => {
    expect(shortSessionId('wt-1729000000000-3')).toBe('#3')
    expect(shortSessionId('imported-1729000000000-k3x9ab')).toBe('#k3x9')
  })
})

describe('messageTypeName', () => {
  it('writes message types in the draft spelling', () => {
    expect(messageTypeName('subscribe_ok')).toBe('SUBSCRIBE_OK')
    expect(messageTypeName('0x40')).toBe('0x40')
  })

  it('shows IDs of 20 characters or fewer whole, longer ones as 8…8', () => {
    expect(shortId('wt-1729000000000-3')).toBe('wt-1729000000000-3')
    expect(shortId('7f3a91c0d2e4b6a8e2b4')).toBe('7f3a91c0d2e4b6a8e2b4')
    expect(shortId('7f3a91c0d2e4b6a8e2b4c91e')).toBe('7f3a91c0…e2b4c91e')
  })
})
