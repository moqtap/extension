/** Sizing rules for the panel's resizable splits. */

export type SplitOrientation = 'horizontal' | 'vertical'

/** Below this width a list and its detail stack instead of sitting side by side. */
export const SPLIT_STACK_WIDTH = 600

export function splitOrientation(width: number, stackBelow = SPLIT_STACK_WIDTH): SplitOrientation {
  return width > 0 && width < stackBelow ? 'vertical' : 'horizontal'
}

/**
 * The first pane's size within `total`, keeping both panes at their minimum.
 * When both minimums do not fit, the panes share the space by their minimums.
 */
export function clampSplit(size: number, total: number, minFirst: number, minSecond: number): number {
  if (total <= 0) return 0
  if (minFirst + minSecond > total) return Math.round((total * minFirst) / (minFirst + minSecond))
  return Math.round(Math.min(total - minSecond, Math.max(minFirst, size)))
}

/** Arrow keys move the divider by `step`, Home and End to the limits. */
export function splitKeySize(
  key: string,
  size: number,
  orientation: SplitOrientation,
  step = 16,
): number | null {
  const back = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp'
  const fwd = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown'
  if (key === back) return size - step
  if (key === fwd) return size + step
  if (key === 'Home') return 0
  if (key === 'End') return Number.POSITIVE_INFINITY
  return null
}

/** What a split stores: its first pane in px, or as a share of the whole. */
export function storedSplit(size: number, total: number, unit: 'px' | 'ratio'): number {
  if (unit === 'px') return Math.round(size)
  return total > 0 ? Math.round((size / total) * 1000) / 1000 : 0
}

export function restoredSplit(stored: number, total: number, unit: 'px' | 'ratio'): number {
  return unit === 'px' ? stored : stored * total
}
