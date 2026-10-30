<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  type CatalogView,
  packagingConflicts,
  packagingLabel,
  registryTrackKey,
  type TrackKey,
  type TrackPackaging,
  trackSummary,
} from '../catalogs'
import { initText, type SessionCmafView } from '../cmaf'
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
import { propertyTypeText, resolutionLabel, type SessionLocView } from '../loc'
import { sessionViews } from '../packaging'
import { shownTracks, trackDirection } from '../alias-tracks'
import { type RequestTimes, trackRoundTrip } from '../requests'
import { trackByteLabels } from '../stream-format'
import { TIMELINE_LABELS, templateOf, templateText } from '../timelines'
import { trackColourClass } from '../track-colour'
import type { SessionEntry, TrackEntry } from '../use-inspector'
import type { GridColumn } from '../grid'
import { trackNameParts, trackViewLabel } from '../track-view'
import DataGrid from './DataGrid.vue'
import DirMark from './DirMark.vue'
import Icon from './Icon.vue'
import PopupMenu from './PopupMenu.vue'

const DECAY_WINDOW_MS = 5_000

const props = defineProps<{
  session: SessionEntry
  /** How long each request took to answer. */
  times: RequestTimes
  /** The session's catalog tracks, as read so far */
  catalogs?: CatalogView[]
  /** What those catalogs say about each track, by {@link registryTrackKey} */
  packaging?: Map<TrackKey, TrackPackaging>
  /** The session's LOC tracks */
  loc?: SessionLocView
  /** The session's CMAF and timeline tracks */
  cmaf?: SessionCmafView
  /** The toolbar's filter text, matched against track names */
  filter: string
}>()
const emit = defineEmits<{ openStreams: [trackName: string] }>()

// ── Bitrate tick (same pattern as ConnectionList.vue) ────────────
// Gated behind rAF so it pauses when the panel is backgrounded.
const bitrateTick = ref(0)
const bitrateTickInterval = setInterval(() => {
  requestAnimationFrame(() => {
    bitrateTick.value++
  })
}, 500)
onBeforeUnmount(() => clearInterval(bitrateTickInterval))

// ── Filter state ─────────────────────────────────────────────────
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

const viewBtn = ref<HTMLButtonElement | null>(null)
const viewOpen = ref(false)
const viewLabel = computed(() =>
  trackViewLabel({ activeOnly: activeOnly.value, direction: directionFilter.value, grouped: groupByNs.value }),
)
const DIRECTIONS: { id: DirectionFilter; label: string }[] = [
  { id: 'all', label: 'All directions' },
  { id: 'tx', label: 'Sent' },
  { id: 'rx', label: 'Received' },
]

// ── Filtering ────────────────────────────────────────────────────
const allTracks = computed(() => Array.from(shownTracks(props.session).values()))

