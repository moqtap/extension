<script lang="ts" setup>
import { type IconName, icons } from '../icons'

defineProps<{ name: IconName }>()
</script>

<template>
  <span class="ext-icon" aria-hidden="true" v-html="icons[name]" />
</template>

<style scoped>
.ext-icon {
  display: inline-flex;
  flex: none;
}
</style>
