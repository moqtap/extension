<script lang="ts" setup>
import type { PayloadMediaInfo } from '@moqtap/media/bmff'
import type { StreamContentType } from '@/src/detect/content-detect'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { formatBytes, messageTypeName, plural } from '../format'
import type { MessageEntry, StreamEntry, TrackEntry } from '../use-inspector'
import Icon from './Icon.vue'

const ROW_HEIGHT = 22 // px — must match CSS .stream-row height (--row-tool)
const OVERSCAN = 10 // extra rows rendered above/below viewport

const props = defineProps<{
  streams: StreamEntry[]
  selectedId: number | null
  /** Track registry for resolving trackAlias → track name */
  tracks: Map<string, TrackEntry>
  /** When true, collapse to Track column only (detail panel is open) */
  compact?: boolean
  /** Whether stream data recording is active */
  recording: boolean
  /** Control messages, used to name draft-17+ request streams by their request */
  messages?: MessageEntry[]
}>()

const emit = defineEmits<{
  inspect: [streamId: number]
  toggleRecording: [recording: boolean]
  clear: []
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
const filterText = ref('')

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
  const q = filterText.value.trim().toLowerCase()
  if (!q) return props.streams
  return props.streams.filter((s) => streamLabel(s).toLowerCase().includes(q))
})

const isFiltered = computed(
  () => filteredStreams.value.length !== props.streams.length,
)

// ── Virtual scroll ───────────────────────────────────────────────
const scrollContainer = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const containerHeight = ref(0)

const totalHeight = computed(() => filteredStreams.value.length * ROW_HEIGHT)

const visibleRange = computed(() => {
  const start = Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN)
  const visibleCount = Math.ceil(containerHeight.value / ROW_HEIGHT)
  const end = Math.min(
    filteredStreams.value.length,
    start + visibleCount + OVERSCAN * 2,
  )
  return { start, end }
})

const visibleStreams = computed(() =>
  filteredStreams.value.slice(visibleRange.value.start, visibleRange.value.end),
)

const offsetY = computed(() => visibleRange.value.start * ROW_HEIGHT)

// ── Auto-scroll ──────────────────────────────────────────────────
const SCROLL_THRESHOLD = 30
const isAtBottom = ref(true)

function onScroll() {
  const el = scrollContainer.value
  if (!el) return
  scrollTop.value = el.scrollTop
  isAtBottom.value =
    el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD
}

function scrollToBottom() {
  const el = scrollContainer.value
  if (!el || !isAtBottom.value) return
  el.scrollTop = el.scrollHeight
}

// Auto-scroll when list grows
watch(
  () => filteredStreams.value.length,
  () => {
    if (isAtBottom.value) {
      nextTick(scrollToBottom)
    }
  },
)

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  const el = scrollContainer.value
  if (!el) return
  containerHeight.value = el.clientHeight
  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      containerHeight.value = entry.contentRect.height
    }
  })
  resizeObserver.observe(el)
})

onUnmounted(() => {
  resizeObserver?.disconnect()
})

// ── Footer stats ──────────────────────────────────────────────────
function sumBytes(list: StreamEntry[], dir?: 'tx' | 'rx'): number {
  let total = 0
  for (const s of list) {
    if (!dir || s.direction === dir) total += s.byteCount
  }
  return total
}

const VARIANT_LABELS: Record<string, string> = {
  cmaf: 'CMAF',
  fmp4: 'fMP4',
}

function mediaLabel(info: PayloadMediaInfo): string {
  return VARIANT_LABELS[info.variant] ?? 'fMP4'
}

function codecLabel(contentType: StreamContentType): string {
  return contentType === 'h265' ? 'H.265' : 'H.264'
}

/** The short content type shown in the Type column, or null. */
function contentLabel(stream: StreamEntry): string | null {
  switch (stream.contentType) {
    case 'fmp4':
      return stream.mediaInfo ? mediaLabel(stream.mediaInfo) : 'fMP4'
    case 'h264':
    case 'h265':
      return codecLabel(stream.contentType)
    case 'json':
      return 'JSON'
    case 'cbor':
      return 'CBOR'
    case 'msgpack':
      return 'MsgPack'
    default:
      return null
  }
}

function contentTitle(stream: StreamEntry): string | undefined {
  if (stream.contentType === 'fmp4' && stream.mediaInfo) {
    return stream.mediaInfo.boxes.join(' · ')
  }
  if (stream.contentType === 'h264' || stream.contentType === 'h265') {
    return stream.codecString ?? codecLabel(stream.contentType)
  }
  return undefined
}