const filteredTracks = computed(() => {
  let list = allTracks.value
  if (activeOnly.value) {
    list = list.filter((t) => t.status === 'active' || t.status === 'pending')
  }
  if (directionFilter.value !== 'all') {
    list = list.filter((t) => t.unnamed?.directionKnown !== false && trackDirection(t) === directionFilter.value)
  }
  const q = props.filter.trim().toLowerCase()
  if (q) list = list.filter((t) => t.fullName.toLowerCase().includes(q))
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

// ── What the catalogs say ────────────────────────────────────────

/**
 * The Media column: for a track a catalog describes, its packaging and shape;
 * for a catalog track, how many tracks it declares.
 */
interface MediaCell {
  badge: string
  /** Codec, size, rate: whatever the catalog gave */
  text: string
  title: string
  catalog: boolean
}

const catalogsByKey = computed(() => {
  const map = new Map<TrackKey, CatalogView>()
  for (const c of props.catalogs ?? []) map.set(c.key, c)
  return map
})

function mediaCell(track: TrackEntry): MediaCell | null {
  const key = registryTrackKey(track)
  const catalog = catalogsByKey.value.get(key)
  if (catalog) {
    const parts: string[] = []
    // With no object read there is no track count to give.
    if (catalog.objects.length > 0) parts.push(plural(catalog.tracks.length, 'track'))
    if (catalog.incomplete.length > 0) parts.push('incomplete')
    return {
      badge: 'catalog',
      text: parts.join(' · '),
      title: catalog.incomplete.join(' '),
      catalog: true,
    }
  }
  const described = props.packaging?.get(key)
  if (!described) return null
  const t = described.track
  const disagree = packagingConflicts(described).map(
    (c) =>
      `catalogs disagree on ${c.field}: ${c.values
        .map((v) => `${v.catalogName} ${v.value ?? 'none'}`)
        .join(', ')}`,
  )
  const template = templateOf(described)?.template
  const title = [
    t.role,
    t.mimeType,
    t.bitrate != null ? formatBitrate(t.bitrate) : null,
    template ? `template ${templateText(template)}` : null,
    described.publish ? 'listed under publishTracks' : null,
    ...disagree,
  ]
  return {
    badge: packagingLabel(t.packaging) ?? '?',
    text: trackSummary(t),
    title: title.filter((x) => x).join(' · '),
    catalog: false,
  }
}

// ── How the track is read ────────────────────────────────────────

const views = computed(() => sessionViews(props.session))

/** For each track, the byte format all its streams share. */
const byteLabels = computed(() => trackByteLabels(props.session, props.packaging))

/**
 * The Media cell: the reader the track's packaging calls for, as the data
 * gives it (the catalogs, or what its bytes identify), then whatever the
 * catalog gave. `reader` is null when nothing gives a packaging.
 */
interface FormatCell {
  reader: string | null
  badgeClass: string
  text: string
  title: string
}

function formatCell(track: TrackEntry, media: MediaCell | null): FormatCell {
  const key = registryTrackKey(track)
  const base = { text: media?.text ?? '' }
  const titled = (title: string) => [title, media?.title].filter((x) => x).join(' · ')

  if (media?.catalog) {
    return { ...base, reader: 'Catalog', badgeClass: '', title: media.title }
  }
  const cmaf = props.cmaf?.trackState(track) ?? null
  if (cmaf) {
    return {
      ...base,
      reader: 'CMAF',
      badgeClass: cmaf.init.status === 'known' ? 'mq-badge--ok' : 'mq-badge--check',
      title: titled(`${initText(cmaf.init)}. ${plural(cmaf.objectCount, 'object')} read.`),
    }
  }
  const timeline = props.cmaf?.timelineState(track) ?? null
  if (timeline) {
    const describes =
      timeline.depends.length > 0 ? ` Describes ${timeline.depends.join(', ')}.` : ''
    return {
      ...base,
      reader: TIMELINE_LABELS[timeline.kind],
      badgeClass: 'mq-badge--ok',
      title: titled(`${plural(timeline.objectCount, 'object')} read.${describes}`),
    }
  }
  const loc = locReading(track)
  if (loc) return { ...base, reader: loc.badge, badgeClass: loc.badgeClass, title: titled(loc.title) }
  const bytes = byteLabels.value.get(key) ?? null
  // A packaging the panel has no reader for is named as the catalog gives it.
  const text = bytes === null && media ? [media.badge, media.text].filter((x) => x).join(' ') : base.text
  return { text, reader: bytes, badgeClass: '', title: media?.title ?? '' }
}

function isHex(track: TrackEntry): boolean {
  void views.value.revision.value
  return views.value.isHex(registryTrackKey(track))
}

function setHex(track: TrackEntry, on: boolean) {
  views.value.setHex(registryTrackKey(track), on)
}

function locReading(
  track: TrackEntry,
): { badge: string; title: string; badgeClass: string } | null {
  const state = props.loc?.trackState(track) ?? null
  if (!state) return null
  const r = state.resolution
  const seen =
    state.types.length === 0
      ? 'No LOC property IDs seen'
      : `Property ${state.types.length === 1 ? 'ID' : 'IDs'} seen: ${state.types.map(propertyTypeText).join(', ')}`
  const title = [
    'profile' in r ? '' : `${resolutionLabel(r)}.`,
    `${seen} in ${plural(state.objectCount, 'object')}.`,
    state.malformedCount > 0
      ? `${plural(state.malformedCount, 'property block')} did not decode.`
      : '',
    state.conflicts?.some((c) => c.field === 'codec')
      ? 'The catalogs disagree on the codec.'
      : '',
  ]
    .filter((x) => x)
    .join(' ')
  if ('profile' in r) return { badge: `LOC ${r.profile}`, title, badgeClass: 'mq-badge--ok' }
  if (state.objectCount === 0) return { badge: 'LOC', title, badgeClass: '' }
  if (r.candidates.length === 0) return { badge: 'LOC ?', title, badgeClass: 'mq-badge--error' }
  return { badge: `LOC ${r.candidates.join(' / ')}`, title, badgeClass: 'mq-badge--check' }
}

/** Plain text in the cell; colour only where the reading failed or needs a look. */
function formatTone(badgeClass: string): string | undefined {
  if (badgeClass === 'mq-badge--error') return 'tone-error'
  if (badgeClass === 'mq-badge--check') return 'tone-warning'
  return undefined
}

// ── Computed rows with bitrate ───────────────────────────────────

interface TrackRow {
  track: TrackEntry
  stats: TrackStats | undefined
  bitrate: number
  format: FormatCell
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
    return {
      track,
      stats,
      bitrate,
      format: formatCell(track, mediaCell(track)),
    }
  })
})

