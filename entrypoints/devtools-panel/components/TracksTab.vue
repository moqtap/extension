<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { DirectionFilter } from '../prefs'
import { getCachedPref, loadPrefs, savePref } from '../prefs'
import type { SessionEntry, TrackEntry } from '../use-inspector'

const TRACK_COLORS = [
  '#e06c75',
  '#61afef',
  '#98c379',
  '#d19a66',
  '#c678dd',
  '#56b6c2',
  '#e5c07b',
  '#be5046',
]

const DECAY_WINDOW_MS = 5_000

const props = defineProps<{
  session: SessionEntry
}>()

// ── Bitrate tick (same pattern as ConnectionList.vue) ────────────
// Gated behind rAF so it pauses when the panel is backgrounded.
const bitrateTick = ref(0)
const bitrateTickInterval = setInterval(() => {
  requestAnimationFrame(() => {
    bitrateTick.value++
  })
}, 500)
onBeforeUnmount(() => clearInterval(bitrateTickInterval))

// ── Filter state (reuse same prefs as TrackList sidebar) ─────────
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

function toggleDirection(dir: 'tx' | 'rx') {
  directionFilter.value = directionFilter.value === dir ? 'all' : dir
}

// ── Filtering ────────────────────────────────────────────────────
const allTracks = computed(() => Array.from(props.session.tracks.values()))

const filteredTracks = computed(() => {
  let list = allTracks.value
  if (activeOnly.value) {
    list = list.filter((t) => t.status === 'active' || t.status === 'pending')
  }
  if (directionFilter.value !== 'all') {
    list = list.filter((t) => t.direction === directionFilter.value)
  }
  return list
})

// ── Per-track stats (aggregate from streams + datagram groups) ───

interface TrackStats {
  totalBytes: number
  firstDataAt: number | undefined
  lastDataAt: number | undefined
  streamCount: number
  dgGroupCount: number
}

const trackStatsByAlias = computed(() => {
  const map = new Map<string, TrackStats>()

  for (const stream of props.session.streams.values()) {
    if (stream.trackAlias == null) continue
    const alias = String(stream.trackAlias)
    let stats = map.get(alias)
    if (!stats) {
      stats = {
        totalBytes: 0,
        firstDataAt: undefined,
        lastDataAt: undefined,
        streamCount: 0,
        dgGroupCount: 0,
      }
      map.set(alias, stats)
    }
    stats.totalBytes += stream.byteCount
    stats.streamCount++
    if (stream.firstDataAt != null) {
      if (stats.firstDataAt == null || stream.firstDataAt < stats.firstDataAt) {
        stats.firstDataAt = stream.firstDataAt
      }
    }
    if (stream.lastDataAt != null) {
      if (stats.lastDataAt == null || stream.lastDataAt > stats.lastDataAt) {
        stats.lastDataAt = stream.lastDataAt
      }
    }
  }

  for (const dg of props.session.datagramGroups.values()) {
    const alias = String(dg.trackAlias)
    let stats = map.get(alias)
    if (!stats) {
      stats = {
        totalBytes: 0,
        firstDataAt: undefined,
        lastDataAt: undefined,
        streamCount: 0,
        dgGroupCount: 0,
      }
      map.set(alias, stats)
    }
    stats.totalBytes += dg.byteCount
    stats.dgGroupCount++
    if (dg.firstDataAt != null) {
      if (stats.firstDataAt == null || dg.firstDataAt < stats.firstDataAt) {
        stats.firstDataAt = dg.firstDataAt
      }
    }
    if (dg.lastDataAt != null) {
      if (stats.lastDataAt == null || dg.lastDataAt > stats.lastDataAt) {
        stats.lastDataAt = dg.lastDataAt
      }
    }
  }

  return map
})

function getStats(track: TrackEntry): TrackStats | undefined {
  if (track.trackAlias == null) return undefined
  return trackStatsByAlias.value.get(track.trackAlias)
}

// ── Computed rows with bitrate ───────────────────────────────────

interface TrackRow {
  track: TrackEntry
  stats: TrackStats | undefined
  bitrate: number
}

const trackRows = computed((): TrackRow[] => {
  void bitrateTick.value // reactive dependency for decay
  const now = Date.now()
  return filteredTracks.value.map((track) => {
    const stats = getStats(track)
    let bitrate = 0
    if (
      stats &&
      stats.totalBytes > 0 &&
      stats.firstDataAt != null &&
      stats.lastDataAt != null
    ) {
      const activeSec = Math.max(
        (stats.lastDataAt - stats.firstDataAt) / 1000,
        1,
      )
      const activeBps = (stats.totalBytes * 8) / activeSec
      const decay = Math.max(0, 1 - (now - stats.lastDataAt) / DECAY_WINDOW_MS)
      bitrate = activeBps * decay
    }
    return { track, stats, bitrate }
  })
})

// ── Namespace grouping ───────────────────────────────────────────
interface NsGroup {
  ns: string
  rows: TrackRow[]
}

