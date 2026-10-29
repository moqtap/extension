/**
 * Registered by the background, MAIN world at document_start, only while some
 * tab has an impairment profile: tells the WebTransport hook to wait for its
 * tab's answer before connecting.
 */

import { ANY_KEY } from '@/src/impair/flag'

export default defineUnlistedScript(() => {
  ;(globalThis as Record<symbol, unknown>)[ANY_KEY] = true
})
