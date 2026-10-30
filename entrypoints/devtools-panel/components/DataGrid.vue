<script lang="ts" setup generic="R">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, toRaw, watch } from 'vue'
import {
  ariaSort,
  clampWidth,
  columnShown,
  EMPTY_GRID_PREFS,
  followsTail,
  type GridColumn,
  type GridPrefs,
  gridTemplate,
  groupItems,
  itemAt,
  nextSort,
  offsetsOf,
  revealTop,
  rowInView,
  rowKeyTarget,
  sortRows,
} from '../grid'
import { formatCount } from '../format'
import { rowHeight } from '../host'
import { getCachedPref, savePref } from '../prefs'
import Icon from './Icon.vue'
import PopupMenu from './PopupMenu.vue'

/**
 * A virtualised data grid in the DevTools manner: sortable headers, widths
 * you drag, a header menu to show and hide columns, zebra rows. Widths, shown
 * columns and sort are kept per `gridId`.
 */
const props = defineProps<{
  gridId: string
  label: string
  columns: GridColumn<R>[]
  rows: R[]
  rowKey: (row: R) => string | number
  selectedKey?: string | number | null
  rowClass?: (row: R) => string | undefined
  groupOf?: (row: R) => string
  /** Keep the newest row in view while scrolled to the end and unsorted */
  follow?: boolean
  /**
   * A row opens in place to show the columns not shown. It opens only while
   * `actionColumn` (the control a click on the row stands for) is not shown.
   */
  expandable?: boolean
  actionColumn?: string
}>()

const emit = defineEmits<{
  /** A row was clicked or reached with the arrow keys. */
  activate: [row: R]
  /** A row was clicked or Enter pressed on it, not reached with the arrows. */
  open: [row: R]
}>()

defineSlots<{
  /** `current`: the row is the grid's tab stop, so its controls take Tab */
  cell(props: { row: R; column: GridColumn<R>; current: boolean }): unknown
}>()

const ROW = rowHeight()
const OVERSCAN = 8

// ── Prefs ─────────────────────────────────────────────────────────
const stored = getCachedPref('grids')[props.gridId]
const prefs = reactive<GridPrefs>({
  widths: { ...(stored?.widths ?? EMPTY_GRID_PREFS.widths) },
  shown: { ...(stored?.shown ?? EMPTY_GRID_PREFS.shown) },
  sort: stored?.sort ?? null,
})
function save() {
  const all = getCachedPref('grids')
  void savePref('grids', {
    ...all,
    [props.gridId]: { widths: { ...prefs.widths }, shown: { ...prefs.shown }, sort: prefs.sort },
  })
}

// ── Columns ───────────────────────────────────────────────────────
const root = ref<HTMLElement | null>(null)
const width = ref(0)
const viewport = ref(0)
const scrollTop = ref(0)

const shownColumns = computed(() =>
  props.columns.filter((c) => columnShown(c as GridColumn<never>, prefs, width.value)),
)
const template = computed(() => gridTemplate(shownColumns.value as GridColumn<never>[], prefs.widths))
const minWidth = computed(() =>
  shownColumns.value.reduce(
    (sum, c) => sum + (c.width === undefined ? (c.minWidth ?? 120) : clampWidth(c as GridColumn<never>, prefs.widths[c.id] ?? c.width)),
    0,
  ),
)
const hideable = computed(() => props.columns.filter((c) => !c.pinned))
/** The columns a row's expansion lists: what is not shown, the action last. */
const hiddenColumns = computed(() => {
  const hidden = props.columns.filter((c) => !shownColumns.value.includes(c))
  return [...hidden.filter((c) => c.id !== props.actionColumn), ...hidden.filter((c) => c.id === props.actionColumn)]
})
/** Rows open while the row's own action is out of view and something is hidden. */
const rowsOpen = computed(
  () =>
    !!props.expandable &&
    hiddenColumns.value.length > 0 &&
    !shownColumns.value.some((c) => c.id === props.actionColumn),
)

// ── Rows ──────────────────────────────────────────────────────────
const sortColumn = computed(() => {
  const s = prefs.sort
  const col = s ? props.columns.find((c) => c.id === s.column) : undefined
  return s && col?.sort ? { col, dir: s.dir } : null
})
const sortedRows = computed(() => {
  const s = sortColumn.value
  return s ? sortRows(props.rows, s.col.sort!, s.dir) : props.rows
})
const collapsed = ref(new Set<string>())
const items = computed(() => groupItems(sortedRows.value, props.groupOf, collapsed.value))

