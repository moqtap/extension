<script lang="ts">
import type { ProblemSeverity as Severity } from '../problems'

interface ListState {
  open: Set<string>
  closedGroups: Set<string>
  hidden: Set<Severity>
}
/** Which rows were open, by session, while the view comes and goes */
const remembered = new Map<string, ListState>()
</script>

<script lang="ts" setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { rowHeight } from '../host'
import {
  groupBySubject,
  type PanelProblem,
  problemJson,
  problemText,
  type ProblemGroup,
  type ProblemSeverity,
  type ProblemTarget,
  levelsLabel,
  rowKey,
  SEVERITIES,
  SEVERITY_NAMES,
  SEVERITY_PLURALS,
  severityCounts,
  showText,
} from '../problems'
import { vTruncatedTitle } from '../truncated-title'
import Icon from './Icon.vue'
import PopupMenu from './PopupMenu.vue'
import ProblemRow from './ProblemRow.vue'

/**
 * A session's problems as a tree: a header per subject, a row per problem,
 * what it found under the row's arrow. Drawn as it scrolls. `embedded` lists
 * the rows of one subject inline, with no headers and no toolbar.
 */
const props = defineProps<{
  problems: PanelProblem[]
  /** Session start, which times count from */
  startedAt: number
  /** The toolbar's filter text */
  filter: string
  /** The session in a line, for copied text */
  session: string
  /** Keeps which rows are open while the view comes and goes */
  stateKey: string
  /** Media tracks in the Tracks tab's order */
  trackOrder?: string[]
  embedded?: boolean
}>()

const emit = defineEmits<{
  open: [target: ProblemTarget]
}>()

const ICONS = { error: 'error', warning: 'warning', info: 'info' } as const

let saved = remembered.get(props.stateKey)
if (!saved) {
  saved = { open: new Set(), closedGroups: new Set(), hidden: new Set() }
  remembered.set(props.stateKey, saved)
}
const state = saved
const open = ref(new Set(state.open))
const closedGroups = ref(new Set(state.closedGroups))
const hidden = ref(new Set(state.hidden))
watch([open, closedGroups, hidden], () => {
  state.open = open.value
  state.closedGroups = closedGroups.value
  state.hidden = hidden.value
})

function matches(p: PanelProblem, q: string): boolean {
  if (!q) return true
  const hay = [
    p.title,
    p.subject.label,
    p.id,
    p.found ?? '',
    p.spec?.label ?? '',
    ...p.also.map((a) => a.label),
    ...p.items.flatMap((i) => [i.name, i.path ?? '']),
  ]
  return hay.some((h) => h.toLowerCase().includes(q))
}

const shown = computed(() => {
  const q = props.filter.trim().toLowerCase()
  return props.problems.filter((p) => !hidden.value.has(p.severity) && matches(p, q))
})
const groups = computed((): ProblemGroup[] => groupBySubject(shown.value, props.trackOrder))

type Item =
  | { kind: 'group'; key: string; group: ProblemGroup }
  | { kind: 'problem'; key: string; problem: PanelProblem; parent: string | null }

const items = computed((): Item[] => {
  if (props.embedded) {
    return shown.value.map((p) => ({ kind: 'problem', key: rowKey(p), problem: p, parent: null }))
  }
  const out: Item[] = []
  for (const g of groups.value) {
    const key = `g|${g.subject.key}`
    out.push({ kind: 'group', key, group: g })
    if (closedGroups.value.has(key)) continue
    for (const p of g.problems) out.push({ kind: 'problem', key: rowKey(p), problem: p, parent: key })
  }
  return out
})

// ─── Drawn as it scrolls ───────────────────────────────────────────

const ROW = rowHeight()
const OVERSCAN = 8
/** Measured heights of open problems, row included */
const measured = ref(new Map<string, number>())
const root = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewport = ref(0)

function heightOf(item: Item): number {
  if (item.kind === 'problem' && open.value.has(item.key)) {
    return measured.value.get(item.key) ?? ROW * 8
  }
  return ROW
}

const offsets = computed(() => {
  const out = new Array<number>(items.value.length + 1)
  out[0] = 0
  items.value.forEach((item, i) => (out[i + 1] = out[i]! + heightOf(item)))
  return out
})

function indexAt(y: number): number {
  const o = offsets.value
  let lo = 0
  let hi = items.value.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (o[mid + 1]! <= y) lo = mid + 1
    else hi = mid
  }
  return lo
}

