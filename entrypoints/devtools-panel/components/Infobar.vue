<script lang="ts" setup>
import Icon from './Icon.vue'

defineProps<{ kind: 'info' | 'warning'; dismissible?: boolean }>()
const emit = defineEmits<{ dismiss: [] }>()
</script>

<template>
  <div class="infobar" :class="`infobar--${kind}`" role="status">
    <Icon :name="kind" class="infobar__icon" />
    <p class="infobar__text"><slot /></p>
    <div v-if="$slots.actions" class="infobar__actions"><slot name="actions" /></div>
    <button
      v-if="dismissible"
      class="mq-btn mq-btn--quiet mq-btn--icon infobar__close"
      aria-label="Dismiss"
      title="Dismiss"
      @click="emit('dismiss')"
    >
      <Icon name="x" />
    </button>
  </div>
</template>

<style scoped>
.infobar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--header-tool);
  padding: 1px var(--space-1) 1px var(--space-2);
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}
.infobar--info {
  background: var(--info-soft);
}
.infobar--warning {
  background: var(--warning-soft);
}
.infobar__icon {
  flex: none;
}
.infobar--info .infobar__icon {
  color: var(--info);
}
.infobar--warning .infobar__icon {
  color: var(--warning);
}
.infobar__text {
  flex: 1;
  min-width: 0;
}
.infobar__actions {
  display: flex;
  gap: var(--space-1);
  flex: none;
}
.infobar__close {
  flex: none;
}
</style>
