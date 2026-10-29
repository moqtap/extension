/**
 * Content script bridge — runs in ISOLATED world.
 *
 * Two responsibilities:
 * 1. Relays intercepted WebTransport events from MAIN world content script
 *    to the background service worker via a persistent port.
 * 2. Listens for activation signal from background (when a DevTools panel
 *    connects) and forwards it to the MAIN world content script.
 * 3. Passes the tab's impairment answer (src/impair) to the MAIN world.
 *
 * On exactly APP_ORIGIN it also relays the sign-in callback and the
 * signed-in / signed-out hint to the background (src/account/bridge-relay.ts
 * says what passes). It never receives anything back: tokens stay in the
 * background and the DevTools panel.
 *
 * Also tells the MAIN world, at startup, when this document's own origin is
 * on the worker exclusion list, so the content script can skip worker
 * wrapping there. Only that verdict is posted, never the list: every script
 * in the window can read what is posted to it (src/storage/worker-exclusions.ts).
 *
 * Uses runtime.connect (persistent port) rather than sendMessage (one-shot)
 * so that high-frequency stream data doesn't create per-message channel
 * overhead. Single teardown on tab close instead of hundreds of in-flight
 * message channels.
 */

import { APP_ORIGIN } from '@/src/account/config'
import { accountRelay } from '@/src/account/bridge-relay'
import type { ContentToBackgroundMsg } from '@/src/messaging/types'
import { bytesToBase64 } from '@/src/messaging/types'
import { isTabAnswerMsg, type TabAnswer } from '@/src/impair/messages'
import { EXCLUSIONS_KEY, exclusionNotice } from '@/src/storage/worker-exclusions'

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  matchOriginAsFallback: true,
  runAt: 'document_start',

  main() {
    // ── Relay this origin's exclusion verdict to MAIN world ──────────
    // Async, but the MAIN world Proxy safety net handles Workers created
    // before it arrives. Nothing is posted for an origin that is not listed,
    // so most pages see no message at all.
    try {
      const origin = location.origin
      browser.storage.local
        .get(EXCLUSIONS_KEY)
        .then((result) => {
          const notice = exclusionNotice(result[EXCLUSIONS_KEY], origin)
          if (notice !== null) window.postMessage(notice, origin)
        })
        .catch(() => {
          /* storage not available */
        })
    } catch {
      /* extension context invalidated */
    }

    // ── Persistent port to background ────────────────────────────────
    let port: ReturnType<typeof browser.runtime.connect> | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectAttempt = 0
    let teardown = false

    function scheduleReconnect() {
      if (teardown || reconnectTimer || port) return
      // 250ms, 500ms, 1s, 2s, 4s, capped at 8s. Most SW-restart cases
      // resolve on the first retry; backoff handles genuine context loss.
      const delay = Math.min(250 * 2 ** reconnectAttempt, 8000)
      reconnectAttempt++
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect()
      }, delay)
    }

    function postAnswer(answer: TabAnswer) {
      window.postMessage({ source: 'moqtap-impair', answer }, '*')
    }

    function connect() {
      if (teardown) return
      try {
        port = browser.runtime.connect({ name: 'moqtap-bridge' })
      } catch {
        // Extension context invalidated (extension disabled/uninstalled/updated).
        // Nothing routes this tab any more, so its sessions connect directly.
        port = null
        teardown = true
        postAnswer({ on: false, route: null })
        return
      }
      reconnectAttempt = 0

      // Activation signals from background arrive on the same port
      port.onMessage.addListener((message: { type?: string }) => {
        if (message?.type === 'activate-tab') {
          window.postMessage({ source: 'moqtap-activate' }, '*')
        } else if (isTabAnswerMsg(message)) {
          postAnswer(message.answer)
        }
      })

      port.onDisconnect.addListener(() => {
        port = null
        // SW was idle-terminated (or extension context invalidated). Try to
        // reconnect so we keep receiving activate-tab signals; runtime.connect
        // itself respawns the SW.
        scheduleReconnect()
      })
    }

    connect()

    // ── Disconnect on bfcache to avoid "message channel is closed" errors ──
    window.addEventListener('pagehide', (event) => {
      if (event.persisted && port) {
        // Page is entering back/forward cache — close the port cleanly
        // to avoid "The page keeping the extension port is moved into
        // back/forward cache, so the message channel is closed" errors.
        // Suppress reconnect while bfcached; pageshow will re-trigger it.
        teardown = true
        if (reconnectTimer) {
          clearTimeout(reconnectTimer)
          reconnectTimer = null
        }
        port.disconnect()
        port = null
      }
    })

    window.addEventListener('pageshow', (event) => {
      if (event.persisted && !port) {
        // Page restored from bfcache — reconnect
        teardown = false
        reconnectAttempt = 0
        connect()
      }
    })

    // ── Account messages from app. → background ──────────────────────
    if (location.origin === APP_ORIGIN && window === window.top) {
      window.addEventListener('message', (event) => {
        const relay = accountRelay(event, {
          selfOrigin: location.origin,
          isTop: window === window.top,
          self: window,
          appOrigin: APP_ORIGIN,
        })
        if (relay === null) return
        try {
          browser.runtime.sendMessage(relay).catch(() => {
            /* background unavailable */
          })
        } catch {
          /* extension context invalidated */
        }
      })
    }

    // ── Forward intercepted events: MAIN world → background ──────────
    window.addEventListener('message', (event) => {
      if (event.source !== window) return
      if (event.data?.source !== 'moqtap-content') return

      if (!port) return

      const msg = event.data.payload as ContentToBackgroundMsg

      // ArrayBuffer doesn't survive Chrome extension structured clone
      // reliably (port.postMessage has the same issue as sendMessage).
      // Encode stream data as base64 here in the ISOLATED world — the
      // MAIN world still gets zero-copy via Transferable.
      try {
        if (
          (msg.type === 'stream:data' || msg.type === 'datagram:data') &&
          msg.data instanceof ArrayBuffer
        ) {
          port.postMessage({
            ...msg,
            data: bytesToBase64(new Uint8Array(msg.data)),
          })
        } else {
          port.postMessage(msg)
        }
      } catch {
        // Port disconnected
        port = null
      }
    })
  },
})
