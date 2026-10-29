<script lang="ts" setup>
import { inject, nextTick, onBeforeUnmount, provide, ref, watch } from 'vue'
import { placeMenu, placeSubmenu } from '../layout'
import { MENU_LEVEL, MENU_ROOT, type MenuRoot, menuKey, OPEN_SUB_EVENT } from '../menu-keys'

/**
 * A menu anchored to the element that opened it. Arrow keys, Home and End
 * move between items, Escape closes it and returns focus to the anchor.
 * A `MenuSubmenu` item opens another one beside it (`side`).
 */
const props = withDefaults(
  defineProps<{
    anchor: HTMLElement | null
    label: string
    /** A submenu, beside the item that opened it. */
    side?: boolean
    /** Focus an item on opening: off for a submenu opened by hovering. */
    focusOnOpen?: boolean
  }>(),
  { side: false, focusOnOpen: true },
)
const emit = defineEmits<{ close: [] }>()

const el = ref<HTMLElement | null>(null)
const pos = ref({ left: 0, top: 0, maxHeight: 0 })

const parentRoot = inject(MENU_ROOT, null)
const nested = parentRoot !== null
const root: MenuRoot = parentRoot ?? { menus: new Set(), closeAll: (refocus = true) => close(refocus) }
if (!nested) provide(MENU_ROOT, root)
const level = { open: ref<symbol | null>(null) }
provide(MENU_LEVEL, level)

const ITEMS = '[role^="menuitem"]:not([aria-disabled="true"])'

/** This menu's own items, not a submenu's. */
function items(): HTMLElement[] {
  return Array.from(el.value?.querySelectorAll<HTMLElement>(ITEMS) ?? [])
}

function place() {
  const menu = el.value
  const a = props.anchor
  if (!menu || !a) return
  const size = { width: menu.offsetWidth, height: menu.scrollHeight }
  const view = { width: window.innerWidth, height: window.innerHeight }
  pos.value = (props.side ? placeSubmenu : placeMenu)(a.getBoundingClientRect(), size, view)
}

function close(refocus = true) {
  emit('close')
  if (refocus) props.anchor?.focus()
}

function onKey(e: KeyboardEvent) {
  const list = items()
  const active = document.activeElement as HTMLElement | null
  const i = list.indexOf(active as HTMLElement)
  const action = menuKey(e.key, {
    index: i,
    count: list.length,
    onTrigger: i >= 0 && active?.getAttribute('aria-haspopup') === 'menu',
    nested,
  })
  if (action === null) return
  if (action.kind === 'leave') {
    root.closeAll(false)
    return
  }
  e.preventDefault()
  e.stopPropagation()
  if (action.kind === 'focus') list[action.index]?.focus()
  else if (action.kind === 'open-sub') active?.dispatchEvent(new CustomEvent(OPEN_SUB_EVENT))
  else close()
}

function onDocPointer(e: PointerEvent) {
  const t = e.target as Node
  for (const m of root.menus) if (m.contains(t)) return
  if (props.anchor?.contains(t)) return
  close(false)
}

// Items that do their thing close every menu; a disabled one, padding or a submenu item does not.
function onClick(e: MouseEvent) {
  const item = (e.target as HTMLElement).closest('[role^="menuitem"]')
  if (!item || item.getAttribute('aria-disabled') === 'true' || item.hasAttribute('data-keep-open')) return
  if (item.getAttribute('aria-haspopup') === 'menu') return
  root.closeAll()
}

/**
 * The pointer takes the focus, as in DevTools' menus: one highlighted item.
 * Only when it moves: a menu opened from the keyboard under a resting
 * pointer keeps its focus.
 */
let hoverTimer: ReturnType<typeof setTimeout> | undefined
let lastPointer = ''
function onPointerMove(e: PointerEvent) {
  const at = `${e.screenX},${e.screenY}`
  if (at === lastPointer) return
  lastPointer = at
  const item = (e.target as HTMLElement).closest<HTMLElement>('[role^="menuitem"]')
  if (!item || !el.value?.contains(item)) return
  if (item.getAttribute('aria-disabled') !== 'true' && document.activeElement !== item) {
    item.focus({ preventScroll: true })
  }
  clearTimeout(hoverTimer)
  if (item.getAttribute('aria-haspopup') !== 'menu') hoverTimer = setTimeout(() => (level.open.value = null), 200)
}

watch(
  () => props.anchor,
  () => void nextTick(place),
)

function focusDefault() {
  const list = items()
  ;(list.find((i) => i.getAttribute('aria-checked') === 'true') ?? list[0])?.focus()
}

void nextTick(() => {
  if (el.value) root.menus.add(el.value)
  place()
  if (props.focusOnOpen) focusDefault()
})

// Items re-rendered under the focus (a list that grows while open) drop it; take it back.
function onFocusOut() {
  setTimeout(() => {
    if (el.value && (document.activeElement === document.body || document.activeElement === null)) focusDefault()
  })
}

const onResize = () => close(false)
if (!nested) {
  document.addEventListener('pointerdown', onDocPointer, true)
  window.addEventListener('resize', onResize)
}
onBeforeUnmount(() => {
  clearTimeout(hoverTimer)
  if (el.value) root.menus.delete(el.value)
  if (!nested) {
    document.removeEventListener('pointerdown', onDocPointer, true)
    window.removeEventListener('resize', onResize)
  }
})

defineExpose({ place })
</script>

<template>
  <Teleport to="body">
    <div
      ref="el"
      class="mq-menu popup-menu"
      role="menu"
      :aria-label="label"
      :style="{ left: `${pos.left}px`, top: `${pos.top}px`, maxHeight: pos.maxHeight ? `${pos.maxHeight}px` : undefined }"
      @keydown="onKey"
      @click="onClick"
      @pointermove="onPointerMove"
      @focusout="onFocusOut"
    >
      <slot />
    </div>
  </Teleport>
</template>

<style scoped>
.popup-menu {
  position: fixed;
  z-index: var(--z-menu);
  min-width: 160px;
  max-width: min(360px, calc(100vw - 8px));
  overflow-y: auto;
  list-style: none;
}
</style>

<style>
/* Shared by every menu's items. */
.popup-menu .mq-menu__item {
  display: flex;
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  text-align: left;
  white-space: nowrap;
}
.popup-menu .mq-menu__item:focus {
  outline: none;
}
/* The pointer moves the focus, so hover and keyboard focus are one highlight;
   a menu opened by the pointer shows none until an item is hovered. */
.popup-menu .mq-menu__item:hover,
.popup-menu .mq-menu__item:focus-visible,
.popup-menu .mq-menu__item[aria-expanded='true'] {
  background: var(--menu-hover);
  color: var(--ink);
}
.popup-menu .mq-menu__item[aria-disabled='true'] {
  color: var(--ink-disabled);
  cursor: default;
}
.popup-menu .mq-menu__item[aria-disabled='true']:is(:hover, :focus-visible) {
  background: transparent;
}
.popup-menu .mq-menu__item .menu-hint {
  margin-left: auto;
  padding-left: var(--space-3);
  color: var(--ink-muted);
}
.popup-menu .mq-menu__label {
  white-space: normal;
}
.popup-menu hr {
  margin: var(--space-1) 0;
}
</style>
