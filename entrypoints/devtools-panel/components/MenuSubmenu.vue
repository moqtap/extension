<script lang="ts" setup>
import { inject, onBeforeUnmount, ref, watch } from 'vue'
import { MENU_LEVEL, OPEN_SUB_EVENT } from '../menu-keys'
import Icon from './Icon.vue'
import PopupMenu from './PopupMenu.vue'

/**
 * An item that opens a submenu beside it: on hover, a click, or ArrowRight,
 * Enter or Space; ArrowLeft or Escape in the submenu comes back here.
 */
const props = defineProps<{ label: string; disabled?: boolean }>()

const level = inject(MENU_LEVEL)
const id = Symbol(props.label)
const item = ref<HTMLButtonElement | null>(null)
const open = ref(false)
/** Opened from the keyboard: the submenu takes the focus. */
const keyboard = ref(false)

function show(fromKeyboard: boolean) {
  if (props.disabled) return
  keyboard.value = fromKeyboard
  open.value = true
  if (level) level.open.value = id
}
function closed() {
  open.value = false
  if (level?.open.value === id) level.open.value = null
}
if (level) watch(level.open, (v) => v !== id && (open.value = false))

// A click from the keyboard (Enter in a browser that sends one) has no pointer position.
function onClick(e: MouseEvent) {
  if (!open.value || e.detail === 0) show(e.detail === 0)
}

let timer: ReturnType<typeof setTimeout> | undefined
function onEnter() {
  clearTimeout(timer)
  timer = setTimeout(() => show(false), 150)
}
function onLeave() {
  clearTimeout(timer)
}
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <button
    ref="item"
    class="mq-menu__item menu-sub"
    role="menuitem"
    aria-haspopup="menu"
    :aria-expanded="open"
    :aria-disabled="disabled ? 'true' : undefined"
    @click="onClick"
    @pointerenter="onEnter"
    @pointerleave="onLeave"
    v-on="{ [OPEN_SUB_EVENT]: () => show(true) }"
  >
    <span class="menu-sub__label">{{ label }}</span>
    <Icon name="chevronRight" class="menu-sub__caret" />
  </button>
  <PopupMenu v-if="open" :anchor="item" :label="label" side :focus-on-open="keyboard" @close="closed">
    <slot />
  </PopupMenu>
</template>

<style scoped>
.popup-menu .menu-sub {
  position: relative;
  align-items: center;
  padding-right: 28px;
}
.menu-sub__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* In the column where radio items put their check. */
.menu-sub__caret {
  position: absolute;
  right: var(--space-2);
  color: var(--ink-muted);
}
.menu-sub__caret :deep(svg) {
  width: 12px;
  height: 12px;
}
</style>
