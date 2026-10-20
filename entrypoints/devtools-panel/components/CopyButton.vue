<script lang="ts" setup>
import { onBeforeUnmount, ref } from 'vue'
import Icon from './Icon.vue'

/** The design system's CopyButton, icon only, for a value shown beside it. */
const props = defineProps<{ value: string; what: string }>()

const copied = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(timer))

async function copy() {
  try {
    await navigator.clipboard.writeText(props.value)
  } catch {
    // The value stays on screen to select by hand.
    return
  }
  copied.value = true
  clearTimeout(timer)
  timer = setTimeout(() => (copied.value = false), 1600)
}
</script>

<template>
  <button
    type="button"
    class="mq-btn mq-btn--quiet mq-btn--icon mq-copy"
    :data-state="copied ? 'copied' : undefined"
    :aria-label="`Copy ${what}`"
    :title="`Copy ${what}`"
    @click="copy"
  >
    <Icon name="copy" />
  </button>
  <span class="mq-sr" aria-live="polite">{{ copied ? 'Copied' : '' }}</span>
</template>
