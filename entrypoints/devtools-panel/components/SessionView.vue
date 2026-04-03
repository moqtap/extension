<script lang="ts" setup>
import { ref, computed } from 'vue';
import type { SessionEntry, StreamContentType } from '../use-inspector';
import ControlMessageLog from './ControlMessageLog.vue';
import StreamList from './StreamList.vue';
import StreamDataViewer from './StreamDataViewer.vue';
import TrackList from './TrackList.vue';

const props = defineProps<{
  session: SessionEntry;
  getStreamData: (sessionId: string, streamId: number) => Promise<Uint8Array | null>;
  setStreamRecording: (sessionId: string, recording: boolean) => void;
  clearStreams: (sessionId: string) => void;
}>();

const emit = defineEmits<{
  exportTrace: [sessionId: string];
}>();

type Tab = 'messages' | 'streams' | 'details';
const activeTab = ref<Tab>('messages');

const selectedStreamId = ref<number | null>(null);
const selectedStreamData = ref<Uint8Array | null>(null);
const selectedContentType = ref<StreamContentType>('binary');
const loadingStream = ref(false);
const trackFilter = ref<string | null>(null);
/** byteCount at the time we last loaded stream data — used to detect new arrivals */
const loadedByteCount = ref(0);

const streamList = computed(() => Array.from(props.session.streams.values()));
const trackList = computed(() => Array.from(props.session.tracks.values()));
const hasTracks = computed(() => props.session.tracks.size > 0);
const selectedStream = computed(() =>
  selectedStreamId.value != null ? props.session.streams.get(selectedStreamId.value) ?? null : null,
);

/** True when the currently-viewed stream has received more data since we loaded it */
const hasNewData = computed(() => {
  if (loadingStream.value) return false;
  const stream = selectedStream.value;
  if (!stream || stream.byteCount === 0) return false;
  return stream.byteCount > loadedByteCount.value;
});

/** Filter messages by track if a track filter is active */
const filteredMessages = computed(() => {
  if (!trackFilter.value) return props.session.messages;
  // Find the track's subscribeId and filter messages that mention it
  const track = props.session.tracks.get(trackFilter.value);
  if (!track) return props.session.messages;
  const subId = track.subscribeId;
  return props.session.messages.filter((msg) => {
    if (!msg.decoded || typeof msg.decoded !== 'object') return false;
    const d = msg.decoded as Record<string, unknown>;
    const msgSubId = String(d.subscribeId ?? d.request_id ?? d.subscribe_id ?? '');
    return msgSubId === subId;
  });
});

