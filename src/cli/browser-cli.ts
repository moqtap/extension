/** The background's CLI bridge and tab impairment, on the real browser APIs. */

import { browser } from 'wxt/browser'
import { storageArea } from '@/src/account/stores'
import { ImpairManager } from '@/src/impair/manager'
import { FLAG_SCRIPT_ID } from '@/src/impair/flag'
import type { TabAnswerMsg } from '@/src/impair/messages'
import { serveCliPort, type CliPortLike } from './background'
import { CLI_PORT } from './messages'
import { toBase64Url } from './protocol'
import { CliBridge } from './service'

export function startCli(sendToFrame: (tabId: number, frameId: number, msg: TabAnswerMsg) => void): ImpairManager {
  const bridge = new CliBridge({
    fetch: (input, init) => fetch(input, init),
    local: storageArea(browser.storage.local),
    subtle: crypto.subtle,
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    now: () => Date.now(),
  })
  const impair = new ImpairManager({
    cli: bridge,
    store: storageArea(browser.storage.session),
    sendToFrame,
    // An extension API call also keeps the service worker alive between lease renewals.
    tabExists: (tabId) => browser.tabs.get(tabId).then(() => true, () => false),
    newOwner: () => toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    every: (ms, fn) => {
      const t = setInterval(fn, ms)
      return () => clearInterval(t)
    },
    setFlag,
  })
  const extensionBase = browser.runtime.getURL('/')
  browser.runtime.onConnect.addListener((port) => {
    if (port.name === CLI_PORT) serveCliPort(bridge, impair, port as unknown as CliPortLike, extensionBase)
  })
  return impair
}

/** Registers `impair-flag.js` in every frame while `any`, so documents wait for their tab's answer. */
async function setFlag(any: boolean): Promise<void> {
  const registered = await browser.scripting.getRegisteredContentScripts({ ids: [FLAG_SCRIPT_ID] })
  if (any && registered.length === 0) {
    await browser.scripting.registerContentScripts([
      {
        id: FLAG_SCRIPT_ID,
        js: ['impair-flag.js'],
        matches: ['<all_urls>'],
        allFrames: true,
        matchOriginAsFallback: true,
        runAt: 'document_start',
        world: 'MAIN',
        persistAcrossSessions: false,
      },
    ])
  } else if (!any && registered.length > 0) {
    await browser.scripting.unregisterContentScripts({ ids: [FLAG_SCRIPT_ID] })
  }
}
