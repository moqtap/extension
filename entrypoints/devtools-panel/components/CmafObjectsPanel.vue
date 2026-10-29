<script lang="ts" setup>
import { computed, nextTick, ref, watch } from 'vue'
import {
  type CmafObjectView,
  type CmafTrackState,
  eptText,
  initText,
  sapText,
  syncText,
} from '../cmaf'
import { formatBytes, plural } from '../format'
import type { ParsedStreamFraming, StreamObject } from '../stream-framing'
import FragmentTable from './FragmentTable.vue'

/**
 * The objects of one CMAF stream, each parsed when opened, under the CMAF
 * header the catalogs give the track.
 */
const props = defineProps<{
  data: Uint8Array
  framing: ParsedStreamFraming
  state: CmafTrackState
  objectView: (obj: StreamObject, data: Uint8Array) => CmafObjectView
  /** An object to open and scroll to, by its offset in the stream */
  focus?: { offset: number; seq: number } | null
}>()

const root = ref<HTMLElement | null>(null)
/** Objects opened, by offset; parsed only while open. */
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

const initBadge = computed(() => ({
  text: initText(props.state.init),
  cls: props.state.init.status === 'known' ? 'mq-badge--ok' : 'mq-badge--check',
}))
</script>

<template>
  <div ref="root" class="cmaf-panel">
    <div class="cmaf-summary">
      <span class="mq-badge mq-badge--mono">CMAF</span>
      <span class="mq-badge mq-badge--mono" :class="initBadge.cls">{{
        initBadge.text
      }}</span>
      <span v-if="state.draft" class="mq-badge mq-badge--mono">{{
        state.draft.toUpperCase()
      }}</span>
      <span class="mq-badge mq-badge--mono">{{
        plural(framing.objects.length, 'object')
      }}</span>
    </div>

    <ul class="cmaf-objects">
      <li v-for="{ obj, whole, view } in items" :key="obj.offset" :data-offset="obj.offset">
        <details :open="open.has(obj.offset)" @toggle="toggle(obj.offset, $event)">
          <summary class="cmaf-object">
            <span class="mono">g{{ groupOf(obj) }} · o{{ obj.objectId }}</span>
            <span class="muted"
              >{{ formatBytes(obj.payloadLength)
              }}<template v-if="obj.status !== undefined">
                · status {{ obj.status }}</template
              ></span
            >
          </summary>
          <div v-if="view" class="cmaf-detail">
            <dl class="mq-kv cmaf-kv">
              <dt>Boxes</dt>
              <dd class="mono">
                {{ view.object.boxes.join(' ') || '(none)'
                }}<template v-if="view.object.unreadBytes > 0">
                  · {{ formatBytes(view.object.unreadBytes) }} after the last box</template
                ><template v-if="view.object.truncated"> · cut short</template>
              </dd>
              <template v-if="syncText(view.object.firstSample)">
                <dt>First sample</dt>
                <dd>{{ syncText(view.object.firstSample) }}</dd>
              </template>
              <template v-if="sapText(view.object.sap)">
                <dt>SAP</dt>
                <dd>{{ sapText(view.object.sap) }}</dd>
              </template>
              <template v-if="eptText(view.object.timing)">
                <dt>Earliest presentation</dt>
                <dd>{{ eptText(view.object.timing) }}</dd>
              </template>
            </dl>
            <FragmentTable
              :object="view.object"
              :timescales="view.timescales"
              :header-track-ids="view.headerTrackIds"
            />
            <ul v-if="view.findings.length > 0" class="cmaf-findings">
              <li v-for="(f, i) in view.findings" :key="i" class="cmaf-bad">
                {{ f.path ? `${f.path}: ` : '' }}{{ f.message }}
                <span class="muted">({{ f.section }})</span>
              </li>
            </ul>
          </div>
          <p v-else-if="!whole" class="cmaf-detail muted">The object is cut short.</p>
          <p v-else-if="obj.payloadLength === 0" class="cmaf-detail muted">No payload.</p>
        </details>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.cmaf-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
}

.cmaf-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
}

.cmaf-objects {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.cmaf-object {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  cursor: pointer;
}

.cmaf-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-1) 0 var(--space-2) var(--space-3);
}

.cmaf-findings {
  margin: 0;
  padding-left: var(--space-3);
}

.cmaf-bad {
  color: var(--danger);
}

.mono {
  font-family: var(--font-mono);
}
.muted {
  color: var(--ink-muted);
}
</style>
