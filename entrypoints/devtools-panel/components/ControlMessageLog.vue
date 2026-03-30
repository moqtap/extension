<script lang="ts" setup>
import { ref } from 'vue';
import type { MessageEntry } from '../use-inspector';
import PayloadViewer from './PayloadViewer.vue';
import { useAutoScroll } from '../use-auto-scroll';

defineProps<{
  messages: MessageEntry[];
}>();

const expandedIndex = ref<number | null>(null);
const logContainer = ref<HTMLElement | null>(null);
useAutoScroll(logContainer);

function toggle(index: number) {
  expandedIndex.value = expandedIndex.value === index ? null : index;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  } as Intl.DateTimeFormatOptions);
}
</script>

<template>
  <div ref="logContainer" class="message-log">
    <div v-if="messages.length === 0" class="empty-state">
      No control messages yet
    </div>
    <div
      v-for="(msg, i) in messages"
      :key="i"
      class="message-row"
      :class="{ expanded: expandedIndex === i }"
    >
      <div class="message-summary" @click="toggle(i)">
        <span class="msg-expand">{{ expandedIndex === i ? '\u25BC' : '\u25B6' }}</span>
        <span class="msg-time mono">{{ formatTime(msg.timestamp) }}</span>
        <span
          class="msg-direction"
          :class="msg.direction === 'tx' ? 'direction-tx' : 'direction-rx'"
        >
          {{ msg.direction === 'tx' ? '\u2191' : '\u2193' }}
        </span>
        <span class="msg-type mono">{{ msg.messageType }}</span>
        <span class="msg-size mono">{{ msg.raw.length }}B</span>
      </div>
      <div v-if="expandedIndex === i" class="message-detail">
        <PayloadViewer :data="msg.decoded" :raw="msg.raw" :stack="msg.stack" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.message-log {
  height: 100%;
  overflow-y: auto;
}

.message-row {
  border-bottom: 1px solid var(--border);
}

.message-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  cursor: pointer;
  transition: background 0.1s;
}
.message-summary:hover {
  background: var(--bg-hover);
}

.msg-expand {
  font-size: 9px;
  color: var(--text-secondary);
  width: 10px;
}

.msg-time {
  color: var(--text-secondary);
  font-size: 10px;
  min-width: 75px;
}

.msg-direction {
  font-size: 12px;
  font-weight: bold;
  width: 14px;
  text-align: center;
}

.msg-type {
  flex: 1;
  color: var(--text-warning);
}

.msg-size {
  color: var(--text-secondary);
  font-size: 10px;
}

.message-detail {
  padding: 8px 10px 8px 32px;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border);
}
</style>
