<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  formatBitrate,
  formatBytes,
  formatDuration,
  formatOffset,
  isoTitle,
  plural,
} from '../format'
import type { DirectionFilter } from '../prefs'
import { getCachedPref, loadPrefs, savePref } from '../prefs'
import { type RequestTimes, trackRoundTrip } from '../requests'
import { trackColourClass } from '../track-colour'
import type { SessionEntry, TrackEntry } from '../use-inspector'

const DECAY_WINDOW_MS = 5_000

const props = defineProps<{
  session: SessionEntry
  /** How long each request took to answer. */
  times: RequestTimes
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

/**
 * Stats keyed the way each kind of stream names its track: `a:<alias>` for
 * subgroup and datagram data, `r:<requestId>` for fetch streams, which carry
 * no alias at all. Prefixed so the two number spaces cannot collide.
 */
const trackStatsByKey = computed(() => {
  const map = new Map<string, TrackStats>()

  for (const stream of props.session.streams.values()) {
    const key =
      stream.trackAlias != null
        ? `a:${stream.trackAlias}`
        : stream.fetchRequestId != null
          ? `r:${stream.fetchRequestId}`
          : null
    if (key == null) continue
    const alias = key
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
    const alias = `a:${dg.trackAlias}`
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
  // A fetch's data arrives under its request id; everything else under an
  // alias the publisher assigned.
  if (track.via === 'fetch') {
    return trackStatsByKey.value.get(`r:${track.subscribeId}`)
  }
  if (track.trackAlias == null) return undefined
  return trackStatsByKey.value.get(`a:${track.trackAlias}`)
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
function statusIcon(status: string): string {
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
}

/** Data-pane times count from the session start. */
function relTime(ts: number | undefined): string {
  return ts == null ? '—' : formatOffset(ts, props.session.createdAt)
}

function absTitle(ts: number | undefined): string | undefined {
  return ts == null ? undefined : isoTitle(ts)
}

/** How long the track has carried data, or did until it ended. */
function activeFor(track: TrackEntry, stats: TrackStats | undefined): string {
  const start = stats?.firstDataAt ?? track.subscribedAt
  if (start == null) return '—'
  const end =
    track.status === 'done' || track.status === 'error'
      ? (track.subscribeDoneAt ??
        track.subscribeErrorAt ??
        stats?.lastDataAt ??
        start)
      : Date.now()
  return formatDuration(end - start)
}

function formatLatency(track: TrackEntry): string {
  const ms = trackRoundTrip(track, props.times)
  return ms === null ? '—' : formatDuration(ms)
}

/** Rows as namespace groups, or as one unnamed group when not grouping. */
const visibleGroups = computed((): NsGroup[] =>
  groupByNs.value ? groups.value : [{ ns: '', rows: trackRows.value }],
)

const headerCount = computed(() => {
  const shown = filteredTracks.value.length
  const total = allTracks.value.length
  return shown < total ? `${shown}/${total}` : `${total}`
})
</script>

<template>
  <div class="tracks-tab">
    <div class="filter-bar tracks-toolbar">
      <h2 class="toolbar-title">
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

    <p v-if="filteredTracks.length === 0" class="pane-message">
      {{
        allTracks.length === 0
          ? 'No track subscriptions yet.'
          : 'No tracks match these filters.'
      }}
    </p>

    <div v-else class="tracks-table-wrap">
      <table class="mq-table tracks-table">
        <thead>
          <tr>
            <th class="col-color"><span class="mq-sr">Colour</span></th>
            <th class="col-dir"><span class="mq-sr">Direction</span></th>
            <th class="col-status"><span class="mq-sr">Status</span></th>
            <th class="col-name">Track</th>
            <th class="mq-r" title="SUBSCRIBE sent, from session start">Subscribed</th>
            <th class="mq-r" title="SUBSCRIBE_OK received, from session start">OK</th>
            <th class="mq-r" title="From the request to its response">Latency</th>
            <th class="mq-r" title="First object byte, from session start">First byte</th>
            <th class="mq-r">Total</th>
            <th class="mq-r">Bitrate</th>
            <th class="mq-r">Active</th>
            <th class="col-error">Error</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="g in visibleGroups" :key="g.ns">
            <tr v-if="groupByNs" class="ns-group-row">
              <td colspan="12">
                <button
                  class="ns-toggle"
                  :aria-expanded="!collapsedGroups.has(g.ns)"
                  @click="toggleGroup(g.ns)"
                >
                  <span class="ns-chevron" aria-hidden="true">{{
                    collapsedGroups.has(g.ns) ? '▸' : '▾'
                  }}</span>
                  <span class="ns-name">{{ g.ns }}</span>
                  <span class="ns-count">{{ plural(g.rows.length, 'track') }}</span>
                </button>
              </td>
            </tr>
            <template v-if="!groupByNs || !collapsedGroups.has(g.ns)">
              <tr v-for="row in g.rows" :key="row.track.subscribeId">
                <td class="col-color">
                  <span :class="trackColourClass(row.track.colorIndex)" aria-hidden="true" />
                </td>
                <td
                  class="col-dir dir"
                  :class="row.track.direction === 'tx' ? 'dir-c2s' : 'dir-s2c'"
                  :title="row.track.direction === 'tx' ? 'outgoing' : 'incoming'"
                >
                  {{ row.track.direction === 'tx' ? '→' : '←' }}
                </td>
                <td
                  class="col-status"
                  :class="`status-${row.track.status}`"
                  :title="row.track.status"
                >
                  {{ statusIcon(row.track.status) }}
                </td>
                <td class="col-name mono" :title="row.track.fullName">
                  <span
                    v-if="!groupByNs && row.track.trackNamespace.length > 0"
                    class="track-ns"
                    >{{ row.track.trackNamespace.join('/') }} / </span
                  >{{ row.track.trackName }}
                </td>
                <td class="mono mq-r" :title="absTitle(row.track.subscribedAt)">
                  {{ relTime(row.track.subscribedAt) }}
                </td>
                <td class="mono mq-r" :title="absTitle(row.track.subscribeOkAt)">
                  {{ relTime(row.track.subscribeOkAt) }}
                </td>
                <td class="mono mq-r">{{ formatLatency(row.track) }}</td>
                <td class="mono mq-r" :title="absTitle(row.stats?.firstDataAt)">
                  {{ relTime(row.stats?.firstDataAt) }}
                </td>
                <td class="mono mq-r">
                  {{ row.stats ? formatBytes(row.stats.totalBytes) : '—' }}
                </td>
                <td class="mono mq-r">
                  {{ row.bitrate > 0 ? formatBitrate(row.bitrate) : '—' }}
                </td>
                <td class="mono mq-r">
                  {{ activeFor(row.track, row.stats) }}
                </td>
                <td class="col-error" :title="row.track.errorReason ?? ''">
                  <template v-if="row.track.errorReason"
                    >✕ {{ row.track.errorReason }}</template
                  >
                </td>
              </tr>
            </template>
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

.toolbar-title {
  font-family: var(--type-tool-label-family);
  font-size: var(--type-tool-label-size);
  line-height: var(--type-tool-label-line);
  font-weight: var(--type-tool-label-weight);
  color: var(--ink-muted);
  margin-right: auto;
}

.tracks-table-wrap {
  flex: 1;
  overflow: auto;
  background: var(--surface);
}

.tracks-table {
  font-size: var(--type-data-size);
}
.tracks-table thead {
  position: sticky;
  top: 0;
  z-index: 2;
}
.tracks-table th,
.tracks-table td {
  padding-left: var(--space-2);
  padding-right: var(--space-2);
  white-space: nowrap;
}
.tracks-table th {
  padding-top: var(--space-1);
  padding-bottom: var(--space-1);
}
.tracks-table td {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mono {
  font-family: var(--font-mono);
}

.col-color,
.col-dir,
.col-status {
  width: 20px;
  text-align: center;
}
td.col-error {
  color: var(--danger);
}
.track-ns {
  color: var(--ink-muted);
}

.ns-group-row td {
  padding: 0;
  background: var(--surface-sunken);
}
.ns-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  height: var(--row-tool);
  padding: 0 var(--space-2);
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.ns-toggle:hover {
  background: var(--surface-hover);
}
.ns-chevron {
  width: 10px;
  color: var(--ink-muted);
}
.ns-name {
  font-family: var(--type-data-strong-family);
  font-size: var(--type-data-strong-size);
  line-height: var(--type-data-strong-line);
  font-weight: var(--type-data-strong-weight);
}
.ns-count {
  color: var(--ink-muted);
}
</style>
