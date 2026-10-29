<script lang="ts" setup>
import { computed, nextTick, ref, toRaw, watch } from 'vue'
import { formatBytes, formatDuration, formatOffset, isoTitle, messageTypeName } from '../format'
import type { GridColumn } from '../grid'
import { messageMatches } from '../requests'
import type { MessageEntry } from '../use-inspector'
import DataGrid from './DataGrid.vue'
import DirMark from './DirMark.vue'
import Icon from './Icon.vue'
import PayloadViewer from './PayloadViewer.vue'
import SplitView from './SplitView.vue'

const props = defineProps<{
  messages: MessageEntry[]
  /** Session start, which the time column counts from. */
  startedAt: number
  draft: number | null
  /** Each response's time since its request. */
  responseTimes: Map<MessageEntry, number>
  /** Each error response's code by name. */
  errorLabels: Map<MessageEntry, string>
  /** A message to open and scroll to */
  focus?: { message: MessageEntry; seq: number } | null
  /** Each message's track name, where its request names one */
  tracks: Map<MessageEntry, string>
  /** The toolbar's filter text, matched against message and track names */
  filter: string
}>()

interface Row {
  msg: MessageEntry
  /** Index in the session's messages: the row's key */
  i: number
}

const rows = computed((): Row[] => {
  const q = props.filter.trim().toLowerCase()
  const out: Row[] = []
  props.messages.forEach((msg, i) => {
    if (
      q === '' ||
      messageMatches(msg.messageType, q, props.draft) ||
      (props.tracks.get(msg)?.toLowerCase().includes(q) ?? false)
    ) {
      out.push({ msg, i })
    }
  })
  return out
})

const isError = (type: string) => /_error$/i.test(type)

const columns: GridColumn<Row>[] = [
  {
    id: 'time',
    label: 'Time',
    width: 92,
    minWidth: 60,
    mono: true,
    title: 'From session start',
    sort: (r) => r.msg.timestamp,
  },
  { id: 'dir', label: 'Dir', width: 36, align: 'center', showFrom: 480, sort: (r) => r.msg.direction },
  { id: 'message', label: 'Message', minWidth: 120, pinned: true, sort: (r) => messageTypeName(r.msg.messageType) },
  { id: 'track', label: 'Track', width: 200, showFrom: 760, sort: (r) => props.tracks.get(r.msg) },
  { id: 'size', label: 'Size', width: 72, align: 'end', mono: true, showFrom: 360, sort: (r) => r.msg.raw.length },
]

const selected = ref<number | null>(null)
const selectedMsg = computed(() => (selected.value === null ? null : (props.messages[selected.value] ?? null)))
watch(
  () => props.filter,
  () => {
    if (selected.value !== null && !rows.value.some((r) => r.i === selected.value)) selected.value = null
  },
)

const grid = ref<{ reveal(key: number): void } | null>(null)
watch(
  () => props.focus,
  async (focus) => {
    if (!focus) return
    const target = toRaw(focus.message)
    const i = props.messages.findIndex((m) => toRaw(m) === target)
    if (i < 0) return
    selected.value = i
    await nextTick()
    grid.value?.reveal(i)
  },
  { immediate: true },
)

function pick(row: Row) {
  selected.value = row.i
}
</script>

<template>
  <div class="message-pane">
    <p v-if="messages.length === 0" class="pane-message">No control messages yet.</p>
    <p v-else-if="rows.length === 0" class="pane-message">No messages match this filter.</p>
    <SplitView
      v-else
      split-id="messages"
      label="Resize message detail"
      :second="selectedMsg !== null"
      :initial="0.5"
      :min-first="120"
      :min-second="160"
    >
      <template #first>
        <DataGrid
          ref="grid"
          grid-id="messages"
          label="Control messages"
          :columns="columns"
          :rows="rows"
          :row-key="(r) => r.i"
          :selected-key="selected"
          :row-class="(r) => (isError(r.msg.messageType) ? 'row-error' : undefined)"
          follow
          @activate="pick"
        >
          <template #cell="{ row, column }">
            <span v-if="column.id === 'time'" :title="isoTitle(row.msg.timestamp)">{{
              formatOffset(row.msg.timestamp, startedAt)
            }}</span>
            <DirMark v-else-if="column.id === 'dir'" :dir="row.msg.direction" />
            <template v-else-if="column.id === 'message'"
              >{{ messageTypeName(row.msg.messageType)
              }}<span v-if="errorLabels.has(row.msg)" class="row-note">{{ errorLabels.get(row.msg) }}</span
              ><span v-else-if="responseTimes.has(row.msg)" class="row-note" title="Response time">{{
                formatDuration(responseTimes.get(row.msg)!)
              }}</span></template
            >
            <span v-else-if="column.id === 'track'" :title="tracks.get(row.msg)">{{ tracks.get(row.msg) }}</span>
            <template v-else-if="column.id === 'size'">{{ formatBytes(row.msg.raw.length) }}</template>
          </template>
        </DataGrid>
      </template>
      <template #second>
        <section v-if="selectedMsg" class="message-detail" aria-labelledby="message-detail-title">
          <div class="tool-bar detail-bar">
            <h2 id="message-detail-title" class="detail-title">
              {{ messageTypeName(selectedMsg.messageType) }}
            </h2>
            <button
              class="mq-btn mq-btn--quiet mq-btn--icon"
              aria-label="Close message"
              title="Close"
              @click="selected = null"
            >
              <Icon name="x" />
            </button>
          </div>
          <div class="detail-body">
            <PayloadViewer
              :key="selected!"
              :data="selectedMsg.decodedPretty"
              :raw="selectedMsg.raw"
              :stack="selectedMsg.stack"
            />
          </div>
        </section>
      </template>
    </SplitView>
  </div>
</template>

<style scoped>
.message-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

/* What the row's message says beyond its name: an error's code, a response's time. */
.row-note {
  margin-left: var(--space-2);
  color: var(--ink-muted);
}
.row-error .row-note {
  color: inherit;
}

.message-detail {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--surface);
}
.detail-bar {
  justify-content: space-between;
}
.detail-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: inherit;
  font-weight: 400;
  padding-left: var(--space-1);
}
.detail-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--space-2);
}
</style>
