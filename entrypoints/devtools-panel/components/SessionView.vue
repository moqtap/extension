<script lang="ts" setup>
import type { StreamContentType } from '@/src/detect/content-detect'
import { computed, nextTick, ref, watch } from 'vue'
import { formatBytes, formatClock, formatCount, isoTitle } from '../format'
import type { SessionEntry } from '../use-inspector'
import ControlMessageLog from './ControlMessageLog.vue'
import StreamDataViewer from './StreamDataViewer.vue'
import StreamList from './StreamList.vue'
import TrackList from './TrackList.vue'
import TracksTab from './TracksTab.vue'
import Icon from './Icon.vue'

const props = defineProps<{
  session: SessionEntry
  getStreamData: (
    sessionId: string,
    streamId: number,
  ) => Promise<Uint8Array | null>
  getDatagramGroupData: (
    sessionId: string,
    groupKey: string,
  ) => Promise<Uint8Array | null>
  setStreamRecording: (sessionId: string, recording: boolean) => void
  clearStreams: (sessionId: string) => void
}>()

const emit = defineEmits<{
  exportTrace: [sessionId: string]
  shareTrace: [sessionId: string]
}>()

type Tab = 'messages' | 'streams' | 'details' | 'tracks'
const activeTab = ref<Tab>('messages')

// Reset tab if tracks tab is active but protocol is no longer moqt
watch(
  () => props.session.protocol,
  (proto) => {
    if (activeTab.value === 'tracks' && proto !== 'moqt') {
      activeTab.value = 'messages'
    }
  },
)

const tabs = computed(() => {
  const s = props.session
  const list: { id: Tab; label: string; count: number | null }[] = [
    { id: 'messages', label: 'Messages', count: s.messages.length },
    {
      id: 'streams',
      label: 'Streams',
      count: s.streams.size + s.datagramGroups.size,
    },
  ]
  if (s.protocol === 'moqt') {
    list.push({ id: 'tracks', label: 'Tracks', count: s.tracks.size })
  }
  list.push({ id: 'details', label: 'Details', count: null })
  return list
})

const tabEls = ref<HTMLButtonElement[]>([])

/** Arrow keys move between tabs. */
function onTabKey(e: KeyboardEvent, index: number) {
  const n = tabs.value.length
  let next = -1
  if (e.key === 'ArrowRight') next = (index + 1) % n
  else if (e.key === 'ArrowLeft') next = (index - 1 + n) % n
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = n - 1
  if (next < 0) return
  e.preventDefault()
  activeTab.value = tabs.value[next].id
  void nextTick(() => tabEls.value[next]?.focus())
}

const selectedStreamId = ref<number | null>(null)
const selectedStreamData = ref<Uint8Array | null>(null)
const selectedContentType = ref<StreamContentType>('binary')
const loadingStream = ref(false)
const trackFilter = ref<string | null>(null)
/** byteCount at the time we last loaded stream data — used to detect new arrivals */
const loadedByteCount = ref(0)

/** Map from synthetic datagram group streamId → groupKey (for data loading) */
const dgIdToGroupKey = new Map<number, string>()
let nextDgSyntheticId = -1

function getOrCreateDgId(groupKey: string): number {
  for (const [id, gk] of dgIdToGroupKey) {
    if (gk === groupKey) return id
  }
  const id = nextDgSyntheticId--
  dgIdToGroupKey.set(id, groupKey)
  return id
}

