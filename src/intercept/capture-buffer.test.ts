import { describe, expect, it } from 'vitest'
import type { ContentToBackgroundMsg } from '@/src/messaging/types'
import { CaptureBuffer, MAX_DATA_BUFFER, MAX_LIFECYCLE_BUFFER } from './capture-buffer'

const opened = (n: number) =>
  ({ type: 'session:opened', sessionId: `s${n}`, url: 'https://x/', createdAt: n }) as unknown as ContentToBackgroundMsg
const closed = (n: number) => ({ type: 'session:closed', sessionId: `s${n}` }) as unknown as ContentToBackgroundMsg
const media = (n: number) =>
  ({ type: 'stream:data', sessionId: 's0', streamId: n, direction: 'rx', bidi: false, data: new ArrayBuffer(4) }) as unknown as ContentToBackgroundMsg

describe('CaptureBuffer', () => {
  it('drains in arrival order and reports nothing missed when nothing was dropped', () => {
    const b = new CaptureBuffer()
    b.push(opened(1))
    b.push(media(1))
    b.push(closed(1))
    expect(b.drain().map((m) => m.type)).toEqual(['session:opened', 'stream:data', 'session:closed'])
    expect(b.drain()).toEqual([])
  })

  it('dropped media is not a missed connection', () => {
    const b = new CaptureBuffer()
    b.push(opened(1))
    for (let i = 0; i < MAX_DATA_BUFFER + 50; i++) b.push(media(i))
    const out = b.drain()
    expect(out.some((m) => m.type === 'capture:missed')).toBe(false)
    expect(out.filter((m) => m.type === 'stream:data')).toHaveLength(MAX_DATA_BUFFER)
  })

  it('counts each dropped session:opened, and only those', () => {
    const b = new CaptureBuffer()
    b.push(opened(1))
    b.push(opened(2))
    b.push(closed(1))
    for (let i = 0; i < MAX_LIFECYCLE_BUFFER - 1; i++) b.push(closed(100 + i))
    const out = b.drain()
    expect(out.at(-1)).toEqual({ type: 'capture:missed', connections: 2 })
    expect(out.filter((m) => m.type === 'session:opened')).toHaveLength(0)
  })

  it('starts counting again after a drain', () => {
    const b = new CaptureBuffer()
    b.push(opened(1))
    for (let i = 0; i < MAX_LIFECYCLE_BUFFER; i++) b.push(closed(i))
    expect(b.drain().at(-1)).toEqual({ type: 'capture:missed', connections: 1 })
    b.push(opened(2))
    expect(b.drain().some((m) => m.type === 'capture:missed')).toBe(false)
  })
})
