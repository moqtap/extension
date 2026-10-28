/**
 * Upload a session and share it: redact, serialise, upload to
 * the chosen org's library, then create the share the dialog asked for.
 */

import type { CreatedShare, LibraryClient, UploadedTrace } from '@/src/account/library'
import { type Trace, writeMoqtrace } from '@moqtap/trace'
import { redactTrace, type ShareContent } from './redact-trace'

export type Audience = { readonly kind: 'link'; readonly days: number } | { readonly kind: 'org' }

export interface ShareRequest {
  readonly trace: Trace
  readonly draft: string | null
  readonly content: ShareContent
  /** Ids of the session's control and request streams. */
  readonly controlStreams: ReadonlySet<bigint>
  readonly orgId: string
  readonly title: string | null
  readonly audience: Audience
}

export interface ShareResult {
  readonly trace: UploadedTrace
  readonly share: CreatedShare
}

export async function shareTrace(
  library: LibraryClient,
  req: ShareRequest,
  progress: (step: 'uploading' | 'sharing') => void = () => {},
): Promise<ShareResult> {
  const bytes = writeMoqtrace(
    await redactTrace(req.trace, req.content, req.draft, req.controlStreams),
  )
  progress('uploading')
  const trace = await library.upload(req.orgId, bytes, req.title)
  progress('sharing')
  const share =
    req.audience.kind === 'link'
      ? await library.createLink(trace.id, req.audience.days)
      : await library.shareWithOrg(trace.id)
  return { trace, share }
}

/**
 * Firefox asks the user for the data collection categories the manifest
 * lists as optional (`data_collection_permissions`). The request has to run
 * inside the click, before anything is awaited. A Firefox too old to know
 * the key (before 140) rejects the call naming it, and then there is nothing
 * to ask. Any other refusal, a call outside a user gesture included, means
 * no consent: treating it as "nothing to ask" would upload unconsented.
 */
export function requestDataCollection(includeAuth: boolean): Promise<boolean> {
  if (!import.meta.env.FIREFOX) return Promise.resolve(true)
  const permissions = browser.permissions as unknown as {
    request(p: { data_collection: string[] }): Promise<boolean>
  }
  try {
    return permissions
      .request({
        data_collection: includeAuth
          ? ['websiteContent', 'authenticationInfo']
          : ['websiteContent'],
      })
      .catch(predatesDataCollection)
  } catch (err) {
    return Promise.resolve(predatesDataCollection(err))
  }
}

/** True only for the schema error of a Firefox that does not know the key. */
export function predatesDataCollection(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  // Firefox words it `Unexpected property "data_collection"`; only the key
  // is matched, since the gesture error never names it.
  return message.includes('data_collection')
}
