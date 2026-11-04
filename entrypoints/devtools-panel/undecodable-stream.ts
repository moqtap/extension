/**
 * A data stream's bytes that do not decode under the session's draft, as the
 * stream view names them: a live stream as it reads now, an imported one as
 * its trace recorded them.
 */

import { plural } from './format'
import type { SourceUndecodable } from './loc'
import {
  type ParsedStreamFraming,
  parseStreamFraming,
  readStream,
} from './stream-framing'
import type { ImportedFraming, RecordedUndecodable } from './use-inspector'

export interface UndecodableNotice {
  /** Where the bytes start in the stream's data; null when they are not in it */
  offset: number | null
  title: string
  reason: string
  /** The bytes the trace kept outside the stream's data */
  raw?: Uint8Array
}

/** The codec's reason as a sentence. */
export function sentence(reason: string): string {
  const text = reason.charAt(0).toUpperCase() + reason.slice(1)
  return /[.!?]$/.test(text) ? text : `${text}.`
}

/** `length` bytes at `offset` that do not decode, in words. */
export function heldTitle(length: number, offset: number): string {
  const verb = length === 1 ? "doesn't" : "don't"
  return `${plural(length, 'byte')} at offset 0x${offset.toString(16)} ${verb} decode`
}

/** A track's stream bytes that do not decode, one sentence pair per stream. */
export function sourcesText(list: readonly SourceUndecodable[]): string {
  return list
    .map((u) => `Stream ${u.source.slice(2)}: ${heldTitle(u.length, u.offset)}. ${sentence(u.reason)}`)
    .join(' ')
}

/**
 * The stream's objects and its bytes that do not decode. `complete` says the
 * bytes are the whole stream: it ended with a FIN and every byte is here.
 */
export function undecodableNotice(
  data: Uint8Array,
  draft: string | undefined,
  options: {
    complete: boolean
    importedFraming?: ImportedFraming
    recorded?: RecordedUndecodable
  },
): { framing: ParsedStreamFraming | null; undecodable: UndecodableNotice | null } {
  const { recorded, importedFraming } = options
  if (recorded) {
    const end = recorded.offset ?? data.length
    const framing =
      importedFraming === 'unavailable'
        ? null
        : readStream(data.subarray(0, end), draft, { complete: true }).framing
    const length = recorded.length ?? (recorded.offset !== null ? data.length - end : null)
    const held = data.length - end
    const title =
      recorded.offset !== null && length !== null
        ? heldTitle(length, recorded.offset) +
          (length > held ? `; the trace kept ${plural(held, 'byte')}` : '')
        : `The trace records ${length !== null ? plural(length, 'byte') : 'bytes'} on this stream that didn't decode`
    return {
      framing,
      undecodable: {
        offset: recorded.offset,
        title,
        reason: sentence(recorded.reason),
        ...(recorded.raw ? { raw: recorded.raw } : {}),
      },
    }
  }
  // Payloads alone: the stream's framing is not in them.
  if (importedFraming === 'unavailable')
    return { framing: parseStreamFraming(data, draft), undecodable: null }
  const read = readStream(data, draft, { complete: options.complete })
  const run = read.undecodable
  return {
    framing: read.framing,
    undecodable: run && {
      offset: run.offset,
      title: heldTitle(run.length, run.offset),
      reason: sentence(run.reason),
    },
  }
}