/**
 * QUIC stream class marker shown beside the stream id.
 *
 * Worth the column space because it is the structural split in MoQT: every
 * draft from 07 to 19 states "Objects are sent on unidirectional streams",
 * leaving bidirectional streams to the control plane — the control stream in
 * all drafts, plus per-request streams from draft-17 on. Absent for imported
 * traces, which carry no stream class.
 */
function kindGlyph(stream: StreamEntry): string {
  // Not →, which the direction column uses.
  return stream.bidi ? '⇄' : '↦'
}

function kindTitle(stream: StreamEntry): string {
  return stream.bidi
    ? 'Bidirectional stream — control or request messages'
    : 'Unidirectional stream — objects'
}

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
    <div class="tool-bar stream-toolbar">
      <button
        class="mq-btn mq-btn--quiet mq-btn--icon record-btn"
        :class="{ recording: props.recording }"
        :aria-pressed="props.recording"
        :aria-label="
          props.recording ? 'Stop recording stream data' : 'Record stream data'
        "
        :title="
          props.recording ? 'Stop recording stream data' : 'Record stream data'
        "
        @click="emit('toggleRecording', !props.recording)"
      >
        <span class="record-dot" aria-hidden="true" />
      </button>
      <button
        class="mq-btn mq-btn--quiet mq-btn--icon clear-btn"
        aria-label="Clear stream data"
        title="Clear stream data"
        @click="emit('clear')"
      >
        <Icon name="ban" />
      </button>
      <div class="filter-field">
        <input
          v-model="filterText"
          class="mq-input mq-input--mono filter-input"
          type="search"
          aria-label="Filter streams by track name"
          placeholder="Filter by track name"
          spellcheck="false"
        />
        <button
          v-if="filterText"
          class="mq-btn mq-btn--quiet mq-btn--icon filter-clear"
          aria-label="Clear filter"
          title="Clear filter"
          @click="filterText = ''"
        >
          <Icon name="x" />
        </button>
      </div>
    </div>

    <!-- Sticky header row (outside scroll container) -->
    <div v-if="streams.length > 0" class="stream-header-row" aria-hidden="true">
      <span v-if="!compact" class="col-id">ID</span>
      <span v-if="!compact" class="col-dir">Dir</span>
      <span v-if="!compact" class="col-type">Type</span>
      <span class="col-track">Track</span>
      <span v-if="!compact" class="col-status">Status</span>
      <span v-if="!compact" class="col-bytes">Size</span>
    </div>

    <div ref="scrollContainer" class="stream-scroll" @scroll.passive="onScroll">
      <p v-if="streams.length === 0" class="pane-message">No streams yet.</p>
      <p v-else-if="filteredStreams.length === 0" class="pane-message">
        No streams match this filter.
      </p>
      <template v-else>
        <!-- Spacer div sets total scrollable height -->
        <div class="virtual-spacer" :style="{ height: totalHeight + 'px' }">
          <!-- Visible rows, offset to their correct position -->
          <ul
            class="virtual-window"
            aria-label="Streams"
            :style="{ transform: `translateY(${offsetY}px)` }"
          >
            <li v-for="stream in visibleStreams" :key="stream.streamId">
              <button
                class="stream-row"
                :aria-current="
                  stream.streamId === props.selectedId ? 'true' : undefined
                "
                @click="emit('inspect', stream.streamId)"
              >
                <span v-if="!compact" class="col-id">
                  <span
                    v-if="stream.datagramGroupKey"
                    class="mq-badge mq-badge--mono row-badge"
                    title="Datagram group"
                    >DG</span
                  >
                  <template v-else>
                    <span
                      v-if="stream.bidi !== undefined"
                      class="stream-kind"
                      :title="kindTitle(stream)"
                      >{{ kindGlyph(stream) }}</span
                    >{{ stream.streamId }}
                  </template>
                </span>
                <span
                  v-if="!compact"
                  class="col-dir dir"
                  :class="stream.direction === 'tx' ? 'dir-c2s' : 'dir-s2c'"
                  :title="
                    stream.direction === 'tx'
                      ? 'client to server'
                      : 'server to client'
                  "
                >
                  {{ stream.direction === 'tx' ? '→' : '←' }}
                </span>
                <span v-if="!compact" class="col-type">
                  <span
                    v-if="contentLabel(stream)"
                    class="mq-badge mq-badge--mono row-badge"
                    :title="contentTitle(stream)"
                    >{{ contentLabel(stream) }}</span
                  >
                </span>
                <span
                  class="col-track"
                  :title="
                    controlLabel(stream)
                      ? stream.controlRole === 'request'
                        ? 'Request stream — one request and its responses'
                        : 'MoQT control stream'
                      : resolveTrack(stream)?.fullName
                  "
                >
                  <span v-if="controlLabel(stream)" class="track-control">{{
                    controlLabel(stream)
                  }}</span>
                  <span v-else-if="resolveTrack(stream)" class="track-name">
                    {{ resolveTrack(stream)!.fullName }}
                    <span v-if="stream.datagramGroupKey" class="group-tag"
                      >g:{{ stream.groupId }}</span
                    >
                    <span
                      v-else-if="stream.fetchRequestId != null"
                      class="group-tag"
                      >fetch</span
                    >
                  </span>
                  <span
                    v-else-if="stream.trackAlias != null"
                    class="track-alias"
                  >
                    alias:{{ stream.trackAlias }}
                    <span v-if="stream.datagramGroupKey" class="group-tag"
                      >g:{{ stream.groupId }}</span
                    >
                  </span>
                  <span
                    v-else-if="stream.fetchRequestId != null"
                    class="track-alias"
                  >
                    fetch:{{ stream.fetchRequestId }}
                  </span>
                  <span v-else class="track-alias">#{{ stream.streamId }}</span>
                </span>
                <span v-if="!compact" class="col-status">
                  <template v-if="stream.datagramGroupKey">{{
                    plural(stream.datagramCount ?? 0, 'datagram')
                  }}</template>
                  <template v-else>{{
                    stream.closed ? 'closed' : 'open'
                  }}</template>
                </span>
                <span v-if="!compact" class="col-bytes">{{
                  formatBytes(stream.byteCount)
                }}</span>
              </button>
            </li>
          </ul>
        </div>
      </template>
    </div>

    <div v-if="streams.length > 0" class="stream-footer">
      <span class="footer-value">{{
        plural(isFiltered ? filteredStreams.length : streams.length, 'stream')
      }}</span>
      <span
        v-for="part in transferParts(isFiltered ? filteredStreams : streams)"
        :key="part.dir"
        class="footer-transfer"
        :title="part.dir === 'tx' ? 'client to server' : 'server to client'"
        ><span class="dir" :class="part.dir === 'tx' ? 'dir-c2s' : 'dir-s2c'">{{
          part.dir === 'tx' ? '→' : '←'
        }}</span>
        {{ part.bytes }}</span
      >
    </div>
  </div>
