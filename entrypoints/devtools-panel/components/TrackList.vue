<script lang="ts" setup>
import { computed, onMounted, ref, watch } from 'vue'
import type { DirectionFilter } from '../prefs'
import { getCachedPref, loadPrefs, savePref } from '../prefs'
import type { TrackEntry } from '../use-inspector'

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
]

const props = defineProps<{
  tracks: TrackEntry[]
  activeFilter: string | null
}>()

const emit = defineEmits<{
  filter: [subscribeId: string | null]
}>()

// ── Filter state (persisted) ──────────────────────────────────────
const activeOnly = ref(false)
const groupByNs = ref(false)
const directionFilter = ref<DirectionFilter>('all')

onMounted(async () => {
  await loadPrefs()
  activeOnly.value = getCachedPref('trackActiveOnly')
  groupByNs.value = getCachedPref('trackGroupByNs')
  directionFilter.value = getCachedPref('trackDirectionFilter')
})

watch(activeOnly, (v) => savePref('trackActiveOnly', v))
watch(groupByNs, (v) => savePref('trackGroupByNs', v))
watch(directionFilter, (v) => savePref('trackDirectionFilter', v))

// ── Collapsed namespace groups ────────────────────────────────────
const collapsedGroups = ref(new Set<string>())

function toggleGroup(ns: string) {
  const s = new Set(collapsedGroups.value)
  if (s.has(ns)) s.delete(ns)
  else s.add(ns)
  collapsedGroups.value = s
}

// ── Filtering ─────────────────────────────────────────────────────
const filteredTracks = computed(() => {
  let list = props.tracks
  if (activeOnly.value) {
    list = list.filter((t) => t.status === 'active' || t.status === 'pending')
  }
  if (directionFilter.value !== 'all') {
    list = list.filter((t) => t.direction === directionFilter.value)
  }
  return list
})

// Clear track filter if the filtered-out track is no longer visible
watch(filteredTracks, (visible) => {
  if (
    props.activeFilter &&
    !visible.some((t) => t.subscribeId === props.activeFilter)
  ) {
    emit('filter', null)
  }
})

// ── Grouping ──────────────────────────────────────────────────────
interface NsGroup {
  ns: string
  tracks: TrackEntry[]
  active: number
  pending: number
  error: number
  done: number
}

const groups = computed((): NsGroup[] => {
  const map = new Map<string, NsGroup>()
  for (const t of filteredTracks.value) {
    const ns =
      t.trackNamespace.length > 0
        ? t.trackNamespace.join('/')
        : '(no namespace)'
    let g = map.get(ns)
    if (!g) {
      g = { ns, tracks: [], active: 0, pending: 0, error: 0, done: 0 }
      map.set(ns, g)
    }
    g.tracks.push(t)
    g[t.status]++
  }
  return Array.from(map.values())
})

function groupSummary(g: NsGroup): string {
  const parts: string[] = []
  if (g.active > 0) parts.push(`${g.active} active`)
  if (g.pending > 0) parts.push(`${g.pending} pending`)
  if (g.error > 0) parts.push(`${g.error} error`)
  if (g.done > 0) parts.push(`${g.done} done`)
  // If all tracks share the same status, the total is enough context
  if (parts.length === 1) return `${g.tracks.length} ${parts[0].split(' ')[1]}`
  return parts.join(', ')
}

// ── Helpers ───────────────────────────────────────────────────────
function trackColor(track: TrackEntry): string {
  return TRACK_COLORS[track.colorIndex % TRACK_COLORS.length]
}

const statusIcon = computed(() => (status: string) => {
  switch (status) {
    case 'pending':
      return '⏳'
    case 'active':
      return '●'
    case 'error':
      return '✖'
    case 'done':
      return '○'
    default:
      return '•'
  }
})

function toggleFilter(subscribeId: string) {
  emit('filter', props.activeFilter === subscribeId ? null : subscribeId)
}

function toggleDirection(dir: 'tx' | 'rx') {
  directionFilter.value = directionFilter.value === dir ? 'all' : dir
}

const headerCount = computed(() => {
  const shown = filteredTracks.value.length
  const total = props.tracks.length
  return shown < total ? `${shown}/${total}` : `${total}`
})
</script>

