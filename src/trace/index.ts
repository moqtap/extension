/**
 * Trace recording for the WebTransport Inspector extension.
 *
 * Wraps @moqtap/trace with extension-specific defaults.
 * The recorder captures control messages and state transitions
 * for export as .moqtrace files.
 */

import { createRecorder } from '@moqtap/trace'
import type { SupportedDraft } from '../types/common'
import { traceSource } from './source'

/**
 * The first datagram's `"sid"`; each later one takes the next. SPEC.md
 * "`"sid"` — the stream ID": at least 2^62, which no QUIC stream ID reaches
 * (RFC 9000 Section 2.1).
 */
export const DATAGRAM_SID_BASE = 1n << 62n

/**
 * Create a trace recorder configured for the extension's observer role.
 *
 * @param draft - The detected MoQT draft version
 * @param endpoint - Optional remote peer URI for trace metadata
 */
export function createExtensionRecorder(
  draft: SupportedDraft,
  endpoint?: string,
) {
  return createRecorder({
    protocol: `moq-transport-${draft}`,
    perspective: 'observer',
    detail: 'headers',
    source: traceSource(),
    endpoint,
  })
}
