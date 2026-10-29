/**
 * The DevTools the panel sits in. host.css keys its look off the classes set
 * here; the metrics are set as properties so scripts and styles share them.
 */

export type Host = 'chrome' | 'firefox'

export interface HostMetrics {
  /** UI text size, px */
  text: number
  /** Grid row height, px */
  row: number
  /** Toolbar height without its border, px */
  bar: number
  /** Connection row height in the sidebar, px: at least an infobar's, a comfortable target */
  side: number
}

export const HOST_METRICS: Record<Host, HostMetrics> = {
  chrome: { text: 12, row: 21, bar: 26, side: 28 },
  firefox: { text: 11, row: 24, bar: 28, side: 30 },
}

export function currentHost(): Host {
  return import.meta.env.FIREFOX ? 'firefox' : 'chrome'
}

export function applyHost(root: HTMLElement, host: Host): void {
  root.classList.add('host', `host--${host}`)
  const m = HOST_METRICS[host]
  root.style.setProperty('--host-text', `${m.text}px`)
  root.style.setProperty('--row-tool', `${m.row}px`)
  root.style.setProperty('--header-tool', `${m.bar}px`)
  root.style.setProperty('--row-side', `${m.side}px`)
}

/** The grid row height in this DevTools, for virtual lists. */
export function rowHeight(): number {
  return HOST_METRICS[currentHost()].row
}
