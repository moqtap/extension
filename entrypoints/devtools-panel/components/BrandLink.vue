<script lang="ts" setup>
import logo from '../moqtap-logo.svg?raw'
import markSvg from '../moqtap-mark.svg?raw'

/** The T mark alone, where the whole logo does not fit. */
defineProps<{ mark?: boolean }>()
</script>

<template>
  <a
    class="brand-link"
    :class="{ 'is-mark': mark }"
    href="https://moqtap.com"
    target="_blank"
    rel="noopener"
    aria-label="moqtap.com"
    title="moqtap.com"
    v-html="mark ? markSvg : logo"
  />
</template>

<style scoped>
/* A toolbar item: the brand lockup with its T as tall as the toolbar text's
   capitals and its baseline on the text's. The logo's height is 898 units, the
   T's 698 from the baseline up; system-ui capitals are 0.7 em. */
.brand-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  height: var(--control-tool, 24px);
  padding: 0 var(--space-1);
  border-radius: var(--radius-sm);
  line-height: 0;
  color: var(--ink);
}
.brand-link:hover {
  background: var(--surface-hover);
}
.brand-link :deep(svg) {
  display: block;
  height: calc(var(--host-text) * 0.9);
  width: auto;
  transform: translateY(var(--logo-drop, 1px));
}
/* Each DevTools' text sits differently in its bar; measured, not derived. */
:global(html.host--firefox .brand-link) {
  --logo-drop: 1.8px;
}
.brand-link.is-mark :deep(svg) {
  height: calc(var(--host-text) * 0.7);
  transform: none;
}
</style>
