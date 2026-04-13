<script lang="ts" setup>
import type { PayloadMediaInfo } from '@/src/detect/bmff-boxes'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { StreamEntry, TrackEntry } from '../use-inspector'

const ROW_HEIGHT = 24 // px — must match CSS .stream-row height
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
}>()

const emit = defineEmits<{
  inspect: [streamId: number]
  toggleRecording: [recording: boolean]
  clear: []
}>()

// ── Track lookup index (O(1) instead of O(n) per stream) ─────────
const trackIndex = computed(() => {
  const byAlias = new Map<string, TrackEntry>()
  const bySubId = new Map<string, TrackEntry>()
  for (const track of props.tracks.values()) {
    if (track.trackAlias) byAlias.set(track.trackAlias, track)
    bySubId.set(track.subscribeId, track)
  }
  return { byAlias, bySubId }
})

function resolveTrack(stream: StreamEntry): TrackEntry | null {
  if (stream.trackAlias == null) return null
  const alias = String(stream.trackAlias)
  const idx = trackIndex.value
  return idx.byAlias.get(alias) ?? idx.bySubId.get(alias) ?? null
}

// ── Filter ────────────────────────────────────────────────────────
const filterText = ref('')

/** The display string used for matching — mirrors what the Track column shows */
function streamLabel(stream: StreamEntry): string {
  if (stream.isControl) return 'Control'
  const track = resolveTrack(stream)
  const suffix = stream.datagramGroupKey ? ` g:${stream.groupId}` : ''
  if (track) return track.fullName + suffix
  if (stream.trackAlias != null) return `alias:${stream.trackAlias}${suffix}`
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function streamCount(list: StreamEntry[]): string {
  return `${list.length} stream${list.length !== 1 ? 's' : ''}`
}

const VARIANT_LABELS: Record<string, string> = {
  cmaf: 'CMAF',
  loc: 'LOC',
  fmp4: 'fMP4',
}

function mediaLabel(info: PayloadMediaInfo): string {
  const label = VARIANT_LABELS[info.variant] ?? 'fMP4'
  return `${label}(${info.boxes.length})`
}

function transferSummary(list: StreamEntry[]): string {
  const tx = sumBytes(list, 'tx')
  const rx = sumBytes(list, 'rx')
  const parts: string[] = []
  if (tx > 0) parts.push(`↑ ${formatBytes(tx)}`)
  if (rx > 0) parts.push(`↓ ${formatBytes(rx)}`)
  return parts.join('  ')
}
</script>

<template>
  <div class="stream-list-wrapper">
    <div class="stream-toolbar">
      <button
        class="toolbar-btn record-btn"
        :class="{ recording: props.recording }"
        :title="
          props.recording
            ? 'Stop recording stream data'
            : 'Resume recording stream data'
        "
        @click="emit('toggleRecording', !props.recording)"
      >
        <span class="record-dot" />
      </button>
      <button
        class="toolbar-btn clear-btn"
        title="Clear stream data"
        @click="emit('clear')"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
        >
          <circle cx="8" cy="8" r="6.5" />
          <line x1="3.5" y1="12.5" x2="12.5" y2="3.5" />
        </svg>
      </button>
      <div class="filter-field">
        <input
          v-model="filterText"
          class="filter-input mono"
          type="text"
          placeholder="Filter by track name..."
          spellcheck="false"
        />
        <button
          v-if="filterText"
          class="filter-clear"
          title="Clear filter"
          @click="filterText = ''"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <path
              d="M3.5 3.5l9 9m0-9l-9 9"
              stroke="currentColor"
              stroke-width="1.8"
              fill="none"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>
    </div>

    <!-- Sticky header row (outside scroll container) -->
    <div v-if="streams.length > 0" class="stream-header-row">
      <span v-if="!compact" class="col-id">#</span>
      <span v-if="!compact" class="col-dir">Dir</span>
      <span v-if="!compact" class="col-type">Type</span>
      <span class="col-track">Track</span>
      <span v-if="!compact" class="col-status">Status</span>
      <span v-if="!compact" class="col-bytes">Bytes</span>
    </div>

    <div ref="scrollContainer" class="stream-scroll" @scroll.passive="onScroll">
      <div v-if="streams.length === 0" class="empty-state">No streams yet</div>
      <div v-else-if="filteredStreams.length === 0" class="empty-state">
        No streams match filter
      </div>
      <template v-else>
        <!-- Spacer div sets total scrollable height -->
        <div class="virtual-spacer" :style="{ height: totalHeight + 'px' }">
          <!-- Visible rows, offset to their correct position -->
          <div
            class="virtual-window"
            :style="{ transform: `translateY(${offsetY}px)` }"
          >
            <div
              v-for="stream in visibleStreams"
              :key="stream.streamId"
              class="stream-row"
              :class="{ selected: stream.streamId === props.selectedId }"
              @click="emit('inspect', stream.streamId)"
            >
              <span v-if="!compact" class="col-id mono">
                <span
                  v-if="stream.datagramGroupKey"
                  class="dg-badge"
                  title="Datagram group"
                  >DG</span
                >
                <template v-else>{{ stream.streamId }}</template>
              </span>
              <span
                v-if="!compact"
                class="col-dir"
                :class="
                  stream.direction === 'tx' ? 'direction-tx' : 'direction-rx'
                "
              >
                {{ stream.direction === 'tx' ? 'TX' : 'RX' }}
              </span>
              <span v-if="!compact" class="col-type">
                <span
                  v-if="stream.contentType === 'fmp4' && stream.mediaInfo"
                  class="content-badge content-fmp4"
                  :title="stream.mediaInfo.boxes.join(' · ')"
                >
                  {{ mediaLabel(stream.mediaInfo) }}
                </span>
                <span
                  v-else-if="stream.contentType === 'fmp4'"
                  class="content-badge content-fmp4"
                >
                  fMP4
                </span>
                <span
                  v-else-if="stream.contentType === 'json'"
                  class="content-badge content-json"
                >
                  JSON
                </span>
                <span
                  v-else-if="stream.contentType === 'cbor'"
                  class="content-badge content-cbor"
                >
                  CBOR
                </span>
                <span
                  v-else-if="stream.contentType === 'msgpack'"
                  class="content-badge content-msgpack"
                >
                  MPK
                </span>
              </span>
              <span
                class="col-track"
                :title="
                  stream.isControl
                    ? 'MoQT control stream (bidi)'
                    : resolveTrack(stream)?.fullName
                "
              >
                <span v-if="stream.isControl" class="track-control"
                  >MoQT Control</span
                >
                <span v-else-if="resolveTrack(stream)" class="track-tag">
                  {{ resolveTrack(stream)!.fullName }}
                  <span v-if="stream.datagramGroupKey" class="group-tag mono"
                    >g:{{ stream.groupId }}</span
                  >
                </span>
                <span
                  v-else-if="stream.trackAlias != null"
                  class="track-alias mono"
                >
                  alias:{{ stream.trackAlias }}
                  <span v-if="stream.datagramGroupKey" class="group-tag"
                    >g:{{ stream.groupId }}</span
                  >
                </span>
                <span v-else class="track-alias mono"
                  >#{{ stream.streamId }}</span
                >
              </span>
              <span v-if="!compact" class="col-status">
                <span
                  v-if="stream.datagramGroupKey"
                  class="badge badge-dg"
                  :title="`${stream.datagramCount} datagrams`"
                >
                  {{ stream.datagramCount }} dg
                </span>
                <span
                  v-else
                  class="badge"
                  :class="stream.closed ? 'badge-closed' : 'badge-open'"
                >
                  {{ stream.closed ? 'closed' : 'open' }}
                </span>
              </span>
              <span v-if="!compact" class="col-bytes mono">{{
                formatBytes(stream.byteCount)
              }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>

    <div v-if="streams.length > 0" class="stream-footer">
      <template v-if="isFiltered">
        <span class="footer-value">{{ streamCount(filteredStreams) }}</span>
        <span class="footer-transfer">{{
          transferSummary(filteredStreams)
        }}</span>
      </template>
      <template v-else>
        <span class="footer-value">{{ streamCount(streams) }}</span>
        <span class="footer-transfer">{{ transferSummary(streams) }}</span>
      </template>
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
}

.stream-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px 2px 4px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.toolbar-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 6px;
  border-radius: 3px;
  display: flex;
  align-items: center;
  flex-shrink: 0;
}
.toolbar-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.clear-btn {
  padding: 4px;
}

