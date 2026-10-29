<script lang="ts" setup>
import { computed } from 'vue'
import { annexBUnits } from '../byte-media'
import { formatBytes, plural } from '../format'
import type { ParsedStreamFraming } from '../stream-framing'

/** Each object's Annex-B NAL units. */
const props = defineProps<{
  data: Uint8Array
  /** The stream's objects; null reads the bytes as one payload */
  framing: ParsedStreamFraming | null
  codec: 'h264' | 'h265'
}>()

const items = computed(() => {
  const f = props.framing
  const objects = f
    ? f.objects.map((obj) => ({
        offset: obj.offset,
        label: `g${obj.groupId ?? f.headerFields.groupId ?? 0} · o${obj.objectId}`,
        payloadOffset: obj.payloadOffset,
        payloadLength: obj.payloadLength,
      }))
    : [{ offset: 0, label: null, payloadOffset: 0, payloadLength: props.data.length }]
  return objects.map((o) => {
    const end = o.payloadOffset + o.payloadLength
    const view =
      end <= props.data.length && o.payloadLength > 0
        ? annexBUnits(props.data.subarray(o.payloadOffset, end), props.codec)
        : null
    return { ...o, view }
  })
})
</script>

<template>
  <div class="nal-panel">
    <div v-if="framing" class="nal-summary">
      <span class="mq-badge mq-badge--mono">{{ plural(framing.objects.length, 'object') }}</span>
    </div>
    <ul class="nal-objects">
      <li v-for="item in items" :key="item.offset">
        <details v-if="item.view">
          <summary class="nal-object">
            <span v-if="item.label" class="mono">{{ item.label }}</span>
            <span class="muted">{{ formatBytes(item.payloadLength) }}</span>
            <span class="mono nal-names">{{
              item.view.units.map((u) => u.name).join(' ')
            }}</span>
          </summary>
          <div class="nal-detail">
            <p v-if="item.view.prefix > 0" class="muted">
              {{ formatBytes(item.view.prefix) }} before the first start code
            </p>
            <table class="mq-table nal-table">
              <thead>
                <tr>
                  <th>Offset</th>
                  <th>Start code</th>
                  <th>nal_unit_type</th>
                  <th>Size</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="unit in item.view.units" :key="unit.offset">
                  <td class="mono">{{ unit.offset }}</td>
                  <td class="mono">{{ unit.startCode }} bytes</td>
                  <td class="mono">
                    {{ unit.type }} {{ unit.name
                    }}<span v-if="unit.keyframe" class="mq-badge mq-badge--mono nal-key"
                      >keyframe</span
                    >
                  </td>
                  <td class="mono">{{ formatBytes(unit.size) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </details>
        <div v-else class="nal-object">
          <span v-if="item.label" class="mono">{{ item.label }}</span>
          <span class="muted">{{ formatBytes(item.payloadLength) }}</span>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.nal-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
}

.nal-summary {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.nal-objects {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.nal-object {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}
summary.nal-object {
  cursor: pointer;
}

.nal-names {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.nal-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-1) 0 var(--space-2) var(--space-3);
}
.nal-detail p {
  margin: 0;
}

.nal-table {
  font-size: var(--type-data-size);
}
.nal-table th,
.nal-table td {
  padding-left: var(--space-2);
  padding-right: var(--space-2);
}

.nal-key {
  margin-left: var(--space-1);
}

.mono {
  font-family: var(--font-mono);
}
.muted {
  color: var(--ink-muted);
}
</style>
