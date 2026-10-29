<script lang="ts" setup>
import { computed, ref } from 'vue'
import { formatCount, formatOffset, isoTitle } from '../format'
import {
  groupProblems,
  type PanelProblem,
  type ProblemKind,
  type ProblemPlace,
  type ProblemSeverity,
  type ProblemTarget,
  SEVERITIES,
  severityCounts,
} from '../problems'
import Icon from './Icon.vue'

/** A session's problems, one row per kind, its instances behind the row's arrow. */
const props = defineProps<{
  problems: PanelProblem[]
  /** Session start, which the time column counts from */
  startedAt: number
  /** The toolbar's filter text, matched against titles and details */
  filter: string
}>()

const emit = defineEmits<{
  open: [target: ProblemTarget]
}>()

const ICONS = { error: 'error', warning: 'warning', info: 'info' } as const
const NAMES = { error: 'Error', warning: 'Warning', info: 'Note' } as const
const PLURALS = { error: 'Errors', warning: 'Warnings', info: 'Notes' } as const

/** How many places an instance lists before the rest are summed up as "and N more". */
const PLACES_SHOWN = 3

const hidden = ref(new Set<ProblemSeverity>())
const open = ref(new Set<string>())
const allPlaces = ref(new Set<PanelProblem>())

const kinds = computed(() => groupProblems(props.problems))
const counts = computed(() => severityCounts(kinds.value))
const shown = computed(() => {
  const q = props.filter.trim().toLowerCase()
  const matching = props.problems.filter(
    (p) =>
      !hidden.value.has(p.severity) &&
      (!q || p.title.toLowerCase().includes(q) || (p.detail?.toLowerCase().includes(q) ?? false)),
  )
  return groupProblems(matching)
})

function toggleSeverity(severity: ProblemSeverity) {
  const next = new Set(hidden.value)
  if (next.has(severity)) next.delete(severity)
  else next.add(severity)
  hidden.value = next
}

function toggle(key: string) {
  const next = new Set(open.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  open.value = next
}

function places(p: PanelProblem): ProblemPlace[] {
  return allPlaces.value.has(p) ? p.places : p.places.slice(0, PLACES_SHOWN)
}

/** The rule's section, when every instance cites the same one: said once, over them. */
function sharedSection(k: ProblemKind): string | null {
  const first = k.problems[0]?.section ?? null
  return k.problems.length > 1 && k.problems.every((p) => p.section === first) ? first : null
}

function showAllPlaces(p: PanelProblem) {
  allPlaces.value = new Set([...allPlaces.value, p])
}
</script>

<template>
  <Teleport to="#tab-tools" defer>
    <div class="severity-toggles" role="group" aria-label="Show problems by severity">
      <template v-for="s in SEVERITIES" :key="s">
        <button
          v-if="counts[s] > 0"
          class="mq-btn mq-btn--quiet severity"
          :class="`severity--${s}`"
          :aria-pressed="!hidden.has(s)"
          @click="toggleSeverity(s)"
        >
          {{ PLURALS[s] }}<span class="severity-count">{{ formatCount(counts[s]) }}</span>
        </button>
      </template>
    </div>
  </Teleport>
  <p v-if="shown.length === 0" class="pane-message">No problems match this filter.</p>
  <ul v-else class="kinds" aria-label="Problems">
    <li v-for="k in shown" :key="k.key" class="kind" :class="`kind--${k.severity}`">
      <button class="kind-row" :aria-expanded="open.has(k.key)" @click="toggle(k.key)">
        <Icon :name="open.has(k.key) ? 'chevronDown' : 'chevronRight'" class="kind-chevron" />
        <span class="kind-glyph"><Icon :name="ICONS[k.severity]" /><span class="mq-sr">{{ NAMES[k.severity] }}</span></span>
        <span class="kind-title" :title="k.title">{{ k.title }}</span>
        <span class="kind-time" :title="k.atMs !== null ? isoTitle(k.atMs) : undefined">{{
          k.atMs !== null ? formatOffset(k.atMs, startedAt) : ''
        }}</span>
        <span class="kind-count" :aria-label="`${formatCount(k.count)} times`">{{ formatCount(k.count) }}</span>
      </button>
      <ul v-if="open.has(k.key)" class="instances">
        <li v-if="sharedSection(k)" class="instance instance-section">{{ sharedSection(k) }}</li>
        <li v-for="(p, i) in k.problems" :key="i" class="instance">
          <span v-if="p.detail" class="instance-detail">{{ p.detail }}</span>
          <span v-if="p.section && !sharedSection(k)" class="instance-section">{{ p.section }}</span>
          <span v-if="p.places.length > 0" class="instance-places">
            <template v-for="(place, j) in places(p)" :key="j">
              <button class="place-link" @click="emit('open', place.target)">{{ place.label }}</button>
              <span v-if="place.note" class="place-note">{{ place.note }}</span>
            </template>
            <button v-if="places(p).length < p.places.length" class="place-more" @click="showAllPlaces(p)">
              and {{ p.places.length - places(p).length }} more
            </button>
          </span>
        </li>
      </ul>
    </li>
  </ul>
</template>

<style scoped>
.severity-toggles {
  display: flex;
  gap: 2px;
}
/* Filter chips in the Network manner: text, pressed while shown. */
.severity {
  gap: var(--space-1);
  padding: 0 6px;
  border-radius: var(--radius-full);
  font-variant-numeric: tabular-nums;
}
.severity-count {
  color: var(--ink-muted);
}

.kinds,
.instances {
  list-style: none;
  padding: 0;
  margin: 0;
}

.kind-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  height: var(--row-tool);
  padding: 0 var(--space-2) 0 var(--space-1);
  border: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: default;
}
.kind--error > .kind-row {
  background: var(--danger-soft);
  color: var(--danger);
}
.kind--warning > .kind-row {
  background: var(--warning-soft);
}
.kind--info > .kind-row:hover {
  background: var(--surface-hover);
}
.kind-chevron {
  color: var(--ink-muted);
}
.kind-row :deep(svg) {
  width: 12px;
  height: 12px;
}
.kind-glyph {
  display: inline-flex;
}
.kind--error .kind-glyph {
  color: var(--danger);
}
.kind--warning .kind-glyph {
  color: var(--warning);
}
.kind--info .kind-glyph {
  color: var(--info);
}
.kind-title {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kind-time {
  font-family: var(--font-mono);
  color: var(--ink-muted);
  font-variant-numeric: tabular-nums;
}
/* Console's repeat count. */
.kind-count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: var(--radius-full);
  background: var(--surface-sunken);
  color: var(--ink-muted);
  text-align: center;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
}

.instance {
  display: flex;
  flex-direction: column;
  padding: 2px var(--space-2) 2px 36px;
  border-bottom: 1px solid var(--line);
  overflow-wrap: break-word;
}
.instance-detail,
.instance-section {
  color: var(--ink-muted);
}
.instance-places {
  display: flex;
  flex-wrap: wrap;
  gap: 0 var(--space-3);
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
  color: var(--ink-muted);
}
.place-note {
  color: var(--ink-muted);
}
</style>
