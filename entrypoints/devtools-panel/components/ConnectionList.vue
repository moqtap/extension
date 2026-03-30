<script lang="ts" setup>
import type { SessionEntry } from '../use-inspector';

defineProps<{
  sessions: SessionEntry[];
  selectedId: string | null;
}>();

const emit = defineEmits<{
  select: [id: string];
}>();

function formatUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + (u.port ? ':' + u.port : '') + u.pathname;
  } catch {
    return url;
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function protocolBadge(session: SessionEntry): { label: string; class: string } {
  switch (session.protocol) {
    case 'moqt':
      return { label: session.draft ? `MoQT d${session.draft}` : 'MoQT', class: 'badge-moqt' };
    case 'moqt-unknown-draft':
      return { label: 'MoQT ?', class: 'badge-moqt' };
    case 'detecting':
      return { label: '...', class: 'badge-unknown' };
    default:
      return { label: 'WT', class: 'badge-unknown' };
  }
}

function totalBytes(session: SessionEntry): number {
  let total = 0;
  for (const stream of session.streams.values()) total += stream.byteCount;
  return total;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Bitrate display with natural decay.
 *
 * Computes the "active" bitrate over the period firstDataAt → lastDataAt,
 * then applies a linear decay factor based on how long ago the last data
 * arrived. After DECAY_WINDOW_MS of silence the displayed rate reaches 0.
 */
const DECAY_WINDOW_MS = 5_000; // 5 seconds of silence → 0 bps

function formatBitrate(session: SessionEntry): string | null {
  if (session.closed || session.imported) return null;
  let totalBytes = 0;
  let earliest = Infinity;
  let latest = 0;
  for (const stream of session.streams.values()) {
    totalBytes += stream.byteCount;
    if (stream.firstDataAt && stream.firstDataAt < earliest) earliest = stream.firstDataAt;
    if (stream.lastDataAt && stream.lastDataAt > latest) latest = stream.lastDataAt;
  }
  if (totalBytes === 0 || !isFinite(earliest) || latest === 0) return null;

  // Active-period bitrate: bytes over the span in which data actually flowed
  const activeSec = Math.max((latest - earliest) / 1000, 1);
  const activeBps = (totalBytes * 8) / activeSec;

  // Linear decay: 1.0 while data is flowing → 0.0 after DECAY_WINDOW_MS of silence
  const silenceMs = Date.now() - latest;
  const decay = Math.max(0, 1 - silenceMs / DECAY_WINDOW_MS);
  if (decay === 0) return null;

  const bitsPerSec = activeBps * decay;
  if (bitsPerSec >= 1_000_000) return `${(bitsPerSec / 1_000_000).toFixed(1)} Mbps`;
  if (bitsPerSec >= 1_000) return `${(bitsPerSec / 1_000).toFixed(0)} kbps`;
  if (bitsPerSec >= 1) return `${Math.round(bitsPerSec)} bps`;
  return null;
}
</script>

<template>
  <div class="connection-list">
    <div v-if="sessions.length === 0" class="empty-list">
      No connections
    </div>
    <div
      v-for="session in sessions"
      :key="session.sessionId"
      class="connection-item"
      :class="{ selected: session.sessionId === selectedId }"
      @click="emit('select', session.sessionId)"
    >
      <div class="connection-header">
        <span class="badge" :class="protocolBadge(session).class">
          {{ protocolBadge(session).label }}
        </span>
        <span v-if="session.imported" class="badge badge-imported">
          imported
        </span>
        <span
          v-else
          class="badge"
          :class="session.closed ? 'badge-closed' : 'badge-open'"
        >
          {{ session.closed ? 'closed' : 'open' }}
        </span>
        <span v-if="formatBitrate(session)" class="data-stat bitrate">{{ formatBitrate(session) }}</span>
        <span v-else-if="(session.closed || session.imported) && totalBytes(session) > 0" class="data-stat total-data">{{ formatBytes(totalBytes(session)) }}</span>
      </div>
      <div class="connection-url mono" :title="session.url">
        {{ formatUrl(session.url) }}
      </div>
      <div class="connection-meta">
        <span>{{ formatTime(session.createdAt) }}</span>
        <span>{{ session.streams.size }} streams</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.connection-list {
  flex: 1;
  overflow-y: auto;
}

.empty-list {
  padding: 20px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 12px;
}

.connection-item {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.1s;
}
.connection-item:hover {
  background: var(--bg-hover);
}
.connection-item.selected {
  background: var(--bg-selected);
}

.connection-header {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 4px;
}

.connection-url {
  color: var(--text-url);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 2px;
}

.connection-meta {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--text-secondary);
}

.data-stat {
  margin-left: auto;
  font-size: 10px;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace;
}

.bitrate {
  color: var(--text-success);
}

.total-data {
  color: var(--text-secondary);
}


</style>