const streamList = computed(() => {
  const items = Array.from(props.session.streams.values())
  for (const dg of props.session.datagramGroups.values()) {
    const syntheticId = getOrCreateDgId(dg.groupKey)
    items.push({
      streamId: syntheticId,
      direction: dg.direction,
      closed: dg.closed,
      byteCount: dg.byteCount,
      contentType: dg.contentType,
      mediaInfo: dg.mediaInfo,
      firstDataAt: dg.firstDataAt,
      lastDataAt: dg.lastDataAt,
      chunkCount: dg.datagramCount,
      trackAlias: dg.trackAlias,
      datagramGroupKey: dg.groupKey,
      datagramCount: dg.datagramCount,
      groupId: dg.groupId,
    })
  }
  return items
})
const trackList = computed(() => Array.from(props.session.tracks.values()))
const hasTracks = computed(() => props.session.tracks.size > 0)
const selectedStream = computed(() => {
  if (selectedStreamId.value == null) return null
  // Check real streams first
  const stream = props.session.streams.get(selectedStreamId.value)
  if (stream) return stream
  // Check synthetic datagram group entries
  return (
    streamList.value.find((s) => s.streamId === selectedStreamId.value) ?? null
  )
})

/** True when the currently-viewed stream has received more data since we loaded it */
const hasNewData = computed(() => {
  if (loadingStream.value) return false
  const stream = selectedStream.value
  if (!stream || stream.byteCount === 0) return false
  return stream.byteCount > loadedByteCount.value
})

/** Filter messages by track if a track filter is active */
const filteredMessages = computed(() => {
  if (!trackFilter.value) return props.session.messages
  // Find the track's subscribeId and filter messages that mention it
  const track = props.session.tracks.get(trackFilter.value)
  if (!track) return props.session.messages
  const subId = track.subscribeId
  return props.session.messages.filter((msg) => {
    if (!msg.decoded || typeof msg.decoded !== 'object') return false
    const d = msg.decoded as Record<string, unknown>
    const msgSubId = String(
      d.subscribeId ?? d.request_id ?? d.subscribe_id ?? '',
    )
    return msgSubId === subId
  })
})

function protocolLabel(session: SessionEntry): string {
  switch (session.protocol) {
    case 'moqt':
      // A draft nothing named is a fallback, and saying so is the difference
      // between a reading and a guess that looks like one.
      return session.draftAssumed
        ? `MoQT draft-${session.draft} (assumed)`
        : `MoQT draft-${session.draft}`
    case 'moqt-unknown-draft':
      return session.draftFromProtocol
        ? `MoQT ${session.draftFromProtocol} (draft not supported)`
        : 'MoQT (unknown draft)'
    case 'detecting':
      return 'Detecting…'
    default:
      return 'WebTransport (non-MoQT)'
  }
}

/** Where the draft came from, spelled out for the details table. */
function draftSourceLabel(session: SessionEntry): string | null {
  const isMoqt =
    session.protocol === 'moqt' || session.protocol === 'moqt-unknown-draft'
  if (!isMoqt) return null
  if (session.draftAssumed) {
    const why = session.draftAssumedReason ?? 'nothing named the draft'
    return `assumed — ${why}`
  }
  if (session.draftFromProtocol) {
    return `negotiated protocol "${session.draftFromProtocol}"`
  }
  return 'version number in SETUP'
}

const totalBytes = computed(
  () =>
    Array.from(props.session.streams.values()).reduce(
      (s, st) => s + st.byteCount,
      0,
    ) +
    Array.from(props.session.datagramGroups.values()).reduce(
      (s, dg) => s + dg.byteCount,
      0,
    ),
)

async function showStreamData(streamId: number) {
  selectedStreamId.value = streamId

  // Determine if this is a datagram group (synthetic negative ID)
  const dgGroupKey = dgIdToGroupKey.get(streamId)
  const stream = dgGroupKey
    ? streamList.value.find((s) => s.streamId === streamId)
    : props.session.streams.get(streamId)

  selectedContentType.value = stream?.contentType ?? 'binary'
  loadingStream.value = true
  try {
    if (dgGroupKey) {
      selectedStreamData.value = await props.getDatagramGroupData(
        props.session.sessionId,
        dgGroupKey,
      )
    } else {
      selectedStreamData.value = await props.getStreamData(
        props.session.sessionId,
        streamId,
      )
    }
    loadedByteCount.value = stream?.byteCount ?? 0
  } catch {
    selectedStreamData.value = null
  } finally {
    loadingStream.value = false
  }
}

