/**
 * The account constants the bundle is built with (see `origins.ts`).
 *
 * `__MOQTAP_APP_ORIGIN__` / `__MOQTAP_API_ORIGIN__` are replaced by
 * `wxt.config.ts`. The unit tests run without that replacement and get the
 * production origins, which is what the tests assert against.
 */

import { PRODUCTION_ORIGINS } from './origins'

declare const __MOQTAP_APP_ORIGIN__: string | undefined
declare const __MOQTAP_API_ORIGIN__: string | undefined

export const APP_ORIGIN: string =
  typeof __MOQTAP_APP_ORIGIN__ === 'string' ? __MOQTAP_APP_ORIGIN__ : PRODUCTION_ORIGINS.app
export const API_ORIGIN: string =
  typeof __MOQTAP_API_ORIGIN__ === 'string' ? __MOQTAP_API_ORIGIN__ : PRODUCTION_ORIGINS.api

/** `oauth_client.id` on the server. */
export const CLIENT_ID = 'moqtap-extension'

/** The page on APP_ORIGIN that ends sign-in and posts the result to the bridge. */
export const CALLBACK_PATH = '/ext/cb'

export const redirectUri = (appOrigin: string): string => `${appOrigin}${CALLBACK_PATH}`

/** Port name the DevTools panel opens for account state and access tokens. */
export const ACCOUNT_PORT = 'moqtap-account'

/** The server's upload limit, checked before sending. */
export const MAX_TRACE_BYTES = 25 * 1024 * 1024
