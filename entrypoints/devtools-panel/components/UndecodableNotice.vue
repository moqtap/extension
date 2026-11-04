<script lang="ts" setup>
import { hexLines } from '../undecodable'
import type { UndecodableNotice } from '../undecodable-stream'
import Icon from './Icon.vue'

defineProps<{ notice: UndecodableNotice }>()
</script>

<template>
  <div class="mq-notice mq-notice--warning" role="status">
    <Icon name="warning" class="mq-notice__icon" />
    <div class="notice-body">
      <p class="mq-notice__title">{{ notice.title }}</p>
      <p>{{ notice.reason }}</p>
      <pre v-if="notice.raw" class="notice-raw">{{ hexLines(notice.raw) }}</pre>
    </div>
  </div>
</template>

<style scoped>
.notice-body {
  min-width: 0;
}

.notice-raw {
  margin: var(--space-1) 0 0;
  max-height: 12em;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: var(--type-data-xs-size);
  white-space: pre;
}
</style>
