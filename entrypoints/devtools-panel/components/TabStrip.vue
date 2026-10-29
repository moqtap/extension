<script lang="ts" setup generic="T extends string">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { formatCount } from '../format'
import { fitTabs } from '../layout'
import Icon from './Icon.vue'
import PopupMenu from './PopupMenu.vue'

export interface TabItem<I extends string> {
  id: I
  label: string
  count: number | null
}

const props = defineProps<{ tabs: TabItem<T>[]; active: T; panelId: string }>()
const emit = defineEmits<{ select: [id: T] }>()

const strip = ref<HTMLElement | null>(null)
const measure = ref<HTMLElement | null>(null)
const moreBtn = ref<HTMLButtonElement | null>(null)
const tabEls = ref<HTMLButtonElement[]>([])
const widths = ref<number[]>([])
const available = ref(Infinity)
const moreOpen = ref(false)

/** Width of the » button. */
const MORE = 28

const activeIndex = computed(() => props.tabs.findIndex((t) => t.id === props.active))
const fit = computed(() =>
  widths.value.length === props.tabs.length
    ? fitTabs(widths.value, available.value, MORE, activeIndex.value)
    : { shown: props.tabs.map((_, i) => i), overflow: [] as number[] },
)
/** Every tab's width together: the strip grows no wider, so what follows it keeps its place. */
const natural = computed(() => widths.value.reduce((a, b) => a + b, 0))
const shownTabs = computed(() => fit.value.shown.map((i) => props.tabs[i]))
const overflowTabs = computed(() => fit.value.overflow.map((i) => props.tabs[i]))

function remeasure() {
  const m = measure.value
  if (!m) return
  widths.value = Array.from(m.children).map((c) => Math.ceil((c as HTMLElement).getBoundingClientRect().width))
}

let ro: ResizeObserver | null = null
onMounted(() => {
  remeasure()
  ro = new ResizeObserver(() => {
    if (strip.value) available.value = strip.value.clientWidth
    remeasure()
  })
  if (strip.value) ro.observe(strip.value)
})
onBeforeUnmount(() => ro?.disconnect())
watch(
  () => props.tabs.map((t) => `${t.label}:${t.count}`).join(),
  () => void nextTick(remeasure),
)

/** Arrow keys move between every tab, shown or not. */
function onKey(e: KeyboardEvent) {
  const n = props.tabs.length
  const i = activeIndex.value
  let next = -1
  if (e.key === 'ArrowRight') next = (i + 1) % n
  else if (e.key === 'ArrowLeft') next = (i - 1 + n) % n
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = n - 1
  if (next < 0) return
  e.preventDefault()
  const id = props.tabs[next].id
  emit('select', id)
  void nextTick(() => tabEls.value.find((el) => el.dataset.id === id)?.focus())
}
</script>

<template>
  <div ref="strip" class="tab-strip" :style="natural > 0 ? { maxWidth: `${natural}px` } : undefined">
    <div class="mq-tabs tab-strip__tabs" role="tablist" aria-label="Views">
      <button
        v-for="tab in shownTabs"
        :id="`tab-${tab.id}`"
        :key="tab.id"
        ref="tabEls"
        :data-id="tab.id"
        class="mq-tab"
        role="tab"
        :aria-selected="active === tab.id"
        :aria-controls="panelId"
        :tabindex="active === tab.id ? 0 : -1"
        @click="emit('select', tab.id)"
        @keydown="onKey"
      >
        {{ tab.label }}<span v-if="tab.count !== null" class="mq-tab__count">{{ formatCount(tab.count) }}</span>
      </button>
    </div>
    <button
      v-if="overflowTabs.length > 0"
      ref="moreBtn"
      class="mq-btn mq-btn--quiet mq-btn--icon tab-strip__more"
      aria-label="More views"
      title="More views"
      aria-haspopup="menu"
      :aria-expanded="moreOpen"
      @click="moreOpen = !moreOpen"
    >
      <Icon name="chevronsRight" />
    </button>
    <PopupMenu v-if="moreOpen" :anchor="moreBtn" label="More views" @close="moreOpen = false">
      <button
        v-for="tab in overflowTabs"
        :key="tab.id"
        class="mq-menu__item"
        role="menuitem"
        @click="emit('select', tab.id)"
      >
        {{ tab.label }}<span v-if="tab.count !== null" class="menu-hint">{{ formatCount(tab.count) }}</span>
      </button>
    </PopupMenu>
    <div ref="measure" class="mq-tabs tab-strip__measure" aria-hidden="true">
      <span v-for="tab in tabs" :key="tab.id" class="mq-tab"
        >{{ tab.label }}<span v-if="tab.count !== null" class="mq-tab__count">{{ formatCount(tab.count) }}</span></span
      >
    </div>
  </div>
</template>

<style scoped>
.tab-strip {
  position: relative;
  display: flex;
  align-items: stretch;
  min-width: 0;
  flex: 1 1 auto;
}
.tab-strip__tabs {
  flex: 0 1 auto;
  min-width: 0;
  border-bottom: 0;
  padding: 0;
  gap: 0;
}
.tab-strip__tabs .mq-tab,
.tab-strip__measure .mq-tab {
  padding: 0 var(--space-2);
  display: inline-flex;
  align-items: center;
}
.tab-strip__more {
  align-self: center;
  flex: none;
}
.tab-strip__measure {
  position: absolute;
  visibility: hidden;
  pointer-events: none;
  top: 0;
  left: 0;
  border: 0;
  padding: 0;
  gap: 0;
  white-space: nowrap;
}
</style>