</template>

<style scoped>
.stream-list-wrapper {
  display: flex;
  flex-direction: column;
  min-width: 280px;
  flex: 1;
  height: 100%;
  background: var(--surface);
}

.record-dot {
  width: 10px;
  height: 10px;
  border-radius: var(--radius-full);
  border: 1.5px solid var(--ink-muted);
}
.record-btn.recording .record-dot {
  background: var(--danger);
  border-color: var(--danger);
}

.filter-field {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  margin-left: var(--space-1);
}

.filter-input {
  padding-right: var(--control-tool);
}
.filter-input::-webkit-search-cancel-button {
  display: none;
}

.filter-clear {
  position: absolute;
  right: 0;
}

.stream-header-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  font-family: var(--type-tool-label-family);
  font-size: var(--type-tool-label-size);
  line-height: var(--type-tool-label-line);
  font-weight: var(--type-tool-label-weight);
  color: var(--ink-muted);
  border-bottom: 1px solid var(--line);
  background: var(--surface-sunken);
  flex-shrink: 0;
}

.stream-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.virtual-spacer {
  position: relative;
}

.virtual-window {
  will-change: transform;
  list-style: none;
  padding: 0;
}

/* One MessageLog-style row: 22px, data type. */
.stream-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  height: var(--row-tool);
  padding: 0 var(--space-2);
  border: 0;
  border-bottom: 1px solid var(--line);
  background: transparent;
  color: var(--ink);
  font-family: var(--type-data-family);
  font-size: var(--type-data-size);
  line-height: var(--type-data-line);
  font-variant-numeric: tabular-nums;
  text-align: left;
  cursor: pointer;
}
.stream-row:hover {
  background: var(--surface-hover);
}
.stream-row[aria-current='true'] {
  background: var(--surface-selected);
}

.col-id {
  width: 52px;
  flex-shrink: 0;
  white-space: nowrap;
}
.stream-kind {
  color: var(--ink-muted);
  margin-right: 3px;
}
.col-dir {
  width: 28px;
  flex-shrink: 0;
  text-align: center;
}
.col-type {
  width: 64px;
  flex-shrink: 0;
}
.col-track {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.col-status {
  width: 84px;
  flex-shrink: 0;
  color: var(--ink-muted);
  font-family: var(--font-sans);
  white-space: nowrap;
}
.col-bytes {
  width: 76px;
  flex-shrink: 0;
  text-align: right;
  white-space: nowrap;
}

.row-badge {
  height: 16px;
  padding: 0 4px;
}

.track-control {
  font-weight: 500;
}
.track-alias,
.group-tag {
  color: var(--ink-muted);
}
.group-tag {
  margin-left: 3px;
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
</style>
