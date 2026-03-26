<script lang="ts" setup>
import { ref } from 'vue';
import type { StreamEntry, TrackEntry } from '../use-inspector';
import { useAutoScroll } from '../use-auto-scroll';

const props = defineProps<{
  streams: StreamEntry[];
  selectedId: number | null;
  /** Track registry for resolving trackAlias → track name */
  tracks: Map<string, TrackEntry>;
  /** When true, collapse to Track column only (detail panel is open) */
  compact?: boolean;
}>();

const listContainer = ref<HTMLElement | null>(null);
useAutoScroll(listContainer);

const emit = defineEmits<{
  inspect: [streamId: number];
}>();

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveTrack(stream: StreamEntry): TrackEntry | null {
  if (stream.trackAlias == null) return null;
  const alias = String(stream.trackAlias);
  // Match by trackAlias (subscribe message field)
  for (const track of props.tracks.values()) {
    if (track.trackAlias === alias) return track;
  }
  // Fallback: match by subscribeId (draft-14 uses request_id, not trackAlias)
  for (const track of props.tracks.values()) {
    if (track.subscribeId === alias) return track;
  }
  return null;
}
</script>

<template>
  <div ref="listContainer" class="stream-list">
    <div v-if="streams.length === 0" class="empty-state">
      No streams yet
    </div>
    <div class="stream-table" v-else>
      <div class="stream-header-row">
        <span v-if="!compact" class="col-id">#</span>
        <span v-if="!compact" class="col-dir">Dir</span>
        <span v-if="!compact" class="col-type">Type</span>
        <span class="col-track">Track</span>
        <span v-if="!compact" class="col-status">Status</span>
        <span v-if="!compact" class="col-bytes">Bytes</span>
      </div>
      <div
        v-for="stream in streams"
        :key="stream.streamId"
        class="stream-row"
        :class="{ selected: stream.streamId === props.selectedId }"
        @click="emit('inspect', stream.streamId)"
      >
        <span v-if="!compact" class="col-id mono">{{ stream.streamId }}</span>
        <span
          v-if="!compact"
          class="col-dir"
          :class="stream.direction === 'tx' ? 'direction-tx' : 'direction-rx'"
        >
          {{ stream.direction === 'tx' ? 'TX' : 'RX' }}
        </span>
        <span v-if="!compact" class="col-type">
          <span
            v-if="stream.contentType !== 'binary'"
            class="content-badge"
            :class="`content-${stream.contentType}`"
          >
            {{ stream.contentType === 'fmp4' ? 'fMP4' : 'JSON' }}
          </span>
        </span>
        <span class="col-track" :title="resolveTrack(stream)?.fullName">
          <span v-if="resolveTrack(stream)" class="track-tag">{{ resolveTrack(stream)!.fullName }}</span>
          <span v-else-if="stream.trackAlias != null" class="track-alias mono">alias:{{ stream.trackAlias }}</span>
          <span v-else class="track-alias mono">#{{ stream.streamId }}</span>
        </span>
        <span v-if="!compact" class="col-status">
          <span class="badge" :class="stream.closed ? 'badge-closed' : 'badge-open'">
            {{ stream.closed ? 'closed' : 'open' }}
          </span>
        </span>
        <span v-if="!compact" class="col-bytes mono">{{ formatBytes(stream.byteCount) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stream-list {
  min-width: 280px;
  flex: 1;
  overflow-y: auto;
  height: 100%;
}

.stream-header-row, .stream-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  font-size: 11px;
}

.stream-header-row {
  color: var(--text-secondary);
  font-weight: 600;
  border-bottom: 1px solid var(--border);
  background: var(--bg-tertiary);
  position: sticky;
  top: 0;
}

.stream-row {
  cursor: pointer;
  border-bottom: 1px solid var(--border);
}
.stream-row:hover {
  background: var(--bg-hover);
}
.stream-row.selected {
  background: var(--bg-selected);
  color: var(--text-primary);
}

.col-id { width: 30px; }
.col-dir { width: 30px; text-align: center; font-weight: 600; font-size: 10px; }
.col-type { width: 38px; text-align: center; }
.col-track { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-status { width: 50px; }
.col-bytes { width: 70px; text-align: right; }

.content-badge {
  display: inline-block;
  font-size: 9px;
  font-weight: 600;
  padding: 0 4px;
  border-radius: 3px;
  line-height: 1.5;
  letter-spacing: 0.3px;
}
.content-json {
  background: var(--content-json-bg);
  color: var(--content-json-color);
}
.content-fmp4 {
  background: var(--content-fmp4-bg);
  color: var(--content-fmp4-color);
}

.track-tag {
  font-size: 10px;
  color: var(--text-warning);
}
.track-alias {
  font-size: 10px;
  color: var(--text-secondary);
}
</style>
