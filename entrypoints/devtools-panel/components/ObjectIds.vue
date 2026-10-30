<script lang="ts" setup>
/**
 * An object's numbers as plain text, the same in every object list. The group
 * only where the object carries its own (a fetch stream); a subgroup stream's
 * one group is in the stream's meta line.
 */
defineProps<{ group?: number | bigint; object: number | bigint }>()
</script>

<template>
  <span v-if="group !== undefined" class="object-id">group {{ group }}</span>
  <span class="object-id">object {{ object }}</span>
</template>

<style scoped>
.object-id {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
</style>
