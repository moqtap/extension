import type { CliView, TabImpairment } from '@/src/cli/messages'
import { isOff, OFF, type Profile, sameProfile, type ProfileChoice, type Profiles } from '@/src/cli/protocol'

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

/** A known profile impairs the session; Off and a profile the panel cannot name do not colour its gauge. */
export function impairsSession(p: SessionProfile | null): boolean {
  return p !== null && p.profile !== null && !isOff(p.profile)
}

/** An item or a folder of them, as the impairment menu shows it. */
export type MenuNode =
  | { readonly kind: 'item'; readonly choice: ProfileChoice }
  | { readonly kind: 'folder'; readonly name: string; readonly children: readonly MenuNode[] }

/** The submenu the built-in presets move into once there are scenarios of one's own. */
export const DEFAULT_FOLDER = 'Default'

/**
 * The menu's sections, each a run of items and submenus between separators.
 * Without scenarios of one's own: Off and the presets, as one section. With
 * them: Off; the scenarios, each folder a submenu (folders first, then the
 * scenarios at that level, in the CLI's order); the presets under "Default".
 */
export function menuTree(choices: readonly ProfileChoice[]): MenuNode[][] {
  const item = (choice: ProfileChoice): MenuNode => ({ kind: 'item', choice })
  const presets = choices.filter((c) => 'preset' in c.profile)
  const scenarios = choices.filter((c) => 'scenario' in c.profile)
  if (scenarios.length === 0) return presets.length > 0 ? [presets.map(item)] : []
  const off = presets.filter((c) => isOff(c.profile))
  const builtIn = presets.filter((c) => !isOff(c.profile))
  const sections: MenuNode[][] = []
  if (off.length > 0) sections.push(off.map(item))
  sections.push(foldered(scenarios, 0))
  if (builtIn.length > 0) sections.push([{ kind: 'folder', name: DEFAULT_FOLDER, children: builtIn.map(item) }])
  return sections
}

function foldered(choices: readonly ProfileChoice[], depth: number): MenuNode[] {
  const folders = new Map<string, ProfileChoice[]>()
  const here: MenuNode[] = []
  for (const c of choices) {
    const name = c.folder?.[depth]
    if (name === undefined) here.push({ kind: 'item', choice: c })
    else folders.set(name, [...(folders.get(name) ?? []), c])
  }
  const names = [...folders.keys()].sort((a, b) => a.localeCompare(b))
  return [
    ...names.map((name): MenuNode => ({ kind: 'folder', name, children: foldered(folders.get(name)!, depth + 1) })),
    ...here,
  ]
}

/** Whether `node` is `profile`'s item or holds it. */
export function holds(node: MenuNode, profile: Profile): boolean {
  return node.kind === 'item' ? sameProfile(node.choice.profile, profile) : node.children.some((n) => holds(n, profile))
}

/** The CLI as the impairment menu's first line names it: its version and the identity's first two groups. */
export function cliHeader(view: CliView | null): string {
  switch (view?.state) {
    case 'connected':
    case 'confirm':
    case 'declined':
      return `moqtap CLI ${view.cliVersion} · ${shortFingerprint(view.fingerprint)}`
    case 'unsupported':
      return 'This browser cannot verify the moqtap CLI'
    default:
      return "moqtap CLI isn't running"
  }
}

/** An identity's first two groups, enough to tell two CLIs apart at a glance. */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.split('-').slice(0, 2).join('-')
}

/** The toolbar's impairment button text. */
export function impairmentButtonLabel(tab: TabImpairment | null): string {
  return tab === null || isOff(tab.profile) ? 'No impairment' : tab.name
}

const PRESET_SHORT = { none: null, offline: 'Offline', '3g': '3G', '4g': '4G' } as const

/** Each listed scenario's short label, by scenario name. */
export function scenarioLabels(profiles: Profiles): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const c of profiles.profiles) {
    if ('scenario' in c.profile && c.shortLabel !== undefined) out.set(c.profile.scenario, c.shortLabel)
  }
  return out
}

/**
 * What a connection row writes beside its gauge: a preset's short name, or a
 * scenario's short label from its file. Otherwise the gauge stands alone and
 * the full name is the tooltip.
 */
export function profileShortLabel(profile: Profile | null, labels: ReadonlyMap<string, string>): string | null {
  if (profile === null) return null
  if ('scenario' in profile) return labels.get(profile.scenario) ?? null
  return PRESET_SHORT[profile.preset]
}
