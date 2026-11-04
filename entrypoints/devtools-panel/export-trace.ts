/**
 * What the toolbar's Export writes. SPEC.md "Privacy Considerations" says of
 * payload-bearing events and fields: "recorders MUST NOT enable it by default
 * and SHOULD require explicit operator opt-in per session or per track", so
 * the first choice, and the default, leaves them out.
 */

import type { Trace } from '@moqtap/trace'
import { redactTrace } from './redact-trace'

export interface ExportChoice {
  readonly label: string
  readonly payloads: boolean
}

/** In menu order; the first is the default. */
export const EXPORT_CHOICES: readonly ExportChoice[] = [
  { label: 'Export without payloads', payloads: false },
  { label: 'Export with payloads', payloads: true },
]

/**
 * The trace as built, or without payloads: the share dialog's payloads-off
 * redaction and nothing else. Auth stays as the trace holds it, and the
 * detail level comes from src/trace/detail.ts.
 */
export function exportedTrace(
  trace: Trace,
  payloads: boolean,
  draft: string | null,
  controlStreams: ReadonlySet<bigint>,
): Promise<Trace> {
  if (payloads) return Promise.resolve(trace)
  return redactTrace(trace, { payloads: false, auth: true }, draft, controlStreams)
}
