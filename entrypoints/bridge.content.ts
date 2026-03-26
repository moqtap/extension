/**
 * Content script bridge — runs in ISOLATED world.
 *
 * Two responsibilities:
 * 1. Relays intercepted WebTransport events from MAIN world content script
 *    to the background service worker via a persistent port.
 * 2. Listens for activation signal from background (when a DevTools panel
 *    connects) and forwards it to the MAIN world content script.
 *
 * Uses runtime.connect (persistent port) rather than sendMessage (one-shot)
 * so that high-frequency stream data doesn't create per-message channel
 * overhead. Single teardown on tab close instead of hundreds of in-flight
 * message channels.
 */

import type { ContentToBackgroundMsg } from '@/src/messaging/types';
import { bytesToBase64 } from '@/src/messaging/types';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',

  main() {

    // ── Persistent port to background ────────────────────────────────
    let port: ReturnType<typeof browser.runtime.connect> | null = null;

    function connect() {
      try {
        port = browser.runtime.connect({ name: 'moqtap-bridge' });
      } catch {
        // Extension context invalidated
        port = null;
        return;
      }

      // Activation signals from background arrive on the same port
      port.onMessage.addListener((message: { type?: string }) => {
        if (message?.type === 'activate-tab') {
          window.postMessage({ source: 'moqtap-activate' }, '*');
        }
      });

      port.onDisconnect.addListener(() => {
        port = null;
        // Extension context invalidated — don't reconnect
      });
    }

    connect();

    // ── Disconnect on bfcache to avoid "message channel is closed" errors ──
    window.addEventListener('pagehide', (event) => {
      if (event.persisted && port) {
        // Page is entering back/forward cache — close the port cleanly
        // to avoid "The page keeping the extension port is moved into
        // back/forward cache, so the message channel is closed" errors.
        port.disconnect();
        port = null;
      }
    });

    window.addEventListener('pageshow', (event) => {
      if (event.persisted && !port) {
        // Page restored from bfcache — reconnect
        connect();
      }
    });

    // ── Forward intercepted events: MAIN world → background ──────────
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      if (event.data?.source !== 'moqtap-content') return;

      if (!port) return;

      const msg = event.data.payload as ContentToBackgroundMsg;

      // ArrayBuffer doesn't survive Chrome extension structured clone
      // reliably (port.postMessage has the same issue as sendMessage).
      // Encode stream data as base64 here in the ISOLATED world — the
      // MAIN world still gets zero-copy via Transferable.
      try {
        if (msg.type === 'stream:data' && msg.data instanceof ArrayBuffer) {
          port.postMessage({ ...msg, data: bytesToBase64(new Uint8Array(msg.data)) });
        } else {
          port.postMessage(msg);
        }
      } catch {
        // Port disconnected
        port = null;
      }
    });
  },
});
