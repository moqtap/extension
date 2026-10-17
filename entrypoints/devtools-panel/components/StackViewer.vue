<script lang="ts" setup>
import { computed } from 'vue'
import { parseStack, shortUrl, type StackFrame } from '../stack-parse'

const props = defineProps<{
  stack: string
}>()

const groups = computed(() => parseStack(props.stack))

function openSource(frame: StackFrame) {
  if (!frame.url || frame.isNative) return
  // browser.devtools.panels.openResource uses 0-based line/column numbers
  const col = frame.column > 0 ? frame.column - 1 : 0
  browser.devtools.panels.openResource(frame.url, frame.line - 1, col, () => {})
}
</script>

<template>
  <div class="stack-viewer">
    <p v-if="groups.length === 0" class="empty">No stack trace for this message.</p>
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
              v-if="!frame.isNative"
              href="#"
              class="file-link"
              :title="frame.url + ':' + frame.line + ':' + frame.column"
              @click.prevent="openSource(frame)"
              >{{ shortUrl(frame.url) }}:{{ frame.line }}</a
            >
            <span v-else class="file-native" :title="frame.url"
              >{{ shortUrl(frame.url) }}:{{ frame.line }}</span
            >
          </template>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.stack-viewer {
  font: 400 12px/20px var(--font-mono);
  padding: var(--space-1) 0;
}

.empty {
  color: var(--ink-muted);
  padding: var(--space-2) 0;
  font-family: var(--font-sans);
}

.stack-frame {
  padding: 0 var(--space-1);
  white-space: nowrap;
}

.stack-frame:hover {
  background: var(--surface-hover);
}

.stack-frame.native,
.fn-raw,
.at,
.file-native {
  color: var(--ink-muted);
}

.fn-name {
  color: var(--ink);
  font-weight: 500;
}

.file-link {
  color: var(--link);
  text-decoration: underline;
  text-underline-offset: 0.15em;
}

.async-separator {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 2px var(--space-1);
  color: var(--ink-muted);
}

.async-separator::before,
.async-separator::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--line);
}

.async-label {
  font-style: italic;
}
</style>