/** Open rows, by key */
const expanded = ref(new Set<string | number>())
const EXPANSION_PAD = 4
/** An open row's expansion: a line per hidden column. */
const expansionHeight = computed(() => hiddenColumns.value.length * ROW + 2 * EXPANSION_PAD)
function isExpanded(row: R): boolean {
  return rowsOpen.value && expanded.value.has(keyOf(row))
}
const offsets = computed(() =>
  offsetsOf(
    items.value.map((it) => (it.kind === 'row' && isExpanded(it.row) ? ROW + expansionHeight.value : ROW)),
  ),
)
function topOf(pos: number): number {
  return pos < 0 ? -1 : (offsets.value[pos] ?? -1)
}

const range = computed(() => {
  const start = Math.max(0, itemAt(offsets.value, scrollTop.value) - OVERSCAN)
  const end = Math.min(items.value.length, itemAt(offsets.value, scrollTop.value + viewport.value) + 1 + OVERSCAN)
  return { start, end }
})
const visible = computed(() =>
  items.value.slice(range.value.start, range.value.end).map((item, i) => ({ item, pos: range.value.start + i })),
)

function keyOf(row: R): string | number {
  return props.rowKey(toRaw(row) as R)
}
function posOfKey(key: string | number | null | undefined): number {
  if (key === null || key === undefined) return -1
  return items.value.findIndex((it) => it.kind === 'row' && keyOf(it.row) === key)
}

// ── Scrolling ─────────────────────────────────────────────────────
const atEnd = ref(true)
const hasSelection = computed(() => props.selectedKey !== undefined && props.selectedKey !== null)
/** The selected row was in view when last looked at, so resizes and updates keep it there. */
let keepSelected = hasSelection.value
function onScroll() {
  const el = root.value
  if (!el) return
  scrollTop.value = el.scrollTop
  atEnd.value = el.scrollHeight - el.scrollTop - el.clientHeight < ROW
  // A scroll the browser makes while resizing is not the user leaving the row.
  if (hasSelection.value && el.clientHeight === viewport.value) {
    keepSelected = rowInView(topOf(posOfKey(props.selectedKey)), ROW, el.scrollTop, el.clientHeight)
  }
}

/** Scroll so the item at `pos` is under the sticky header, not behind it. */
function reveal(pos: number) {
  const el = root.value
  if (!el) return
  const top = revealTop(topOf(pos), ROW, el.scrollTop, el.clientHeight)
  if (top !== null) el.scrollTop = top
}

function keepSelectedInView() {
  if (!keepSelected || !hasSelection.value) return
  void nextTick(() => reveal(posOfKey(props.selectedKey)))
}

watch(
  () => items.value.length,
  () => {
    if (followsTail({ follow: !!props.follow, sorted: !!sortColumn.value, atEnd: atEnd.value, selected: hasSelection.value })) {
      void nextTick(() => {
        if (root.value) root.value.scrollTop = root.value.scrollHeight
      })
    }
  },
)
watch([items, viewport], keepSelectedInView)

let ro: ResizeObserver | null = null
onMounted(() => {
  const el = root.value
  if (!el) return
  width.value = el.clientWidth
  viewport.value = el.clientHeight
  ro = new ResizeObserver(() => {
    width.value = el.clientWidth
    viewport.value = el.clientHeight
  })
  ro.observe(el)
  if (props.follow) el.scrollTop = el.scrollHeight
  const sel = posOfKey(props.selectedKey)
  if (sel >= 0) reveal(sel)
})
onBeforeUnmount(() => ro?.disconnect())

// ── Focus and keys ────────────────────────────────────────────────
const focusPos = ref(0)
watch(
  () => props.selectedKey,
  (key) => {
    const pos = posOfKey(key)
    if (pos >= 0) focusPos.value = pos
    keepSelected = pos >= 0
    keepSelectedInView()
  },
  { immediate: true },
)
/** The row Tab lands on: the focused one, or the first in view when it has scrolled away. */
const tabPos = computed(() => {
  const { start, end } = range.value
  if (focusPos.value >= start && focusPos.value < end) return focusPos.value
  return Math.min(Math.max(start, itemAt(offsets.value, scrollTop.value)), Math.max(0, items.value.length - 1))
})

