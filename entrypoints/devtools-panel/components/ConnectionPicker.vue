<script lang="ts" setup>
import { ref } from 'vue'
import { connectionHost, connectionName } from '../connection-name'
import { shortSessionId } from '../format'
import type { SessionEntry } from '../use-inspector'
import Icon from './Icon.vue'
import PopupMenu from './PopupMenu.vue'

defineProps<{ sessions: SessionEntry[]; selected: SessionEntry | null }>()
const emit = defineEmits<{
  select: [id: string]
  /** The selected connection's context menu, at the pointer or under the picker. */
  context: [anchor: HTMLElement, at: { x: number; y: number } | null]
}>()

function onKey(e: KeyboardEvent) {
  if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return
  e.preventDefault()
  emit('context', e.currentTarget as HTMLElement, null)
}

const open = ref(false)
const btn = ref<HTMLButtonElement | null>(null)
</script>

<template>
  <button
    ref="btn"
    class="mq-btn mq-btn--quiet picker-btn"
    aria-haspopup="menu"
    :aria-expanded="open"
    :title="selected?.url"
    :aria-label="selected ? `Connection: ${connectionName(selected)}` : 'Connection'"
    @click="open = !open"
    @contextmenu.prevent="emit('context', $event.currentTarget as HTMLElement, { x: $event.clientX, y: $event.clientY })"
    @keydown="onKey"
  >
    <span v-if="selected && !selected.closed && !selected.imported" class="mq-dot picker-dot" aria-hidden="true" />
    <template v-if="selected">
      <span class="picker-name">{{ connectionHost(selected.url) }}</span>
      <span class="picker-id">{{ shortSessionId(selected.sessionId) }}</span>
    </template>
    <span v-else class="picker-name">Connection</span>
    <Icon name="chevronDown" />
  </button>
  <PopupMenu v-if="open" :anchor="btn" label="Connections" @close="open = false">
    <button
      v-for="s in sessions"
      :key="s.sessionId"
      class="mq-menu__item"
      role="menuitemradio"
      :aria-checked="s.sessionId === selected?.sessionId"
      :title="s.url"
      @click="emit('select', s.sessionId)"
    >
      {{ connectionName(s) }}
      <span class="menu-hint">{{ s.imported ? 'imported' : s.closed ? 'closed' : 'open' }}</span>
    </button>
  </PopupMenu>
</template>

<style scoped>
.picker-btn {
  gap: var(--space-1);
  min-width: 0;
  padding: 0 var(--space-1);
}
.picker-name {
  min-width: 0;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.picker-id {
  flex: none;
  font-family: var(--font-mono);
  color: var(--ink-muted);
}
.picker-dot {
  color: var(--success);
  flex: none;
}
</style>