const range = computed(() => {
  if (props.embedded) return { start: 0, end: items.value.length }
  const start = Math.max(0, indexAt(scrollTop.value) - OVERSCAN)
  const end = Math.min(items.value.length, indexAt(scrollTop.value + viewport.value) + 1 + OVERSCAN)
  return { start, end }
})

const visible = computed(() =>
  items.value.slice(range.value.start, range.value.end).map((item, i) => ({
    item,
    index: range.value.start + i,
  })),
)

function onScroll() {
  if (root.value) scrollTop.value = root.value.scrollTop
}

let sizeObserver: ResizeObserver | null = null
const rowObserver = new ResizeObserver((entries) => {
  let next: Map<string, number> | null = null
  for (const e of entries) {
    const key = (e.target as HTMLElement).dataset.key
    if (!key) continue
    const h = Math.round((e.target as HTMLElement).offsetHeight)
    if (measured.value.get(key) !== h) {
      next ??= new Map(measured.value)
      next.set(key, h)
    }
  }
  if (next) measured.value = next
})

onMounted(() => {
  const el = root.value
  if (!el || props.embedded) return
  viewport.value = el.clientHeight
  sizeObserver = new ResizeObserver(() => {
    viewport.value = el.clientHeight
  })
  sizeObserver.observe(el)
})
onBeforeUnmount(() => {
  sizeObserver?.disconnect()
  rowObserver.disconnect()
})

/** Open problems are measured while drawn. */
const vObserveOpen = {
  mounted(el: HTMLElement) {
    rowObserver.observe(el)
  },
  beforeUnmount(el: HTMLElement) {
    rowObserver.unobserve(el)
  },
}

// Rows added above the first visible one keep it where it was.
let anchor: { key: string; delta: number } | null = null
watch(
  items,
  () => {
    if (props.embedded || !root.value) return
    const i = indexAt(scrollTop.value)
    const item = items.value[i]
    anchor = item ? { key: item.key, delta: scrollTop.value - offsets.value[i]! } : null
  },
  { flush: 'pre' },
)
watch(
  offsets,
  () => {
    if (!anchor || !root.value) return
    const i = items.value.findIndex((x) => x.key === anchor!.key)
    if (i < 0) return
    const top = offsets.value[i]! + anchor.delta
    if (Math.abs(top - root.value.scrollTop) >= 1) root.value.scrollTop = top
    anchor = null
  },
  { flush: 'post' },
)

// ─── Toggles ──────────────────────────────────────────────────────

const levelsBtn = ref<HTMLButtonElement | null>(null)
const levelsOpen = ref(false)

function toggleSeverity(severity: ProblemSeverity) {
  const next = new Set(hidden.value)
  if (next.has(severity)) next.delete(severity)
  else next.add(severity)
  hidden.value = next
}

function setOpen(key: string, value: boolean) {
  if (open.value.has(key) === value) return
  const next = new Set(open.value)
  if (value) next.add(key)
  else next.delete(key)
  open.value = next
}

function setGroupOpen(key: string, value: boolean) {
  if (!closedGroups.value.has(key) === value) return
  const next = new Set(closedGroups.value)
  if (value) next.delete(key)
  else next.add(key)
  closedGroups.value = next
}

function isOpen(item: Item): boolean {
  return item.kind === 'group' ? !closedGroups.value.has(item.key) : open.value.has(item.key)
}

function toggle(item: Item) {
  if (item.kind === 'group') setGroupOpen(item.key, !isOpen(item))
  else setOpen(item.key, !isOpen(item))
}

// ─── Keyboard: the tree pattern ───────────────────────────────────

const currentKey = ref<string | null>(null)
const current = computed(() => {
  const i = items.value.findIndex((x) => x.key === currentKey.value)
  return i >= 0 ? i : 0
})

async function focusIndex(i: number) {
  const item = items.value[i]
  if (!item) return
  currentKey.value = item.key
  const el = root.value
  if (el && !props.embedded) {
    const top = offsets.value[i]!
    const bottom = offsets.value[i]! + ROW
    if (top < el.scrollTop) el.scrollTop = top
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
    scrollTop.value = el.scrollTop
  }
  await nextTick()
  root.value?.querySelector<HTMLElement>(`[data-index="${i}"] [role="treeitem"]`)?.focus()
}

