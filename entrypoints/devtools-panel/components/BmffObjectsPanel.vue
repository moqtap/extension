<script lang="ts" setup>
import { parseCmafObject } from '@moqtap/media/cmaf'
import { computed, ref, watch } from 'vue'
import { initTracksText, payloadInit } from '../byte-media'
import { syncText } from '../cmaf'
import { formatBytes, plural } from '../format'
import type { ParsedStreamFraming, StreamObject } from '../stream-framing'
import FragmentTable from './FragmentTable.vue'

/** The ISO BMFF boxes and movie fragments of each object, each read on its own when opened. */
const props = defineProps<{
  data: Uint8Array
  /** The stream's objects; null reads the bytes as one payload */
  framing: ParsedStreamFraming | null
}>()

/** Objects opened, by offset; parsed only while open. */
const open = ref(new Set<number>())

watch(
  () => props.data,
  () => {
    open.value = new Set()
  },
)

function toggle(offset: number, event: Event) {
  const isOpen = (event.target as HTMLDetailsElement).open
  if (isOpen === open.value.has(offset)) return
  const next = new Set(open.value)
  if (isOpen) next.add(offset)
  else next.delete(offset)
  open.value = next
}

interface Item {
  offset: number
  label: string | null
  payloadOffset: number
  payloadLength: number
  status?: number
}

const objects = computed((): Item[] => {
  const f = props.framing
  if (!f) {
    return [{ offset: 0, label: null, payloadOffset: 0, payloadLength: props.data.length }]
  }
  return f.objects.map((obj: StreamObject) => {
    const groupId = obj.groupId ?? f.headerFields.groupId ?? 0
    return {
      offset: obj.offset,
      label: `g${groupId} · o${obj.objectId}`,
      payloadOffset: obj.payloadOffset,
      payloadLength: obj.payloadLength,
      ...(obj.status !== undefined ? { status: obj.status } : {}),
    }
  })
})

/** No init segment is applied, so decode times stay in ticks. */
const NO_TIMESCALES = new Map<number, number | null>()

const items = computed(() =>
  objects.value.map((item) => {
    const whole = item.payloadOffset + item.payloadLength <= props.data.length
    if (!whole || item.payloadLength === 0 || !open.value.has(item.offset)) {
      return { item, whole, view: null, own: null }
    }
    const payload = props.data.subarray(item.payloadOffset, item.payloadOffset + item.payloadLength)
    return { item, whole, view: parseCmafObject(payload), own: payloadInit(payload) }
  }),
)
</script>

<template>
  <div class="bmff-panel">
    <div v-if="framing" class="bmff-summary">
      <span class="mq-badge mq-badge--mono">{{ plural(framing.objects.length, 'object') }}</span>
    </div>

    <ul class="bmff-objects">
      <li v-for="{ item, whole, view, own } in items" :key="item.offset">
        <details :open="open.has(item.offset)" @toggle="toggle(item.offset, $event)">
          <summary class="bmff-object">
            <span v-if="item.label" class="mono">{{ item.label }}</span>
            <span class="muted"
              >{{ formatBytes(item.payloadLength)
              }}<template v-if="item.status !== undefined">
                · status {{ item.status }}</template
              ></span
            >
          </summary>
          <div v-if="view" class="bmff-detail">
            <dl class="mq-kv bmff-kv">
              <dt>Boxes</dt>
              <dd class="mono">
                {{ view.boxes.join(' ') || '(none)'
                }}<template v-if="view.unreadBytes > 0">
                  · {{ formatBytes(view.unreadBytes) }} after the last box</template
                ><template v-if="view.truncated"> · cut short</template>
              </dd>
              <template v-if="own && own.tracks.length > 0">
                <dt>Tracks</dt>
                <dd class="mono">{{ initTracksText(own) }}</dd>
              </template>
              <template v-if="syncText(view.firstSample)">
                <dt>First sample</dt>
                <dd>{{ syncText(view.firstSample) }}</dd>
              </template>
            </dl>
            <FragmentTable
              :object="view"
              :timescales="NO_TIMESCALES"
              :header-track-ids="null"
            />
          </div>
          <p v-else-if="!whole" class="bmff-detail muted">The object is cut short.</p>
          <p v-else-if="item.payloadLength === 0" class="bmff-detail muted">No payload.</p>
        </details>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.bmff-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
}

.bmff-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
}

.bmff-objects {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.bmff-object {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  cursor: pointer;
}

.bmff-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-1) 0 var(--space-2) var(--space-3);
}

.mono {
  font-family: var(--font-mono);
}
.muted {
  color: var(--ink-muted);
}
</style>
