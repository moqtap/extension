import { describe, expect, it } from 'vitest'
import {
  ariaSort,
  clampWidth,
  columnShown,
  EMPTY_GRID_PREFS,
  type GridColumn,
  gridTemplate,
  groupItems,
  nextSort,
  followsTail,
  itemAt,
  offsetsOf,
  revealTop,
  rowInView,
  rowKeyTarget,
  sortRows,
} from './grid'

describe('nextSort', () => {
  it('goes ascending, descending, then back to arrival order', () => {
    const a = nextSort(null, 'size')
    expect(a).toEqual({ column: 'size', dir: 'ascending' })
    const b = nextSort(a, 'size')
    expect(b).toEqual({ column: 'size', dir: 'descending' })
    expect(nextSort(b, 'size')).toBeNull()
  })

  it('starts ascending on another column', () => {
    expect(nextSort({ column: 'size', dir: 'descending' }, 'id')).toEqual({ column: 'id', dir: 'ascending' })
  })

  it('names the sorted column for aria-sort and none for the rest', () => {
    const s = { column: 'id', dir: 'descending' as const }
    expect(ariaSort(s, 'id')).toBe('descending')
    expect(ariaSort(s, 'size')).toBe('none')
    expect(ariaSort(null, 'id')).toBe('none')
  })
})

describe('sortRows', () => {
  const rows = [
    { n: 'b', v: 3 },
    { n: 'a', v: null },
    { n: 'c', v: 1 },
    { n: 'd', v: 3 },
  ]

  it('sorts numbers both ways, keeping ties in arrival order', () => {
    expect(sortRows(rows, (r) => r.v, 'ascending').map((r) => r.n)).toEqual(['c', 'b', 'd', 'a'])
    expect(sortRows(rows, (r) => r.v, 'descending').map((r) => r.n)).toEqual(['b', 'd', 'c', 'a'])
  })

  it('puts rows with no value last in either direction', () => {
    expect(sortRows(rows, (r) => r.v, 'descending').at(-1)?.n).toBe('a')
  })

  it('sorts text naturally and without case', () => {
    const names = ['video/10', 'Video/2', 'audio']
    expect(sortRows(names, (n) => n, 'ascending')).toEqual(['audio', 'Video/2', 'video/10'])
  })

  it('leaves the input as it was', () => {
    const copy = [...rows]
    sortRows(rows, (r) => r.v, 'ascending')
    expect(rows).toEqual(copy)
  })
})

describe('columnShown', () => {
  const name: GridColumn<never> = { id: 'name', label: 'Track', pinned: true }
  const dir: GridColumn<never> = { id: 'dir', label: 'Dir', width: 28, showFrom: 560 }
  const size: GridColumn<never> = { id: 'size', label: 'Size', width: 70 }

  it('hides secondary columns by default when the grid is narrow', () => {
    expect(columnShown(dir, EMPTY_GRID_PREFS, 420)).toBe(false)
    expect(columnShown(dir, EMPTY_GRID_PREFS, 560)).toBe(true)
    expect(columnShown(size, EMPTY_GRID_PREFS, 200)).toBe(true)
  })

  it('follows what the user picked at any width', () => {
    const prefs = { ...EMPTY_GRID_PREFS, shown: { dir: true, size: false } }
    expect(columnShown(dir, prefs, 300)).toBe(true)
    expect(columnShown(size, prefs, 1400)).toBe(false)
  })

  it('never hides a pinned column', () => {
    expect(columnShown(name, { ...EMPTY_GRID_PREFS, shown: { name: false } }, 100)).toBe(true)
  })
})

describe('gridTemplate', () => {
  const cols: GridColumn<never>[] = [
    { id: 'id', label: 'ID', width: 52, minWidth: 40 },
    { id: 'name', label: 'Track', minWidth: 96 },
    { id: 'size', label: 'Size', width: 70 },
  ]

  it('gives the free column the rest, the others their width', () => {
    expect(gridTemplate(cols, {})).toBe('52px minmax(96px, 1fr) 70px')
  })

  it('uses dragged widths within the limits', () => {
    expect(gridTemplate(cols, { id: 10, size: 120.4 })).toBe('40px minmax(96px, 1fr) 120px')
    expect(clampWidth(cols[2], 5000)).toBe(900)
  })
})