function onKeydown(e: KeyboardEvent) {
  if (!(e.target as HTMLElement).matches('[role="treeitem"]')) return
  const i = current.value
  const item = items.value[i]
  if (!item) return
  const mod = e.ctrlKey || e.metaKey
  switch (e.key) {
    case 'ArrowDown':
      void focusIndex(Math.min(items.value.length - 1, i + 1))
      break
    case 'ArrowUp':
      void focusIndex(Math.max(0, i - 1))
      break
    case 'Home':
      void focusIndex(0)
      break
    case 'End':
      void focusIndex(items.value.length - 1)
      break
    case 'ArrowRight':
      if (!isOpen(item)) toggle(item)
      else if (item.kind === 'group') void focusIndex(i + 1)
      break
    case 'ArrowLeft':
      if (isOpen(item)) toggle(item)
      else if (item.kind === 'problem' && item.parent) {
        void focusIndex(items.value.findIndex((x) => x.key === item.parent))
      }
      break
    case ' ':
      toggle(item)
      break
    case 'Enter':
      if (item.kind === 'problem' && item.problem.places[0]) emit('open', item.problem.places[0].target)
      else toggle(item)
      break
    case 'c':
    case 'C':
      if (!mod || item.kind !== 'problem' || !window.getSelection()?.isCollapsed) return
      void copy(item.problem, 'text')
      break
    case 'f':
    case 'F':
      if (!mod) return
      document.querySelector<HTMLInputElement>('.filter-input')?.focus()
      break
    case 'F10':
      if (!e.shiftKey || item.kind !== 'problem') return
      openMenu(item.problem, e.target as HTMLElement, null)
      break
    case 'ContextMenu':
      if (item.kind !== 'problem') return
      openMenu(item.problem, e.target as HTMLElement, null)
      break
    default:
      return
  }
  e.preventDefault()
}

// ─── Copy and the context menu ────────────────────────────────────

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Every row's text stays selectable.
    return false
  }
}

function copy(p: PanelProblem, as: 'text' | 'json'): Promise<boolean> {
  const ctx = { startedAt: props.startedAt, session: props.session }
  return writeClipboard(as === 'text' ? problemText(p, ctx) : JSON.stringify(problemJson(p, ctx), null, 2))
}

function copyAll() {
  const ctx = { startedAt: props.startedAt, session: props.session }
  const list = props.embedded ? shown.value : groups.value.flatMap((g) => g.problems)
  return writeClipboard(list.map((p) => problemText(p, ctx)).join('\n\n'))
}

const menu = ref<{ problem: PanelProblem; anchor: HTMLElement; at: { x: number; y: number } | null } | null>(null)

function openMenu(problem: PanelProblem, anchor: HTMLElement, at: { x: number; y: number } | null) {
  menu.value = { problem, anchor, at }
}

function onRowMenu(problem: PanelProblem, e: MouseEvent | KeyboardEvent, anchor: HTMLElement) {
  openMenu(problem, anchor, e instanceof MouseEvent ? { x: e.clientX, y: e.clientY } : null)
}
</script>