function protocolLabel(session: SessionEntry): string {
  switch (session.protocol) {
    case 'moqt':
      return `MoQT draft-${session.draft}`;
    case 'moqt-unknown-draft':
      return 'MoQT (unknown draft)';
    case 'detecting':
      return 'Detecting...';
    default:
      return 'WebTransport (non-MoQT)';
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function showStreamData(streamId: number) {
  selectedStreamId.value = streamId;
  const stream = props.session.streams.get(streamId);
  selectedContentType.value = stream?.contentType ?? 'binary';
  loadingStream.value = true;
  try {
    selectedStreamData.value = await props.getStreamData(props.session.sessionId, streamId);
    loadedByteCount.value = stream?.byteCount ?? 0;
  } catch {
    selectedStreamData.value = null;
  } finally {
    loadingStream.value = false;
  }
}

async function refreshStreamData() {
  if (selectedStreamId.value == null) return;
  await showStreamData(selectedStreamId.value);
}

function closeStreamData() {
  selectedStreamId.value = null;
  selectedStreamData.value = null;
  loadedByteCount.value = 0;
}
</script>

<template>
  <div class="session-view">
    <div class="session-header">
      <div class="session-info">
        <span class="session-url mono">{{ session.url }}</span>
        <span class="session-protocol">{{ protocolLabel(session) }}</span>
        <span v-if="session.imported" class="session-imported">
          Imported
        </span>
        <span v-else-if="session.closed" class="session-closed">
          Closed{{ session.closedReason ? `: ${session.closedReason}` : '' }}
        </span>
        <button
          v-if="session.protocol === 'moqt' && !session.imported"
          class="export-btn"
          title="Export .moqtrace"
          @click="emit('exportTrace', session.sessionId)"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1v9M8 10L5 7M8 10l3-3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M3 12v2h10v-2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          .moqtrace
        </button>
      </div>
      <div class="tabs">
        <button
          class="tab"
          :class="{ active: activeTab === 'messages' }"
          @click="activeTab = 'messages'"
        >
          Messages ({{ session.messages.length }})
        </button>
        <button
          class="tab"
          :class="{ active: activeTab === 'streams' }"
          @click="activeTab = 'streams'"
        >
          Streams ({{ session.streams.size }})
        </button>
        <button
          class="tab"
          :class="{ active: activeTab === 'details' }"
          @click="activeTab = 'details'"
        >
          Details
        </button>
      </div>
    </div>
    <div class="session-body">
      <TrackList
        v-if="hasTracks && activeTab === 'messages'"
        :tracks="trackList"
        :active-filter="trackFilter"
        @filter="trackFilter = $event"
      />
      <ControlMessageLog
        v-if="activeTab === 'messages'"
        :messages="filteredMessages"
      />
      <div v-else-if="activeTab === 'streams'" class="streams-panel" :class="{ 'has-detail': selectedStreamId != null }">
        <StreamList
          :streams="streamList"
          :selected-id="selectedStreamId"
          :tracks="session.tracks"
          :compact="selectedStreamId != null"
          :recording="session.streamRecording !== false"
          @inspect="showStreamData"
          @toggle-recording="props.setStreamRecording(session.sessionId, $event)"
          @clear="props.clearStreams(session.sessionId)"
        />
        <div v-if="selectedStreamId != null" class="stream-detail">
          <div class="detail-header">
            <span class="detail-title mono">Stream #{{ selectedStreamId }}</span>
            <span v-if="selectedStream" class="detail-meta">
              {{ selectedStream.direction === 'tx' ? 'TX' : 'RX' }}
              · {{ formatBytes(selectedStream.byteCount) }}
              <template v-if="selectedStream.chunkCount > 0"> · {{ selectedStream.chunkCount }} chunks</template>
              · {{ selectedStream.closed ? 'closed' : 'open' }}
            </span>
            <button
              v-if="hasNewData"
              class="detail-refresh"
              title="New data available — click to refresh"
              @click="refreshStreamData"
            >
              <span class="refresh-dot"></span>
              Refresh
            </button>
            <button class="detail-close" title="Close" @click="closeStreamData">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
              </svg>
            </button>
          </div>
          <div v-if="loadingStream" class="detail-loading">Loading stream data...</div>
          <StreamDataViewer
            v-else-if="selectedStreamData"
            :data="selectedStreamData"
            :content-type="selectedContentType"
            :is-moqt="session.protocol === 'moqt'"
            :draft="session.draft"
            :tracks="session.tracks"
            class="detail-viewer"
          />
          <div v-else class="detail-empty">No data available</div>
        </div>
      </div>
      <div v-else-if="activeTab === 'details'" class="details-panel">
        <table class="details-table mono">
          <tbody>
            <tr>
              <td class="details-label">URL</td>
              <td>{{ session.url }}</td>
            </tr>
            <tr>
              <td class="details-label">Protocol</td>
              <td>{{ protocolLabel(session) }}</td>
            </tr>
            <tr>
              <td class="details-label">Session ID</td>
              <td>{{ session.sessionId }}</td>
            </tr>
            <tr>
              <td class="details-label">Created</td>
              <td>{{ new Date(session.createdAt).toISOString() }}</td>
            </tr>
            <tr>
              <td class="details-label">Status</td>
              <td>{{ session.closed ? 'Closed' : 'Open' }}</td>
            </tr>
            <tr>
              <td class="details-label">Streams</td>
              <td>{{ session.streams.size }}</td>
            </tr>
            <tr>
              <td class="details-label">Messages</td>
              <td>{{ session.messages.length }}</td>
            </tr>
            <tr>
              <td class="details-label">Total Data</td>
              <td>{{ formatBytes(Array.from(session.streams.values()).reduce((s, st) => s + st.byteCount, 0)) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.session-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.session-header {
  border-bottom: 1px solid var(--border);
  background: var(--bg-tertiary);
}

.session-info {
  padding: 6px 12px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.session-url {
  color: var(--text-url);
  font-size: 12px;
}

.session-protocol {
  color: var(--text-accent);
  font-size: 11px;
}

.session-closed {
  color: var(--text-error);
  font-size: 11px;
}

.session-imported {
  color: var(--badge-imported-color);
  font-size: 11px;
  font-weight: 600;
}

.export-btn {
  margin-left: auto;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text-accent);
  padding: 2px 10px;
  cursor: pointer;
  font-size: 11px;
  font-family: inherit;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.export-btn:hover {
  background: var(--bg-selected);
  color: var(--text-primary);
}

.tabs {
  display: flex;
  border-top: 1px solid var(--border);
}

.tab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  padding: 6px 14px;
  cursor: pointer;
  font-size: 11px;
  font-family: inherit;
}
.tab:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}
.tab.active {
  color: var(--text-primary);
  border-bottom-color: var(--text-accent);
}

.session-body {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
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
  border-left: 1px solid var(--border);
}

.detail-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.detail-title {
  font-size: 11px;
  color: var(--text-primary);
  font-weight: 600;
}

.detail-meta {
  font-size: 10px;
  color: var(--text-secondary);
  flex: 1;
}

.detail-refresh {
  background: none;
  border: 1px solid var(--text-accent);
  color: var(--text-accent);
  cursor: pointer;
  padding: 1px 8px;
  border-radius: 3px;
  font-size: 10px;
  font-family: inherit;
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.detail-refresh:hover {
  background: var(--bg-selected);
}
.refresh-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-accent);
  animation: pulse-dot 1.5s ease-in-out infinite;
}
@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.detail-close {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
  display: flex;
  align-items: center;
}
.detail-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.detail-loading {
  padding: 20px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 12px;
}

.detail-viewer {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.detail-empty {
  padding: 20px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 12px;
}

/* ── Details ────────────────────────────────────────────────────── */

.details-panel {
  padding: 12px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.details-table {
  width: 100%;
  border-collapse: collapse;
}
.details-table td {
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
}
.details-label {
  color: var(--text-secondary);
  width: 100px;
  white-space: nowrap;
}
</style>
