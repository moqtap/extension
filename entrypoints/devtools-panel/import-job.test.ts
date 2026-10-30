import { encodeSubgroupStream } from '@moqtap/codec/draft22'
import { readMoqtrace, writeMoqtrace } from '@moqtap/trace'
import { describe, expect, it } from 'vitest'
import { buildTrace } from './build-trace'
import {
  decodeInChunks,
  type ImportReply,
  type ImportRequest,
  type ImportWorker,
  runImport,
  startImport,
} from './import-job'
import { sessionFromTrace } from './import-trace'
import type { SessionEntry } from './use-inspector'

// biome-ignore lint/suspicious/noExplicitAny: fixtures for nominal codec types
type Any = any

/** A draft-22 session with `count` subgroup streams of 20 objects each. */
async function traceBytes(count: number): Promise<Uint8Array> {
  const streams = new Map<number, Uint8Array>()
  for (let s = 0; s < count; s++) {
    streams.set(
      4 * s + 3,
      encodeSubgroupStream({
        type: 'subgroup',
        headerType: 0x10,
        trackAlias: 1n,
        groupId: BigInt(s),
        subgroupId: 0n,
        publisherPriority: 0x80,
        objects: Array.from({ length: 20 }, (_, i) => ({
          type: 'object',
          byteOffset: 0,
          payloadByteOffset: 0,
          objectId: BigInt(i),
          payloadLength: 64,
          payload: new Uint8Array(64).fill(i),
          extensionData: new Uint8Array(0),
        })),
      } as Any),
    )
  }
  const session = {
    sessionId: 's1',
    url: 'https://relay.example/moq',
    createdAt: 1000,
    closed: true,
    protocol: 'moqt',
    draft: '22',
    messages: [],
    streams: new Map(
      [...streams].map(([id, bytes]) => [
        id,
        {
          streamId: id,
          direction: 'rx',
          closed: true,
          byteCount: bytes.length,
          chunkCount: 1,
          contentType: 'binary',
          firstDataAt: 1010,
          lastDataAt: 1020,
        },
      ]),
    ),
    tracks: new Map(),
    datagramGroups: new Map(),
    bitrateSamples: [],
  } as Any as SessionEntry
  const trace = await buildTrace(session, async (_s, id) => streams.get(id) ?? null)
  return writeMoqtrace(trace)
}

function blobOf(bytes: Uint8Array): Blob {
  return new Blob([bytes as BlobPart])
}

describe('decodeInChunks', () => {
  it('yields what readMoqtrace reads, reporting each chunk', async () => {
    const bytes = await traceBytes(10)
    const progress: number[] = []
    const { header, events } = decodeInChunks(
      bytes,
      (loaded, total) => {
        expect(total).toBe(bytes.length)
        progress.push(loaded)
      },
      1000,
    )
    const whole = readMoqtrace(bytes)
    expect(header).toEqual(whole.header)
    expect([...events]).toEqual(whole.events)
    expect(progress.at(-1)).toBe(bytes.length)
    expect(progress.length).toBe(Math.ceil(bytes.length / 1000))
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
  })

  it('decodes no further than the events taken', async () => {
    const bytes = await traceBytes(10)
    const progress: number[] = []
    const { events } = decodeInChunks(bytes, (n) => progress.push(n), 1000)
    const first = events[Symbol.iterator]().next()
    expect(first.done).toBe(false)
    expect(progress.at(-1)).toBeLessThan(bytes.length)
  })

  it('refuses a file that is no trace', () => {
    expect(() =>
      decodeInChunks(new TextEncoder().encode('not a trace at all'), () => {}),
    ).toThrow(/not a \.moqtrace file/)
  })
})

describe('runImport', () => {
  it('posts progress, then the session with its buffers to transfer', async () => {
    const bytes = await traceBytes(30)
    const replies: { reply: ImportReply; transfer?: Transferable[] }[] = []
    await runImport(
      { file: blobOf(bytes), filename: 'big.moqtrace' },
      (reply, transfer) => replies.push({ reply, transfer }),
      2048,
    )

    const progress = replies.filter((r) => r.reply.type === 'progress')
    expect(progress.length).toBeGreaterThan(2)
    expect(progress[0].reply).toEqual({
      type: 'progress',
      loaded: 0,
      total: bytes.length,
    })
    expect(progress.at(-1)?.reply).toEqual({
      type: 'progress',
      loaded: bytes.length,
      total: bytes.length,
    })

    const last = replies.at(-1)!
    expect(last.reply.type).toBe('done')
    if (last.reply.type !== 'done') return
    let colour = 0
    const direct = sessionFromTrace(readMoqtrace(bytes), {
      sessionId: '',
      filename: 'big.moqtrace',
      nextColorIndex: () => colour++,
    })
    expect(last.reply.result).toEqual(direct)
    expect(last.reply.colors).toBe(colour)
    const buffers = [...last.reply.result.streamData.values()].map(
      (d) => d.buffer,
    )
    expect(last.transfer).toHaveLength(new Set(buffers).size)
    for (const b of buffers) expect(last.transfer).toContain(b)
    // The result survives the structured clone a worker reply goes through.
    expect(structuredClone(last.reply.result)).toEqual(direct)
  })

  it('posts an error for a bad file', async () => {
    const replies: ImportReply[] = []
    await runImport(
      { file: blobOf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])), filename: 'x' },
      (reply) => replies.push(reply),
    )
    expect(replies.at(-1)).toEqual({
      type: 'error',
      message: expect.stringMatching(/not a \.moqtrace file/),
    })
  })
})

/** A worker that answers from `runImport` on the same thread. */
class FakeWorker implements ImportWorker {
  onmessage: ((e: MessageEvent<ImportReply>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  terminated = false
  request?: ImportRequest
  postMessage(request: ImportRequest) {
    this.request = request
  }
  terminate() {
    this.terminated = true
  }
  reply(reply: ImportReply) {
    this.onmessage?.({ data: reply } as MessageEvent<ImportReply>)
  }
  async run() {
    await runImport(this.request!, (reply) => this.reply(reply), 2048)
  }
}

const file = (bytes: Uint8Array) => new File([bytes as BlobPart], 'big.moqtrace')

describe('startImport', () => {
  it('reports progress and resolves with the session', async () => {
    const worker = new FakeWorker()
    const seen: [number, number][] = []
    const job = startImport(
      file(await traceBytes(5)),
      (loaded, total) => seen.push([loaded, total]),
      () => worker,
    )
    expect(worker.request?.filename).toBe('big.moqtrace')
    await worker.run()
    const result = await job.done
    expect(result?.streamData.size).toBe(5)
    expect(seen.length).toBeGreaterThan(1)
    expect(worker.terminated).toBe(true)
  })

  it('rejects with the worker\'s error', async () => {
    const worker = new FakeWorker()
    const job = startImport(file(new Uint8Array(4)), () => {}, () => worker)
    await worker.run()
    await expect(job.done).rejects.toThrow()
    expect(worker.terminated).toBe(true)
  })

  it('cancel stops the worker and resolves with nothing', async () => {
    const worker = new FakeWorker()
    const seen: number[] = []
    const job = startImport(
      file(await traceBytes(5)),
      (loaded) => seen.push(loaded),
      () => worker,
    )
    worker.reply({ type: 'progress', loaded: 10, total: 100 })
    job.cancel()
    expect(worker.terminated).toBe(true)
    // Anything the worker had already posted is ignored.
    worker.reply({ type: 'progress', loaded: 20, total: 100 })
    await expect(job.done).resolves.toBeNull()
    expect(seen).toEqual([10])
  })
})
