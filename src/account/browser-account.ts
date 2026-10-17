/**
 * The background's account, on the real browser APIs. Called once from
 * `entrypoints/background.ts`.
 */

import { browser } from 'wxt/browser'
import { installAccount, type PortLike } from './background'
import { AccountService, type SenderLike } from './service'
import { indexedDbSecrets, storageArea } from './stores'

export function startAccount(): AccountService {
  const account = new AccountService({
    session: storageArea(browser.storage.session),
    local: storageArea(browser.storage.local),
    secrets: indexedDbSecrets(),
    fetch: (input, init) => fetch(input, init),
    openTab: async (url, active) => (await browser.tabs.create({ url, active })).id,
    closeTab: async (tabId) => {
      await browser.tabs.remove(tabId)
    },
    extensionId: browser.runtime.id,
    deviceLabel: import.meta.env.FIREFOX ? 'Firefox extension' : 'Chrome extension',
  })
  installAccount(account, {
    runtime: {
      id: browser.runtime.id,
      getURL: (path) => browser.runtime.getURL(path as '/'),
      onMessage: {
        addListener: (fn) =>
          browser.runtime.onMessage.addListener((msg: unknown, sender) =>
            fn(msg, sender as SenderLike),
          ),
      },
      onConnect: {
        addListener: (fn) =>
          browser.runtime.onConnect.addListener((port) => fn(port as unknown as PortLike)),
      },
    },
    tabs: { onRemoved: browser.tabs.onRemoved },
  })
  return account
}