// ── Grid ──────────────────────────────────────────────────────────
function nsOf(row: TrackRow): string {
  if (row.track.unnamed) return 'Known by alias only'
  return row.track.trackNamespace.length > 0 ? row.track.trackNamespace.join('/') : '(no namespace)'
}

const STATUS_ORDER = { error: 0, pending: 1, active: 2, done: 3 } as const

const anyError = computed(() => allTracks.value.some((t) => t.status === 'error' || t.errorReason))

const columns = computed((): GridColumn<TrackRow>[] => [
  {
    id: 'status',
    label: 'Status',
    srOnly: true,
    width: 28,
    minWidth: 24,
    align: 'center',
    pinned: true,
    sort: (r) => STATUS_ORDER[r.track.status],
  },
  {
    id: 'dir',
    label: 'Direction',
    srOnly: true,
    width: 28,
    minWidth: 24,
    align: 'center',
    showFrom: 640,
    sort: (r) => trackDirection(r.track),
  },
  { id: 'name', label: 'Track', minWidth: 120, pinned: true, sort: (r) => r.track.fullName },
  {
    id: 'media',
    label: 'Media',
    width: 180,
    showFrom: 560,
    title: 'What the track is read as, and what its catalog says',
    sort: (r) => r.format.reader ?? r.format.text,
  },
  {
    id: 'subscribed',
    label: 'Subscribed',
    width: 88,
    align: 'end',
    mono: true,
    showFrom: 1000,
    title: 'SUBSCRIBE sent, from session start',
    sort: (r) => r.track.subscribedAt,
  },
  {
    id: 'ok',
    label: 'OK',
    width: 88,
    align: 'end',
    mono: true,
    showFrom: 1100,
    title: 'SUBSCRIBE_OK received, from session start',
    sort: (r) => r.track.subscribeOkAt,
  },
  {
    id: 'latency',
    label: 'Latency',
    width: 72,
    align: 'end',
    mono: true,
    showFrom: 700,
    title: 'From the request to its response',
    sort: (r) => trackRoundTrip(r.track, props.times),
  },
  {
    id: 'first',
    label: 'First byte',
    width: 88,
    align: 'end',
    mono: true,
    showFrom: 1000,
    title: 'First object byte, from session start',
    sort: (r) => r.stats?.firstDataAt,
  },
  { id: 'total', label: 'Total', width: 72, align: 'end', mono: true, showFrom: 360, sort: (r) => r.stats?.totalBytes },
  { id: 'bitrate', label: 'Bitrate', width: 80, align: 'end', mono: true, showFrom: 560, sort: (r) => r.bitrate },
  { id: 'active', label: 'Active', width: 72, align: 'end', mono: true, showFrom: 900 },
  // An error column with no error in it is only noise, in the row and when it opens.
  ...(anyError.value
    ? [{ id: 'error', label: 'Error', width: 140, pinned: true, sort: (r: TrackRow) => r.track.errorReason }]
    : []),
  // Shown once everything else fits; until then a row opens to show it.
  { id: 'actions', label: 'Show streams', srOnly: true, width: 112, showFrom: 1100 },
])

