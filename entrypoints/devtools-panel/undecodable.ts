/**
 * A control message that did not decode because it carries a Message
 * Parameter its draft does not define, worded as what the bytes show: which
 * message, which parameter, who sent it and the rule. Every other decode
 * failure keeps `@moqtap/inspect`'s wording.
 */

import { decodeErrorReason } from '@/src/trace/decode-error'
import { controlMessageName } from '@/src/trace/message-name'
import { messageTypeName } from './format'
import { moqtSpec, type PanelProblem } from './problems'
import type { MessageEntry, StreamEntry } from './use-inspector'

const RULE_17 =
  'All Message Parameters MUST be defined in the negotiated version of MOQT or negotiated via Setup Options. An endpoint that receives an unknown Message Parameter MUST close the session with PROTOCOL_VIOLATION.'

/** The section stating it, checked in each draft's text; drafts before 16 have no such rule. */
const PARAMETER_RULE: Record<string, { section: string; quote: string }> = {
  '16': { section: '9.2', quote: RULE_17.replace('Setup Options', 'Setup Parameters') },
  '17': { section: '9.3', quote: RULE_17 },
  '18': { section: '10.2', quote: RULE_17 },
  '19': { section: '10.2', quote: RULE_17 },
  '20': { section: '10.2', quote: RULE_17 },
  '21': { section: '9.20', quote: RULE_17 },
  '22': { section: '9.20', quote: RULE_17 },
}

/** The value of the QUIC varint `bytes` opens with, or null when it is cut short. */
function leadingVarint(bytes: Uint8Array): number | null {
  if (bytes.length === 0) return null
  const len = 1 << (bytes[0]! >> 6)
  if (bytes.length < len) return null
  let v = bytes[0]! & 0x3f
  for (let i = 1; i < len; i++) v = v * 256 + bytes[i]!
  return v
}

/** Bytes as hex, 16 to a line. */
export function hexLines(bytes: Uint8Array): string {
  const lines: string[] = []
  for (let i = 0; i < bytes.length; i += 16) {
    lines.push(Array.from(bytes.subarray(i, i + 16), (b) => b.toString(16).padStart(2, '0')).join(' '))
  }
  return lines.join('\n')
}

export interface UndecodableContext {
  draft: string | undefined
  streams: ReadonlyMap<number, Pick<StreamEntry, 'direction'>>
  messages: readonly MessageEntry[]
}

/**
 * Who sent the bytes: the entry's own direction, or on a draft-17+ request
 * stream whose first message they are, the side that opened the stream (a
 * request stream opens with its request).
 */
function senderOf(message: MessageEntry, ctx: UndecodableContext): 'page' | 'relay' | null {
  const side = (d: 'tx' | 'rx') => (d === 'tx' ? 'page' : 'relay')
  if (message.direction) return side(message.direction)
  const id = message.streamId
  if (id === undefined || Number(ctx.draft) < 17) return null
  const onStream = ctx.messages.filter((m) => m.streamId === id)
  if (onStream[0] !== message || onStream.some((m) => m.messageType === 'setup')) return null
  const stream = ctx.streams.get(id)
  return stream ? side(stream.direction) : null
}

/** The row's wording for a message with a parameter its draft does not define; null for any other failure. */
export function undefinedParameter(
  message: MessageEntry,
  ctx: UndecodableContext,
): Partial<PanelProblem> | null {
  const draft = ctx.draft
  const rule = draft ? PARAMETER_RULE[draft] : undefined
  const param = /Unknown Message Parameter type (0x[0-9a-f]+)/i.exec(decodeErrorReason(message.decoded))?.[1]
  const type = leadingVarint(message.raw)
  if (!rule || !param || type === null) return null
  const name = controlMessageName(type, draft)
  if (name.startsWith('0x')) return null
  const shown = messageTypeName(name)
  const negotiated = draft === '16' ? 'a Setup Parameter' : 'a Setup Option'
  return {
    id: 'session.parameter.undefined',
    family: `session.parameter.undefined|${name}|${param.toLowerCase()}`,
    title: `${shown} carries parameter ${param}, which draft-${draft} doesn't define`,
    found: `Parameter type ${param} in ${shown}`,
    expected: `Parameters draft-${draft} defines, or ones negotiated with ${negotiated}`,
    remedy: `Remove parameter ${param} from ${shown}, or negotiate it with ${negotiated}`,
    spec: moqtSpec({ revision: draft!, ...rule }),
    sender: senderOf(message, ctx),
    evidence: message.raw.length > 0 ? hexLines(message.raw) : null,
  }
}
