/**
 * Trace recording for the WebTransport Inspector extension.
 *
 * Wraps @moqtap/trace with extension-specific defaults.
 * The recorder captures control messages and state transitions
 * for export as .moqtrace files.
 */

import { createRecorder } from '@moqtap/trace';
import type { SupportedDraft } from '../types/common';

// Re-export trace utilities
export { writeMoqtrace, readMoqtrace, readMoqtraceHeader, traceToJSON } from '@moqtap/trace';
export { createMoqtraceWriter } from '@moqtap/trace';
export type {
  Trace,
  TraceHeader,
  TraceEvent,
  ControlMessageEvent,
  StreamOpenedEvent,
  StreamClosedEvent,
  ObjectHeaderEvent,
  ObjectPayloadEvent,
  StateChangeEvent,
  AnnotationEvent,
  DetailLevel,
  Perspective,
  RecorderOptions,
  TraceRecorder,
} from '@moqtap/trace';

/**
 * Create a trace recorder configured for the extension's observer role.
 *
 * @param draft - The detected MoQT draft version
 * @param endpoint - Optional remote peer URI for trace metadata
 */
export function createExtensionRecorder(draft: SupportedDraft, endpoint?: string) {
  return createRecorder({
    protocol: `moq-transport-${draft}`,
    perspective: 'observer',
    detail: 'headers',
    source: 'moqtap-extension/0.1.0',
    endpoint,
  });
}
