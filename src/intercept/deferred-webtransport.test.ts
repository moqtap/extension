import { describe, expect, it } from 'vitest'
import { deferWebTransport } from './deferred-webtransport'

/**
 * A WebTransport shaped like the browsers': members are prototype accessors
 * and methods, which throw on anything but a real instance.
 */
class FakeWebTransport {
  static instances: FakeWebTransport[] = []
  readonly url: string
  readonly options: unknown
  readonly written: unknown[] = []
  readonly opened: string[] = []
  readonly closes: unknown[] = []
  readonly cancelled: unknown[] = []
  #ready!: { resolve: () => void; reject: (e: unknown) => void; promise: Promise<void> }
  #closed!: { resolve: (v: unknown) => void; reject: (e: unknown) => void; promise: Promise<unknown> }
  #draining = new Promise<void>(() => {})
  #uni!: ReadableStreamDefaultController<unknown>
  #dgIn!: ReadableStreamDefaultController<Uint8Array>
  #incomingUni: ReadableStream<unknown>
  #incomingBidi: ReadableStream<unknown>
  #datagrams: FakeDatagrams
  protocolValue = ''

  constructor(url: string, options?: unknown, Datagrams: typeof FakeDatagrams = FakeDatagrams) {
    this.url = url
    this.options = options
    let r: typeof this.#ready['resolve'] = () => {}
    let j: typeof this.#ready['reject'] = () => {}
    const ready = new Promise<void>((a, b) => {
      r = a
      j = b
    })
    ready.catch(() => {})
    this.#ready = { resolve: r, reject: j, promise: ready }
    let cr: (v: unknown) => void = () => {}
    let cj: (e: unknown) => void = () => {}
    const closed = new Promise<unknown>((a, b) => {
      cr = a
      cj = b
    })
    closed.catch(() => {})
    this.#closed = { resolve: cr, reject: cj, promise: closed }
    this.#incomingUni = new ReadableStream({
      start: (c) => void (this.#uni = c),
      cancel: (reason) => void this.cancelled.push(reason),
    })
    this.#incomingBidi = new ReadableStream({})
    const written = this.written
    this.#datagrams = new Datagrams(
      new ReadableStream<Uint8Array>({ start: (c) => void (this.#dgIn = c) }),
      new WritableStream({ write: (chunk) => void written.push(chunk) }),
    )
    FakeWebTransport.instances.push(this)
  }
  get ready() {
    return this.#ready.promise
  }
  get closed() {
    return this.#closed.promise
  }
  get draining() {
    return this.#draining
  }
  get datagrams() {
    return this.#datagrams
  }
  get incomingUnidirectionalStreams() {
    return this.#incomingUni
  }
  get incomingBidirectionalStreams() {
    return this.#incomingBidi
  }
  get protocol() {
    return this.protocolValue
  }
  get reliability() {
    return 'reliable-only'
  }
  get congestionControl() {
    return 'default'
  }
  async createBidirectionalStream() {
    this.opened.push('bidi')
    return { readable: new ReadableStream(), writable: new WritableStream() }
  }
  async createUnidirectionalStream() {
    this.opened.push('uni')
    return new WritableStream()
  }
  async getStats() {
    return { bytesSent: 1 }
  }
  createSendGroup() {
    return { group: true }
  }
  close(info?: unknown) {
    this.closes.push(info)
  }
  // Test controls.
  establish(protocol = '') {
    this.protocolValue = protocol
    this.#ready.resolve()
  }
  refuse(err: unknown) {
    this.#ready.reject(err)
    this.#closed.reject(err)
  }
  end(info: unknown) {
    this.#closed.resolve(info)
  }
  pushUni(stream: unknown) {
    this.#uni.enqueue(stream)
  }
  pushDatagram(bytes: Uint8Array) {
    this.#dgIn.enqueue(bytes)
  }
}

class FakeDatagrams {
  #readable: ReadableStream<Uint8Array>
  #writable: WritableStream<unknown>
  #outgoingHighWaterMark = 1
  constructor(readable: ReadableStream<Uint8Array>, writable: WritableStream<unknown>) {
    this.#readable = readable
    this.#writable = writable
  }
  get readable() {
    return this.#readable
  }
  get writable() {
    return this.#writable
  }
  get maxDatagramSize() {
    return 1200
  }
  get outgoingHighWaterMark() {
    return this.#outgoingHighWaterMark
  }
  set outgoingHighWaterMark(v: number) {
    this.#outgoingHighWaterMark = v
  }
}

class FakeDatagramsWithBuffer extends FakeDatagrams {
  #buffered = 0
  get incomingMaxBufferedDatagrams() {
    return this.#buffered
  }
  set incomingMaxBufferedDatagrams(v: number) {
    this.#buffered = v
  }
}

// biome-ignore lint/suspicious/noExplicitAny: the page's view of a WebTransport
type Page = Record<string, any>

function make(options?: unknown) {
  const d = deferWebTransport(FakeWebTransport, options)
  const page = d.transport as Page
  const attach = () => {
    const real = new FakeWebTransport('https://127.0.0.1:1/x')
    d.attach(real)
    return real
  }
  return { d, page, attach }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

async function state(p: Promise<unknown>): Promise<string> {
  let s = 'pending'
  p.then(
    () => void (s = 'resolved'),
    () => void (s = 'rejected'),
  )
  await tick()
  return s
}

describe('deferWebTransport', () => {
  it('passes for a WebTransport and hides its own members from enumeration', () => {
    const { page } = make()
    expect(page instanceof FakeWebTransport).toBe(true)
    expect(Object.keys(page)).toEqual([])
    expect(() => [page.ready, page.closed, page.datagrams, page.protocol]).not.toThrow()
  })

  it('reads as a connecting session before the real one exists', async () => {
    const { page } = make({ congestionControl: 'low-latency' })
    expect(page.protocol).toBe('')
    expect(page.reliability).toBe('pending')
    expect(page.congestionControl).toBe('low-latency')
    expect(page.datagrams.maxDatagramSize).toBe(1024)
    expect(page.datagrams).toBe(page.datagrams)
    expect(page.datagrams.readable).toBe(page.datagrams.readable)
    expect(await state(page.ready)).toBe('pending')
  })

  it('follows the real session once attached', async () => {
    const { page, attach } = make()
    const ready = page.ready
    const real = attach()
    expect(page.ready).toBe(ready)
    real.establish('moqt-16')
    await page.ready
    expect(page.protocol).toBe('moqt-16')
    expect(page.reliability).toBe('reliable-only')
    real.end({ closeCode: 7, reason: 'bye' })
    expect(await page.closed).toEqual({ closeCode: 7, reason: 'bye' })
  })

  it('runs calls made before the session existed against it', async () => {
    const { page, attach } = make()
    const bidi = page.createBidirectionalStream()
    const uni = page.createUnidirectionalStream()
    const stats = page.getStats()
    const real = attach()
    expect(await bidi).toHaveProperty('readable')
    expect(await uni).toBeInstanceOf(WritableStream)
    expect(await stats).toEqual({ bytesSent: 1 })
    expect(real.opened).toEqual(['bidi', 'uni'])
    page.close({ closeCode: 1, reason: 'done' })
    expect(real.closes).toEqual([{ closeCode: 1, reason: 'done' }])
  })

  it('carries streams the page took before the session existed', async () => {
    const { page, attach } = make()
    const writer = page.datagrams.writable.getWriter()
    const datagrams = page.datagrams.readable.getReader()
    const incoming = page.incomingUnidirectionalStreams.getReader()
    const written = writer.write(new Uint8Array([1, 2]))
    const read = datagrams.read()
    const next = incoming.read()
    const real = attach()
    await written
    expect(real.written).toEqual([new Uint8Array([1, 2])])
    real.pushDatagram(new Uint8Array([9]))
    expect(await read).toEqual({ done: false, value: new Uint8Array([9]) })
    const stream = new ReadableStream()
    real.pushUni(stream)
    expect(await next).toEqual({ done: false, value: stream })
  })

  it('serves a BYOB reader on the datagram stand-in', async () => {
    const { page, attach } = make()
    const reader = page.datagrams.readable.getReader({ mode: 'byob' })
    const read = reader.read(new Uint8Array(8))
    attach().pushDatagram(new Uint8Array([4, 5, 6]))
    const { value } = await read
    expect(Array.from(value)).toEqual([4, 5, 6])
  })

  it('hands out the real members when the page first asks after attach', () => {
    const { page, attach } = make()
    const real = attach()
    expect(page.datagrams).toBe(real.datagrams)
    expect(page.incomingUnidirectionalStreams).toBe(real.incomingUnidirectionalStreams)
  })

  it('applies tunables the page set early', () => {
    const { page, attach } = make()
    page.datagrams.outgoingHighWaterMark = 4
    expect(page.datagrams.outgoingHighWaterMark).toBe(4)
    const real = attach()
    expect(real.datagrams.outgoingHighWaterMark).toBe(4)
    page.datagrams.outgoingHighWaterMark = 6
    expect(real.datagrams.outgoingHighWaterMark).toBe(6)
  })

  it('applies other tunables of the browser datagram prototype the same way', () => {
    const g = globalThis as Record<string, unknown>
    g.WebTransportDatagramDuplexStream = FakeDatagramsWithBuffer
    try {
      const d = deferWebTransport(FakeWebTransport, undefined)
      const page = d.transport as Page
      expect(page.datagrams instanceof FakeDatagramsWithBuffer).toBe(true)
      expect(page.datagrams.incomingMaxBufferedDatagrams).toBeUndefined()
      page.datagrams.incomingMaxBufferedDatagrams = 5
      expect(page.datagrams.incomingMaxBufferedDatagrams).toBe(5)
      const real = new FakeWebTransport('https://127.0.0.1:1/x', undefined, FakeDatagramsWithBuffer)
      d.attach(real)
      expect((real.datagrams as FakeDatagramsWithBuffer).incomingMaxBufferedDatagrams).toBe(5)
    } finally {
      delete g.WebTransportDatagramDuplexStream
    }
  })

  it('cancels the real queue when the page cancelled the stand-in', async () => {
    const { page, attach } = make()
    const cancelled = page.incomingUnidirectionalStreams.cancel('not needed')
    const real = attach()
    await cancelled
    expect(real.cancelled).toEqual(['not needed'])
  })

  it('closing before the session exists ends it as the real one does, and nothing connects', async () => {
    const { d, page } = make()
    const bidi = page.createBidirectionalStream()
    const incoming = page.incomingUnidirectionalStreams.getReader().read()
    page.close({ closeCode: 3, reason: 'x' })
    expect(d.wanted()).toBe(false)
    const err = await page.ready.catch((e: unknown) => e)
    expect(err).toMatchObject({ source: 'session' })
    expect(await page.closed.catch((e: unknown) => e)).toBe(err)
    expect(await bidi.catch((e: DOMException) => e.name)).toBe('InvalidStateError')
    expect(await incoming.catch((e: unknown) => e)).toBe(err)
    expect(() => page.close()).not.toThrow()
  })

  it('fails with the error that stopped the real session from being made', async () => {
    const { d, page } = make()
    const bidi = page.createBidirectionalStream()
    const writer = page.datagrams.writable.getWriter()
    const boom = new DOMException('blocked', 'SecurityError')
    d.fail(boom)
    expect(await page.ready.catch((e: unknown) => e)).toBe(boom)
    expect(await page.closed.catch((e: unknown) => e)).toBe(boom)
    expect(await bidi.catch((e: DOMException) => e.name)).toBe('InvalidStateError')
    expect(await writer.write(new Uint8Array(1)).catch((e: unknown) => e)).toBe(boom)
  })

  it('refuses members it cannot run before the session exists, and runs them after', () => {
    const { page, attach } = make()
    expect(() => page.createSendGroup()).toThrow(expect.objectContaining({ name: 'InvalidStateError' }))
    attach()
    expect(page.createSendGroup()).toEqual({ group: true })
  })

  it('leaves draining pending until the real one settles, as the browsers do', async () => {
    const { page } = make()
    expect(await state(page.draining)).toBe('pending')
  })

  it('needs nothing from outside its own body', async () => {
    const fn = new Function(`return (${deferWebTransport.toString()})`)() as typeof deferWebTransport
    const d = fn(FakeWebTransport, undefined)
    const real = new FakeWebTransport('https://127.0.0.1:1/x')
    d.attach(real)
    real.establish()
    await (d.transport as Page).ready
  })
})
