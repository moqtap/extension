/**
 * Which moqtap deployment a build talks to.
 *
 * Read by `wxt.config.ts` at build time and compiled into the bundle as
 * constants, never read at runtime: the bridge's origin check is only as good
 * as the origin it compares against, so nothing a page or a stored value can
 * reach may change it.
 *
 * - mode `production` (`wxt build`, `wxt zip`) → `app.moqtap.com`, `api.moqtap.com`
 * - any other mode → the same, unless `MOQTAP_APP_ORIGIN` / `MOQTAP_API_ORIGIN`
 *   name another deployment, such as `http://app.localhost:8787`
 */

export interface Origins {
  readonly app: string
  readonly api: string
}

export const PRODUCTION_ORIGINS: Origins = {
  app: 'https://app.moqtap.com',
  api: 'https://api.moqtap.com',
}

/**
 * Exactly an origin: https, or http only on `localhost` / `*.localhost`, the
 * same rule the server applies to its own origin vars.
 */
export function isOrigin(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.origin !== value) return false
  if (url.protocol === 'https:') return true
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname.endsWith('.localhost'))
  )
}

export function originsFor(
  mode: string,
  env: Readonly<Record<string, string | undefined>> = {},
): Origins {
  const app = env.MOQTAP_APP_ORIGIN
  const api = env.MOQTAP_API_ORIGIN
  if (mode === 'production') {
    // A release built on a machine that happens to have a dev override set
    // must not ship pointing at it.
    if (app !== undefined || api !== undefined) {
      throw new Error(
        'MOQTAP_APP_ORIGIN / MOQTAP_API_ORIGIN are refused in a production build',
      )
    }
    return PRODUCTION_ORIGINS
  }
  if (app === undefined && api === undefined) return PRODUCTION_ORIGINS
  // One deployment's app paired with another's api would sign in on one
  // server and upload to the other.
  if (app === undefined || api === undefined) {
    throw new Error('MOQTAP_APP_ORIGIN and MOQTAP_API_ORIGIN must be set together')
  }
  const chosen = { app, api }
  for (const [name, value] of Object.entries(chosen)) {
    if (!isOrigin(value)) throw new Error(`${name} origin is not an origin: ${value}`)
  }
  if (chosen.app === chosen.api) throw new Error('app and api origins must differ')
  return chosen
}