function focusRow(pos: number) {
  focusPos.value = pos
  reveal(pos)
  void nextTick(() => root.value?.querySelector<HTMLElement>(`[data-pos="${pos}"]`)?.focus())
}

function activate(pos: number) {
  const it = items.value[pos]
  if (!it) return
  focusPos.value = pos
  if (it.kind === 'group') toggleGroup(it.key)
  else {
    emit('activate', it.row)
    emit('open', it.row)
    if (rowsOpen.value) toggleExpanded(keyOf(it.row))
  }
}

function toggleExpanded(key: string | number) {
  const s = new Set(expanded.value)
  if (s.has(key)) s.delete(key)
  else s.add(key)
  expanded.value = s
}

function onRowKey(e: KeyboardEvent, pos: number) {
  // Keys in a control inside a cell stay with the control.
  if (e.target !== e.currentTarget) return
  const it = items.value[pos]
  if (it?.kind === 'group' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    if (it.collapsed === (e.key === 'ArrowRight')) toggleGroup(it.key)
    e.preventDefault()
    return
  }
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    activate(pos)
    return
  }
  const page = Math.max(1, Math.floor(viewport.value / ROW) - 1)
  const next = rowKeyTarget(e.key, pos, items.value.length, page)
  if (next === null) return
  e.preventDefault()
  focusRow(next)
  const target = items.value[next]
  if (target?.kind === 'row') emit('activate', target.row)
}

function toggleGroup(key: string) {
  const s = new Set(collapsed.value)
  if (s.has(key)) s.delete(key)
  else s.add(key)
  collapsed.value = s
}

/** Left and right move between the sortable headers; one of them is the tab stop. */
const headFocus = ref(0)
function onHeadKey(e: KeyboardEvent) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  const btns = Array.from(root.value?.querySelectorAll<HTMLElement>('.grid-sort') ?? [])
  const i = btns.indexOf(document.activeElement as HTMLElement)
  const next = btns[i + (e.key === 'ArrowRight' ? 1 : -1)]
  if (!next) return
  e.preventDefault()
  headFocus.value = btns.indexOf(next)
  next.focus()
}
const sortableIds = computed(() => shownColumns.value.filter((c) => c.sort).map((c) => c.id))

// ── Sorting and widths ────────────────────────────────────────────
function toggleSort(id: string) {
  prefs.sort = nextSort(prefs.sort, id)
  save()
}

let drag: { col: GridColumn<R>; x: number; w: number } | null = null
function startResize(e: PointerEvent, col: GridColumn<R>) {
  const handle = e.currentTarget as HTMLElement
  handle.setPointerCapture(e.pointerId)
  drag = { col, x: e.clientX, w: prefs.widths[col.id] ?? col.width ?? 0 }
}
function moveResize(e: PointerEvent) {
  if (!drag) return
  prefs.widths[drag.col.id] = clampWidth(drag.col as GridColumn<never>, drag.w + e.clientX - drag.x)
}
function endResize() {
  if (!drag) return
  drag = null
  save()
}
function resetWidth(col: GridColumn<R>) {
  delete prefs.widths[col.id]
  save()
}

// ── Column menu ───────────────────────────────────────────────────
const menuAnchor = ref<HTMLElement | null>(null)
function openMenu(e: MouseEvent) {
  const cell = (e.target as HTMLElement).closest<HTMLElement>('.grid-hcell')
  menuAnchor.value = cell?.querySelector<HTMLElement>('.grid-sort') ?? cell ?? root.value
}
function isShown(col: GridColumn<R>): boolean {
  return shownColumns.value.includes(col)
}
function toggleColumn(col: GridColumn<R>) {
  prefs.shown[col.id] = !isShown(col)
  save()
}
function resetColumns() {
  prefs.shown = {}
  prefs.widths = {}
  save()
}

defineExpose({
  /** Bring a row into view and make it the focus stop. */
  reveal(key: string | number) {
    const pos = posOfKey(key)
    if (pos < 0) return
    focusPos.value = pos
    void nextTick(() => reveal(pos))
  },
})
</script>

