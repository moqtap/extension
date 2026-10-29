<script lang="ts" setup>
import { computed, ref } from 'vue'
import { formatOffset, isoTitle } from '../format'
import {
  type PanelProblem,
  type ProblemPlace,
  type ProblemSeverity,
  type ProblemTarget,
  SEVERITIES,
  severityCounts,
} from '../problems'

/** A session's problems, most severe first, each linked to what it is about. */
const props = defineProps<{
  problems: PanelProblem[]
  /** Session start, which the time column counts from */
  startedAt: number
}>()

const emit = defineEmits<{
  open: [target: ProblemTarget]
}>()

const GLYPHS = { error: '✕', warning: '▲', info: 'i' } as const
const NAMES = { error: 'Error', warning: 'Warning', info: 'Note' } as const
const PLURALS = { error: 'Errors', warning: 'Warnings', info: 'Notes' } as const

/** How many places a problem lists before the rest are summed up as "and N more". */
const PLACES_SHOWN = 3

const hidden = ref(new Set<ProblemSeverity>())
const expanded = ref(new Set<PanelProblem>())

const counts = computed(() => severityCounts(props.problems))
const shown = computed(() => props.problems.filter((p) => !hidden.value.has(p.severity)))

function toggleSeverity(severity: ProblemSeverity) {
  const next = new Set(hidden.value)
  if (next.has(severity)) next.delete(severity)
  else next.add(severity)
  hidden.value = next
}

function places(p: PanelProblem): ProblemPlace[] {
  return expanded.value.has(p) ? p.places : p.places.slice(0, PLACES_SHOWN)
}

function expand(p: PanelProblem) {
  expanded.value = new Set([...expanded.value, p])
}
</script>

<template>
  <div class="problems">
    <div class="problem-filter" role="group" aria-label="Show problems by severity">
      <template v-for="s in SEVERITIES" :key="s">
        <button
          v-if="counts[s] > 0"
          class="mq-btn mq-btn--quiet"
          :class="`problem-filter--${s}`"
          :aria-pressed="!hidden.has(s)"
          @click="toggleSeverity(s)"
        >
          <span aria-hidden="true">{{ GLYPHS[s] }}</span>
          {{ PLURALS[s] }} <span class="mq-tab__count">{{ counts[s] }}</span>
        </button>
      </template>
    </div>
    <ul class="problem-list">
      <li
        v-for="(p, i) in shown"
        :key="i"
        class="problem"
        :class="`problem--${p.severity}`"
      >
        <span class="problem__glyph"
          ><span aria-hidden="true">{{ GLYPHS[p.severity] }}</span
          ><span class="mq-sr">{{ NAMES[p.severity] }}</span></span
        >
        <span class="problem__time" :title="p.atMs !== null ? isoTitle(p.atMs) : undefined">{{
          p.atMs !== null ? formatOffset(p.atMs, startedAt) : ''
        }}</span>
        <span class="problem__text">
          <span class="problem__title">{{ p.title }}</span>
          <span v-if="p.detail" class="problem__detail">{{ p.detail }}</span>
          <span v-if="p.section" class="problem__detail problem__section">{{ p.section }}</span>
          <ul v-if="p.places.length > 0" class="problem__places">
            <li v-for="(place, j) in places(p)" :key="j">
              <button class="problem__link" @click="emit('open', place.target)">
                {{ place.label }}
              </button>
              <span v-if="place.note" class="problem__note">{{ place.note }}</span>
            </li>
            <li v-if="places(p).length < p.places.length">
              <button class="problem__more" @click="expand(p)">
                and {{ p.places.length - places(p).length }} more
              </button>
            </li>
          </ul>
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.problems {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.problem-filter {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}
.problem-filter--error [aria-hidden='true'] {
  color: var(--danger);
}
.problem-filter--warning [aria-hidden='true'] {
  color: var(--warning);
}
.problem-filter--info [aria-hidden='true'] {
  color: var(--info);
}

/* One line per problem: glyph, time from session start, title, detail. */
.problem-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.problem {
  display: grid;
  grid-template-columns: 1em auto 1fr;
  gap: var(--space-2);
  align-items: baseline;
}
.problem__glyph {
  text-align: center;
}
.problem--error .problem__glyph {
  color: var(--danger);
}
.problem--warning .problem__glyph {
  color: var(--warning);
}
.problem--info .problem__glyph {
  color: var(--info);
}
.problem__time {
  font-family: var(--font-mono);
  color: var(--ink-muted);
  font-variant-numeric: tabular-nums;
}
.problem__text {
  min-width: 0;
  overflow-wrap: anywhere;
}
.problem__title {
  font-family: var(--font-mono);
}
.problem__detail {
  display: block;
  color: var(--ink-muted);
}
.problem__section {
  font-family: var(--font-mono);
}
.problem__places {
  list-style: none;
  padding: 0;
  margin: 0;
}
.problem__link,
.problem__more {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  font-family: var(--font-mono);
  color: var(--link);
  text-decoration: underline;
  cursor: pointer;
}
.problem__more {
  color: var(--ink-muted);
}
.problem__note {
  margin-left: var(--space-1);
  color: var(--ink-muted);
}
</style>
