<script lang="ts" setup>
import type { ProfileChoice } from '@/src/cli/protocol'
import type { MenuNode } from '../impair-choices'
import ImpairmentNodes from './ImpairmentNodes.vue'
import MenuSubmenu from './MenuSubmenu.vue'

/** Profiles as radio items, folders as submenus of them. */
defineProps<{
  nodes: readonly MenuNode[]
  checked: (c: ProfileChoice) => boolean
  disabled: (c: ProfileChoice) => boolean
}>()
const emit = defineEmits<{ pick: [choice: ProfileChoice] }>()
</script>

<template>
  <template v-for="node in nodes" :key="node.kind === 'item' ? `i:${node.choice.name}` : `f:${node.name}`">
    <button
      v-if="node.kind === 'item'"
      class="mq-menu__item"
      role="menuitemradio"
      :aria-checked="checked(node.choice)"
      :aria-disabled="disabled(node.choice) ? 'true' : undefined"
      @click="emit('pick', node.choice)"
    >
      {{ node.choice.name }}
    </button>
    <MenuSubmenu v-else :label="node.name">
      <ImpairmentNodes :nodes="node.children" :checked="checked" :disabled="disabled" @pick="emit('pick', $event)" />
    </MenuSubmenu>
  </template>
</template>
