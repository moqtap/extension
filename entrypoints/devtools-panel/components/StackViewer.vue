<script lang="ts" setup>
import { computed } from 'vue'
import { parseStack, shortUrl, type StackFrame } from '../stack-parse'

const props = defineProps<{
  stack: string
}>()

const groups = computed(() => parseStack(props.stack))

function openSource(frame: StackFrame) {
  if (!frame.url || frame.isNative) return
  // chrome.devtools.panels.openResource uses 0-based line/column numbers
  const col = frame.column > 0 ? frame.column - 1 : 0
  chrome.devtools.panels.openResource(frame.url, frame.line - 1, col, () => {})
}
</script>

<template>
  <div class="stack-viewer">
    <div v-if="groups.length === 0" class="empty">No stack trace available</div>
    <template v-for="(group, gi) in groups" :key="gi">
      <div v-if="group.isAsync" class="async-separator">
        <span class="async-label">(async)</span>
      </div>
      <div
        v-for="(frame, fi) in group.frames"
        :key="`${gi}-${fi}`"
        class="stack-frame"
        :class="{ native: frame.isNative }"
      >
        <template v-if="frame.raw">
          <span class="fn-raw">{{ frame.raw }}</span>
        </template>
        <template v-else>
          <span class="fn-name">{{ frame.functionName }}</span>
          <template v-if="frame.url">
            <span class="at"> @ </span>
            <a
              class="file-link"
              :class="{ clickable: !frame.isNative }"
              :title="frame.url + ':' + frame.line + ':' + frame.column"
              @click.prevent="openSource(frame)"
              >{{ shortUrl(frame.url) }}:{{ frame.line }}</a
            >
          </template>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.stack-viewer {
  font-family:
    'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New',
    monospace;
  font-size: 11px;
  line-height: 1.8;
  padding: 4px 0;
}

.empty {
  color: var(--text-secondary);
  padding: 8px 0;
}

.stack-frame {
  padding: 0 4px;
  white-space: nowrap;
}

.stack-frame:hover {
  background: var(--bg-hover);
}

.stack-frame.native {
  opacity: 0.5;
}

.fn-name {
  color: var(--text-warning);
}

.fn-raw {
  color: var(--text-secondary);
}

.at {
  color: var(--text-secondary);
}

.file-link {
  color: var(--text-url);
  text-decoration: none;
}

.file-link.clickable {
  cursor: pointer;
}

.file-link.clickable:hover {
  text-decoration: underline;
}

.async-separator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px;
  color: var(--text-secondary);
  opacity: 0.7;
}

.async-separator::before,
.async-separator::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border);
}

.async-label {
  font-style: italic;
  font-size: 10px;
}
</style>
