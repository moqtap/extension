<script lang="ts" setup>
import type { CliView } from '@/src/cli/messages'
import { isLink, LINKS, type Link } from '@/src/cli/protocol'
import { computed } from 'vue'
import { CLI_ERRORS, LINK_LABELS } from '../cli-copy'
import Icon from './Icon.vue'

const props = defineProps<{ view: CliView | null; compact?: boolean }>()
const emit = defineEmits<{ setLink: [link: Link]; reconsider: [] }>()

const connected = computed(() => (props.view?.state === 'connected' ? props.view : null))
const status = computed(() => connected.value?.status ?? null)

const summary = computed(() => {
  const s = status.value
  if (s === null) return `moqtap CLI ${connected.value?.cliVersion ?? ''}`.trim()
  return `${s.listen} · ${s.clientConnected ? 'client connected' : 'no client'}`
})

const compactTitle = computed(() => {
  const s = status.value
  if (s === null) return 'moqtap CLI'
  return `CLI link: ${s.link === null ? 'scenario' : LINK_LABELS[s.link]}. ${summary.value}`
})

function onChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value
  if (isLink(v)) emit('setLink', v)
}
</script>

<template>
  <div v-if="connected" class="cli" :class="{ compact }">
    <span v-if="compact" class="cli-icon" :title="compactTitle">
      <Icon name="terminal" />
      <span class="mq-sr">{{ compactTitle }}</span>
    </span>
    <template v-else>
      <div class="cli-row">
        <label class="mq-label" for="cli-link">CLI link</label>
        <select
          id="cli-link"
          class="mq-select cli-select"
          :value="status?.link ?? ''"
          :disabled="status === null || status.scenario"
          @change="onChange"
        >
          <option v-if="status === null || status.scenario" value="" disabled>
            {{ status === null ? '…' : 'Scenario' }}
          </option>
          <option v-for="l in LINKS" :key="l" :value="l">{{ LINK_LABELS[l] }}</option>
        </select>
      </div>
      <p class="mq-muted cli-summary mq-mono" :title="`Identity ${connected.fingerprint}`">
        {{ summary }}
      </p>
      <p v-if="connected.error" class="mq-error-text" role="status">
        {{ CLI_ERRORS[connected.error] }}
      </p>
    </template>
  </div>
  <div v-else-if="view?.state === 'declined' && !compact" class="cli">
    <button class="mq-btn mq-btn--quiet cli-reconsider" @click="emit('reconsider')">
      <Icon name="terminal" /> Control the moqtap CLI
    </button>
  </div>
  <div v-else-if="view?.state === 'unsupported' && !compact" class="cli">
    <p class="mq-muted">Update the browser to control the moqtap CLI from here.</p>
  </div>
</template>

<style scoped>
.cli {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
  border-top: 1px solid var(--line);
}
.cli.compact {
  align-items: center;
  padding: var(--space-2) var(--space-1);
}
.cli-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.cli-row .mq-label {
  flex: none;
}
.cli-select {
  flex: 1;
  min-width: 0;
}
.cli-summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cli-icon {
  display: inline-flex;
  color: var(--ink-muted);
}
.cli-reconsider {
  align-self: flex-start;
  gap: var(--space-1);
}
</style>