async function refreshStreamData() {
  if (selectedStreamId.value == null) return
  await showStreamData(selectedStreamId.value)
}

function closeStreamData() {
  selectedStreamId.value = null
  selectedStreamData.value = null
  loadedByteCount.value = 0
}
/**
 * One sentence about `@moqtap/collector` on this page, for the Details tab.
 *
 * The connection list carries a badge; this spells out what to do about it,
 * because "SDK idle" and "SDK late" are both actionable and neither is
 * self-explanatory from three words in a chip.
 */
const collectorDetail = computed((): string | null => {
  const c = props.session.collector
  if (!c || c.state === 'none') return null
  switch (c.state) {
    case 'collected':
      return `@moqtap/collector ${c.version} — instrumenting this connection`
    case 'dormant':
      return (
        `@moqtap/collector ${c.version} — on the page but not transmitting. ` +
        'init() has not been given a key, so nothing is collected.'
      )
    case 'predates':
      return (
        `@moqtap/collector ${c.version} — attached after this connection opened, ` +
        'so it never saw it. Call init() before opening the transport.'
      )
  }
})
</script>

<template>
  <div class="session-view">
    <div class="session-header">
      <div class="mq-tabs session-tabs" role="tablist" aria-label="Session views">
        <button
          v-for="(tab, i) in tabs"
          :id="`tab-${tab.id}`"
          :key="tab.id"
          ref="tabEls"
          class="mq-tab"
          role="tab"
          :aria-selected="activeTab === tab.id"
          aria-controls="session-panel"
          :tabindex="activeTab === tab.id ? 0 : -1"
          @click="activeTab = tab.id"
          @keydown="onTabKey($event, i)"
        >
          {{ tab.label
          }}<span v-if="tab.count !== null" class="mq-tab__count">{{
            formatCount(tab.count)
          }}</span>
        </button>
      </div>
      <div
        v-if="session.protocol === 'moqt' && !session.imported"
        class="session-actions"
      >
        <button
          class="mq-btn mq-btn--quiet export-btn"
          aria-label="Export .moqtrace"
          title="Export .moqtrace"
          @click="emit('exportTrace', session.sessionId)"
        >
          <Icon name="download" />
          <span class="action-label" aria-hidden="true">.moqtrace</span>
        </button>
        <button
          class="mq-btn mq-btn--secondary share-btn"
          aria-label="Share"
          title="Upload to moqtap and share"
          @click="emit('shareTrace', session.sessionId)"
        >
          <Icon name="share" />
          <span class="action-label">Share</span>
        </button>
      </div>
    </div>
    <div
      id="session-panel"
      class="session-body"
      role="tabpanel"
      :aria-labelledby="`tab-${activeTab}`"
    >
      <TrackList
        v-if="hasTracks && activeTab === 'messages'"
        :tracks="trackList"
        :active-filter="trackFilter"
        @filter="trackFilter = $event"
      />
      <ControlMessageLog
        v-if="activeTab === 'messages'"
        :messages="filteredMessages"
        :started-at="session.createdAt"
      />
      <div
        v-else-if="activeTab === 'streams'"
        class="streams-panel"
        :class="{ 'has-detail': selectedStreamId != null }"
      >
        <StreamList
          :streams="streamList"
          :selected-id="selectedStreamId"
          :tracks="session.tracks"
          :messages="session.messages"
          :compact="selectedStreamId != null"
          :recording="session.streamRecording !== false"
          @inspect="showStreamData"
          @toggle-recording="
            props.setStreamRecording(session.sessionId, $event)
          "
          @clear="props.clearStreams(session.sessionId)"
        />
        <section
          v-if="selectedStreamId != null"
          class="stream-detail"
          aria-labelledby="stream-detail-title"
        >
          <div class="tool-bar detail-header">
            <h2 id="stream-detail-title" class="detail-title">
              <template v-if="selectedStream?.datagramGroupKey"
                >Datagram group g:{{ selectedStream.groupId }}</template
              >
              <template v-else>Stream {{ selectedStreamId }}</template>
            </h2>
            <span v-if="selectedStream" class="detail-meta">
              <span
                class="dir"
                :class="selectedStream.direction === 'tx' ? 'dir-c2s' : 'dir-s2c'"
                :title="
                  selectedStream.direction === 'tx'
                    ? 'client to server'
                    : 'server to client'
                "
                >{{ selectedStream.direction === 'tx' ? '→' : '←' }}</span
              >
              <template
                v-if="
                  !selectedStream.datagramGroupKey &&
                  selectedStream.bidi !== undefined
                "
              >
                {{ selectedStream.bidi ? 'bidirectional' : 'unidirectional' }}
                ·</template
              >
              {{ formatBytes(selectedStream.byteCount) }}
              <template v-if="selectedStream.datagramGroupKey">
                · {{ formatCount(selectedStream.datagramCount ?? 0) }}
                datagrams</template
              >
              <template v-else-if="selectedStream.chunkCount > 0">
                · {{ formatCount(selectedStream.chunkCount) }} chunks</template
              >
              · {{ selectedStream.closed ? 'closed' : 'open' }}
            </span>
            <button
              v-if="hasNewData"
              class="mq-btn mq-btn--secondary detail-refresh"
              title="New data arrived. Reload this stream."
              @click="refreshStreamData"
            >
              <span class="mq-dot refresh-dot" aria-hidden="true"></span>
              Refresh
            </button>
            <button
              class="mq-btn mq-btn--quiet mq-btn--icon"
              aria-label="Close stream"
              title="Close stream"
              @click="closeStreamData"
            >
              <Icon name="x" />
            </button>
          </div>
          <p v-if="loadingStream" class="pane-message">Loading stream data…</p>
          <StreamDataViewer
            v-else-if="selectedStreamData"
            :data="selectedStreamData"
            :content-type="selectedContentType"
            :codec-string="selectedStream?.codecString"
            :media-info="selectedStream?.mediaInfo"
            :is-moqt="session.protocol === 'moqt'"
            :draft="session.draft"
            :tracks="session.tracks"
            :is-datagram-group="!!selectedStream?.datagramGroupKey"
            class="detail-viewer"
          />
          <p v-else class="pane-message">
            No data recorded for this stream.
          </p>
        </section>
      </div>
      <TracksTab v-else-if="activeTab === 'tracks'" :session="session" />
      <div v-else-if="activeTab === 'details'" class="details-panel">
        <dl class="mq-kv details-list">
          <dt>URL</dt>
          <dd class="mq-mono">{{ session.url }}</dd>
          <template v-if="collectorDetail">
            <dt>Collector</dt>
            <dd>{{ collectorDetail }}</dd>
          </template>
          <dt>Protocol</dt>
          <dd>{{ protocolLabel(session) }}</dd>
          <template v-if="draftSourceLabel(session)">
            <dt>Draft from</dt>
            <dd>{{ draftSourceLabel(session) }}</dd>
          </template>
          <template v-if="session.clientImplementation">
            <dt>Client</dt>
            <dd class="mq-mono">{{ session.clientImplementation }}</dd>
          </template>
          <template v-if="session.serverImplementation">
            <dt>Relay</dt>
            <dd class="mq-mono">{{ session.serverImplementation }}</dd>
          </template>
          <template v-if="session.options?.protocols?.length">
            <dt>Offered protocols</dt>
            <dd class="mq-mono">{{ session.options.protocols.join(', ') }}</dd>
          </template>
          <template v-if="session.negotiatedProtocol">
            <dt>Selected protocol</dt>
            <dd class="mq-mono">{{ session.negotiatedProtocol }}</dd>
          </template>
          <template v-if="session.options?.congestionControl">
            <dt>Congestion control</dt>
            <dd class="mq-mono">{{ session.options.congestionControl }}</dd>
          </template>
          <template v-if="session.options?.allowPooling !== undefined">
            <dt>Pooling</dt>
            <dd>{{ session.options.allowPooling ? 'Allowed' : 'Disabled' }}</dd>
          </template>
          <template v-if="session.options?.requireUnreliable !== undefined">
            <dt>Require unreliable</dt>
            <dd>{{ session.options.requireUnreliable ? 'Yes' : 'No' }}</dd>
          </template>
          <template v-if="session.options?.serverCertificateHashes">
            <dt>Pinned certificates</dt>
            <dd class="mq-mono">{{ session.options.serverCertificateHashes }}</dd>
          </template>
          <dt>Session ID</dt>
          <dd class="mq-mono">{{ session.sessionId }}</dd>
          <dt>Created</dt>
          <dd :title="isoTitle(session.createdAt)">
            {{ new Date(session.createdAt).toLocaleDateString() }}
            {{ formatClock(session.createdAt) }}
          </dd>
          <dt>Status</dt>
          <dd>{{ session.closed ? 'Closed' : 'Open' }}</dd>
          <template v-if="session.frameId">
            <dt>Source</dt>
            <dd>iframe (frame {{ session.frameId }})</dd>
          </template>
          <dt>Streams</dt>
          <dd class="mq-num">{{ formatCount(session.streams.size) }}</dd>
          <dt>Messages</dt>
          <dd class="mq-num">{{ formatCount(session.messages.length) }}</dd>
          <dt>Total data</dt>
          <dd class="mq-mono mq-num">{{ formatBytes(totalBytes) }}</dd>
        </dl>
      </div>
    </div>
  </div>
