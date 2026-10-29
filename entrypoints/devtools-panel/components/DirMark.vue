<script lang="ts" setup>
import Icon from './Icon.vue'

/** Sent up, received down, as DevTools marks WebSocket frames. */
const props = defineProps<{ dir: 'tx' | 'rx'; label?: string }>()
const text = () => props.label ?? (props.dir === 'tx' ? 'Sent' : 'Received')
</script>

<template>
  <span
    class="dir"
    :class="dir === 'tx' ? 'dir-c2s' : 'dir-s2c'"
    role="img"
    :aria-label="text()"
    :title="text()"
    ><Icon :name="dir === 'tx' ? 'arrowUp' : 'arrowDown'"
  /></span>
</template>