<template>
  <!-- Filters only: the toolbar's counter carries the counts. -->
  <Teleport v-if="!embedded" to="#tab-tools" defer>
    <button
      ref="levelsBtn"
      class="mq-btn mq-btn--quiet levels-btn"
      aria-haspopup="menu"
      :aria-expanded="levelsOpen"
      :aria-label="`Show: ${levelsLabel(hidden)}`"
      @click="levelsOpen = !levelsOpen"
    >
      <span class="levels-label">{{ levelsLabel(hidden) }}</span>
      <Icon name="chevronDown" class="caret" />
    </button>
  </Teleport>
  <PopupMenu v-if="levelsOpen" :anchor="levelsBtn" label="Problem levels" @close="levelsOpen = false">
    <button
      v-for="s in SEVERITIES"
      :key="s"
      class="mq-menu__item"
      role="menuitemcheckbox"
      :aria-checked="!hidden.has(s)"
      data-keep-open
      @click="toggleSeverity(s)"
    >
      {{ SEVERITY_PLURALS[s] }}
    </button>
  </PopupMenu>
  <p v-if="items.length === 0" class="pane-message">No problems match this filter.</p>
  <div
    v-else
    ref="root"
    class="problem-tree"
    :class="{ 'problem-tree--embedded': embedded }"
    role="tree"
    aria-label="Problems"
    :style="{ '--problem-row': `${ROW}px` }"
    @scroll="onScroll"
    @keydown="onKeydown"
  >
    <div class="problem-space" :style="embedded ? undefined : { height: `${offsets[items.length]}px` }">
      <div
        v-for="{ item, index } in visible"
        :key="item.key"
        :data-index="index"
        class="problem-item"
        :style="embedded ? undefined : { top: `${offsets[index]}px` }"
      >
        <div
          v-if="item.kind === 'group'"
          class="group-row"
          role="treeitem"
          aria-level="1"
          :aria-expanded="isOpen(item)"
          :tabindex="index === current ? 0 : -1"
          @click="toggle(item)"
          @focus="currentKey = item.key"
        >
          <Icon :name="isOpen(item) ? 'chevronDown' : 'chevronRight'" class="group-chevron" />
          <span v-truncated-title class="group-label"
            ><span v-if="item.group.subject.kind !== 'session'" class="group-kind">{{
              item.group.subject.kind === 'catalog' ? 'Catalog' : 'Track'
            }}</span>
            {{ item.group.subject.label }}</span
          >
          <template v-for="s in SEVERITIES" :key="s">
            <span
              v-if="severityCounts(item.group.problems)[s] > 0"
              class="group-count"
              :class="`glyph--${s}`"
              ><Icon :name="ICONS[s]" /><span class="mq-sr">{{ SEVERITY_NAMES[s] }}</span
              >{{ severityCounts(item.group.problems)[s] }}</span
            >
          </template>
        </div>
        <ProblemRow
          v-else
          v-bind="open.has(item.key) ? { 'data-key': item.key } : {}"
          v-observe-open="open.has(item.key) && !embedded"
          :problem="item.problem"
          :open="open.has(item.key)"
          :started-at="startedAt"
          :current="index === current"
          :level="item.parent ? 2 : 1"
          :style="item.parent ? { '--indent': '16px' } : undefined"
          @toggle="toggle(item)"
          @focus="currentKey = item.key"
          @open="(t) => emit('open', t)"
          :copy="(as: 'text' | 'json') => copy(item.problem, as)"
          @menu="(e, a) => onRowMenu(item.problem, e, a)"
        />
      </div>
    </div>
  </div>
  <PopupMenu v-if="menu" :anchor="menu.anchor" :at="menu.at" label="Problem" @close="menu = null">
    <button class="mq-menu__item" role="menuitem" @click="copy(menu.problem, 'text')">Copy as text</button>
    <button class="mq-menu__item" role="menuitem" @click="copy(menu.problem, 'json')">Copy as JSON</button>
    <button
      v-if="menu.problem.spec"
      class="mq-menu__item"
      role="menuitem"
      @click="writeClipboard(menu.problem.spec.url)"
    >
      Copy spec link
    </button>
    <button
      v-if="menu.problem.places[0]"
      class="mq-menu__item"
      role="menuitem"
      @click="emit('open', menu.problem.places[0].target)"
    >
      {{ showText(menu.problem.places[0].target) }}
    </button>
    <hr role="separator" />
    <button class="mq-menu__item" role="menuitem" @click="copyAll">Copy all</button>
  </PopupMenu>
</template>

<style scoped>
/* As Tracks' view button, so a tab switch moves nothing in the slot. */
.levels-btn {
  gap: var(--space-1);
  max-width: 220px;
}
.levels-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.caret :deep(svg) {
  width: 12px;
  height: 12px;
}

.problem-tree {
  container: problems / inline-size;
  flex: 1;
  min-height: 0;
  overflow: auto;
  overflow-anchor: none;
}
.problem-tree--embedded {
  flex: none;
  overflow: visible;
}
.problem-space {
  position: relative;
}
.problem-item {
  position: absolute;
  left: 0;
  right: 0;
}
.problem-tree--embedded .problem-item {
  position: static;
}
.group-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  height: var(--problem-row);
  padding: 0 var(--space-2) 0 var(--space-1);
  background: var(--surface-sunken);
  border-bottom: 1px solid var(--line);
  font-weight: 600;
  cursor: default;
  outline: none;
}
.group-row:focus-visible {
  box-shadow: inset 0 0 0 1px var(--focus);
}
.group-row :deep(svg) {
  width: 12px;
  height: 12px;
}
.group-chevron {
  color: var(--ink-muted);
}
.group-label {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.group-kind {
  color: var(--ink-muted);
  font-weight: normal;
}
.group-count {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-weight: normal;
  font-variant-numeric: tabular-nums;
}
.glyph--error {
  color: var(--danger);
}
.glyph--warning {
  color: var(--warning);
}
.glyph--info {
  color: var(--info);
}
</style>
