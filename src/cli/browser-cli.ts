/** The background's CLI bridge, on the real browser APIs. */

import { browser } from 'wxt/browser'
import { storageArea } from '@/src/account/stores'
import { serveCliPort, type CliPortLike } from './background'
import { CLI_PORT } from './messages'
import { CliBridge } from './service'

export function startCli(): CliBridge {
  const bridge = new CliBridge({
    fetch: (input, init) => fetch(input, init),
    local: storageArea(browser.storage.local),
    subtle: crypto.subtle,
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    now: () => Date.now(),
  })
  const extensionBase = browser.runtime.getURL('/')
  browser.runtime.onConnect.addListener((port) => {
    if (port.name === CLI_PORT) serveCliPort(bridge, port as unknown as CliPortLike, extensionBase)
  })
  return bridge
}
