<script lang="ts" setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import { formatClock, formatOffset, isoTitle } from '../format'
import {
  copyIncludes,
  countText,
  type PanelProblem,
  type ProblemTarget,
  placeText,
  SENDER_TEXT,
  SEVERITY_NAMES,
  seenText,
  showText,
  sinceText,
} from '../problems'
import { rowHeight } from '../host'
import { vTruncatedTitle } from '../truncated-title'
import Icon from './Icon.vue'

/** One problem: a row, and below it while open, what it found, the fix, where and the rule. */
const props = defineProps<{
  problem: PanelProblem
  open: boolean
  /** Session start, which times count from */
  startedAt: number
  /** The roving tab stop of the list */
  current: boolean
  /** Tree depth: 2 under a subject header, 1 without */
  level: number
  /** Puts the row on the clipboard; false when the browser refused */
  copy: (as: 'text' | 'json') => Promise<boolean>
}>()

const emit = defineEmits<{
  toggle: []
  open: [target: ProblemTarget]
  menu: [event: MouseEvent | KeyboardEvent, anchor: HTMLElement]
  focus: []
}>()

const ICONS = { error: 'error', warning: 'warning', info: 'info' } as const

const p = computed(() => props.problem)
const first = computed(() => p.value.places[0] ?? null)
const last = computed(() => p.value.places[p.value.places.length - 1] ?? null)

function time(atMs: number | null | undefined): string {
  return atMs == null ? '' : formatOffset(atMs, props.startedAt)
}

const range = computed(() => {
  const a = first.value?.atMs
  const b = last.value?.atMs
  if (a == null) return ''
  return b == null || b === a ? time(a) : `${time(a)} – ${time(b)}`
})

const countWide = computed(() => countText(p.value))
const countNarrow = computed(() => countText(p.value, true))

const allPlaces = ref(false)
const evidenceOpen = ref(false)

/** Show all: a list of fixed rows, at most 12 tall, drawn as it scrolls. */
const ROW = rowHeight()
const VISIBLE = 12
const placesTop = ref(0)
const placesSlice = computed(() => {
  const start = Math.max(0, Math.floor(placesTop.value / ROW) - 4)
  const end = Math.min(p.value.places.length, start + VISIBLE + 8)
  return { start, list: p.value.places.slice(start, end) }
})

/** A click on the row toggles it, unless it made a selection. */
function onRowClick(e: MouseEvent) {
  if ((e.target as HTMLElement).closest('button, a')) return
  if (!window.getSelection()?.isCollapsed) return
  emit('toggle')
}

/** As DevTools' copy buttons: "Copied" on the button for a moment, and said aloud. */
const copied = ref<'text' | 'json' | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(copiedTimer))
async function copyAs(as: 'text' | 'json') {
  if (!(await props.copy(as))) return
  copied.value = as
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copied.value = null), 1600)
}

const rowEl = ref<HTMLElement | null>(null)
defineExpose({ focus: () => rowEl.value?.focus(), el: rowEl })
</script>

