<script lang="ts" setup>
import { computed, nextTick, ref, watch } from 'vue'
import { formatBytes, plural } from '../format'
import {
  decodedLines,
  hexBytes,
  type LocObjectView,
  type LocTrackState,
  payloadText,
  propertyId,
  rawValue,
  resolutionLabel,
  trackTimescaleText,
} from '../loc'
import type { ParsedStreamFraming, StreamObject } from '../stream-framing'

/**
 * The objects of one LOC stream, each decoded when opened: its properties
 * under the track's profile, and its payload framing for H.264 and H.265.
 */
const props = defineProps<{
  data: Uint8Array
  framing: ParsedStreamFraming
  state: LocTrackState
  objectView: (
    obj: StreamObject,
    groupId: number,
    data: Uint8Array,
  ) => LocObjectView
  /** An object to open and scroll to, by its offset in the stream */
  focus?: { offset: number; seq: number } | null
}>()

const root = ref<HTMLElement | null>(null)
/** Objects opened, by offset; decoded only while open. */
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

/** Every object, with its decoding when it is open and whole. */
const items = computed(() =>
  props.framing.objects.map((obj) => {
    const whole = obj.payloadOffset + obj.payloadLength <= props.data.length
    const view =
      whole && open.value.has(obj.offset)
        ? props.objectView(obj, groupOf(obj), props.data)
        : null
    return { obj, whole, view }
  }),
)

const profileBadge = computed(() => {
  const r = props.state.resolution
  if ('profile' in r) {
    return {
      text: props.state.pinned ? `${r.profile} (pinned)` : r.profile,
      cls: 'mq-badge--ok',
    }
  }
  return {
    text: resolutionLabel(r),
    cls: r.candidates.length === 0 ? 'mq-badge--error' : 'mq-badge--check',
  }
})

function offsetText(n: number): string {
  return `0x${n.toString(16).padStart(4, '0')}`
}

function propertyBytes(offset: number, length: number): string {
  return hexBytes(props.data.subarray(offset, offset + length))
}

function ambiguousText(view: LocObjectView['properties'][number]): string | null {
  const a = view.result.ambiguous
  if (!a) return null
  return a
    .map((m) => {
      const meaning = m.meanings.length ? m.meanings.join(' / ') : 'undefined'
      return `${m.profile}: ${meaning}${m.error ? ` (${m.error.replace('_', ' ')})` : ''}`
    })
    .join(' · ')
}

function statusNote(view: LocObjectView['properties'][number]): string | null {
  const r = view.result
  if (r.transport) return 'transport property'
  if (r.error === 'invalid_length') return 'length outside what the draft states'
  if (r.error === 'out_of_range') return 'value outside what the draft states'
  return null
}
</script>

