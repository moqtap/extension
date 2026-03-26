/**
 * MoQT session state machine — delegates to @moqtap/codec.
 *
 * The extension observes session state by feeding decoded control messages
 * into the codec's session FSM via receive(). The FSM tracks phase
 * (idle → setup → ready → draining → closed), validates message sequences,
 * and manages subscription/fetch state.
 */

import { createSessionState } from '@moqtap/codec/session';
import { getCodec } from '../codec/control-message';
import type { SupportedDraft } from '../types/common';

// Re-export session types from the codec
export type {
  SessionPhase,
  SessionState,
  SessionStateOptions,
  TransitionResult,
  ValidationResult,
  ProtocolViolation,
  ProtocolViolationCode,
  SideEffect,
  SubscriptionPhase,
  SubscriptionState,
  FetchPhase,
  FetchState,
} from '@moqtap/codec/session';

/**
 * Create a session state machine for the detected draft.
 *
 * The extension always acts as an observer, but the FSM needs a role
 * to determine legal message directions. Use 'client' since we're
 * watching from the client's perspective.
 */
export function createExtensionSession(
  draft: SupportedDraft,
  role: 'client' | 'server' = 'client',
) {
  const codec = getCodec(draft);
  return createSessionState({ codec, role });
}
