/**
 * The panel's calls to the trace library on `api.`.
 *
 * The panel uploads with `fetch` itself: `api.` answers CORS with
 * `Access-Control-Allow-Origin: *`, so no host permission is needed. The
 * access token comes from the background through `getToken`; on a 401 the
 * call asks once for a fresh one and retries.
 */

import { API_ORIGIN, MAX_TRACE_BYTES } from './config'

export class LibraryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'LibraryError'
  }
}

export type GetToken = (force: boolean) => Promise<string>

export interface UploadedTrace {
  readonly id: string
  readonly orgId: string
  readonly bytes: number
  readonly detail: string
  readonly expiresAt: number | null
}

export interface CreatedShare {
  readonly id: string
  readonly audience: 'link' | 'org'
  /** Link shares only; shown once by the server. */
  readonly url: string | null
  readonly expiresAt: number | null
}

export interface LibraryClient {
  upload(orgId: string, bytes: Uint8Array, title: string | null): Promise<UploadedTrace>
  createLink(traceId: string, expiresInDays: number): Promise<CreatedShare>
  shareWithOrg(traceId: string): Promise<CreatedShare>
}

async function failure(res: Response): Promise<LibraryError> {
  let code = `http_${res.status}`
  let message = `moqtap answered ${res.status}`
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown }
    if (typeof body.error === 'string') code = body.error
    if (typeof body.message === 'string') message = body.message
  } catch {
    // Not JSON; the status says enough.
  }
  return new LibraryError(res.status, code, message)
}

export function libraryClient(
  getToken: GetToken,
  opts: { fetch?: typeof fetch; apiOrigin?: string } = {},
): LibraryClient {
  const f = opts.fetch ?? ((input, init) => fetch(input, init))
  const api = opts.apiOrigin ?? API_ORIGIN

  async function call(path: string, init: RequestInit): Promise<unknown> {
    const send = async (force: boolean) =>
      f(`${api}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${await getToken(force)}` },
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      })
    let res = await send(false)
    if (res.status === 401) res = await send(true)
    if (!res.ok) throw await failure(res)
    return res.json()
  }

  return {
    async upload(orgId, bytes, title) {
      if (bytes.byteLength > MAX_TRACE_BYTES) {
        throw new LibraryError(
          413,
          'too_large',
          `this trace is ${(bytes.byteLength / 1048576).toFixed(1)} MiB; the limit is 25 MiB`,
        )
      }
      const q = title !== null && title !== '' ? `?title=${encodeURIComponent(title)}` : ''
      const body = (await call(`/v1/orgs/${encodeURIComponent(orgId)}/traces${q}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes as BodyInit,
      })) as { trace: UploadedTrace }
      return body.trace
    },
    async createLink(traceId, expiresInDays) {
      const body = (await call(`/v1/traces/${encodeURIComponent(traceId)}/links`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expiresInDays }),
      })) as { share: { id: string; url: string; expiresAt: number } }
      return { id: body.share.id, audience: 'link', url: body.share.url, expiresAt: body.share.expiresAt }
    },
    async shareWithOrg(traceId) {
      const body = (await call(`/v1/traces/${encodeURIComponent(traceId)}/shares`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audience: 'org' }),
      })) as { share: { id: string } }
      return { id: body.share.id, audience: 'org', url: null, expiresAt: null }
    },
  }
}