<template>
  <div ref="root" class="loc-panel">
    <div class="loc-summary">
      <span class="mq-badge mq-badge--mono">LOC</span>
      <span class="mq-badge mq-badge--mono" :class="profileBadge.cls">{{
        profileBadge.text
      }}</span>
      <span v-if="state.codec" class="mq-badge mq-badge--mono">{{
        state.codec
      }}</span>
      <span
        v-for="t in state.trackTimescales.map(trackTimescaleText)"
        :key="t.text"
        class="mq-badge mq-badge--mono"
        :title="t.title"
        >{{ t.text }}</span
      >
      <span class="mq-badge mq-badge--mono">{{
        plural(framing.objects.length, 'object')
      }}</span>
    </div>

    <ul class="loc-objects">
      <li v-for="{ obj, whole, view } in items" :key="obj.offset" :data-offset="obj.offset">
        <details
          :open="open.has(obj.offset)"
          @toggle="toggle(obj.offset, $event)"
        >
          <summary class="loc-object">
            <span class="mono">g{{ groupOf(obj) }} · o{{ obj.objectId }}</span>
            <span class="muted"
              >{{ formatBytes(obj.payloadLength)
              }}<template v-if="obj.status !== undefined">
                · status {{ obj.status }}</template
              ><template v-if="obj.propertiesLength">
                · properties {{ formatBytes(obj.propertiesLength) }} at
                <span class="mono">{{
                  offsetText(obj.propertiesOffset ?? 0)
                }}</span></template
              ></span
            >
          </summary>
          <div v-if="view" class="loc-detail">
            <p v-if="view.record.propertiesError" class="loc-error">
              The property block does not decode:
              {{ view.record.propertiesError }}
            </p>
            <p
              v-else-if="view.properties.length === 0 && view.record.propertiesLength"
              class="mono"
            >
              {{
                propertyBytes(
                  view.record.propertiesOffset ?? 0,
                  view.record.propertiesLength,
                )
              }}
            </p>
            <p
              v-else-if="view.properties.length === 0"
              class="muted"
            >
              No properties.
            </p>
            <table v-else class="mq-table loc-props">
              <colgroup>
                <col class="loc-col-id" />
                <col class="loc-col-name" />
                <col />
                <col class="loc-col-bytes" />
              </colgroup>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Property</th>
                  <th>Value</th>
                  <th>Bytes</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, i) in view.properties" :key="i">
                  <td class="mono">
                    <span v-if="row.result.immutable" class="muted"
                      >↳ </span
                    >{{ propertyId(row.result.type) }}
                  </td>
                  <td>
                    <template v-if="row.result.name">{{
                      row.result.name
                    }}</template>
                    <span
                      v-else-if="ambiguousText(row)"
                      class="muted"
                      :title="ambiguousText(row) ?? undefined"
                      >ambiguous</span
                    >
                    <span v-else class="muted">{{
                      row.result.transport ? 'transport' : 'not defined'
                    }}</span>
                  </td>
                  <td class="loc-value">
                    <template v-if="decodedLines(row.result).length">
                      <span
                        v-for="(line, j) in decodedLines(
                          row.result,
                          view.timescaleFromTrack,
                        )"
                        :key="j"
                        class="loc-line"
                        ><template v-if="j > 0">or </template>{{
                          line
                        }}</span
                      >
                    </template>
                    <span v-else class="mono">{{
                      rawValue(row.result.raw)
                    }}</span>
                    <span v-if="ambiguousText(row)" class="loc-line muted">{{
                      ambiguousText(row)
                    }}</span>
                    <span v-if="statusNote(row)" class="loc-line muted">{{
                      statusNote(row)
                    }}</span>
                  </td>
                  <td class="mono">
                    <span class="muted">{{ offsetText(row.offset) }}</span>
                    {{ propertyBytes(row.offset, row.length) }}
                  </td>
                </tr>
              </tbody>
            </table>
            <p v-if="payloadText(view.payload)" class="loc-payload">
              <span class="muted">Payload</span>
              {{ payloadText(view.payload) }}
            </p>
          </div>
          <p v-else-if="!whole" class="loc-detail muted">
            The object is cut short.
          </p>
        </details>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.loc-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
}

.loc-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
}

.loc-objects {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.loc-object {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  cursor: pointer;
}

.loc-detail {
  padding: var(--space-1) 0 var(--space-2) var(--space-3);
}

.loc-props {
  font-size: var(--type-data-size);
  table-layout: fixed;
  width: 100%;
}
.loc-col-id {
  width: 7em;
}
.loc-col-name {
  width: 22%;
}
.loc-col-bytes {
  width: 34%;
}
.loc-props th,
.loc-props td {
  padding-left: var(--space-2);
  padding-right: var(--space-2);
  vertical-align: top;
  overflow-wrap: anywhere;
}

.loc-line {
  display: block;
}

.loc-payload {
  margin-top: var(--space-1);
}

.loc-error {
  color: var(--danger);
}

.mono {
  font-family: var(--font-mono);
}
.muted {
  color: var(--ink-muted);
}
</style>
