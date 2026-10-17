<script lang="ts" setup>
import { computed, onMounted, ref, watch } from 'vue'
import type { DirectionFilter } from '../prefs'
import { getCachedPref, loadPrefs, savePref } from '../prefs'
import { trackColourClass } from '../track-colour'
import type { TrackEntry } from '../use-inspector'

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
const statusIcon = computed(() => (status: string) => {
  switch (status) {
    case 'pending':
      return '◌'
    case 'active':
      return '●'
    case 'error':
      return '✕'
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
  <section class="track-list" aria-labelledby="track-list-title">
    <div class="filter-bar track-header">
      <h2 id="track-list-title" class="header-title">
        Tracks <span class="mq-tab__count">{{ headerCount }}</span>
      </h2>
      <button
        class="mq-btn mq-btn--quiet"
        :aria-pressed="activeOnly"
        title="Show only active and pending tracks"
        @click="activeOnly = !activeOnly"
      >
        Active only
      </button>
      <button
        class="mq-btn mq-btn--quiet"
        :aria-pressed="groupByNs"
        title="Group tracks by namespace"
        @click="groupByNs = !groupByNs"
      >
        Group by namespace
      </button>
      <span class="bar-sep" aria-hidden="true" />
      <button
        class="mq-btn mq-btn--quiet"
        :aria-pressed="directionFilter === 'tx'"
        title="Show only subscriptions this page sent"
        @click="toggleDirection('tx')"
      >
        <span class="dir dir-c2s" aria-hidden="true">→</span> Outgoing
      </button>
      <button
        class="mq-btn mq-btn--quiet"
        :aria-pressed="directionFilter === 'rx'"
        title="Show only subscriptions this page received"
        @click="toggleDirection('rx')"
      >
        <span class="dir dir-s2c" aria-hidden="true">←</span> Incoming
      </button>
    </div>

    <p v-if="filteredTracks.length === 0" class="empty-hint">
      {{
        tracks.length === 0
          ? 'No subscriptions yet.'
          : 'No tracks match these filters.'
      }}
    </p>

    <!-- Grouped view -->
    <template v-if="groupByNs && filteredTracks.length > 0">
      <div v-for="g in groups" :key="g.ns" class="ns-group">
        <button
          class="ns-group-header"
          :aria-expanded="!collapsedGroups.has(g.ns)"
          @click="toggleGroup(g.ns)"
        >
          <span class="ns-chevron" aria-hidden="true">{{
            collapsedGroups.has(g.ns) ? '▸' : '▾'
          }}</span>
          <span class="ns-name">{{ g.ns }}</span>
          <span class="ns-summary">{{ g.tracks.length }} · {{ groupSummary(g) }}</span>
        </button>
        <template v-if="!collapsedGroups.has(g.ns)">
          <button
            v-for="track in g.tracks"
            :key="track.subscribeId"
            class="track-row track-row-grouped"
            :class="{
              'track-dimmed':
                activeFilter !== null && activeFilter !== track.subscribeId,
            }"
            :aria-pressed="activeFilter === track.subscribeId"
            :title="`Show only messages for ${track.fullName}`"
            @click="toggleFilter(track.subscribeId)"
          >
            <span :class="trackColourClass(track.colorIndex)" aria-hidden="true" />
            <span
              class="track-status"
              :class="`status-${track.status}`"
              :title="track.status"
              >{{ statusIcon(track.status) }}</span
            >
            <span
              class="dir"
              :class="track.direction === 'tx' ? 'dir-c2s' : 'dir-s2c'"
              :title="track.direction === 'tx' ? 'outgoing' : 'incoming'"
              >{{ track.direction === 'tx' ? '→' : '←' }}</span
            >
            <span class="track-name">{{ track.trackName }}</span>
            <span v-if="track.errorReason" class="track-error" :title="track.errorReason">
              ✕ {{ track.errorReason }}
            </span>
          </button>
        </template>
      </div>
    </template>

    <!-- Flat view -->
    <template v-else-if="filteredTracks.length > 0">
      <button
        v-for="track in filteredTracks"
        :key="track.subscribeId"
        class="track-row"
        :class="{
          'track-dimmed':
            activeFilter !== null && activeFilter !== track.subscribeId,
        }"
        :aria-pressed="activeFilter === track.subscribeId"
        :title="`Show only messages for ${track.fullName}`"
        @click="toggleFilter(track.subscribeId)"
      >
        <span :class="trackColourClass(track.colorIndex)" aria-hidden="true" />
        <span
          class="track-status"
          :class="`status-${track.status}`"
          :title="track.status"
          >{{ statusIcon(track.status) }}</span
        >
        <span
          class="dir"
          :class="track.direction === 'tx' ? 'dir-c2s' : 'dir-s2c'"
          :title="track.direction === 'tx' ? 'outgoing' : 'incoming'"
          >{{ track.direction === 'tx' ? '→' : '←' }}</span
        >
        <span class="track-name">
          <span v-if="track.trackNamespace.length > 0" class="track-ns"
            >{{ track.trackNamespace.join('/') }}/</span
          >{{ track.trackName }}
        </span>
        <span v-if="track.errorReason" class="track-error" :title="track.errorReason">
          ✕ {{ track.errorReason }}
        </span>
      </button>
    </template>
  </section>
</template>

<style scoped>
.track-list {
  border-bottom: 1px solid var(--line);
  max-height: 200px;
  overflow-y: auto;
  flex-shrink: 0;
  background: var(--surface);
}

.track-header {
  position: sticky;
  top: 0;
  z-index: 2;
}

.header-title {
  font: 500 12px/16px var(--font-sans);
  color: var(--ink-muted);
  margin-right: auto;
}

.empty-hint {
  padding: var(--space-2) var(--space-3);
  color: var(--ink-muted);
}

/* ── Namespace groups ─────────────────────────────────────────── */

.ns-group-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  height: var(--row-tool);
  padding: 0 var(--space-2);
  border: 0;
  border-bottom: 1px solid var(--line);
  background: var(--surface-sunken);
  text-align: left;
  cursor: pointer;
}
.ns-group-header:hover {
  background: var(--surface-hover);
}

.ns-chevron {
  width: 10px;
  color: var(--ink-muted);
}

.ns-name {
  font: 500 12px/18px var(--font-mono);
}

.ns-summary {
  color: var(--ink-muted);
  font-variant-numeric: tabular-nums;
}

/* ── Track rows ───────────────────────────────────────────────── */

.track-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  height: var(--row-tool);
  padding: 0 var(--space-2);
  border: 0;
  border-bottom: 1px solid var(--line);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.track-row-grouped {
  padding-left: var(--space-6);
}
.track-row:hover {
  background: var(--surface-hover);
}
.track-row[aria-pressed='true'] {
  background: var(--surface-selected);
}
.track-dimmed .track-name,
.track-dimmed .track-ns {
  color: var(--ink-muted);
}

.track-status {
  width: 12px;
  text-align: center;
}

.track-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 400 12px/18px var(--font-mono);
}

.track-ns {
  color: var(--ink-muted);
}

.track-error {
  color: var(--danger);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 160px;
}
</style>
