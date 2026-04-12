<script lang="ts" setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import type { SessionEntry } from '../use-inspector'

/* Reactive tick that drives the bitrate decay animation.
   Gated behind rAF so it pauses when the panel is backgrounded. */
const bitrateTick = ref(0)
const bitrateTickInterval = setInterval(() => {
  requestAnimationFrame(() => {
    bitrateTick.value++
  })
}, 500)
onBeforeUnmount(() => clearInterval(bitrateTickInterval))

const props = defineProps<{
  sessions: SessionEntry[]
  selectedId: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
}>()

function formatUrl(url: string): { host: string; path: string } {
  try {
    const u = new URL(url)
    const host = u.hostname + (u.port ? ':' + u.port : '')
    const path = u.pathname && u.pathname !== '/' ? u.pathname : ''
    return { host, path }
  } catch {
    return { host: url, path: '' }
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function protocolBadge(session: SessionEntry): {
  label: string
  class: string
} {
  switch (session.protocol) {
    case 'moqt':
      return {
        label: session.draft ? `MoQT d${session.draft}` : 'MoQT',
        class: 'badge-moqt',
      }
    case 'moqt-unknown-draft':
      return { label: 'MoQT ?', class: 'badge-moqt' }
    case 'detecting':
      return { label: '...', class: 'badge-unknown' }
    default:
      return { label: 'WT', class: 'badge-unknown' }
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const DECAY_WINDOW_MS = 5_000

interface SessionStats {
  totalBytes: number
  bitrate: string | null
  urlHost: string
  urlPath: string
}

/** Pre-compute per-session stats once per tick, avoiding double iteration in template */
const sessionStats = computed(() => {
  void bitrateTick.value // reactive dependency — forces re-eval during decay
  const map = new Map<string, SessionStats>()
  for (const session of props.sessions) {
    let bytes = 0
    let earliest = Infinity
    let latest = 0
    for (const stream of session.streams.values()) {
      bytes += stream.byteCount
      if (stream.firstDataAt && stream.firstDataAt < earliest)
        earliest = stream.firstDataAt
      if (stream.lastDataAt && stream.lastDataAt > latest)
        latest = stream.lastDataAt
    }

    let bitrate: string | null = null
    if (
      !session.closed &&
      !session.imported &&
      bytes > 0 &&
      isFinite(earliest) &&
      latest > 0
    ) {
      const activeSec = Math.max((latest - earliest) / 1000, 1)
      const activeBps = (bytes * 8) / activeSec
      const decay = Math.max(0, 1 - (Date.now() - latest) / DECAY_WINDOW_MS)
      if (decay > 0) {
        const bps = activeBps * decay
        if (bps >= 1_000_000) bitrate = `${(bps / 1_000_000).toFixed(1)} Mbps`
        else if (bps >= 1_000) bitrate = `${(bps / 1_000).toFixed(0)} kbps`
        else if (bps >= 1) bitrate = `${Math.round(bps)} bps`
      }
    }

    const { host: urlHost, path: urlPath } = formatUrl(session.url)
    map.set(session.sessionId, {
      totalBytes: bytes,
      bitrate,
      urlHost,
      urlPath,
    })
  }
  return map
})
</script>

<template>
  <div class="connection-list">
    <div v-if="sessions.length === 0" class="empty-list">No connections</div>
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
        <span v-if="session.frameId" class="badge badge-iframe"> iframe </span>
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
        <span
          v-if="sessionStats.get(session.sessionId)?.bitrate"
          class="data-stat bitrate"
          >{{ sessionStats.get(session.sessionId)!.bitrate }}</span
        >
        <span
          v-else-if="
            (session.closed || session.imported) &&
            sessionStats.get(session.sessionId)!.totalBytes > 0
          "
          class="data-stat total-data"
          >{{
            formatBytes(sessionStats.get(session.sessionId)!.totalBytes)
          }}</span
        >
      </div>
      <div class="connection-url mono" :title="session.url">
        <span class="url-host">{{
          sessionStats.get(session.sessionId)!.urlHost
        }}</span
        ><span
          v-if="sessionStats.get(session.sessionId)!.urlPath"
          class="url-path"
          >{{ sessionStats.get(session.sessionId)!.urlPath }}</span
        >
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
  display: flex;
  min-width: 0;
  margin-bottom: 2px;
}

.url-host {
  flex: 1 1000 auto;
  min-width: 2ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.url-path {
  /* flex-shrink is 1/10000 of the host's, so the host ellipsizes essentially
     to completion before the path begins to shrink. A very small but non-zero
     value avoids a Chromium quirk where shrink:1 + overflow:hidden + ellipsis
     triggers a phantom ellipsis even when the content fits. */
  flex: 0 0.1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  font-family:
    'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New',
    monospace;
}

.bitrate {
  color: var(--text-success);
}

.total-data {
  color: var(--text-secondary);
}
</style>