// ── Helpers ─────────────────────────────────────────────────────

const statusTitle = (status: string) => status.charAt(0).toUpperCase() + status.slice(1)

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
      : props.session.closed
        ? (stats?.lastDataAt ?? start)
        : Date.now()
  return formatDuration(end - start)
}

function formatLatency(track: TrackEntry): string {
  const ms = trackRoundTrip(track, props.times)
  return ms === null ? '—' : formatDuration(ms)
}

</script>

<template>
  <div class="tracks-tab">
    <Teleport to="#tab-tools" defer>
      <button
        ref="viewBtn"
        class="mq-btn mq-btn--quiet view-btn"
        aria-haspopup="menu"
        :aria-expanded="viewOpen"
        :aria-label="`Show: ${viewLabel}`"
        @click="viewOpen = !viewOpen"
      >
        <span class="view-label">{{ viewLabel }}</span>
        <Icon name="chevronDown" class="caret" />
      </button>
    </Teleport>
    <PopupMenu v-if="viewOpen" :anchor="viewBtn" label="Show tracks" @close="viewOpen = false">
      <button
        class="mq-menu__item"
        role="menuitemcheckbox"
        :aria-checked="activeOnly"
        data-keep-open
        @click="activeOnly = !activeOnly"
      >
        Active only
      </button>
      <button
        class="mq-menu__item"
        role="menuitemcheckbox"
        :aria-checked="groupByNs"
        data-keep-open
        @click="groupByNs = !groupByNs"
      >
        Group by namespace
      </button>
      <hr role="separator" />
      <button
        v-for="d in DIRECTIONS"
        :key="d.id"
        class="mq-menu__item"
        role="menuitemradio"
        :aria-checked="directionFilter === d.id"
        data-keep-open
        @click="directionFilter = d.id"
      >
        {{ d.label }}
      </button>
    </PopupMenu>

    <p v-if="filteredTracks.length === 0" class="pane-message">
      {{ allTracks.length === 0 ? 'No track subscriptions yet.' : 'No tracks match these filters.' }}
    </p>

    <DataGrid
      v-else
      grid-id="tracks"
      label="Tracks"
      :columns="columns"
      :rows="trackRows"
      :row-key="(r) => r.track.subscribeId"
      :row-class="(r) => (r.track.status === 'error' ? 'row-error' : undefined)"
      :group-of="groupByNs ? nsOf : undefined"
      expandable
      action-column="actions"
    >
      <template #cell="{ row, column, current }">
        <span v-if="column.id === 'status'" :class="`status-${row.track.status}`" :title="statusTitle(row.track.status)">
          <Icon v-if="row.track.status === 'error'" name="error" />
          <span v-else class="status-dot" />
        </span>
        <span v-else-if="column.id === 'dir' && row.track.unnamed?.directionKnown === false" />
        <DirMark
          v-else-if="column.id === 'dir'"
          :dir="trackDirection(row.track)"
        />
        <span v-else-if="column.id === 'name'" class="name-cell" :title="row.track.fullName"
          ><span :class="trackColourClass(row.track.colorIndex)" class="track-swatch" aria-hidden="true" /><span
            v-if="trackNameParts(row.track, groupByNs).namespace"
            class="muted name-ns"
            >{{ trackNameParts(row.track, groupByNs).namespace }}</span
          ><span class="name-track">{{ row.track.trackName }}</span></span
        >
        <span v-else-if="column.id === 'media'" class="media-cell" :title="row.format.title || undefined">
          <span
            v-if="row.format.reader"
            class="reader-toggle"
            role="group"
            :aria-label="`View ${row.track.fullName} as`"
          >
            <button
              type="button"
              :class="formatTone(row.format.badgeClass)"
              :aria-pressed="!isHex(row.track)"
              :tabindex="current ? 0 : -1"
              @click.stop="setHex(row.track, false)"
            >
              {{ row.format.reader }}
            </button>
            <button
              type="button"
              :aria-pressed="isHex(row.track)"
              :tabindex="current ? 0 : -1"
              @click.stop="setHex(row.track, true)"
            >
              Bytes
            </button>
          </span>
          <span v-if="row.format.text" class="muted media-text" :class="{ 'media-text--alone': !row.format.reader }">{{
            row.format.text
          }}</span>
          <template v-else-if="!row.format.reader">—</template>
        </span>
        <span v-else-if="column.id === 'subscribed'" :title="absTitle(row.track.subscribedAt)">{{
          relTime(row.track.subscribedAt)
        }}</span>
        <span v-else-if="column.id === 'ok'" :title="absTitle(row.track.subscribeOkAt)">{{
          relTime(row.track.subscribeOkAt)
        }}</span>
        <template v-else-if="column.id === 'latency'">{{ formatLatency(row.track) }}</template>
        <span v-else-if="column.id === 'first'" :title="absTitle(row.stats?.firstDataAt)">{{
          relTime(row.stats?.firstDataAt)
        }}</span>
        <template v-else-if="column.id === 'total'">{{
          row.stats ? formatBytes(row.stats.totalBytes) : '—'
        }}</template>
        <template v-else-if="column.id === 'bitrate'">{{
          row.bitrate > 0 ? formatBitrate(row.bitrate) : '—'
        }}</template>
        <template v-else-if="column.id === 'active'">{{ activeFor(row.track, row.stats) }}</template>
        <span v-else-if="column.id === 'error'" :title="row.track.errorReason">{{ row.track.errorReason }}</span>
        <button
          v-else-if="column.id === 'actions'"
          type="button"
          class="host-btn host-btn--row"
          :tabindex="current ? 0 : -1"
          @click.stop="emit('openStreams', row.track.fullName)"
        >
          Show streams
        </button>
      </template>
    </DataGrid>
  </div>