const groups = computed((): NsGroup[] => {
  if (!groupByNs.value) return []
  const map = new Map<string, NsGroup>()
  for (const row of trackRows.value) {
    const ns =
      row.track.trackNamespace.length > 0
        ? row.track.trackNamespace.join('/')
        : '(no namespace)'
    let g = map.get(ns)
    if (!g) {
      g = { ns, rows: [] }
      map.set(ns, g)
    }
    g.rows.push(row)
  }
  return Array.from(map.values())
})

const collapsedGroups = ref(new Set<string>())

function toggleGroup(ns: string) {
  const s = new Set(collapsedGroups.value)
  if (s.has(ns)) s.delete(ns)
  else s.add(ns)
  collapsedGroups.value = s
}

// ── Helpers ─────────────────────────────────────────────────────
function trackColor(track: TrackEntry): string {
  return TRACK_COLORS[track.colorIndex % TRACK_COLORS.length]
}

function statusIcon(status: string): string {
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
}

function formatTime(ts: number | undefined): string {
  if (ts == null) return '—'
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  } as Intl.DateTimeFormatOptions)
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function formatBitrate(bps: number): string {
  if (bps <= 0) return '—'
  if (bps < 1_000) return `${bps.toFixed(0)} bps`
  if (bps < 1_000_000) return `${(bps / 1_000).toFixed(1)} Kbps`
  return `${(bps / 1_000_000).toFixed(1)} Mbps`
}

function formatDuration(
  track: TrackEntry,
  stats: TrackStats | undefined,
): string {
  const start = stats?.firstDataAt ?? track.subscribedAt
  if (start == null) return '—'
  const end =
    track.status === 'done' || track.status === 'error'
      ? (track.subscribeDoneAt ??
        track.subscribeErrorAt ??
        stats?.lastDataAt ??
        start)
      : Date.now()
  const sec = Math.max(0, (end - start) / 1000)
  if (sec < 60) return `${sec.toFixed(1)}s`
  const min = Math.floor(sec / 60)
  const remSec = Math.floor(sec % 60)
  return `${min}m ${remSec}s`
}

function formatLatency(track: TrackEntry): string {
  if (track.subscribedAt == null || track.subscribeOkAt == null) return '—'
  const ms = track.subscribeOkAt - track.subscribedAt
  return `${ms}ms`
}

const headerCount = computed(() => {
  const shown = filteredTracks.value.length
  const total = allTracks.value.length
  return shown < total ? `${shown}/${total}` : `${total}`
})
</script>

