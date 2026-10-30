<script lang="ts" setup>
import type { InitSegment } from '@moqtap/media/bmff'
import { parseCmafObject } from '@moqtap/media/cmaf'
import { computed, ref, watch } from 'vue'
import { initTracksText, payloadBoxes, payloadInit } from '../byte-media'
import { syncText } from '../cmaf'
import { formatBytes } from '../format'
import { objectFrames } from '../frames'
import { objectContentText } from '../object-status'
import type { ParsedStreamFraming, StreamObject } from '../stream-framing'
import FragmentTable from './FragmentTable.vue'
import Icon from './Icon.vue'
import ObjectIds from './ObjectIds.vue'

/** The ISO BMFF boxes and movie fragments of each object, each read on its own when opened. */
const props = defineProps<{
  data: Uint8Array
  /** The stream's objects; null reads the bytes as one payload */
  framing: ParsedStreamFraming | null
  /** The session's draft, which names an object's status */
  draft?: string
  /** The track's CMAF header, when the catalogs give one */
  init?: InitSegment | null
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
  ids: { group?: number; object: number } | null
  payloadOffset: number
  payloadLength: number
  status?: number
}

const objects = computed((): Item[] => {
  const f = props.framing
  if (!f) {
    return [{ offset: 0, ids: null, payloadOffset: 0, payloadLength: props.data.length }]
  }
  return f.objects.map((obj: StreamObject) => {
    return {
      offset: obj.offset,
      ids: { group: obj.groupId, object: obj.objectId },
      payloadOffset: obj.payloadOffset,
      payloadLength: obj.payloadLength,
      ...(obj.status !== undefined ? { status: obj.status } : {}),
    }
  })
})

/** No init segment is applied, so decode times stay in ticks. */
const NO_TIMESCALES = new Map<number, number | null>()

/** The header frame types are read by: the track's, else the first one the stream carries. */
const frameInit = computed(() => {
  if (props.init) return props.init
  for (const item of objects.value) {
    if (item.payloadOffset + item.payloadLength > props.data.length) break
    const own = payloadInit(props.data.subarray(item.payloadOffset, item.payloadOffset + item.payloadLength))
    if (own) return own
  }
  return null
})

const items = computed(() =>
  objects.value.map((item) => {
    const whole = item.payloadOffset + item.payloadLength <= props.data.length
    const payload = props.data.subarray(item.payloadOffset, item.payloadOffset + item.payloadLength)
    const boxes = payloadBoxes(payload)
    const frame = whole && item.payloadLength > 0 ? objectFrames(payload, frameInit.value).badge : null
    if (!whole || item.payloadLength === 0 || !open.value.has(item.offset)) {
      return { item, whole, boxes, frame, view: null, own: null }
    }
    return { item, whole, boxes, frame, view: parseCmafObject(payload), own: payloadInit(payload) }
  }),
)
</script>

<template>
  <div class="bmff-panel">
    <ul class="bmff-objects">
      <li v-for="{ item, whole, boxes, frame, view, own } in items" :key="item.offset">
        <details :open="open.has(item.offset)" @toggle="toggle(item.offset, $event)">
          <summary class="bmff-object object-row">
            <Icon name="chevronRight" class="object-row__chevron" />
            <ObjectIds v-if="item.ids" :group="item.ids.group" :object="item.ids.object" />
            <span v-if="frame" class="mq-badge mq-badge--mono frame-badge">{{ frame }}</span>
            <span v-for="(box, i) in boxes" :key="i" class="mq-badge mq-badge--mono">{{ box }}</span>
            <span class="muted">{{ objectContentText(item, draft, formatBytes) }}</span>
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
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
  cursor: pointer;
}

.frame-badge {
  min-width: 4.5ch;
  justify-content: center;
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
