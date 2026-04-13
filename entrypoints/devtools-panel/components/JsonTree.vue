<script lang="ts" setup>
import { computed, ref } from 'vue'
import { isPrettifiedValue, type PrettifiedValue } from '../use-inspector'

const props = defineProps<{
  data: unknown
  label?: string
  depth?: number
  initialExpanded?: boolean
}>()

const depth = computed(() => props.depth ?? 0)
const expanded = ref(props.initialExpanded ?? depth.value < 2)

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
    const arr = props.data as unknown[]
    return `Array(${arr.length})`
  }
  if (dataType.value === 'object' && props.data) {
    const keys = Object.keys(props.data as Record<string, unknown>)
    if (keys.length <= 3) return `{ ${keys.join(', ')} }`
    return `{ ${keys.slice(0, 3).join(', ')}, … }`
  }
  return ''
})

const valueClass = computed(() => {
  if (prettyValue.value) return prettyValue.value.cssClass
  switch (dataType.value) {
    case 'string':
      return 'json-string'
    case 'number':
      return 'json-number'
    case 'boolean':
      return 'json-boolean'
    case 'null':
      return 'json-null'
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
  () => prettyValue.value != null && prettyValue.value.display !== prettyValue.value.original,
)

function toggle() {
  if (isExpandable.value) expanded.value = !expanded.value
}
</script>

<template>
  <div class="json-node" :style="{ paddingLeft: depth > 0 ? '16px' : '0' }">
    <div class="json-line" @click="toggle">
      <span v-if="isExpandable" class="json-toggle">{{
        expanded ? '▼' : '▶'
      }}</span>
      <span v-else class="json-toggle-spacer" />
      <span v-if="label !== undefined" class="json-key"
        >{{ label }}<span class="json-colon">: </span></span
      >
      <template v-if="!isExpandable">
        <span
          :class="valueClass"
          :title="prettyValue?.original"
          :style="showPrettyHint ? 'text-decoration: underline dotted; text-underline-offset: 3px' : undefined"
        >{{ formattedValue }}</span>
        <span
          v-if="showPrettyHint"
          class="json-pretty-hint"
          :title="prettyValue!.original"
        >*</span>
      </template>
      <template v-else-if="!expanded">
        <span class="json-preview">{{ preview }}</span>
      </template>
      <template v-else>
        <span class="json-bracket">{{ dataType === 'array' ? '[' : '{' }}</span>
      </template>
    </div>
    <template v-if="isExpandable && expanded">
      <JsonTree
        v-for="entry in entries"
        :key="entry.key"
        :data="entry.value"
        :label="entry.key"
        :depth="depth + 1"
      />
      <div class="json-line" :style="{ paddingLeft: '16px' }">
        <span class="json-bracket">{{ dataType === 'array' ? ']' : '}' }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.json-node {
  font-family:
    'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New',
    monospace;
  font-size: 11px;
  line-height: 1.6;
}

.json-line {
  display: flex;
  align-items: center;
  cursor: default;
}
.json-line:hover {
  background: var(--bg-hover);
}

.json-toggle {
  font-size: 8px;
  width: 12px;
  cursor: pointer;
  color: var(--text-secondary);
  flex-shrink: 0;
}
.json-toggle-spacer {
  width: 12px;
  flex-shrink: 0;
}

.json-key {
  color: var(--text-accent);
}
.json-colon {
  color: var(--text-secondary);
  white-space-collapse: preserve;
}

.json-string {
  color: var(--text-success);
  word-break: break-all;
}
.json-number {
  color: var(--text-warning);
}
.json-boolean {
  color: var(--json-boolean);
}
.json-null {
  color: var(--text-secondary);
  font-style: italic;
}
.json-preview {
  color: var(--text-secondary);
}
.json-bracket {
  color: var(--text-secondary);
}

/* Prettified-value styles */
.json-pretty {
  color: var(--text-accent);
}
.json-bytes {
  color: var(--text-warning);
  word-break: break-all;
}
.json-pretty-hint {
  color: var(--text-secondary);
  font-size: 9px;
  vertical-align: super;
  cursor: help;
  margin-left: 1px;
}
</style>