<template>
  <div class="problem" :class="{ 'problem--open': open }">
    <div
      ref="rowEl"
      class="problem-row"
      role="treeitem"
      :aria-level="level"
      :aria-expanded="open"
      :tabindex="current ? 0 : -1"
      :data-severity="problem.severity"
      @click="onRowClick"
      @focus="emit('focus')"
      @contextmenu.prevent="emit('menu', $event, rowEl!)"
    >
      <button
        type="button"
        class="problem-chevron"
        tabindex="-1"
        :aria-label="open ? 'Collapse' : 'Expand'"
        @click="emit('toggle')"
      >
        <Icon :name="open ? 'chevronDown' : 'chevronRight'" />
      </button>
      <span class="problem-glyph" :class="`glyph--${problem.severity}`"
        ><Icon :name="ICONS[problem.severity]" /><span class="mq-sr">{{
          SEVERITY_NAMES[problem.severity]
        }}</span></span
      >
      <span v-truncated-title class="problem-title">{{ problem.title }}</span>
      <span v-if="countWide" class="problem-count">
        <span class="count-wide">{{ countWide }}</span
        ><span class="count-narrow">{{ countNarrow }}</span>
      </span>
      <span class="problem-time">{{ range }}</span>
    </div>
    <div v-if="open" class="problem-detail" role="group">
      <dl class="detail-grid">
        <template v-if="problem.found">
          <dt>Found</dt>
          <dd class="mono">{{ problem.found }}</dd>
        </template>
        <template v-if="problem.expected">
          <dt>Expected</dt>
          <dd class="mono">{{ problem.expected }}</dd>
        </template>
        <template v-if="problem.remedy">
          <dt>Fix</dt>
          <dd>{{ problem.remedy }}</dd>
        </template>
        <dt>Affected</dt>
        <dd>
          <span>{{ problem.subject.label }}</span>
          <span v-if="problem.sender" class="muted"> · {{ SENDER_TEXT[problem.sender] }}</span>
          <span v-if="problem.items.length > 0" class="chips">
            <span v-for="item in problem.items" :key="`${item.name}|${item.path}`" class="chip">
              <span class="mono">{{ item.name }}</span>
              <span v-if="item.path && item.path !== item.name" class="mono muted">{{ item.path }}</span>
              <span v-for="mark in item.marks" :key="mark" class="chip-mark">{{ mark }}</span>
            </span>
          </span>
          <span v-if="problem.notApplied" class="not-applied">
            <span class="mq-badge mq-badge--error">Not applied</span>
            <span class="muted">A reader keeps the previous catalog.</span>
          </span>
        </dd>
        <template v-if="first">
          <dt>Seen</dt>
          <dd>
            <span>{{ seenText(problem) }}</span>
            <span class="seen-line">
              First:
              <button class="place-link" @click="emit('open', first.target)">{{ first.label }}</button>
              <span v-if="first.atMs != null" class="muted" :title="isoTitle(first.atMs)">
                at {{ time(first.atMs) }} ({{ formatClock(first.atMs) }})</span
              >
            </span>
            <span v-if="last && last !== first" class="seen-line">
              Last:
              <button class="place-link" @click="emit('open', last.target)">{{ last.label }}</button>
              <span class="muted"
                ><template v-if="last.atMs != null"> at {{ time(last.atMs) }}</template>
                {{ sinceText(problem) }}</span
              >
            </span>
            <button
              v-if="problem.places.length > 2"
              class="place-more"
              :aria-expanded="allPlaces"
              @click="allPlaces = !allPlaces"
            >
              {{ allPlaces ? 'Hide' : `Show all ${problem.places.length.toLocaleString('en-US')}` }}
            </button>
            <div
              v-if="allPlaces"
              class="all-places"
              :style="{ height: `${Math.min(problem.places.length, VISIBLE) * ROW}px` }"
              @scroll="placesTop = ($event.target as HTMLElement).scrollTop"
            >
              <div :style="{ height: `${problem.places.length * ROW}px`, position: 'relative' }">
                <div
                  v-for="(place, i) in placesSlice.list"
                  :key="placesSlice.start + i"
                  class="all-place"
                  :style="{ top: `${(placesSlice.start + i) * ROW}px`, height: `${ROW}px` }"
                >
                  <button class="place-link" @click="emit('open', place.target)">
                    {{ placeText(place, startedAt) }}
                  </button>
                  <span v-if="place.note" class="muted">{{ place.note }}</span>
                </div>
              </div>
            </div>
          </dd>
        </template>
        <template v-if="problem.evidence">
          <dt>Evidence</dt>
          <dd>
            <button class="place-more" :aria-expanded="evidenceOpen" @click="evidenceOpen = !evidenceOpen">
              {{ evidenceOpen ? 'Hide' : 'Show' }}
            </button>
            <div v-if="evidenceOpen && problem.header" class="header-evidence">
              <span v-if="problem.header.bytes" class="mono">{{ problem.header.bytes }}</span>
              <dl class="header-fields">
                <div v-for="f in problem.header.fields" :key="f.label" :class="{ 'is-marked': f.marked }">
                  <dt>{{ f.label }}</dt>
                  <dd class="mono">{{ f.value }}</dd>
                </div>
              </dl>
              <button type="button" class="host-btn" @click="emit('open', problem.header.target)">
                {{ showText(problem.header.target) }}
              </button>
            </div>
            <pre v-else-if="evidenceOpen" class="evidence mono">{{ problem.evidence }}</pre>
          </dd>
        </template>
        <template v-if="problem.spec">
          <dt>Spec</dt>
          <dd>
            <q v-if="problem.spec.quote" class="spec-quote">{{ problem.spec.quote }}</q>
            <span class="seen-line">
              Learn more:
              <a :href="problem.spec.url" target="_blank" rel="noopener">{{ problem.spec.label }}</a>
              <template v-for="ref in problem.also" :key="ref.url">
                · <a :href="ref.url" target="_blank" rel="noopener">{{ ref.label }}</a>
              </template>
            </span>
          </dd>
        </template>
      </dl>
      <div class="detail-actions">
        <button
          v-for="as in (['text', 'json'] as const)"
          :key="as"
          type="button"
          class="host-btn"
          :title="copyIncludes(problem, as)"
          @click="copyAs(as)"
        >
          <span class="host-btn__stack">
            <span :class="{ 'is-hidden': copied === as }">{{ as === 'text' ? 'Copy as text' : 'Copy as JSON' }}</span>
            <span :class="{ 'is-hidden': copied !== as }" aria-hidden="true"><Icon name="check" />Copied</span>
          </span>
        </button>
        <button v-if="first" type="button" class="host-btn" @click="emit('open', first.target)">
          {{ showText(first.target) }}
        </button>
        <span class="mq-sr" aria-live="polite">{{
          copied === 'text' ? 'Copied as text' : copied === 'json' ? 'Copied as JSON' : ''
        }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.problem-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  height: var(--problem-row, 20px);
  padding: 0 var(--space-2) 0 calc(var(--space-1) + var(--indent, 0px));
  color: var(--ink);
  cursor: default;
  user-select: text;
  outline: none;
}
.problem-row:hover {
  background: var(--surface-hover);
}
.problem-row:focus-visible {
  background: var(--surface-selected);
  box-shadow: inset 0 0 0 1px var(--focus);
}
.problem-chevron {
  display: inline-flex;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ink-muted);
  cursor: pointer;
}
.problem-row :deep(svg) {
  width: 12px;
  height: 12px;
}
.problem-glyph {
  display: inline-flex;
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
.problem-title {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.problem-count,
.problem-time {
  flex: none;
  color: var(--ink-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.problem-time {
  min-width: 22ch;
  text-align: right;
  font-family: var(--font-mono);
}
.count-narrow {
  display: none;
}
@container problems (max-width: 480px) {
  .problem-time {
    display: none;
  }
  .count-wide {
    display: none;
  }
  .count-narrow {
    display: inline;
  }
}

.problem-detail {
  padding: var(--space-1) var(--space-2) var(--space-2) calc(36px + var(--indent, 0px));
  border-bottom: 1px solid var(--line);
  user-select: text;
}
.detail-grid {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 2px var(--space-3);
  margin: 0;
}
.detail-grid dt {
  color: var(--ink-muted);
}
.detail-grid dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.mono {
  font-family: var(--font-mono);
}
.muted {
  color: var(--ink-muted);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 2px var(--space-1);
  margin-top: 2px;
}
.chip {
  display: inline-flex;
  flex-wrap: wrap;
  max-width: 100%;
  gap: 0 var(--space-1);
  padding: 0 var(--space-1);
  border-radius: var(--radius-sm, 2px);
  background: var(--surface-sunken);
}
.chip > span {
  white-space: nowrap;
}
.chip-mark {
  color: var(--ink-muted);
}
.chip-mark::before {
  content: '· ';
}
.not-applied {
  display: flex;
  gap: var(--space-1);
  align-items: baseline;
  margin-top: 2px;
}
.seen-line {
  display: block;
}
.place-link,
.place-more {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--link);
  text-decoration: underline;
  cursor: pointer;
}
.place-more {
  display: block;
}
.all-places {
  overflow-y: auto;
  margin-top: 2px;
  border: 1px solid var(--line);
}
.all-place {
  position: absolute;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-1);
  white-space: nowrap;
  overflow: hidden;
}
.evidence {
  margin: 2px 0 0;
  padding: var(--space-1);
  background: var(--surface-sunken);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.header-evidence {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-1);
  margin-top: 2px;
}
.header-fields {
  display: grid;
  grid-template-columns: max-content max-content;
  margin: 0;
  padding: var(--space-1) 0;
  background: var(--surface-sunken);
}
.header-fields > div {
  display: contents;
}
.header-fields dt,
.header-fields dd {
  margin: 0;
  padding: 0 var(--space-2);
}
.header-fields dt {
  color: var(--ink-muted);
}
.header-fields .is-marked > * {
  background: var(--surface-selected);
  color: var(--ink);
  font-weight: 600;
}
.spec-quote {
  display: block;
  font-style: italic;
}
.detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
</style>
