<script lang="ts" setup>
import { computed, ref } from 'vue'
import { isPrettifiedValue, type PrettifiedValue } from '../use-inspector'

/**
 * A decoded value as the design system's JsonTree: nested `<details>`, keys
 * in data-strong, values coloured by kind. Called without a label it is the
 * tree's root; each entry renders itself again with its key as the label.
 */
const props = defineProps<{
  data: unknown
  label?: string
  depth?: number
  initialExpanded?: boolean
}>()

const depth = computed(() => props.depth ?? 0)
// The caller opens the first level; nested values start closed.
const expanded = ref(props.initialExpanded)

const prettyValue = computed((): PrettifiedValue | null =>
  isPrettifiedValue(props.data) ? props.data : null,
)

const dataType = computed(() => {
  if (prettyValue.value) return 'pretty'
  if (props.data === null) return 'null'
  if (Array.isArray(props.data)) return 'array'
  return typeof props.data
})

const isExpandable = computed(
  () => dataType.value === 'object' || dataType.value === 'array',
)

const entries = computed(() => {
  if (dataType.value === 'array') {
    return (props.data as unknown[]).map((val, i) => ({
      key: String(i),
      value: val,
    }))
  }
  if (dataType.value === 'object' && props.data) {
    return Object.entries(props.data as Record<string, unknown>).map(
      ([key, value]) => ({ key, value }),
    )
  }
  return []
})

const preview = computed(() => {
  if (dataType.value === 'array') {
    return `[${(props.data as unknown[]).length}]`
  }
  if (dataType.value === 'object' && props.data) {
    const n = Object.keys(props.data as Record<string, unknown>).length
    return `{${n}}`
  }
  return ''
})

/** Value colour classes from bundle.css: s string, n number, b boolean. */
const valueClass = computed(() => {
  if (prettyValue.value) {
    return prettyValue.value.cssClass === 'json-bytes' ? 'n' : 'b'
  }
  switch (dataType.value) {
    case 'string':
      return 's'
    case 'number':
    case 'bigint':
      return 'n'
    case 'boolean':
      return 'b'
    case 'null':
      return 'null'
    default:
      return ''
  }
})

const formattedValue = computed(() => {
  if (prettyValue.value) {
    const p = prettyValue.value
    return p.quoted ? `"${p.display}"` : p.display
  }
  if (dataType.value === 'string') return `"${props.data}"`
  if (dataType.value === 'null') return 'null'
  return String(props.data)
})

/** Whether the prettified display differs from the original (show hint). */
const showPrettyHint = computed(
  () =>
    prettyValue.value != null &&
    prettyValue.value.display !== prettyValue.value.original,
)

function onToggle(e: Event) {
  expanded.value = (e.target as HTMLDetailsElement).open
}
</script>

<template>
  <ul v-if="label === undefined" class="mq-tree json-tree">
    <template v-if="isExpandable">
      <JsonTree
        v-for="entry in entries"
        :key="entry.key"
        :data="entry.value"
        :label="entry.key"
        :depth="1"
      />
    </template>
    <li v-else class="leaf">
      <span :class="valueClass">{{ formattedValue }}</span>
    </li>
  </ul>
  <li v-else-if="isExpandable">
    <details :open="expanded" @toggle="onToggle">
      <summary>
        <span class="k">{{ label }}</span>
        <span class="mq-muted preview">{{ preview }}</span>
      </summary>
      <ul v-if="expanded">
        <JsonTree
          v-for="entry in entries"
          :key="entry.key"
          :data="entry.value"
          :label="entry.key"
          :depth="depth + 1"
        />
      </ul>
    </details>
  </li>
  <li v-else class="leaf">
    <span class="k">{{ label }}</span>:
    <span
      :class="[valueClass, { 'pretty-hint': showPrettyHint }]"
      :title="prettyValue?.original"
      >{{ formattedValue }}</span
    >
  </li>
</template>

<style scoped>
.json-tree {
  overflow-wrap: anywhere;
}
.preview {
  margin-left: var(--space-1);
}
.pretty-hint {
  text-decoration: underline dotted;
  text-underline-offset: 3px;
  cursor: help;
}
</style>
