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
    <div class="payload-modes" role="group" aria-label="Show message as">
      <button
        class="mq-btn mq-btn--quiet"
        :aria-pressed="viewMode === 'decoded'"
        @click="viewMode = 'decoded'"
      >
        Decoded
      </button>
      <button
        class="mq-btn mq-btn--quiet"
        :aria-pressed="viewMode === 'hex'"
        @click="viewMode = 'hex'"
      >
        Bytes
      </button>
      <button
        v-if="stack"
        class="mq-btn mq-btn--quiet"
        :aria-pressed="viewMode === 'stack'"
        @click="viewMode = 'stack'"
      >
        Stack
      </button>
    </div>
    <div class="payload-content">
      <template v-if="viewMode === 'decoded'">
        <JsonTree v-if="data" :data="data" :initial-expanded="true" />
        <p v-else class="mq-muted">
          This message didn't decode. Bytes shows what it carried.
        </p>
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
  gap: var(--space-1);
}

.payload-modes {
  display: flex;
  gap: var(--space-1);
}

.payload-content {
  max-height: 300px;
  overflow: auto;
}
</style>
