<script lang="ts" setup>
import { computed } from 'vue'
import { formatBytes, messageTypeName, plural } from '../format'
import { streamBytes } from '../sizes'
import type { GridColumn } from '../grid'
import { byteLabel, byteTitle, type StreamFormat } from '../stream-format'
import type { MessageEntry, StreamEntry, TrackEntry } from '../use-inspector'
import DataGrid from './DataGrid.vue'
import DirMark from './DirMark.vue'
import Icon from './Icon.vue'

const props = defineProps<{
  streams: StreamEntry[]
  selectedId: number | null
  /** Track registry for resolving trackAlias → track name */
  tracks: Map<string, TrackEntry>
  /** The toolbar's filter text, matched against the Track column */
  filter: string
  /** Control messages, used to name draft-17+ request streams by their request */
  messages?: MessageEntry[]
  /** What each stream is read as; without it, what its bytes prove */
  formatOf?: (stream: StreamEntry) => StreamFormat
  /** The panel has a status footer: the counts go there */
  appFooter?: boolean
}>()

const emit = defineEmits<{
  inspect: [streamId: number]
}>()

// ── Track lookup index (O(1) instead of O(n) per stream) ─────────
const tracksByAlias = computed(() => {
  const byAlias = new Map<string, TrackEntry>()
  for (const track of props.tracks.values()) {
    if (track.trackAlias) byAlias.set(track.trackAlias, track)
  }
  return byAlias
})

/**
 * The track a data stream belongs to.
 *
 * Subgroup and datagram streams are found by the alias in their header, and by
 * alias only: a request id is a different number space, and falling back to it
 * labels a stream with whichever unrelated subscription happens to share the
 * number. A fetch stream has no alias — it carries the request id of the FETCH
 * that asked for it, which is the key its track is filed under. An unresolved
 * stream shows its alias instead.
 */
function resolveTrack(stream: StreamEntry): TrackEntry | null {
  if (stream.fetchRequestId != null) {
    const track = props.tracks.get(String(stream.fetchRequestId))
    return track?.via === 'fetch' ? track : null
  }
  if (stream.trackAlias == null) return null
  return tracksByAlias.value.get(String(stream.trackAlias)) ?? null
}

// ── Control-plane stream naming ───────────────────────────────────

/**
 * First control message seen on each stream, which names a draft-17+ request
 * stream: the spec requires a request stream to open with its request message,
 * so the first message is the request itself.
 */
const firstMessageByStream = computed(() => {
  const byStream = new Map<number, string>()
  for (const msg of props.messages ?? []) {
    if (msg.streamId == null) continue
    if (!byStream.has(msg.streamId)) byStream.set(msg.streamId, msg.messageType)
  }
  return byStream
})

/** Human label for a control-plane stream, or null if it isn't one */
function controlLabel(stream: StreamEntry): string | null {
  if (!stream.isControl) return null
  if (stream.controlRole === 'request') {
    const type = firstMessageByStream.value.get(stream.streamId)
    return type ? messageTypeName(type) : 'Request'
  }
  return 'MoQT control'
}

// ── Filter ────────────────────────────────────────────────────────

/** The display string used for matching — mirrors what the Track column shows */
function streamLabel(stream: StreamEntry): string {
  const control = controlLabel(stream)
  if (control) return control
  const track = resolveTrack(stream)
  const suffix = stream.datagramGroupKey ? ` g:${stream.groupId}` : ''
  if (track) return track.fullName + suffix
  if (stream.trackAlias != null) return `alias:${stream.trackAlias}${suffix}`
  if (stream.fetchRequestId != null) return `fetch:${stream.fetchRequestId}`
  return `#${stream.streamId}`
}

const filteredStreams = computed(() => {
  const q = props.filter.trim().toLowerCase()
  if (!q) return props.streams
  return props.streams.filter((s) => streamLabel(s).toLowerCase().includes(q))
})

const isFiltered = computed(
  () => filteredStreams.value.length !== props.streams.length,
)

// ── Footer stats ──────────────────────────────────────────────────
function sumBytes(list: StreamEntry[], dir?: 'tx' | 'rx'): number {
  let total = 0
  for (const s of list) {
    if (!dir || s.direction === dir) total += streamBytes(s) ?? 0
  }
  return total
}

function formatOf(stream: StreamEntry): StreamFormat {
  return props.formatOf?.(stream) ?? { from: 'bytes', ...stream }
}

/** The short content type shown in the Type column, or null. */
function contentLabel(stream: StreamEntry): string | null {
  return byteLabel(formatOf(stream))
}

function contentTitle(stream: StreamEntry): string | undefined {
  return byteTitle(formatOf(stream))
}

function statusText(stream: StreamEntry): string {
  return stream.datagramGroupKey ? plural(stream.datagramCount ?? 0, 'datagram') : stream.closed ? 'closed' : 'open'
}

