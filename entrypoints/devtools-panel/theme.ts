/**
 * The panel takes DevTools' theme and has no toggle of its own.
 *
 * Chrome reports `default` or `dark` once, at load. Firefox reports `light`,
 * `dark` or `none` and announces changes. Anything else leaves the attribute
 * off, and tokens.css follows the system.
 */

interface ThemePanels {
  themeName?: string
  onThemeChanged?: {
    addListener(cb: (name: string) => void): void
  }
}

export function themeFor(name: string | undefined): 'light' | 'dark' | null {
  if (name === 'dark') return 'dark'
  if (name === 'default' || name === 'light') return 'light'
  return null
}

export function applyTheme(root: HTMLElement, name: string | undefined): void {
  const theme = themeFor(name)
  if (theme) root.dataset.theme = theme
  else delete root.dataset.theme
}

export function followDevtoolsTheme(root: HTMLElement): void {
  const panels = (browser.devtools?.panels ?? undefined) as
    | ThemePanels
    | undefined
  applyTheme(root, panels?.themeName)
  panels?.onThemeChanged?.addListener((name) => applyTheme(root, name))
}
