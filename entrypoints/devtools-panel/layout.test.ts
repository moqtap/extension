import { describe, expect, it } from 'vitest'
import {
  fitTabs,
  logoPlace,
  panelLayout,
  placeMenu,
  placeSubmenu,
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_RATE_WIDTH,
  sidebarShowsRate,
  tabMenuHasConnection,
} from './layout'

describe('panelLayout', () => {
  it('side panel is narrow, drawer is not, wide puts tabs in the toolbar', () => {
    expect(panelLayout(420, 760)).toEqual({ narrow: true, tabsInline: false, short: false })
    expect(panelLayout(559)).toEqual({ narrow: true, tabsInline: false, short: false })
    expect(panelLayout(560)).toEqual({ narrow: false, tabsInline: false, short: false })
    expect(panelLayout(1099)).toEqual({ narrow: false, tabsInline: false, short: false })
    expect(panelLayout(1100)).toEqual({ narrow: false, tabsInline: true, short: false })
  })

  it('a short drawer puts the tabs in the toolbar from 900 px', () => {
    expect(panelLayout(1430, 280)).toEqual({ narrow: false, tabsInline: true, short: true })
    expect(panelLayout(900, 349)).toEqual({ narrow: false, tabsInline: true, short: true })
    expect(panelLayout(899, 280)).toEqual({ narrow: false, tabsInline: false, short: true })
    expect(panelLayout(900, 350)).toEqual({ narrow: false, tabsInline: false, short: false })
    expect(panelLayout(420, 300)).toEqual({ narrow: true, tabsInline: false, short: true })
  })
})

describe('fitTabs', () => {
  const w = [80, 70, 60, 75, 60]

  it('shows every tab when they fit, with no » menu', () => {
    expect(fitTabs(w, 345, 24, 0)).toEqual({ shown: [0, 1, 2, 3, 4], overflow: [] })
  })

  it('moves the tail into the menu, leaving room for »', () => {
    expect(fitTabs(w, 240, 24, 0)).toEqual({ shown: [0, 1, 2], overflow: [3, 4] })
  })

  it('keeps the active tab in the strip', () => {
    expect(fitTabs(w, 240, 24, 4)).toEqual({ shown: [0, 1, 4], overflow: [2, 3] })
  })

  it('shows only the active tab when nothing else fits', () => {
    expect(fitTabs(w, 90, 24, 3)).toEqual({ shown: [3], overflow: [0, 1, 2, 4] })
  })
})

describe('placeMenu', () => {
  const view = { width: 800, height: 300 }
  const anchor = { left: 100, top: 20, right: 180, bottom: 44 }

  it('opens below the anchor, left-aligned', () => {
    expect(placeMenu(anchor, { width: 200, height: 120 }, view)).toEqual({ left: 100, top: 44, maxHeight: 252 })
  })

  it('aligns to the anchor right edge near the panel edge', () => {
    const a = { left: 700, top: 20, right: 780, bottom: 44 }
    expect(placeMenu(a, { width: 200, height: 120 }, view).left).toBe(580)
  })

  it('opens above when there is more room there', () => {
    const a = { left: 100, top: 250, right: 180, bottom: 274 }
    expect(placeMenu(a, { width: 200, height: 120 }, view)).toEqual({ left: 100, top: 130, maxHeight: 246 })
  })

  it('stays below and scrolls in a short drawer', () => {
    const short = { width: 1400, height: 120 }
    expect(placeMenu(anchor, { width: 200, height: 300 }, short)).toEqual({ left: 100, top: 44, maxHeight: 72 })
  })
})

describe('placeSubmenu', () => {
  const view = { width: 800, height: 300 }
  const item = { left: 100, top: 60, right: 260, bottom: 82 }

  it('opens to the right, its first item level with the one that opened it', () => {
    expect(placeSubmenu(item, { width: 180, height: 100 }, view)).toEqual({ left: 260, top: 56, maxHeight: 292 })
  })

  it('flips to the left at the panel edge', () => {
    const edge = { left: 560, top: 60, right: 720, bottom: 82 }
    expect(placeSubmenu(edge, { width: 180, height: 100 }, view).left).toBe(380)
  })

  it('overlaps rather than leaving a panel too narrow for either side', () => {
    const narrow = { width: 300, height: 300 }
    expect(placeSubmenu({ left: 60, top: 60, right: 240, bottom: 82 }, { width: 180, height: 100 }, narrow).left).toBe(4)
  })

  it('moves up to stay on screen', () => {
    const low = { left: 100, top: 250, right: 260, bottom: 272 }
    expect(placeSubmenu(low, { width: 180, height: 100 }, view).top).toBe(196)
  })

  it('scrolls when taller than a short panel', () => {
    const short = { width: 800, height: 120 }
    expect(placeSubmenu(item, { width: 180, height: 400 }, short)).toEqual({ left: 260, top: 4, maxHeight: 112 })
  })
})

describe('sidebarShowsRate', () => {
  it('drops the rate below 200 px so the host keeps room, and shows it before the first measure', () => {
    expect(SIDEBAR_RATE_WIDTH).toBe(200)
    expect(sidebarShowsRate(240)).toBe(true)
    expect(sidebarShowsRate(200)).toBe(true)
    expect(sidebarShowsRate(160)).toBe(false)
    expect(sidebarShowsRate(0)).toBe(true)
  })
})

describe('tabMenuHasConnection', () => {
  it("leaves the connection's section to the row gauge in a short drawer", () => {
    expect(tabMenuHasConnection(panelLayout(1200, 272))).toBe(false)
    expect(tabMenuHasConnection(panelLayout(1200, 700))).toBe(true)
  })
  it('keeps it in a narrow panel, which has no rows', () => {
    expect(tabMenuHasConnection(panelLayout(420, 900))).toBe(true)
    expect(tabMenuHasConnection(panelLayout(420, 272))).toBe(true)
  })
  it('keeps it when the sidebar is collapsed, which has no gauges', () => {
    expect(tabMenuHasConnection(panelLayout(1200, 272), true)).toBe(true)
  })
})

describe('SIDEBAR_COLLAPSED_WIDTH', () => {
  it('is the four 24 px buttons with their gaps and the bar padding', () => {
    expect(SIDEBAR_COLLAPSED_WIDTH).toBe(110)
  })
})

describe('logoPlace', () => {
  it('sits in the sidebar part of the toolbar, before the compact toggle', () => {
    expect(logoPlace(true, false)).toBe('head')
  })
  it('moves to the foot of a compact sidebar that its buttons fill', () => {
    expect(logoPlace(true, true)).toBe('side')
  })
  it('goes to the status footer with no sidebar', () => {
    expect(logoPlace(false, false)).toBe('footer')
    expect(logoPlace(false, true)).toBe('footer')
  })
})
