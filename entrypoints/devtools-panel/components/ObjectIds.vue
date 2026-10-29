<script lang="ts" setup>
/** An object's group and object numbers as badges, the same in every object list. */
defineProps<{ group: number | bigint; object: number | bigint }>()
</script>

<template>
  <span class="mq-badge mq-badge--mono">group {{ group }}</span>
  <span class="mq-badge mq-badge--mono">object {{ object }}</span>
</template>