const columns: GridColumn<StreamEntry>[] = [
  { id: 'id', label: 'ID', width: 56, minWidth: 36, mono: true, sort: (s) => s.streamId },
  { id: 'dir', label: 'Dir', width: 36, align: 'center', showFrom: 560, sort: (s) => s.direction },
  { id: 'type', label: 'Type', width: 64, showFrom: 560, sort: (s) => contentLabel(s) },
  { id: 'track', label: 'Track', minWidth: 96, pinned: true, sort: (s) => streamLabel(s) },
  { id: 'status', label: 'Status', width: 76, pinned: true, sort: (s) => statusText(s) },
  {
    id: 'size',
    label: 'Size',
    width: 72,
    align: 'end',
    mono: true,
    showFrom: 360,
    sort: (s) => streamBytes(s) ?? -1,
  },
]

/*
 * Bidirectional streams are marked beside the stream id: every draft from 07
 * to 19 states "Objects are sent on unidirectional streams", leaving
 * bidirectional ones to the control plane.
 */

function transferParts(
  list: StreamEntry[],
): { dir: 'tx' | 'rx'; bytes: string }[] {
  const parts: { dir: 'tx' | 'rx'; bytes: string }[] = []
  const tx = sumBytes(list, 'tx')
  const rx = sumBytes(list, 'rx')
  if (tx > 0) parts.push({ dir: 'tx', bytes: formatBytes(tx) })
  if (rx > 0) parts.push({ dir: 'rx', bytes: formatBytes(rx) })
  return parts
}
</script>

<template>
  <div class="stream-list-wrapper">
    <p v-if="streams.length === 0" class="pane-message">No streams yet.</p>
    <p v-else-if="filteredStreams.length === 0" class="pane-message">No streams match this filter.</p>
    <DataGrid
      v-else
      grid-id="streams"
      label="Streams"
      :columns="columns"
      :rows="filteredStreams"
      :row-key="(s) => s.streamId"
      :selected-key="selectedId"
      follow
      @activate="(s) => emit('inspect', s.streamId)"
    >
      <template #cell="{ row: stream, column }">
        <template v-if="column.id === 'id'">
          <span v-if="stream.datagramGroupKey" class="muted" title="Datagram group">DG</span>
          <template v-else
            >{{ stream.streamId
            }}<span v-if="stream.bidi" class="stream-kind" title="Bidirectional stream"
              ><Icon name="arrowLeftRight" /></span
          ></template>
        </template>
        <DirMark v-else-if="column.id === 'dir'" :dir="stream.direction" />
        <span v-else-if="column.id === 'type'" :title="contentTitle(stream)">{{ contentLabel(stream) }}</span>
        <span
          v-else-if="column.id === 'track'"
          :title="
            controlLabel(stream)
              ? stream.controlRole === 'request'
                ? 'Request stream: one request and its responses'
                : 'MoQT control stream'
              : resolveTrack(stream)?.fullName
          "
        >
          <template v-if="controlLabel(stream)">{{ controlLabel(stream) }}</template>
          <template v-else-if="resolveTrack(stream)"
            >{{ resolveTrack(stream)!.fullName
            }}<span v-if="stream.datagramGroupKey" class="group-tag">g:{{ stream.groupId }}</span
            ><span v-else-if="stream.fetchRequestId != null" class="group-tag">fetch</span></template
          >
          <span v-else-if="stream.trackAlias != null" class="muted"
            >alias:{{ stream.trackAlias
            }}<span v-if="stream.datagramGroupKey" class="group-tag">g:{{ stream.groupId }}</span></span
          >
          <span v-else-if="stream.fetchRequestId != null" class="muted">fetch:{{ stream.fetchRequestId }}</span>
          <span v-else class="muted">#{{ stream.streamId }}</span>
        </span>
        <span v-else-if="column.id === 'status'" class="muted">{{ statusText(stream) }}</span>
        <template v-else-if="column.id === 'size' && streamBytes(stream) !== null">{{
          formatBytes(streamBytes(stream)!)
        }}</template>
      </template>
    </DataGrid>

    <Teleport to="#status-slot" defer :disabled="!appFooter">
      <div v-if="streams.length > 0" class="stream-footer" :class="{ 'stream-footer--app': appFooter }">
        <span class="footer-value">{{
          plural(isFiltered ? filteredStreams.length : streams.length, 'stream')
        }}</span>
        <span
          v-for="part in transferParts(isFiltered ? filteredStreams : streams)"
          :key="part.dir"
          class="footer-transfer"
          ><DirMark :dir="part.dir" />
          {{ part.bytes }}</span
        >
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.stream-list-wrapper {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: var(--surface);
}

.stream-kind {
  color: var(--ink-muted);
  margin-left: 3px;
}
.muted,
.group-tag {
  color: var(--ink-muted);
}
.row-selected .muted,
.row-selected .group-tag {
  color: inherit;
}
.group-tag {
  margin-left: 4px;
}

/* ── Footer ───────────────────────────────────────────────────── */

.stream-footer {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-1) var(--space-2);
  color: var(--ink);
  background: var(--surface);
  border-top: 1px solid var(--line);
  flex-shrink: 0;
  white-space: nowrap;
  overflow: hidden;
  font-variant-numeric: tabular-nums;
}

.footer-transfer {
  font-family: var(--font-mono);
}
.stream-footer--app {
  padding: 0;
  border-top: 0;
  background: none;
}
.footer-transfer .dir :deep(svg) {
  width: 12px;
  height: 12px;
  vertical-align: middle;
}

@media (max-height: 349px) {
  .stream-footer:not(.stream-footer--app) {
    display: none;
  }
}
</style>
