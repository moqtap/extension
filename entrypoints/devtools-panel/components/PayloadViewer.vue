<script lang="ts" setup>
import { ref, watch } from 'vue'
import { getCachedPref, savePref } from '../prefs'
import HexViewer from './HexViewer.vue'
import JsonTree from './JsonTree.vue'
import StackViewer from './StackViewer.vue'

const props = defineProps<{
  data: unknown | null
  raw: Uint8Array
  stack?: string
}>()

type ViewMode = 'decoded' | 'hex' | 'stack'

// Use saved preference, but fall back to 'hex' if no decoded data
const savedPref = getCachedPref('payloadViewMode')
const viewMode = ref<ViewMode>(
  savedPref === 'hex'
    ? 'hex'
    : savedPref === 'stack' && props.stack
      ? 'stack'
      : props.data
        ? 'decoded'
        : 'hex',
)

watch(viewMode, (mode) => {
  savePref('payloadViewMode', mode)
})
</script>

<template>
  <div class="payload-viewer">
    <div class="payload-tabs">
      <button
        class="ptab"
        :class="{ active: viewMode === 'decoded' }"
        @click="viewMode = 'decoded'"
      >
        Decoded
      </button>
      <button
        class="ptab"
        :class="{ active: viewMode === 'hex' }"
        @click="viewMode = 'hex'"
      >
        Hex
      </button>
      <button
        v-if="stack"
        class="ptab"
        :class="{ active: viewMode === 'stack' }"
        @click="viewMode = 'stack'"
      >
        Stack
      </button>
    </div>
    <div class="payload-content">
      <template v-if="viewMode === 'decoded'">
        <JsonTree v-if="data" :data="data" :initial-expanded="true" />
        <span v-else class="decode-failed">Decode failed</span>
      </template>
      <StackViewer v-else-if="viewMode === 'stack' && stack" :stack="stack" />
      <HexViewer v-else :data="raw" />
    </div>
  </div>
</template>

<style scoped>
.payload-viewer {
  display: flex;
  flex-direction: column;
}

.payload-tabs {
  display: flex;
  gap: 2px;
  margin-bottom: 6px;
}

.ptab {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text-secondary);
  padding: 2px 8px;
  cursor: pointer;
  font-size: 10px;
  font-family: inherit;
}
.ptab:hover {
  color: var(--text-primary);
}
.ptab.active {
  background: var(--bg-selected);
  color: var(--text-primary);
  border-color: var(--text-accent);
}

.payload-content {
  max-height: 300px;
  overflow: auto;
}

.decode-failed {
  color: var(--text-secondary);
  font-style: italic;
  font-size: 11px;
}
</style>