</template>

<style scoped>
.tracks-tab {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.view-btn {
  gap: var(--space-1);
  max-width: 220px;
}
.view-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.caret :deep(svg) {
  width: 12px;
  height: 12px;
}

.muted {
  color: var(--ink-muted);
}
.row-selected .muted {
  color: inherit;
}
.tone-error {
  color: var(--danger);
}
.tone-warning {
  color: var(--warning);
}

/* The namespace gives way before the track name. */
.name-cell {
  display: flex;
  align-items: center;
  min-width: 0;
}
.name-ns {
  flex: 0 1 auto;
  min-width: 0;
  /* A flex item drops its trailing space, which is the one after the separator. */
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
}
.name-track {
  flex: 0 0.0001 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.track-swatch {
  flex: none;
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: var(--space-1);
  border-radius: 2px;
  vertical-align: middle;
}
.status-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  background: currentColor;
  vertical-align: middle;
}
.status-pending .status-dot,
.status-done .status-dot {
  background: transparent;
  border: 1.5px solid currentColor;
}

.media-cell {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
}
/* The reader and Bytes: a pair of pills, the one in use pressed. */
.reader-toggle {
  display: inline-flex;
  flex: none;
  gap: 1px;
}
.reader-toggle button {
  height: 16px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--radius-full);
  background: transparent;
  font: inherit;
  line-height: normal;
  cursor: pointer;
}
.reader-toggle button:hover {
  background: var(--bar-hover);
}
.reader-toggle button[aria-pressed='true'] {
  background: var(--host-pressed);
}
/* Chrome presses with the selection's fill, so the text takes its ink, as a
   selected row's does; a warning or error tone shows only unpressed. */
:global(html.host--chrome .reader-toggle button[aria-pressed='true']) {
  color: var(--on-row-selected);
}
.media-text {
  margin-left: var(--space-1);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.media-text--alone {
  margin-left: 0;
  color: inherit;
}
</style>