<template>
  <div
    ref="root"
    class="data-grid"
    role="grid"
    :aria-label="label"
    :aria-rowcount="items.length + 1"
    :aria-colcount="shownColumns.length"
    @scroll.passive="onScroll"
  >
    <div
      class="grid-head"
      role="row"
      aria-rowindex="1"
      :style="{ gridTemplateColumns: template, minWidth: `${minWidth}px` }"
      @contextmenu.prevent="openMenu"
      @keydown="onHeadKey"
    >
      <div
        v-for="col in shownColumns"
        :key="col.id"
        class="grid-hcell"
        :class="`align-${col.align ?? 'start'}`"
        role="columnheader"
        :aria-sort="col.sort ? ariaSort(prefs.sort, col.id) : undefined"
        :title="col.title"
      >
        <button
          v-if="col.sort"
          class="grid-sort"
          :tabindex="sortableIds.indexOf(col.id) === Math.min(headFocus, sortableIds.length - 1) ? 0 : -1"
          @click="toggleSort(col.id)"
        >
          <span class="grid-hlabel" :class="{ 'mq-sr': col.srOnly }">{{ col.label }}</span>
          <Icon
            v-if="prefs.sort?.column === col.id"
            class="grid-sort-icon"
            :name="prefs.sort.dir === 'ascending' ? 'chevronUp' : 'chevronDown'"
          />
        </button>
        <span v-else class="grid-hlabel" :class="{ 'mq-sr': col.srOnly }">{{ col.label }}</span>
        <span
          v-if="col.width !== undefined"
          class="grid-resize"
          aria-hidden="true"
          @pointerdown.stop.prevent="startResize($event, col)"
          @pointermove="moveResize"
          @pointerup="endResize"
          @pointercancel="endResize"
          @dblclick="resetWidth(col)"
        />
      </div>
    </div>
    <div class="grid-body" :style="{ height: `${offsets[items.length]}px`, minWidth: `${minWidth}px` }">
      <template v-for="{ item, pos } in visible" :key="item.kind === 'group' ? `g:${item.key}` : keyOf(item.row)">
        <div
          v-if="item.kind === 'group'"
          class="grid-row grid-group"
          role="row"
          :aria-rowindex="pos + 2"
          :aria-expanded="!item.collapsed"
          :tabindex="pos === tabPos ? 0 : -1"
          :data-pos="pos"
          :style="{ top: `${offsets[pos]}px` }"
          @click="activate(pos)"
          @keydown="onRowKey($event, pos)"
        >
          <div class="grid-cell" role="gridcell" :aria-colspan="shownColumns.length">
            <Icon :name="item.collapsed ? 'chevronRight' : 'chevronDown'" class="group-chevron" />
            <span class="group-label">{{ item.label }}</span>
            <span class="group-count">{{ formatCount(item.count) }}</span>
          </div>
        </div>
        <template v-else>
        <div
          class="grid-row"
          :class="[
            rowClass?.(item.row),
            {
              'grid-row--opens': rowsOpen,
              'row-alt': item.index % 2 === 1,
              'row-selected': selectedKey !== undefined && selectedKey !== null && keyOf(item.row) === selectedKey,
            },
          ]"
          role="row"
          :aria-rowindex="pos + 2"
          :aria-selected="selectedKey !== undefined && selectedKey !== null && keyOf(item.row) === selectedKey"
          :aria-expanded="rowsOpen ? isExpanded(item.row) : undefined"
          :tabindex="pos === tabPos ? 0 : -1"
          :data-pos="pos"
          :style="{ top: `${offsets[pos]}px`, gridTemplateColumns: template }"
          @click="activate(pos)"
          @keydown="onRowKey($event, pos)"
        >
          <div
            v-for="col in shownColumns"
            :key="col.id"
            class="grid-cell"
            :class="[`align-${col.align ?? 'start'}`, { 'grid-cell--mono': col.mono }]"
            role="gridcell"
          >
            <slot name="cell" :row="item.row" :column="col" :current="pos === tabPos" />
          </div>
        </div>
        <div
          v-if="isExpanded(item.row)"
          class="grid-expansion"
          :class="{ 'row-alt': item.index % 2 === 1 }"
          role="row"
          :style="{ top: `${offsets[pos]! + ROW}px`, height: `${expansionHeight}px`, padding: `${EXPANSION_PAD}px 0` }"
        >
          <div class="grid-expansion__cell" role="gridcell" :aria-colspan="shownColumns.length">
            <div v-for="col in hiddenColumns" :key="col.id" class="grid-expansion__line">
              <span class="grid-expansion__label">{{ col.id === actionColumn ? '' : col.label }}</span>
              <span class="grid-expansion__value" :class="{ 'grid-cell--mono': col.mono }">
                <slot name="cell" :row="item.row" :column="col" :current="true" />
              </span>
            </div>
          </div>
        </div>
        </template>
      </template>
    </div>
    <PopupMenu v-if="menuAnchor" :anchor="menuAnchor" :label="`${label} columns`" @close="menuAnchor = null">
      <button
        v-for="col in hideable"
        :key="col.id"
        class="mq-menu__item"
        role="menuitemcheckbox"
        :aria-checked="isShown(col)"
        data-keep-open
        @click="toggleColumn(col)"
      >
        {{ col.label }}
      </button>
      <hr role="separator" />
      <button class="mq-menu__item" role="menuitem" @click="resetColumns">Reset columns</button>
    </PopupMenu>
  </div>
