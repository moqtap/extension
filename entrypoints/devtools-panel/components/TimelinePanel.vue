<script lang="ts" setup>
import { computed, nextTick, ref, watch } from 'vue'
import { formatBytes, plural } from '../format'
import { hexBytes } from '../loc'
import type { ParsedStreamFraming, StreamObject } from '../stream-framing'
import {
  TIMELINE_LABELS,
  type TimelineObjectView,
  type TimelineState,
} from '../timelines'

/** The objects of one timeline stream (msf 7, 8; cmsf 3.6.1), each read when opened. */
const props = defineProps<{
  data: Uint8Array
  framing: ParsedStreamFraming
  state: TimelineState
  objectView: (obj: StreamObject, data: Uint8Array) => TimelineObjectView
  /** An object to open and scroll to, by its offset in the stream */
  focus?: { offset: number; seq: number } | null
}>()

const root = ref<HTMLElement | null>(null)
const open = ref(new Set<number>())

watch(
  () => props.data,
  () => {
    open.value = new Set()
  },
)

watch(
  () => props.focus,
  async (focus) => {
    if (!focus) return
    open.value = new Set([...open.value, focus.offset])
    await nextTick()
    root.value
      ?.querySelector(`[data-offset="${focus.offset}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  },
  { immediate: true },
)

function toggle(offset: number, event: Event) {
  const isOpen = (event.target as HTMLDetailsElement).open
  if (isOpen === open.value.has(offset)) return
  const next = new Set(open.value)
  if (isOpen) next.add(offset)
  else next.delete(offset)
  open.value = next
}

function groupOf(obj: StreamObject): number {
  return obj.groupId ?? props.framing.headerFields.groupId ?? 0
}

const items = computed(() =>
  props.framing.objects.map((obj) => {
    const whole = obj.payloadOffset + obj.payloadLength <= props.data.length
    const view =
      whole && obj.payloadLength > 0 && open.value.has(obj.offset)
        ? props.objectView(obj, props.data)
        : null
    return { obj, whole, view }
  }),
)

const describes = computed(() =>
  props.state.depends.length === 0 ? null : props.state.depends.join(', '),
)

const draftLabel = computed(() => {
  const d = props.state.kind === 'sap' ? props.state.draft : props.state.timelineDraft
  return d ? d.toUpperCase() : null
})

/**
 * How an object shows: its records, a SAP timeline's records as event records
 * when none reads as a SAP record, the payload hex when nothing reads, or
 * "No records." for an empty array.
 */
function shownAs(view: TimelineObjectView): 'hex' | 'empty' | 'media' | 'event' | 'sap' {
  if (view.kind === 'invalid') return 'hex'
  if (view.kind === 'sap' && view.entries.length > 0) return 'sap'
  if (view.records.length > 0) return view.kind === 'media' ? 'media' : 'event'
  return view.problems.length > 0 ? 'hex' : 'empty'
}

function payloadHex(obj: StreamObject): string {
  return hexBytes(props.data.subarray(obj.payloadOffset, obj.payloadOffset + obj.payloadLength))
}

/** Milliseconds since 1970 as a date, where it is one. */
function wallclockTitle(ms: number): string | undefined {
  return Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : undefined
}

function dataText(data: unknown): string {
  return JSON.stringify(data)
}
</script>

<template>
  <div ref="root" class="timeline-panel">
    <div class="timeline-summary">
      <span class="mq-badge mq-badge--mono">{{ TIMELINE_LABELS[state.kind] }}</span>
      <span v-if="describes" class="mq-badge mq-badge--mono" title="The tracks it describes"
        >for {{ describes }}</span
      >
      <span v-if="state.kind === 'event' && state.eventType" class="mq-badge mq-badge--mono">{{
        state.eventType
      }}</span>
      <span v-if="draftLabel" class="mq-badge mq-badge--mono">{{ draftLabel }}</span>
      <span class="mq-badge mq-badge--mono">{{
        plural(framing.objects.length, 'object')
      }}</span>
    </div>

    <ul class="timeline-objects">
      <li v-for="{ obj, whole, view } in items" :key="obj.offset" :data-offset="obj.offset">
        <details :open="open.has(obj.offset)" @toggle="toggle(obj.offset, $event)">
          <summary class="timeline-object">
            <span class="mono">g{{ groupOf(obj) }} · o{{ obj.objectId }}</span>
            <span class="muted">{{ formatBytes(obj.payloadLength) }}</span>
          </summary>
          <div v-if="view" class="timeline-detail">
            <code v-if="shownAs(view) === 'hex'" class="timeline-hex">{{ payloadHex(obj) }}</code>
            <p v-else-if="shownAs(view) === 'empty'" class="muted">No records.</p>
            <template v-else-if="view.kind === 'media'">
              <table class="mq-table timeline-records">
                <thead>
                  <tr>
                    <th>Media time</th>
                    <th>Group</th>
                    <th>Object</th>
                    <th>Wallclock</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in view.records" :key="r.at">
                    <td class="mono">{{ r.mediaTime }} ms</td>
                    <td class="mono">{{ r.group }}</td>
                    <td class="mono">{{ r.object }}</td>
                    <td class="mono" :title="wallclockTitle(r.wallclock)">{{ r.wallclock }}</td>
                  </tr>
                </tbody>
              </table>
            </template>
            <template v-else-if="(view.kind === 'event' || view.kind === 'sap') && shownAs(view) === 'event'">
              <table class="mq-table timeline-records">
                <thead>
                  <tr>
                    <th>Index</th>
                    <th>Value</th>
                    <th>Data</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in view.records" :key="r.at">
                    <td class="mono">{{ r.index }}</td>
                    <td
                      v-if="r.index === 't'"
                      class="mono"
                      :title="wallclockTitle(r.time)"
                    >
                      {{ r.time }}
                    </td>
                    <td v-else-if="r.index === 'm'" class="mono">{{ r.mediaTime }} ms</td>
                    <td v-else class="mono">[{{ r.group }}, {{ r.object }}]</td>
                    <td class="mono timeline-data" :title="dataText(r.data)">
                      {{ dataText(r.data) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </template>
            <template v-else-if="view.kind === 'sap'">
              <table class="mq-table timeline-records">
                <thead>
                  <tr>
                    <th>Group</th>
                    <th>Object</th>
                    <th>SAP type</th>
                    <th>Earliest presentation</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="e in view.entries" :key="e.at">
                    <td class="mono">{{ e.group }}</td>
                    <td class="mono">{{ e.object }}</td>
                    <td class="mono">{{ e.sapType === 0 ? '0 (no SAP)' : e.sapType }}</td>
                    <td class="mono">{{ e.ept }} ms</td>
                  </tr>
                </tbody>
              </table>
            </template>
            <ul v-if="view.problems.length > 0" class="timeline-problems">
              <li
                v-for="(p, i) in view.problems"
                :key="i"
                :class="p.severity === 'error' ? 'timeline-bad' : 'timeline-warn'"
              >
                {{ p.path ? `${p.path}: ` : '' }}{{ p.message }}
                <span class="muted">({{ p.section }})</span>
              </li>
            </ul>
          </div>
          <p v-else-if="!whole" class="timeline-detail muted">The object is cut short.</p>
          <p v-else-if="obj.payloadLength === 0" class="timeline-detail muted">No payload.</p>
        </details>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.timeline-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
}

.timeline-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
}

.timeline-objects {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.timeline-object {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  cursor: pointer;
}

.timeline-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-1) 0 var(--space-2) var(--space-3);
}

.timeline-records {
  font-size: var(--type-data-size);
}
.timeline-records th,
.timeline-records td {
  padding-left: var(--space-2);
  padding-right: var(--space-2);
}
.timeline-data {
  max-width: 48ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.timeline-hex {
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}

.timeline-problems {
  margin: 0;
  padding-left: var(--space-3);
}

.timeline-bad {
  color: var(--danger);
}
.timeline-warn {
  color: var(--warning);
}

.mono {
  font-family: var(--font-mono);
}
.muted {
  color: var(--ink-muted);
}
</style>
