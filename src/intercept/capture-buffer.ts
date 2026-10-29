/**
 * What the content script holds until a DevTools panel activates its tab.
 *
 * Split three ways rather than one shared FIFO, because a high-bitrate session
 * produces hundreds of stream:data events per second and would otherwise evict
 * everything that makes the session interpretable within seconds:
 *
 *   1. Lifecycle — session:opened and friends. Losing session:opened makes the
 *      background drop every later event for that session, so the panel shows
 *      nothing at all.
 *   2. Control plane — what lets the panel name a draft and reconstruct track
 *      state. Every MoQT draft from 07 to 19 states "Objects are sent on
 *      unidirectional streams", so bidirectional streams are always control:
 *      the control stream through draft-16, and per-request streams from
 *      draft-17 on. Draft-17 also moved the control stream itself to a pair
 *      of *unidirectional* streams (§3.4, stream type 0x2F00), so those are
 *      admitted by their opening bytes rather than their direction.
 *      Keeping only the first few events would recover the SETUP exchange but
 *      not the track mapping, so this is budgeted by bytes instead. A whole
 *      session's control plane is a few kilobytes (~150 B of SETUP, ~100 B per
 *      track), so the budget below is generous by orders of magnitude while
 *      still holding less memory than the bulk buffer.
 *   3. Bulk — media on unidirectional streams and datagrams. Genuinely
 *      unbounded, and the least valuable per byte, so it stays a small FIFO.
 *
 * Tier 2 is also capped by entry count: a page writing tiny chunks to a bidi
 * stream would otherwise build a huge array well under the byte budget.
 */

import { opensUniControlStream } from '@/src/detect/uni-control-prefix'
import type { ContentToBackgroundMsg } from '@/src/messaging/types'

export const MAX_LIFECYCLE_BUFFER = 500
export const MAX_CONTROL_BUFFER = 2000
export const MAX_CONTROL_BYTES = 256 * 1024
export const MAX_DATA_BUFFER = 500

interface BufferedMsg {
  seq: number
  msg: ContentToBackgroundMsg
  /** Payload size, for the byte-budgeted control buffer */
  bytes: number
}

/** Byte size of a message's payload, or 0 for messages that carry none */
function payloadBytes(msg: ContentToBackgroundMsg): number {
  if (msg.type !== 'stream:data' && msg.type !== 'datagram:data') return 0
  return msg.data instanceof ArrayBuffer ? msg.data.byteLength : msg.data.length
}

/*
 * `opensUniControlStream` is matched per chunk rather than per stream to keep
 * the content script free of per-stream bookkeeping on a hot path. A media
 * chunk that happens to open with these two bytes is admitted too; the byte
 * budget absorbs it, and real control data is orders of magnitude smaller.
 */
function isControlPlane(msg: ContentToBackgroundMsg): boolean {
  if (msg.type !== 'stream:data') return false
  return msg.bidi === true || opensUniControlStream(msg.data)
}

export class CaptureBuffer {
  private seq = 0
  private lifecycle: BufferedMsg[] = []
  private control: BufferedMsg[] = []
  private controlBytes = 0
  private data: BufferedMsg[] = []
  /** Connections whose session:opened was dropped: the panel never sees them. */
  private missed = 0

  push(msg: ContentToBackgroundMsg): void {
    const entry: BufferedMsg = { seq: this.seq++, msg, bytes: payloadBytes(msg) }
    if (isControlPlane(msg)) {
      this.control.push(entry)
      this.controlBytes += entry.bytes
      while (this.control.length > MAX_CONTROL_BUFFER || this.controlBytes > MAX_CONTROL_BYTES) {
        const dropped = this.control.shift()
        if (!dropped) break
        this.controlBytes -= dropped.bytes
      }
    } else if (msg.type === 'stream:data' || msg.type === 'datagram:data') {
      // Includes bidi === undefined: a stream of no known class is bulk.
      // Datagrams never carry control messages.
      this.data.push(entry)
      if (this.data.length > MAX_DATA_BUFFER) this.data.shift()
    } else {
      this.lifecycle.push(entry)
      if (this.lifecycle.length > MAX_LIFECYCLE_BUFFER) {
        if (this.lifecycle.shift()?.msg.type === 'session:opened') this.missed++
      }
    }
  }

  /** Every held message in arrival order, then a capture:missed when connections were lost. */
  drain(): ContentToBackgroundMsg[] {
    // Each buffer is already ordered; sorting the union is simpler than an
    // n-way merge and the combined length is capped in the low thousands.
    const pending = [...this.lifecycle, ...this.control, ...this.data].sort((a, b) => a.seq - b.seq)
    const out = pending.map((e) => e.msg)
    if (this.missed > 0) out.push({ type: 'capture:missed', connections: this.missed })
    this.lifecycle = []
    this.control = []
    this.data = []
    this.controlBytes = 0
    this.missed = 0
    return out
  }
}
