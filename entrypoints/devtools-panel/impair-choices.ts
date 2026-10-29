import type { TabImpairment } from '@/src/cli/messages'
import { isOff, OFF, sameProfile, type ProfileChoice, type Profiles } from '@/src/cli/protocol'

/** What the CLI lists, with Off first when it is missing and `current` when it is not listed. */
export function profileChoices(
  profiles: Profiles | null | undefined,
  current: ProfileChoice | null,
): readonly ProfileChoice[] {
  const out = [...(profiles?.profiles ?? [])]
  if (!out.some((c) => isOff(c.profile))) out.unshift({ name: 'Off', profile: OFF })
  if (current !== null && !out.some((c) => sameProfile(c.profile, current.profile))) out.push(current)
  return out
}

/** The profile in effect for a session at the CLI, and whether it is its own. */
export type SessionProfile =
  | (ProfileChoice & { readonly own: boolean })
  /** The CLI lists it with a profile the panel has no name for. */
  | { readonly own: true; readonly name: null; readonly profile: null }

export function sessionProfile(tab: TabImpairment | null, cliSession: string): SessionProfile {
  const own = tab?.sessions.find((s) => s.session === cliSession)
  if (own !== undefined) return { name: own.name, profile: own.profile, own: true }
  if (tab?.unknown.includes(cliSession)) return { name: null, profile: null, own: true }
  return { name: tab?.name ?? 'Off', profile: tab?.profile ?? OFF, own: false }
}
