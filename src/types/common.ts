/**
 * The MoQT drafts this build has tables and a codec for, oldest first.
 *
 * A runtime array rather than a bare union so code that has to check a string
 * from outside the type system — a draft read out of a trace header, a draft
 * number parsed from a `moqt-NN` protocol string — can narrow it without
 * pulling in the codec. `src/codec/message-ids.ts` keys a `Record` by this
 * type, so a draft added here fails to compile until its tables are wired up.
 */
export const SUPPORTED_DRAFTS = [
  '07',
  '08',
  '09',
  '10',
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
  '20',
  '21',
] as const

export type SupportedDraft = (typeof SUPPORTED_DRAFTS)[number]

/** Whether a draft string is one this build supports. */
export function isSupportedDraft(draft: string): draft is SupportedDraft {
  return (SUPPORTED_DRAFTS as readonly string[]).includes(draft)
}
