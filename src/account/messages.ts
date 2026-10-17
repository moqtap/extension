/**
 * Messages of the account feature, between the page on `app.`, the bridge
 * content script, the background and the DevTools panel.
 *
 * None of them carries a token except {@link AccountTokenReply}, which the
 * background sends only on a port whose sender is an extension page.
 */

// ── page on app. → bridge (window.postMessage, same origin) ──────────────

/** Posted by `app./ext/cb` when a sign-in ends. */
export interface OAuthCallbackPageMsg {
  readonly type: 'moqtap:oauth-callback'
  readonly code: string | null
  readonly state: string | null
  readonly error: string | null
}

/**
 * Posted by every `app.` page load: whether that page has a
 * session. No token and no user data; the extension still signs in only
 * through code + PKCE.
 */
export interface SessionHintPageMsg {
  readonly type: 'moqtap:session'
  readonly state: 'signed-in' | 'signed-out'
}

// ── bridge → background (runtime.sendMessage) ────────────────────────────

export interface BridgeAccountMsg {
  readonly kind: 'moqtap-account'
  readonly message: OAuthCallbackPageMsg | SessionHintPageMsg
}

// ── panel ↔ background (port ACCOUNT_PORT) ───────────────────────────────

export interface OrgSummary {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly kind: 'personal' | 'team'
  readonly role: 'owner' | 'admin' | 'member' | 'viewer'
}

/**
 * Why the extension is signed out, when that is news to the user.
 *
 * - `revoked`: the refresh token was refused (`invalid_grant`), e.g. the
 *   browser was removed under Devices or the token was reused elsewhere
 * - `app-signed-out`: the user signed out on `app.`
 * - `sign-in-failed`: the interactive flow came back with an error
 * - `disconnect-unconfirmed`: Disconnect could not reach the server; the
 *   tokens are gone here, but the device still shows under Devices
 */
export type AccountNotice =
  | 'revoked'
  | 'app-signed-out'
  | 'sign-in-failed'
  | 'disconnect-unconfirmed'

export type AccountView =
  | {
      readonly status: 'signed-out'
      readonly signingIn: boolean
      readonly notice: AccountNotice | null
    }
  | {
      readonly status: 'signed-in'
      readonly handle: string | null
      readonly orgs: readonly OrgSummary[]
      /** The last refresh could not reach the server; credentials are kept. */
      readonly unreachable: boolean
    }

export type PanelAccountMsg =
  | { readonly type: 'account:subscribe' }
  | { readonly type: 'account:sign-in' }
  | { readonly type: 'account:disconnect' }
  | { readonly type: 'account:refresh-orgs' }
  | { readonly type: 'account:get-token'; readonly requestId: number; readonly force: boolean }

export interface AccountStateMsg {
  readonly type: 'account:state'
  readonly view: AccountView
}

export interface AccountTokenReply {
  readonly type: 'account:token'
  readonly requestId: number
  readonly token: string | null
  /** Set when `token` is null. */
  readonly error: 'signed-out' | 'unreachable' | null
}

export type BackgroundAccountMsg = AccountStateMsg | AccountTokenReply
