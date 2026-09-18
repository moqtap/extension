/**
 * The bytes a draft-17+ unidirectional control stream opens with.
 *
 * SETUP is message type `0x2F00`. Draft-17 replaced the RFC 9000 integer with
 * MoQT's own varint (Section 1.4.1), so the type is written `af 00`. `6f 00` is
 * what RFC 9000 would produce, and reading it the wrong way round yields a
 * plausible number rather than an error — which is why getting this wrong is
 * silent.
 *
 * This lives in its own module, free of imports, for two reasons. It is used by
 * the content script, which is injected into the page and must not pull in the
 * per-draft codec tables that `control-streams.ts` needs. And it is where
 * the content script gets those bytes instead of hand-writing a second copy: a
 * copy that encoded the type the RFC 9000 way would match no draft-17+ control
 * stream at all, so the whole SETUP exchange would be filed as bulk media and
 * evicted on a busy session. One definition, one test, no drift.
 *
 * Drafts <= 16 do not need this: their control stream is bidirectional, so the
 * `bidi` flag already identifies it and no unidirectional control stream exists.
 */
export const UNI_CONTROL_STREAM_PREFIX: readonly number[] = [0xaf, 0x00]

/** Whether a stream's first bytes are a draft-17+ SETUP, i.e. a control stream. */
export function opensUniControlStream(data: ArrayBuffer | string): boolean {
  if (!(data instanceof ArrayBuffer)) return false
  if (data.byteLength < UNI_CONTROL_STREAM_PREFIX.length) return false
  const head = new Uint8Array(data, 0, UNI_CONTROL_STREAM_PREFIX.length)
  return UNI_CONTROL_STREAM_PREFIX.every((b, i) => head[i] === b)
}