</template>

<style scoped>
.data-grid {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: auto;
  background: var(--surface);
  font-variant-numeric: tabular-nums;
  overscroll-behavior: contain;
}

.grid-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: grid;
  height: var(--row-tool);
  background: var(--host-bar, var(--surface));
  border-bottom: 1px solid var(--line);
  color: var(--ink);
}
.grid-hcell {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
  border-right: 1px solid var(--line);
}
.grid-hcell:last-child {
  border-right: 0;
}
.grid-hcell:last-child > .grid-resize {
  right: 0;
}
.grid-sort {
  display: flex;
  align-items: center;
  gap: 2px;
  width: 100%;
  height: 100%;
  min-width: 0;
  padding: 0 6px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: inherit;
  cursor: pointer;
}
.grid-sort:hover {
  background: var(--surface-hover);
}
.align-end .grid-sort {
  flex-direction: row-reverse;
}
.grid-hcell > .grid-hlabel {
  padding: 0 6px;
}
.grid-hlabel {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grid-sort-icon {
  color: var(--ink-muted);
}
.grid-sort-icon :deep(svg) {
  width: 10px;
  height: 10px;
}
.grid-resize {
  position: absolute;
  top: 0;
  right: -3px;
  bottom: 0;
  z-index: 1;
  width: 6px;
  cursor: col-resize;
  touch-action: none;
}

.grid-body {
  position: relative;
}
.grid-row {
  position: absolute;
  left: 0;
  right: 0;
  display: grid;
  height: var(--row-tool);
  color: var(--ink);
  cursor: default;
}
.grid-row--opens {
  cursor: pointer;
}
.grid-row.row-alt:not(.row-selected, .row-error, .row-warning) {
  background: var(--host-zebra, transparent);
}
.grid-row:hover:not(.row-selected) {
  background: var(--surface-hover);
}
.grid-row.row-error:not(.row-selected) {
  background: var(--danger-soft);
  color: var(--danger);
}
.grid-row.row-warning:not(.row-selected) {
  background: var(--warning-soft);
}
.grid-cell {
  min-width: 0;
  padding: 0 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: var(--row-tool);
}
.grid-cell--mono {
  font-family: var(--font-mono);
}
.align-center {
  text-align: center;
}
.align-end {
  text-align: right;
}
.grid-cell :deep(.ext-icon) {
  vertical-align: middle;
}
.grid-cell :deep(.ext-icon svg) {
  width: 12px;
  height: 12px;
}

.grid-expansion {
  position: absolute;
  left: 0;
  right: 0;
  box-sizing: border-box;
  border-bottom: 1px solid var(--line);
  color: var(--ink);
}
.grid-expansion.row-alt {
  background: var(--host-zebra, transparent);
}
/* Lines start under the name column, past the status and direction cells. */
.grid-expansion__line {
  display: grid;
  grid-template-columns: minmax(96px, max-content) minmax(0, 1fr);
  gap: var(--space-3);
  align-items: center;
  height: var(--row-tool);
  padding: 0 6px 0 34px;
}
.grid-expansion__label {
  color: var(--ink-muted);
  white-space: nowrap;
}
.grid-expansion__value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grid-expansion__value :deep(.ext-icon svg) {
  width: 12px;
  height: 12px;
}

.grid-group {
  display: block;
  background: var(--surface-sunken);
}
.grid-group .grid-cell {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.group-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.group-count {
  color: var(--ink-muted);
}
</style>
