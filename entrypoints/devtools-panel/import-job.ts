/**
 * A .moqtrace import run in a worker: the file is decoded and rebuilt as a
 * session there, with progress posted as it goes, and the result handed back
 * with its byte buffers transferred rather than copied.
 */

import {
  createMoqtraceReader,
  type ReadItem,
  type TraceEvent,
  type TraceHeader,
} from '@moqtap/trace'
import { type ImportedSession, sessionFromTrace } from './import-trace'
// WXT defines import.meta.url as self.location.href, which hides the
// `new Worker(new URL(...))` form from Vite; the ?worker import still bundles it.
import ImportTraceWorker from './import-trace.worker.ts?worker'

/** Bytes decoded between progress reports */
export const CHUNK_SIZE = 1 << 20

export interface ImportRequest {
  file: Blob
  filename: string
}

export type ImportReply =
  | { type: 'progress'; loaded: number; total: number }
  /** `colors`: how many track colours the session took, numbered from 0 */
  | { type: 'done'; result: ImportedSession; colors: number }
  | { type: 'error'; message: string }

export interface ImportResult extends ImportedSession {
  colors: number
}

/**
 * The trace's header and its events, decoded a chunk at a time as the events
 * are taken; `onProgress` is told the bytes decoded after each chunk.
 */
export function decodeInChunks(
  bytes: Uint8Array,
  onProgress: (loaded: number, total: number) => void,
  chunkSize = CHUNK_SIZE,
): { header: TraceHeader; events: Iterable<TraceEvent> } {
  const reader = createMoqtraceReader()
  let offset = 0
  let ended = false
  let header: TraceHeader | undefined
  let queued: TraceEvent[] = []

  const take = (items: ReadItem[]) => {
    for (const item of items) {
      if (item.kind === 'event') queued.push(item.event)
      // A segmented trace reads as one, under its first header.
      else header ??= item.header
    }
  }
  const step = () => {
    if (offset >= bytes.length) {
      ended = true
      take(reader.end())
      return
    }
    const next = Math.min(offset + chunkSize, bytes.length)
    take(reader.push(bytes.subarray(offset, next)))
    offset = next
    onProgress(offset, bytes.length)
  }

  while (!header && !ended) step()
  if (!header) throw new Error('Invalid magic bytes: not a .moqtrace file')

  function* events(): Generator<TraceEvent> {
    for (;;) {
      const batch = queued
      queued = []
      yield* batch
      if (ended) return
      step()
    }
  }
  return { header, events: events() }
}

/** Read and rebuild one file, posting progress and then the result or the error. */
export async function runImport(
  request: ImportRequest,
  post: (reply: ImportReply, transfer?: Transferable[]) => void,
  chunkSize = CHUNK_SIZE,
): Promise<void> {
  try {
    const bytes = new Uint8Array(await request.file.arrayBuffer())
    post({ type: 'progress', loaded: 0, total: bytes.length })
    const trace = decodeInChunks(
      bytes,
      (loaded, total) => post({ type: 'progress', loaded, total }),
      chunkSize,
    )
    let colors = 0
    const result = sessionFromTrace(trace, {
      sessionId: '',
      filename: request.filename,
      nextColorIndex: () => colors++,
    })
    post({ type: 'done', result, colors }, transferables(result))
  } catch (err) {
    post({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

function transferables(result: ImportedSession): Transferable[] {
  const buffers = new Set<ArrayBuffer>()
  for (const data of result.streamData.values()) addBuffer(buffers, data)
  for (const data of result.datagramData.values()) addBuffer(buffers, data)
  return [...buffers]
}

function addBuffer(buffers: Set<ArrayBuffer>, data: Uint8Array): void {
  if (data.buffer instanceof ArrayBuffer && data.buffer.byteLength > 0)
    buffers.add(data.buffer)
}

/** What the panel needs of a worker; a fake stands in for it in tests. */
export interface ImportWorker {
  onmessage: ((e: MessageEvent<ImportReply>) => void) | null
  onerror: ((e: ErrorEvent) => void) | null
  postMessage(message: ImportRequest): void
  terminate(): void
}

export interface ImportJob {
  /** The rebuilt session, or null once cancelled */
  done: Promise<ImportResult | null>
  cancel(): void
}

function importWorker(): ImportWorker {
  return new ImportTraceWorker() as ImportWorker
}

/** Import `file` in a worker of its own, which ends with the import. */
export function startImport(
  file: File,
  onProgress: (loaded: number, total: number) => void,
  createWorker: () => ImportWorker = importWorker,
): ImportJob {
  const worker = createWorker()
  let settle: (result: ImportResult | null) => void = () => {}
  let fail: (err: Error) => void = () => {}
  const done = new Promise<ImportResult | null>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  let finished = false
  const finish = () => {
    finished = true
    worker.onmessage = null
    worker.onerror = null
    worker.terminate()
  }

  worker.onmessage = (e) => {
    const reply = e.data
    if (reply.type === 'progress') {
      onProgress(reply.loaded, reply.total)
      return
    }
    finish()
    if (reply.type === 'done') settle({ ...reply.result, colors: reply.colors })
    else fail(new Error(reply.message))
  }
  worker.onerror = (e) => {
    finish()
    fail(new Error(e.message || 'The import worker failed to start'))
  }
  worker.postMessage({ file, filename: file.name })

  return {
    done,
    cancel() {
      if (finished) return
      finish()
      settle(null)
    },
  }
}