<template>
  <div class="track-list">
    <div class="track-header">
      <span class="header-title">Tracks ({{ headerCount }})</span>
      <button
        class="toolbar-btn"
        :class="{ 'toolbar-active': activeOnly }"
        title="Show only active and pending tracks"
        @click="activeOnly = !activeOnly"
      >
        Active only
      </button>
      <button
        class="toolbar-btn"
        :class="{ 'toolbar-active': groupByNs }"
        title="Group tracks by namespace"
        @click="groupByNs = !groupByNs"
      >
        Group by NS
      </button>
      <span class="toolbar-sep" />
      <button
        class="toolbar-btn toolbar-dir"
        :class="{ 'toolbar-active': directionFilter === 'tx' }"
        title="Show only outgoing subscriptions"
        @click="toggleDirection('tx')"
      >
        &#x2191; TX
      </button>
      <button
        class="toolbar-btn toolbar-dir"
        :class="{ 'toolbar-active': directionFilter === 'rx' }"
        title="Show only incoming subscriptions"
        @click="toggleDirection('rx')"
      >
        &#x2193; RX
      </button>
    </div>

    <div v-if="filteredTracks.length === 0" class="empty-hint">
      {{
        tracks.length === 0
          ? 'No subscriptions yet'
          : 'No tracks match current filters'
      }}
    </div>

    <!-- Grouped view -->
    <template v-if="groupByNs && filteredTracks.length > 0">
      <div v-for="g in groups" :key="g.ns" class="ns-group">
        <div class="ns-group-header" @click="toggleGroup(g.ns)">
          <span class="ns-chevron">{{
            collapsedGroups.has(g.ns) ? '▶' : '▼'
          }}</span>
          <span class="ns-name mono">{{ g.ns }}</span>
          <span class="ns-count">({{ g.tracks.length }})</span>
          <span class="ns-summary">&mdash; {{ groupSummary(g) }}</span>
        </div>
        <template v-if="!collapsedGroups.has(g.ns)">
          <div
            v-for="track in g.tracks"
            :key="track.subscribeId"
            class="track-row track-row-grouped"
            :class="{
              'track-active-filter': activeFilter === track.subscribeId,
              'track-dimmed':
                activeFilter !== null && activeFilter !== track.subscribeId,
            }"
            @click="toggleFilter(track.subscribeId)"
          >
            <span
              class="track-color-dot"
              :style="{ background: trackColor(track) }"
            />
            <span class="track-status" :class="`status-${track.status}`">
              {{ statusIcon(track.status) }}
            </span>
            <span
              class="track-dir"
              :class="
                track.direction === 'tx' ? 'direction-tx' : 'direction-rx'
              "
            >
              {{ track.direction === 'tx' ? '↑' : '↓' }}
            </span>
            <span class="track-name mono" :title="track.fullName">
              {{ track.trackName }}
            </span>
            <span
              v-if="track.errorReason"
              class="track-error"
              :title="track.errorReason"
            >
              {{ track.errorReason }}
            </span>
          </div>
        </template>
      </div>
    </template>

    <!-- Flat view -->
    <template v-else-if="filteredTracks.length > 0">
      <div
        v-for="track in filteredTracks"
        :key="track.subscribeId"
        class="track-row"
        :class="{
          'track-active-filter': activeFilter === track.subscribeId,
          'track-dimmed':
            activeFilter !== null && activeFilter !== track.subscribeId,
        }"
        @click="toggleFilter(track.subscribeId)"
      >
        <span
          class="track-color-dot"
          :style="{ background: trackColor(track) }"
        />
        <span class="track-status" :class="`status-${track.status}`">
          {{ statusIcon(track.status) }}
        </span>
        <span
          class="track-dir"
          :class="track.direction === 'tx' ? 'direction-tx' : 'direction-rx'"
        >
          {{ track.direction === 'tx' ? '↑' : '↓' }}
        </span>
        <span class="track-name mono" :title="track.fullName">
          <span v-if="track.trackNamespace.length > 0" class="track-ns"
            >{{ track.trackNamespace.join('/') }}/</span
          >{{ track.trackName }}
        </span>
        <span
          v-if="track.errorReason"
          class="track-error"
          :title="track.errorReason"
        >
          {{ track.errorReason }}
        </span>
      </div>
    </template>
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
  gap: 6px;
  padding: 4px 10px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 2;
}

.header-title {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-right: auto;
}

.toolbar-btn {
  background: none;
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text-secondary);
  padding: 1px 7px;
  cursor: pointer;
  font-size: 10px;
  font-family: inherit;
  white-space: nowrap;
  line-height: 16px;
}
.toolbar-btn:hover {
  background: var(--bg-selected);
  color: var(--text-accent);
  border-color: var(--border);
}
.toolbar-active {
  background: var(--bg-selected);
  color: var(--text-accent);
  border-color: var(--text-accent);
}
.toolbar-btn.toolbar-active:hover {
  background: var(--bg-hover);
  color: var(--text-accent);
  border-color: var(--text-accent);
}

.toolbar-sep {
  width: 1px;
  height: 14px;
  background: var(--border);
  margin: 0 2px;
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

/* ── Namespace groups ─────────────────────────────────────────── */

.ns-group-header {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  font-size: 11px;
  cursor: pointer;
  background: var(--bg-secondary, var(--bg-tertiary));
  border-bottom: 1px solid var(--border);
  user-select: none;
}
.ns-group-header:hover {
  background: var(--bg-hover);
}

.ns-chevron {
  font-size: 8px;
  width: 10px;
  color: var(--text-secondary);
}

.ns-name {
  color: var(--text-primary);
  font-weight: 500;
}

.ns-count {
  color: var(--text-secondary);
  font-size: 10px;
}

.ns-summary {
  color: var(--text-secondary);
  font-size: 10px;
}

/* ── Track rows ───────────────────────────────────────────────── */

.track-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  font-size: 11px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
}
.track-row-grouped {
  padding-left: 24px;
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
.status-active {
  color: var(--text-success);
}
.status-pending {
  color: var(--text-secondary);
}
.status-error {
  color: var(--text-error);
}
.status-done {
  color: var(--text-secondary);
}

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
