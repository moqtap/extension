/** How the panel arranges itself for the space DevTools gives it. */

/** Below this width the connections list becomes a toolbar picker. */
export const NARROW_WIDTH = 560
/** From this width a short drawer puts the tabs in the toolbar's row. */
export const WIDE_WIDTH = 900
/** From this width the tabs share the toolbar's row at any height. */
export const TABS_INLINE_WIDTH = 1100
/** Below this height the panel is a short drawer: every row of chrome counts. */
export const SHORT_HEIGHT = 350

/** Below this width a connection row gives its rate to the tooltip, so the host keeps room. */
export const SIDEBAR_RATE_WIDTH = 200

export function sidebarShowsRate(width: number): boolean {
  return width === 0 || width >= SIDEBAR_RATE_WIDTH
}

export interface PanelLayout {
  narrow: boolean
  tabsInline: boolean
  short: boolean
}

export function panelLayout(width: number, height = Number.POSITIVE_INFINITY): PanelLayout {
  const short = height < SHORT_HEIGHT
  return {
    narrow: width < NARROW_WIDTH,
    tabsInline: width >= TABS_INLINE_WIDTH || (short && width >= WIDE_WIDTH),
    short,
  }
}

/**
 * Whether the tab's impairment menu also carries the selected connection's
 * section. A short drawer leaves it to the row's gauge so the menu fits; a
 * narrow panel has no rows, and a collapsed sidebar no gauges, so it keeps it.
 */
export function tabMenuHasConnection(l: PanelLayout, collapsed = false): boolean {
  return !l.short || l.narrow || collapsed
}

/** Toolbar icon buttons and the gap and padding around them, px. */
export const BAR_BUTTON = 24
export const BAR_GAP = 2
export const BAR_PAD = 4

/** The compact sidebar: exactly the record, clear, import and compact buttons above it. */
export const SIDEBAR_COLLAPSED_WIDTH = BAR_PAD * 2 + BAR_BUTTON * 4 + BAR_GAP * 3

/**
 * Where the logo goes: in the sidebar's part of the toolbar, between its
 * buttons and the compact toggle (`head`); at the foot of a compact sidebar,
 * whose buttons fill its width (`side`); with no sidebar,
 * the status footer, which with no connection open holds just the logo.
 */
export type LogoPlace = 'head' | 'side' | 'footer'

export function logoPlace(sidebar: boolean, compact: boolean): LogoPlace {
  if (!sidebar) return 'footer'
  return compact ? 'side' : 'head'
}

/**
 * Which tabs fit in `available` px, in order, the rest going to a » menu
 * `moreWidth` wide. The active tab always stays in the strip.
 */
export function fitTabs(
  widths: readonly number[],
  available: number,
  moreWidth: number,
  active: number,
): { shown: number[]; overflow: number[] } {
  const all = widths.map((_, i) => i)
  if (widths.reduce((a, b) => a + b, 0) <= available) return { shown: all, overflow: [] }
  const room = available - moreWidth
  const shown: number[] = []
  let used = 0
  for (const i of all) {
    if (used + widths[i] > room) break
    shown.push(i)
    used += widths[i]
  }
  if (active >= 0 && active < widths.length && !shown.includes(active)) {
    while (shown.length > 0 && used + widths[active] > room) used -= widths[shown.pop()!]
    shown.push(active)
  }
  return { shown, overflow: all.filter((i) => !shown.includes(i)) }
}

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

/** Margin a menu keeps from the panel's edges. */
const EDGE = 4

/**
 * Where a menu opens: under its anchor, left-aligned, else right-aligned;
 * above the anchor when there is more room there. Taller menus scroll.
 */
export function placeMenu(
  anchor: Rect,
  menu: { width: number; height: number },
  view: { width: number; height: number },
): { left: number; top: number; maxHeight: number } {
  let left = anchor.left
  if (left + menu.width > view.width - EDGE) left = anchor.right - menu.width
  left = Math.max(EDGE, Math.min(left, view.width - EDGE - menu.width))
  const below = view.height - EDGE - anchor.bottom
  const above = anchor.top - EDGE
  if (menu.height <= below || below >= above) {
    return { left, top: anchor.bottom, maxHeight: Math.max(0, below) }
  }
  const height = Math.min(menu.height, above)
  return { left, top: anchor.top - height, maxHeight: above }
}

/** A menu's padding above its first item, px. */
const MENU_PAD = 4

/**
 * Where a submenu opens: beside the item that opens it, its first item level
 * with that one; on the left when the right has no room; moved up to stay on
 * screen, scrolling when taller than the panel.
 */
export function placeSubmenu(
  item: Rect,
  menu: { width: number; height: number },
  view: { width: number; height: number },
): { left: number; top: number; maxHeight: number } {
  let left = item.right
  if (left + menu.width > view.width - EDGE) left = item.left - menu.width
  left = Math.max(EDGE, Math.min(left, view.width - EDGE - menu.width))
  const maxHeight = Math.max(0, view.height - 2 * EDGE)
  const height = Math.min(menu.height, maxHeight)
  const top = Math.max(EDGE, Math.min(item.top - MENU_PAD, view.height - EDGE - height))
  return { left, top, maxHeight }
}