</template>

<style scoped>
.session-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  flex: 1;
}

.session-header {
  display: flex;
  align-items: stretch;
  background: var(--surface);
  flex-shrink: 0;
}

.session-tabs {
  flex: 1;
  min-width: 0;
}

.session-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-2);
  border-bottom: 1px solid var(--line);
}

/* Docked narrow, the actions go icon-only so the four tabs keep their room. */
@media (max-width: 460px) {
  .action-label {
    display: none;
  }
  .session-actions {
    padding: 0 var(--space-1);
  }
  .session-actions .mq-btn {
    width: var(--mq-ctl);
    padding: 0;
  }
}

.session-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  container-type: inline-size;
}

/* ── Streams split panel ───────────────────────────────────────── */

.streams-panel {
  display: flex;
  flex: 1;
  min-height: 0;
}
/* When detail panel is open, constrain the stream list to its min-width */
.streams-panel.has-detail :deep(.stream-list-wrapper) {
  flex: 0 0 auto;
}

.stream-detail {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--line);
  background: var(--surface);
}

/* Too narrow for the list's minimum width and a readable detail side by
   side: the detail goes under the list instead of being squeezed to a sliver. */
@container (max-width: 600px) {
  .streams-panel.has-detail {
    flex-direction: column;
  }
  .streams-panel.has-detail :deep(.stream-list-wrapper) {
    flex: 0 1 40%;
    min-width: 0;
    min-height: 0;
    height: auto;
    overflow: auto;
  }
  .streams-panel.has-detail .stream-detail {
    flex: 1 1 60%;
    min-height: 0;
    border-left: 0;
    border-top: 1px solid var(--line);
  }
}

.detail-header {
  gap: var(--space-2);
  flex-wrap: wrap;
}

.detail-title {
  font: 500 12px/16px var(--font-mono);
  color: var(--ink);
  white-space: nowrap;
}

.detail-meta {
  flex: 1;
  min-width: 0;
  color: var(--ink-muted);
  font-variant-numeric: tabular-nums;
}
.detail-meta .dir {
  margin-right: var(--space-1);
}

.refresh-dot {
  color: var(--info);
  animation: pulse-dot 1.5s ease-in-out infinite;
}
@keyframes pulse-dot {
  50% {
    opacity: 0.3;
  }
}

.detail-viewer {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* ── Details ────────────────────────────────────────────────────── */

.details-panel {
  padding: var(--space-3);
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.details-list {
  max-width: 900px;
}
</style>
