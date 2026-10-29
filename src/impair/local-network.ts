/**
 * Why a session routed to the CLI failed to establish: `local-network` when
 * the browser's local network permission for this page is denied, otherwise
 * `cli-session`.
 *
 * Self-contained: the worker hook embeds this function's source.
 */
export async function routeFailure(
  permissions: { query(desc: { name: string }): Promise<{ state: string }> } | undefined,
): Promise<'local-network' | 'cli-session'> {
  if (!permissions || typeof permissions.query !== 'function') return 'cli-session'
  // Chromium names it `loopback-network` for 127.0.0.1, earlier `local-network-access`.
  for (const name of ['loopback-network', 'local-network-access']) {
    try {
      const status = await permissions.query({ name })
      if (status.state === 'denied') return 'local-network'
    } catch {
      // Not a permission this browser knows.
    }
  }
  return 'cli-session'
}