.record-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--text-secondary);
}
.record-btn.recording .record-dot {
  background: #e06c75;
}
.record-btn.recording:hover .record-dot {
  background: #c75050;
}

.filter-field {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
}

.filter-input {
  width: 100%;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text-primary);
  font-size: 11px;
  padding: 3px 6px;
  padding-right: 22px;
  outline: none;
  box-sizing: border-box;
}
.filter-input:focus {
  border-color: var(--text-accent);
}
.filter-input::placeholder {
  color: var(--text-secondary);
}

.filter-clear {
  position: absolute;
  right: 2px;
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
  display: flex;
  align-items: center;
  line-height: 1;
}
.filter-clear:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.stream-header-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 8px;
  font-size: 11px;
  color: var(--text-secondary);
  font-weight: 600;
  border-bottom: 1px solid var(--border);
  background: var(--bg-tertiary);
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
}

.stream-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  font-size: 11px;
  height: 24px;
  box-sizing: border-box;
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

.col-id {
  width: 30px;
}
.col-dir {
  width: 30px;
  text-align: center;
  font-weight: 600;
  font-size: 10px;
}
.col-type {
  width: 56px;
  text-align: center;
}
.col-track {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.col-status {
  width: 50px;
}
.col-bytes {
  width: 70px;
  text-align: right;
}

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
  cursor: default;
}
.content-cbor {
  background: var(--content-cbor-bg);
  color: var(--content-cbor-color);
}
.content-msgpack {
  background: var(--content-msgpack-bg);
  color: var(--content-msgpack-color);
}

