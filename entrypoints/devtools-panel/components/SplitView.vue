<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getCachedPref, savePref } from '../prefs'
import {
  clampSplit,
  restoredSplit,
  splitKeySize,
  splitOrientation,
  type SplitOrientation,
  storedSplit,
} from '../split'

/**
 * Two panes and a 1 px divider you drag. Side by side when wide, stacked
 * below `stackBelow` px. The first pane's size is kept per `splitId` and
 * orientation, in px or as a share of the whole.
 */
const props = withDefaults(
  defineProps<{
    splitId: string
    label: string
    /** Show the first pane; without it the second takes everything */
    first?: boolean
    /** Show the second pane; without it the first takes everything */
    second?: boolean
    /** First pane before anything is stored: px, or a share for `unit: 'ratio'` */
    initial: number
    unit?: 'px' | 'ratio'
    minFirst?: number
    minSecond?: number
    /** Stack below this width; 0 never stacks */
    stackBelow?: number
    /** Hold the first pane at this many px, with no handle (a collapsed sidebar) */
    fixed?: number
  }>(),
  { first: true, second: true, unit: 'ratio', minFirst: 120, minSecond: 160, stackBelow: 600 },
)

const root = ref<HTMLElement | null>(null)
const box = ref({ width: 0, height: 0 })
const orientation = computed<SplitOrientation>(() =>
  props.stackBelow > 0 ? splitOrientation(box.value.width, props.stackBelow) : 'horizontal',
)
const total = computed(() => (orientation.value === 'horizontal' ? box.value.width : box.value.height))
const key = computed(() => `${props.splitId}:${orientation.value}`)

/** What is stored for each key; read once, then kept here as it changes. */
const stored = ref<Record<string, number>>({ ...getCachedPref('splits') })
const dragged = ref<number | null>(null)
const size = computed(() => {
  const s = stored.value[key.value]
  const wanted = dragged.value ?? restoredSplit(s ?? props.initial, total.value, props.unit)
  return clampSplit(wanted, total.value, props.minFirst, props.minSecond)
})
const percent = computed(() => (total.value > 0 ? Math.round((size.value / total.value) * 100) : 0))
const both = computed(() => props.first && props.second)
const shown = computed(() => (props.fixed !== undefined ? props.fixed : size.value))
const firstStyle = computed(() => (both.value ? { flex: `0 0 ${shown.value}px` } : { flex: '1 1 auto' }))

const emit = defineEmits<{ size: [px: number] }>()
/** The first pane's width as it moves, 0 while it is hidden, for chrome that lines up with it. */
watch(
  () => (both.value && total.value > 0 ? shown.value : 0),
  (px) => emit('size', px),
  { immediate: true },
)

function persist(px: number) {
  const value = storedSplit(clampSplit(px, total.value, props.minFirst, props.minSecond), total.value, props.unit)
  stored.value = { ...stored.value, [key.value]: value }
  void savePref('splits', { ...getCachedPref('splits'), [key.value]: value })
}

let start: { pos: number; size: number } | null = null
function onDown(e: PointerEvent) {
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  start = { pos: orientation.value === 'horizontal' ? e.clientX : e.clientY, size: size.value }
}
function onMove(e: PointerEvent) {
  if (!start) return
  const pos = orientation.value === 'horizontal' ? e.clientX : e.clientY
  dragged.value = clampSplit(start.size + pos - start.pos, total.value, props.minFirst, props.minSecond)
}
function onUp() {
  if (!start) return
  start = null
  if (dragged.value !== null) persist(dragged.value)
  dragged.value = null
}
function onKey(e: KeyboardEvent) {
  const next = splitKeySize(e.key, size.value, orientation.value)
  if (next === null) return
  e.preventDefault()
  persist(next)
}

let ro: ResizeObserver | null = null
onMounted(() => {
  const el = root.value
  if (!el) return
  box.value = { width: el.clientWidth, height: el.clientHeight }
  ro = new ResizeObserver(() => {
    box.value = { width: el.clientWidth, height: el.clientHeight }
  })
  ro.observe(el)
})
onBeforeUnmount(() => ro?.disconnect())

defineExpose({ orientation })
</script>

<template>
  <div ref="root" class="split-view" :class="`split-view--${orientation}`">
    <div v-if="first" class="split-pane split-first" :style="firstStyle">
      <slot name="first" :orientation="orientation" />
    </div>
    <div v-if="both && fixed !== undefined" class="split-divider split-divider--fixed" />
    <div
      v-else-if="both"
      class="split-divider"
      role="separator"
      tabindex="0"
      :aria-label="label"
      :aria-orientation="orientation === 'horizontal' ? 'vertical' : 'horizontal'"
      :aria-valuenow="percent"
      aria-valuemin="0"
      aria-valuemax="100"
      @pointerdown.prevent="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @keydown="onKey"
    />
    <div v-if="second" class="split-pane split-second">
      <slot name="second" :orientation="orientation" />
    </div>
  </div>
</template>

<style scoped>
.split-view {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.split-view--vertical {
  flex-direction: column;
}
.split-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.split-second {
  flex: 1 1 0;
}
.split-divider {
  position: relative;
  flex: 0 0 1px;
  background: var(--line);
  z-index: 2;
}
/* A 6 px hit area over the 1 px line. */
.split-divider:not(.split-divider--fixed)::before {
  content: '';
  position: absolute;
  inset: 0 -3px;
  cursor: col-resize;
  touch-action: none;
}
.split-view--vertical > .split-divider::before {
  inset: -3px 0;
  cursor: row-resize;
}
.split-divider:focus-visible {
  outline: 0;
  background: var(--focus-ring);
  box-shadow: 0 0 0 1px var(--focus-ring);
}
</style>
