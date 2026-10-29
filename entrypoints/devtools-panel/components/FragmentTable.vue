<script lang="ts" setup>
import type { CmafObject } from '@moqtap/media/cmaf'
import { decodeTimeText } from '../cmaf'

/** One object's movie fragments: per traf its track_ID, decode time and sample count. */
const props = defineProps<{
  object: CmafObject
  /** The header's timescale for each track_ID it has */
  timescales: Map<number, number | null>
  /** The header's track_IDs, to mark one it lacks; null to mark none */
  headerTrackIds: number[] | null
}>()

function notInHeader(trackId: number): boolean {
  return props.headerTrackIds !== null && !props.headerTrackIds.includes(trackId)
}
</script>

<template>
  <table v-if="object.movieFragments.length > 0" class="mq-table fragment-table">
    <thead>
      <tr>
        <th>moof</th>
        <th>Sequence</th>
        <th>track_ID</th>
        <th>baseMediaDecodeTime</th>
        <th>Samples</th>
      </tr>
    </thead>
    <tbody>
      <template v-for="(moof, i) in object.movieFragments" :key="moof.offset">
        <tr v-if="moof.trackFragments.length === 0">
          <td class="mono">{{ i }}</td>
          <td class="mono">{{ moof.sequenceNumber ?? 'no mfhd' }}</td>
          <td class="muted" colspan="3">no traf</td>
        </tr>
        <tr v-for="(traf, j) in moof.trackFragments" :key="traf.offset">
          <td class="mono">{{ j === 0 ? i : '' }}</td>
          <td class="mono">
            {{ j === 0 ? (moof.sequenceNumber ?? 'no mfhd') : '' }}
          </td>
          <td class="mono">
            <template v-if="traf.header">
              {{ traf.header.trackId }}
              <span v-if="notInHeader(traf.header.trackId)" class="bad">not in the header</span>
            </template>
            <span v-else class="bad">no tfhd</span>
          </td>
          <td class="mono">
            {{
              decodeTimeText(
                traf.baseMediaDecodeTime,
                traf.header ? timescales.get(traf.header.trackId) : null,
              )
            }}
          </td>
          <td class="mono">{{ traf.sampleCount }}</td>
        </tr>
      </template>
    </tbody>
  </table>
</template>

<style scoped>
.fragment-table {
  font-size: var(--type-data-size);
}
.fragment-table th,
.fragment-table td {
  padding-left: var(--space-2);
  padding-right: var(--space-2);
  vertical-align: top;
}

.bad {
  color: var(--danger);
}

.mono {
  font-family: var(--font-mono);
}
.muted {
  color: var(--ink-muted);
}
</style>