.dg-badge {
  display: inline-block;
  font-size: 8px;
  font-weight: 700;
  padding: 0 3px;
  border-radius: 2px;
  background: var(--content-cbor-bg, #3d3d50);
  color: var(--content-cbor-color, #c0a0ff);
  letter-spacing: 0.3px;
  line-height: 1.5;
}

.group-tag {
  font-size: 9px;
  color: var(--text-secondary);
  margin-left: 3px;
}

.badge-dg {
  background: var(--content-cbor-bg, #3d3d50);
  color: var(--content-cbor-color, #c0a0ff);
}

.track-control {
  font-size: 10px;
  color: var(--text-accent);
  font-weight: 600;
}
.track-tag {
  font-size: 10px;
  color: var(--text-warning);
}
.track-alias {
  font-size: 10px;
  color: var(--text-secondary);
}

.empty-state {
  padding: 20px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 12px;
}

/* ── Footer ───────────────────────────────────────────────────── */

.stream-footer {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-top: 1px solid var(--border);
  flex-shrink: 0;
  white-space: nowrap;
  overflow: hidden;
}

.footer-label {
  color: var(--text-secondary);
}

.footer-value {
  color: var(--text-primary);
  font-weight: 500;
  font-feature-settings: 'tnum';
  font-variant-numeric: tabular-nums;
}

.footer-transfer {
  color: var(--text-primary);
}

.footer-muted {
  color: var(--text-secondary);
}

.footer-divider {
  width: 1px;
  height: 10px;
  background: var(--border);
  margin: 0 3px;
}
</style>
