/**
 * Common types used across the moqtap extension.
 */

/** Direction of a message (sent or received) */
export enum Direction {
  Tx = 'tx',
  Rx = 'rx',
}

/** Supported draft identifiers */
export type SupportedDraft =
  | '07'
  | '08'
  | '09'
  | '10'
  | '11'
  | '12'
  | '13'
  | '14'
  | '15'
  | '16'
  | '17'

// Re-export codec result types for extension consumers
export { DecodeError } from '@moqtap/codec'
export type { DecodeErrorCode, DecodeResult } from '@moqtap/codec'

// Re-export message types from both drafts
export type { MoqtMessage, MoqtMessageType } from '@moqtap/codec'
export type { Draft14Message, Draft14MessageType } from '@moqtap/codec/draft14'