<template>
  <div class="tracks-tab">
    <!-- Toolbar -->
    <div class="tracks-toolbar">
      <span class="toolbar-title">Tracks ({{ headerCount }})</span>
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
        allTracks.length === 0
          ? 'No track subscriptions yet'
          : 'No tracks match current filters'
      }}
    </div>

    <!-- Table -->
    <div v-else class="tracks-table-wrap">
      <table class="tracks-table">
        <thead>
          <tr>
            <th class="col-color"></th>
            <th class="col-dir">Dir</th>
            <th class="col-status">Status</th>
            <th class="col-name">Track</th>
            <th class="col-time">Sub Sent</th>
            <th class="col-time">Sub OK</th>
            <th class="col-latency">Latency</th>
            <th class="col-time">First Byte</th>
            <th class="col-bytes">Total</th>
            <th class="col-bitrate">Bitrate</th>
            <th class="col-duration">Active</th>
            <th class="col-error">Error</th>
          </tr>
        </thead>
        <tbody>
          <!-- Grouped view -->
          <template v-if="groupByNs">
            <template v-for="g in groups" :key="g.ns">
              <tr class="ns-group-row" @click="toggleGroup(g.ns)">
                <td :colspan="12">
                  <span class="ns-chevron">{{
                    collapsedGroups.has(g.ns) ? '▶' : '▼'
                  }}</span>
                  <span class="ns-name mono">{{ g.ns }}</span>
                  <span class="ns-count">({{ g.rows.length }})</span>
                </td>
              </tr>
              <template v-if="!collapsedGroups.has(g.ns)">
                <tr
                  v-for="row in g.rows"
                  :key="row.track.subscribeId"
                  class="track-row"
                >
                  <td class="col-color">
                    <span
                      class="color-dot"
                      :style="{ background: trackColor(row.track) }"
                    />
                  </td>
                  <td
                    class="col-dir"
                    :class="
                      row.track.direction === 'tx'
                        ? 'direction-tx'
                        : 'direction-rx'
                    "
                  >
                    {{ row.track.direction === 'tx' ? '↑' : '↓' }}
                  </td>
                  <td class="col-status" :class="`status-${row.track.status}`">
                    {{ statusIcon(row.track.status) }}
                  </td>
                  <td class="col-name mono" :title="row.track.fullName">
                    {{ row.track.trackName }}
                  </td>
                  <td class="col-time mono">
                    {{ formatTime(row.track.subscribedAt) }}
                  </td>
                  <td class="col-time mono">
                    {{ formatTime(row.track.subscribeOkAt) }}
                  </td>
                  <td class="col-latency mono">
                    {{ formatLatency(row.track) }}
                  </td>
                  <td class="col-time mono">
                    {{ formatTime(row.stats?.firstDataAt) }}
                  </td>
                  <td class="col-bytes mono">
                    {{ row.stats ? formatBytes(row.stats.totalBytes) : '—' }}
                  </td>
                  <td class="col-bitrate mono">
                    {{ formatBitrate(row.bitrate) }}
                  </td>
                  <td class="col-duration mono">
                    {{ formatDuration(row.track, row.stats) }}
                  </td>
                  <td class="col-error" :title="row.track.errorReason ?? ''">
                    {{ row.track.errorReason ?? '' }}
                  </td>
                </tr>
              </template>
            </template>
          </template>

          <!-- Flat view -->
          <template v-else>
            <tr
              v-for="row in trackRows"
              :key="row.track.subscribeId"
              class="track-row"
            >
              <td class="col-color">
                <span
                  class="color-dot"
                  :style="{ background: trackColor(row.track) }"
                />
              </td>
              <td
                class="col-dir"
                :class="
                  row.track.direction === 'tx' ? 'direction-tx' : 'direction-rx'
                "
              >
                {{ row.track.direction === 'tx' ? '↑' : '↓' }}
              </td>
              <td class="col-status" :class="`status-${row.track.status}`">
                {{ statusIcon(row.track.status) }}
              </td>
              <td class="col-name mono" :title="row.track.fullName">
                <span
                  v-if="row.track.trackNamespace.length > 0"
                  class="track-ns"
                  >{{ row.track.trackNamespace.join('/') }}/</span
                >{{ row.track.trackName }}
              </td>
              <td class="col-time mono">
                {{ formatTime(row.track.subscribedAt) }}
              </td>
              <td class="col-time mono">
                {{ formatTime(row.track.subscribeOkAt) }}
              </td>
              <td class="col-latency mono">{{ formatLatency(row.track) }}</td>
              <td class="col-time mono">
                {{ formatTime(row.stats?.firstDataAt) }}
              </td>
              <td class="col-bytes mono">
                {{ row.stats ? formatBytes(row.stats.totalBytes) : '—' }}
              </td>
              <td class="col-bitrate mono">{{ formatBitrate(row.bitrate) }}</td>
              <td class="col-duration mono">
                {{ formatDuration(row.track, row.stats) }}
              </td>
              <td class="col-error" :title="row.track.errorReason ?? ''">
                {{ row.track.errorReason ?? '' }}
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.tracks-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* ── Toolbar ──────────────────────────────────────────────────── */

.tracks-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.toolbar-title {
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

.empty-hint {
  padding: 16px;
  color: var(--text-secondary);
  font-size: 11px;
  font-style: italic;
  text-align: center;
}

/* ── Table ───────────────────────────────────────────────────── */

.tracks-table-wrap {
  flex: 1;
  overflow: auto;
}

.tracks-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
  table-layout: auto;
}

.tracks-table thead {
  position: sticky;
  top: 0;
  z-index: 2;
}

.tracks-table th {
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border);
  padding: 3px 8px;
  text-align: left;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.3px;
  white-space: nowrap;
  user-select: none;
}

.tracks-table td {
  padding: 3px 8px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.track-row:hover {
  background: var(--bg-hover);
}

/* ── Column sizing ────────────────────────────────────────────── */

.col-color {
  width: 16px;
  text-align: center;
}
.col-dir {
  width: 24px;
  text-align: center;
  font-weight: bold;
}
.col-status {
  width: 24px;
  text-align: center;
}
.col-name {
  max-width: 200px;
}
.col-time {
  width: 90px;
}
.col-latency {
  width: 60px;
}
.col-bytes {
  width: 70px;
  text-align: right;
}
.col-bitrate {
  width: 80px;
  text-align: right;
}
.col-duration {
  width: 65px;
  text-align: right;
}
.col-error {
  max-width: 120px;
  color: var(--text-error);
  font-size: 10px;
}

.color-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.track-ns {
  color: var(--text-secondary);
}

/* ── Status colors ────────────────────────────────────────────── */

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

/* ── Namespace group rows ─────────────────────────────────────── */

.ns-group-row {
  cursor: pointer;
  user-select: none;
}
.ns-group-row td {
  background: var(--bg-secondary, var(--bg-tertiary));
  padding: 3px 10px;
  font-size: 11px;
}
.ns-group-row:hover td {
  background: var(--bg-hover);
}

.ns-chevron {
  font-size: 8px;
  width: 10px;
  display: inline-block;
  color: var(--text-secondary);
}

.ns-name {
  color: var(--text-primary);
  font-weight: 500;
  margin-left: 4px;
}

.ns-count {
  color: var(--text-secondary);
  font-size: 10px;
  margin-left: 4px;
}
</style>
