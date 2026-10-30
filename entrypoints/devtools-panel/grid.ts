/** Column, sort and width rules for the panel's data grids. */

export type SortDir = 'ascending' | 'descending'

export interface SortState {
  column: string
  dir: SortDir
}

export type SortValue = string | number | null | undefined

export interface GridColumn<R = unknown> {
  id: string
  /** Header text; also the column menu's entry */
  label: string
  /** Header text for the screen reader only (icon columns) */
  srOnly?: boolean
  /** Default width in px; the one column without it takes the free space */
  width?: number
  /** Narrowest width in px; for the free column, the least it keeps */
  minWidth?: number
  /** Shown by default only when the grid is at least this wide */
  showFrom?: number
  /** Never hidden: the name, and status or errors */
  pinned?: boolean
  align?: 'start' | 'center' | 'end'
  /** IDs, sizes and times: monospaced */
  mono?: boolean
  /** Header tooltip */
  title?: string
  /** What the column sorts by; absent when it does not sort */
  sort?: (row: R) => SortValue
}

export interface GridPrefs {
  widths: Record<string, number>
  /** Columns the user showed or hid; the rest follow the grid's width */
  shown: Record<string, boolean>
  sort: SortState | null
}

export const EMPTY_GRID_PREFS: GridPrefs = { widths: {}, shown: {}, sort: null }

const MIN_WIDTH = 28
const MAX_WIDTH = 900
const FREE_MIN = 120

/** A header click: ascending, then descending, then the arrival order again. */
export function nextSort(current: SortState | null, column: string): SortState | null {
  if (current?.column !== column) return { column, dir: 'ascending' }
  return current.dir === 'ascending' ? { column, dir: 'descending' } : null
}

export function ariaSort(sort: SortState | null, column: string): 'ascending' | 'descending' | 'none' {
  return sort?.column === column ? sort.dir : 'none'
}

function compare(a: SortValue, b: SortValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

/** Rows in `dir` order by `value`, stable; rows with no value last either way. */
export function sortRows<R>(rows: readonly R[], value: (row: R) => SortValue, dir: SortDir): R[] {
  const sign = dir === 'ascending' ? 1 : -1
  return rows
    .map((row, i) => ({ row, i, v: value(row) }))
    .sort((a, b) => {
      const an = a.v === null || a.v === undefined || a.v === ''
      const bn = b.v === null || b.v === undefined || b.v === ''
      if (an || bn) return an === bn ? a.i - b.i : an ? 1 : -1
      return sign * compare(a.v, b.v) || a.i - b.i
    })
    .map((x) => x.row)
}

/** Whether a column shows in a grid `gridWidth` px wide. */
export function columnShown(col: GridColumn<never>, prefs: GridPrefs, gridWidth: number): boolean {
  if (col.pinned) return true
  return prefs.shown[col.id] ?? gridWidth >= (col.showFrom ?? 0)
}

/** A dragged width within the column's limits. */
export function clampWidth(col: GridColumn<never>, width: number): number {
  return Math.round(Math.min(MAX_WIDTH, Math.max(col.minWidth ?? MIN_WIDTH, width)))
}

/** The grid-template-columns value: fixed columns at their width, the free one taking the rest. */
export function gridTemplate(cols: readonly GridColumn<never>[], widths: Record<string, number>): string {
  return cols
    .map((c) =>
      c.width === undefined
        ? `minmax(${c.minWidth ?? FREE_MIN}px, 1fr)`
        : `${clampWidth(c, widths[c.id] ?? c.width)}px`,
    )
    .join(' ')
}

/** A grid's display rows: namespace headers with their rows under them, collapsed ones without. */
export type GridItem<R> =
  | { kind: 'group'; key: string; label: string; count: number; collapsed: boolean }
  | { kind: 'row'; row: R; index: number }

export function groupItems<R>(
  rows: readonly R[],
  groupOf: ((row: R) => string) | undefined,
  collapsed: ReadonlySet<string>,
): GridItem<R>[] {
  if (!groupOf) return rows.map((row, index) => ({ kind: 'row', row, index }))
  const groups = new Map<string, R[]>()
  for (const row of rows) {
    const key = groupOf(row)
    const list = groups.get(key)
    if (list) list.push(row)
    else groups.set(key, [row])
  }
  const out: GridItem<R>[] = []
  let index = 0
  for (const [key, list] of groups) {
    const shut = collapsed.has(key)
    out.push({ kind: 'group', key, label: key, count: list.length, collapsed: shut })
    if (!shut) for (const row of list) out.push({ kind: 'row', row, index: index++ })
  }
  return out
}

/** The item index a key moves the focus to, or null when the key is not for the grid. */
export function rowKeyTarget(key: string, current: number, count: number, pageRows: number): number | null {
  if (count === 0) return null
  const last = count - 1
  switch (key) {
    case 'ArrowDown':
      return Math.min(last, current + 1)
    case 'ArrowUp':
      return Math.max(0, current - 1)
    case 'PageDown':
      return Math.min(last, current + Math.max(1, pageRows))
    case 'PageUp':
      return Math.max(0, current - Math.max(1, pageRows))
    case 'Home':
      return 0
    case 'End':
      return last
    default:
      return null
  }
}

/**
 * Whether the row at `top` px is wholly in view under a one-row sticky
 * header, rows being `row` px tall; a negative `top` is no row.
 */
export function rowInView(top: number, row: number, scrollTop: number, clientHeight: number): boolean {
  return top >= 0 && top >= scrollTop && top + 2 * row <= scrollTop + clientHeight
}

/** The scrollTop that brings the row at `top` px into view by the shortest scroll, or null when it is in view. */
export function revealTop(top: number, row: number, scrollTop: number, clientHeight: number): number | null {
  if (top < 0 || rowInView(top, row, scrollTop, clientHeight)) return null
  if (top < scrollTop) return top
  return Math.max(0, top + 2 * row - clientHeight)
}

/** Where each item starts, and as the last entry where the list ends. */
export function offsetsOf(heights: readonly number[]): number[] {
  const out = new Array<number>(heights.length + 1)
  out[0] = 0
  for (let i = 0; i < heights.length; i++) out[i + 1] = out[i]! + heights[i]!
  return out
}

/** The item at `y` px, by {@link offsetsOf}; the item count past the end. */
export function itemAt(offsets: readonly number[], y: number): number {
  let lo = 0
  let hi = offsets.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid + 1]! <= y) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** A live grid follows its newest row only at its end, unsorted, with no row selected. */
export function followsTail(opts: { follow: boolean; sorted: boolean; atEnd: boolean; selected: boolean }): boolean {
  return opts.follow && !opts.sorted && opts.atEnd && !opts.selected
}
