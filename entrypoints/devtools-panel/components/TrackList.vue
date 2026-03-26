<script lang="ts" setup>
import { computed } from 'vue';
import type { TrackEntry } from '../use-inspector';

/** 8 distinct colors for track color-coding */
const TRACK_COLORS = [
  '#e06c75', // red
  '#61afef', // blue
  '#98c379', // green
  '#d19a66', // orange
  '#c678dd', // purple
  '#56b6c2', // cyan
  '#e5c07b', // yellow
  '#be5046', // dark red
];

const props = defineProps<{
  tracks: TrackEntry[];
  activeFilter: string | null;
}>();

const emit = defineEmits<{
  filter: [subscribeId: string | null];
}>();

function trackColor(track: TrackEntry): string {
  return TRACK_COLORS[track.colorIndex % TRACK_COLORS.length];
}

const statusIcon = computed(() => (status: string) => {
  switch (status) {
    case 'pending': return '\u23F3'; // hourglass
    case 'active': return '\u25CF';  // filled circle
    case 'error': return '\u2716';   // heavy x
    case 'done': return '\u25CB';    // open circle
    default: return '\u2022';
  }
});

function toggleFilter(subscribeId: string) {
  emit('filter', props.activeFilter === subscribeId ? null : subscribeId);
}
</script>

<template>
  <div class="track-list">
    <div class="track-header">
      <span>Tracks ({{ tracks.length }})</span>
      <button
        v-if="activeFilter"
        class="clear-filter-btn"
        title="Clear filter"
        @click="emit('filter', null)"
      >
        Clear filter
      </button>
    </div>
    <div v-if="tracks.length === 0" class="empty-hint">
      No subscriptions yet
    </div>
    <div
      v-for="track in tracks"
      :key="track.subscribeId"
      class="track-row"
      :class="{
        'track-active-filter': activeFilter === track.subscribeId,
        'track-dimmed': activeFilter !== null && activeFilter !== track.subscribeId,
      }"
      @click="toggleFilter(track.subscribeId)"
    >
      <span class="track-color-dot" :style="{ background: trackColor(track) }" />
      <span class="track-status" :class="`status-${track.status}`">
        {{ statusIcon(track.status) }}
      </span>
      <span class="track-dir" :class="track.direction === 'tx' ? 'direction-tx' : 'direction-rx'">
        {{ track.direction === 'tx' ? '\u2191' : '\u2193' }}
      </span>
      <span class="track-name mono" :title="track.fullName">
        <span v-if="track.trackNamespace.length > 0" class="track-ns">{{ track.trackNamespace.join('/') }}/</span>{{ track.trackName }}
      </span>
      <span v-if="track.errorReason" class="track-error" :title="track.errorReason">
        {{ track.errorReason }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.track-list {
  border-bottom: 1px solid var(--border);
  max-height: 200px;
  overflow-y: auto;
}

.track-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.3px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
}

.clear-filter-btn {
  background: none;
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text-accent);
  padding: 0 6px;
  cursor: pointer;
  font-size: 9px;
  font-family: inherit;
  text-transform: none;
  letter-spacing: normal;
}
.clear-filter-btn:hover {
  background: var(--bg-hover);
}

.empty-hint {
  padding: 6px 10px;
  color: var(--text-secondary);
  font-size: 11px;
  font-style: italic;
}

.track-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  font-size: 11px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
}
.track-row:hover {
  background: var(--bg-hover);
}
.track-active-filter {
  background: var(--bg-selected);
}
.track-dimmed {
  opacity: 0.4;
}

.track-color-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.track-status {
  font-size: 10px;
  width: 14px;
  text-align: center;
}
.status-active { color: var(--text-success); }
.status-pending { color: var(--text-secondary); }
.status-error { color: var(--text-error); }
.status-done { color: var(--text-secondary); }

.track-dir {
  font-size: 11px;
  font-weight: bold;
  width: 12px;
  text-align: center;
}

.track-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.track-ns {
  color: var(--text-secondary);
}

.track-error {
  color: var(--text-error);
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100px;
}
</style>
