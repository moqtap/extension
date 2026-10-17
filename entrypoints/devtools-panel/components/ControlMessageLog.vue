<script lang="ts" setup>
import { ref } from 'vue'
import { formatBytes, formatOffset, isoTitle, messageTypeName } from '../format'
import { useAutoScroll } from '../use-auto-scroll'
import type { MessageEntry } from '../use-inspector'
import PayloadViewer from './PayloadViewer.vue'

defineProps<{
  messages: MessageEntry[]
  /** Session start, which the time column counts from. */
  startedAt: number
}>()

const expandedIndex = ref<number | null>(null)
const logContainer = ref<HTMLElement | null>(null)
useAutoScroll(logContainer)

function toggle(index: number) {
  expandedIndex.value = expandedIndex.value === index ? null : index
}

/** Up and down move between rows; Enter and Space expand (native button). */
function onRowKey(e: KeyboardEvent) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const rows = logContainer.value?.querySelectorAll<HTMLButtonElement>(
    '.mq-log__row',
  )
  if (!rows) return
  const list = Array.from(rows)
  const i = list.indexOf(e.currentTarget as HTMLButtonElement)
  const next = list[e.key === 'ArrowDown' ? i + 1 : i - 1]
  if (next) {
    e.preventDefault()
    next.focus()
  }
}

const isError = (type: string) => /_error$/i.test(type)
</script>

<template>
  <div ref="logContainer" class="message-log mq-log">
    <p v-if="messages.length === 0" class="pane-message">
      No control messages yet.
    </p>
    <template v-else>
      <div class="mq-log__head" aria-hidden="true">
        <span>Time</span><span></span><span>Message</span><span>Size</span>
      </div>
      <ul class="message-list" aria-label="Control messages">
        <li
          v-for="(msg, i) in messages"
          :key="`${msg.timestamp}-${i}`"
          class="message-row"
        >
          <button
            class="mq-log__row"
            :class="{ 'mq-log__row--error': isError(msg.messageType) }"
            :aria-expanded="expandedIndex === i"
            @click="toggle(i)"
            @keydown="onRowKey"
          >
            <span class="mq-log__time" :title="isoTitle(msg.timestamp)">{{
              formatOffset(msg.timestamp, startedAt)
            }}</span>
            <span
              class="mq-log__dir"
              :class="msg.direction === 'tx' ? 'mq-log__dir--c2s' : 'mq-log__dir--s2c'"
              :title="msg.direction === 'tx' ? 'client to server' : 'server to client'"
              ><span aria-hidden="true">{{ msg.direction === 'tx' ? '→' : '←' }}</span
              ><span class="mq-sr">{{
                msg.direction === 'tx' ? 'client to server' : 'server to client'
              }}</span></span
            >
            <span class="mq-log__type">{{ messageTypeName(msg.messageType) }}</span>
            <span class="mq-log__meta">{{ formatBytes(msg.raw.length) }}</span>
          </button>
          <div v-if="expandedIndex === i" class="message-detail">
            <PayloadViewer :data="msg.decodedPretty" :raw="msg.raw" :stack="msg.stack" />
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.message-log {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.mq-log__head {
  position: sticky;
  top: 0;
  z-index: 1;
}

.message-list {
  list-style: none;
  padding: 0;
}

.mq-log__row {
  width: 100%;
  border-top: 0;
  border-left: 0;
  border-right: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  text-align: left;
}
.mq-log__row[aria-expanded='true'] {
  background: var(--surface-selected);
}

.message-detail {
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-6);
  background: var(--surface-sunken);
  border-bottom: 1px solid var(--line);
  font-family: var(--font-sans);
}
</style>