describe('groupItems', () => {
  const rows = [
    { ns: 'live', n: 1 },
    { ns: 'vod', n: 2 },
    { ns: 'live', n: 3 },
  ]

  it('lists rows as they are without a grouping', () => {
    expect(groupItems(rows, undefined, new Set()).map((i) => i.kind)).toEqual(['row', 'row', 'row'])
  })

  it('puts each group header before its rows, in first-seen order', () => {
    const items = groupItems(rows, (r) => r.ns, new Set())
    expect(items.map((i) => (i.kind === 'group' ? `${i.label}:${i.count}` : i.row.n))).toEqual([
      'live:2',
      1,
      3,
      'vod:1',
      2,
    ])
  })

  it('drops the rows of a collapsed group and numbers the rest in order', () => {
    const items = groupItems(rows, (r) => r.ns, new Set(['live']))
    expect(items).toEqual([
      { kind: 'group', key: 'live', label: 'live', count: 2, collapsed: true },
      { kind: 'group', key: 'vod', label: 'vod', count: 1, collapsed: false },
      { kind: 'row', row: rows[1], index: 0 },
    ])
  })
})

describe('rowKeyTarget', () => {
  it('moves by one, by a page, and to the ends, within the rows', () => {
    expect(rowKeyTarget('ArrowDown', 3, 10, 5)).toBe(4)
    expect(rowKeyTarget('ArrowDown', 9, 10, 5)).toBe(9)
    expect(rowKeyTarget('ArrowUp', 0, 10, 5)).toBe(0)
    expect(rowKeyTarget('PageDown', 3, 10, 5)).toBe(8)
    expect(rowKeyTarget('PageUp', 3, 10, 5)).toBe(0)
    expect(rowKeyTarget('Home', 3, 10, 5)).toBe(0)
    expect(rowKeyTarget('End', 3, 10, 5)).toBe(9)
  })

  it('ignores other keys and empty grids', () => {
    expect(rowKeyTarget('a', 3, 10, 5)).toBeNull()
    expect(rowKeyTarget('ArrowDown', 0, 0, 5)).toBeNull()
  })
})

describe('rowInView and revealTop', () => {
  // 21 px rows, a 210 px viewport: the header takes one row, nine rows show.
  it('counts a row under the sticky header as in view', () => {
    expect(rowInView(0, 21, 0, 210)).toBe(true)
    expect(rowInView(8 * 21, 21, 0, 210)).toBe(true)
    expect(rowInView(9 * 21, 21, 0, 210)).toBe(false)
    expect(rowInView(4 * 21, 21, 5 * 21, 210)).toBe(false)
  })

  it('scrolls the shortest way, and not at all when the row shows', () => {
    expect(revealTop(3 * 21, 21, 0, 210)).toBeNull()
    expect(revealTop(20 * 21, 21, 0, 210)).toBe(22 * 21 - 210)
    expect(revealTop(2 * 21, 21, 10 * 21, 210)).toBe(2 * 21)
    expect(revealTop(-1, 21, 0, 210)).toBeNull()
  })

  it('brings a row back after the viewport shrinks under it', () => {
    // A row at the bottom of a tall list, then the list shrinks to 230 px.
    const top = 0
    expect(rowInView(16 * 21, 21, top, 400)).toBe(true)
    const next = revealTop(16 * 21, 21, top, 230)
    expect(next).not.toBeNull()
    expect(rowInView(16 * 21, 21, next!, 230)).toBe(true)
  })
})

describe('offsets of rows that open', () => {
  it('places each item after the ones before it and finds the item at a point', () => {
    const offsets = offsetsOf([21, 21 + 67, 21])
    expect(offsets).toEqual([0, 21, 109, 130])
    expect(itemAt(offsets, 0)).toBe(0)
    expect(itemAt(offsets, 20)).toBe(0)
    expect(itemAt(offsets, 21)).toBe(1)
    expect(itemAt(offsets, 108)).toBe(1)
    expect(itemAt(offsets, 129)).toBe(2)
    expect(itemAt(offsets, 500)).toBe(3)
  })
})

describe('followsTail', () => {
  const base = { follow: true, sorted: false, atEnd: true, selected: false }
  it('follows at the end of an unsorted live grid', () => {
    expect(followsTail(base)).toBe(true)
  })
  it('stops while a row is selected, sorted, or scrolled up', () => {
    expect(followsTail({ ...base, selected: true })).toBe(false)
    expect(followsTail({ ...base, sorted: true })).toBe(false)
    expect(followsTail({ ...base, atEnd: false })).toBe(false)
    expect(followsTail({ ...base, follow: false })).toBe(false)
  })
})
