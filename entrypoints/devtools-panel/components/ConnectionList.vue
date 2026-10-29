<script lang="ts" setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import {
  formatBitrate,
  formatBytes,
  formatClock,
  isoTitle,
  plural,
  shortSessionId,
} from '../format'
import { computeRecentBitrate, type SessionEntry } from '../use-inspector'

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
  /** The narrow sidebar: a status glyph and the short ID per connection. */
  compact?: boolean
  /** The tab has an impairment profile. */
  impaired?: boolean
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

function protocolBadge(session: SessionEntry): {
  label: string
  class: string
  title: string
} {
  switch (session.protocol) {
    case 'moqt':
      return session.draft
        ? {
            label: `draft-${session.draft}`,
            class: 'mq-badge--draft',
            title: `MoQT draft-${session.draft}`,
          }
        : { label: 'MoQT', class: 'mq-badge--mono', title: 'MoQT' }
    case 'moqt-unknown-draft':
      return {
        label: 'MoQT ?',
        class: 'mq-badge--mono',
        title: 'MoQT, draft not identified',
      }
    case 'detecting':
      return {
        label: 'detecting',
        class: '',
        title: 'Reading the first bytes to identify the protocol',
      }
    default:
      return { label: 'WT', class: 'mq-badge--mono', title: 'WebTransport, not MoQT' }
  }
}

/**
 * The `@moqtap/collector` badge, or null when there is nothing to say.
 *
 * `none` renders nothing: most pages have no SDK, and a badge on every row
 * saying so would be noise. The two problem states are the point of this --
 * "the SDK is here but sending nothing" and "the SDK attached after this
 * connection opened" are both invisible everywhere else.
 */
function collectorBadge(session: SessionEntry): {
  label: string
  class: string
  title: string
} | null {
  const c = session.collector
  if (!c || c.state === 'none') return null
  switch (c.state) {
    case 'collected':
      return {
        label: '✓ collected',
        class: 'mq-badge--ok',
        title: `@moqtap/collector ${c.version} is instrumenting this connection`,
      }
    case 'dormant':
      return {
        label: '▲ SDK idle',
        class: 'mq-badge--check',
        title:
          `@moqtap/collector ${c.version} is on the page but not transmitting. ` +
          'init() has no key, so nothing is collected.',
      }
    case 'predates':
      return {
        label: '▲ SDK late',
        class: 'mq-badge--check',
        title:
          `This connection opened before @moqtap/collector ${c.version} attached, ` +
          'so the SDK never saw it. Call init() before opening the transport.',
      }
  }
}

/** An open connection that bypasses the CLI while the tab has a profile. */
function notImpaired(session: SessionEntry): boolean {
  return props.impaired === true && !session.closed && !session.imported && !session.cli
}

function statusOf(session: SessionEntry): {
  word: string
  glyph: string
  class: string
} {
  if (session.imported) return { word: 'imported', glyph: '◆', class: 'st-imported' }
  if (session.closed) return { word: 'closed', glyph: '○', class: 'st-closed' }
  return { word: 'open', glyph: '●', class: 'st-open' }
}

interface SessionStats {
  totalBytes: number
  bitrate: string | null
  /** The same rate in four characters or so, for the 56px sidebar. */
  shortRate: string | null
  urlHost: string
  urlPath: string
}

/** Pre-compute per-session stats once per tick, avoiding double iteration in template */
const sessionStats = computed(() => {
  void bitrateTick.value // reactive dependency — forces re-eval during decay
  const map = new Map<string, SessionStats>()
  const now = Date.now()
  for (const session of props.sessions) {
    let bytes = 0
    for (const stream of session.streams.values()) bytes += stream.byteCount

    let bitrate: string | null = null
    let shortRate: string | null = null
    if (!session.closed && !session.imported) {
      const bps = computeRecentBitrate(session, now)
      if (bps != null && bps >= 1) {
        bitrate = formatBitrate(bps)
        shortRate =
          bps >= 1_000_000
            ? `${(bps / 1_000_000).toFixed(1)}M`
            : bps >= 1_000
              ? `${(bps / 1_000).toFixed(0)}k`
              : `${Math.round(bps)}`
      }
    }

    const { host: urlHost, path: urlPath } = formatUrl(session.url)
    map.set(session.sessionId, {
      totalBytes: bytes,
      bitrate,
      shortRate,
      urlHost,
      urlPath,
    })
  }
  return map
})

function compactLabel(session: SessionEntry): string {
  const s = sessionStats.value.get(session.sessionId)
  const rate = s?.bitrate ? ` · ${s.bitrate}` : ''
  return `${s?.urlHost ?? session.url} ${shortSessionId(session.sessionId)} · ${protocolBadge(session).title} · ${statusOf(session).word}${rate}`
}
</script>

<template>
  <div class="connection-list" :class="{ compact }">
    <p v-if="sessions.length === 0 && !compact" class="empty-list">
      No connections yet.
    </p>
    <ul v-else-if="sessions.length > 0" class="connection-items">
      <li v-for="session in sessions" :key="session.sessionId">
        <button
          v-if="compact"
          class="connection-item compact-item"
          :aria-current="session.sessionId === selectedId ? 'true' : undefined"
          :aria-label="compactLabel(session)"
          :title="compactLabel(session)"
          @click="emit('select', session.sessionId)"
        >
          <span class="status-glyph" :class="statusOf(session).class" aria-hidden="true">{{
            statusOf(session).glyph
          }}</span>
          <span class="compact-id">{{ shortSessionId(session.sessionId) }}</span>
          <span
            v-if="sessionStats.get(session.sessionId)?.shortRate"
            class="compact-rate"
            >{{ sessionStats.get(session.sessionId)!.shortRate }}</span
          >
        </button>
        <button
          v-else
          class="connection-item"
          :aria-current="session.sessionId === selectedId ? 'true' : undefined"
          @click="emit('select', session.sessionId)"
        >
          <span class="connection-header">
            <span
              class="mq-badge"
              :class="protocolBadge(session).class"
              :title="protocolBadge(session).title"
            >
              {{ protocolBadge(session).label }}
            </span>
            <span class="mq-badge" :class="statusOf(session).class">
              <span aria-hidden="true">{{ statusOf(session).glyph }}</span>
              {{ statusOf(session).word }}
            </span>
            <span v-if="session.frameId" class="mq-badge">iframe</span>
            <span
              v-if="notImpaired(session)"
              class="mq-badge mq-badge--check"
              title="Opened before the profile was set. Reload the page to impair it."
            >
              not impaired
            </span>
            <span
              v-if="collectorBadge(session)"
              class="mq-badge"
              :class="collectorBadge(session)!.class"
              :title="collectorBadge(session)!.title"
            >
              {{ collectorBadge(session)!.label }}
            </span>
            <span
              v-if="sessionStats.get(session.sessionId)?.bitrate"
              class="data-stat"
              >{{ sessionStats.get(session.sessionId)!.bitrate }}</span
            >
            <span
              v-else-if="
                (session.closed || session.imported) &&
                sessionStats.get(session.sessionId)!.totalBytes > 0
              "
              class="data-stat"
              >{{
                formatBytes(sessionStats.get(session.sessionId)!.totalBytes)
              }}</span
            >
          </span>
          <span class="connection-url">
            <span class="url-text" :title="session.url">
              <span class="url-host">{{
                sessionStats.get(session.sessionId)!.urlHost
              }}</span
              ><span
                v-if="sessionStats.get(session.sessionId)!.urlPath"
                class="url-path"
                >{{ sessionStats.get(session.sessionId)!.urlPath }}</span
              >
            </span>
            <span class="url-id" :title="session.sessionId">{{ shortSessionId(session.sessionId) }}</span>
          </span>
          <span class="connection-meta">
            <span :title="isoTitle(session.createdAt)">{{
              formatClock(session.createdAt)
            }}</span>
            <span>{{ plural(session.streams.size, 'stream') }}</span>
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.connection-list {
  flex: 1;
  overflow-y: auto;
}

.empty-list {
  padding: var(--space-4) var(--space-2);
  text-align: center;
  color: var(--ink-muted);
}

.connection-items {
  list-style: none;
  padding: 0;
}

.connection-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  width: 100%;
  padding: var(--space-2);
  border: 0;
  border-bottom: 1px solid var(--line);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background-color 120ms;
}
.connection-item:hover {
  background: var(--surface-hover);
}
.connection-item[aria-current='true'] {
  background: var(--tap-soft);
}

.connection-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
}

.st-open {
  color: var(--success);
}
.st-closed,
.st-imported {
  color: var(--ink-muted);
}
.mq-badge.st-open {
  background: var(--success-soft);
  border-color: transparent;
}

.connection-url {
  display: flex;
  gap: var(--space-2);
  min-width: 0;
  font-family: var(--font-mono);
  color: var(--ink);
}

.url-text {
  display: flex;
  flex: 1;
  min-width: 0;
}

/* An address in a one-line slot keeps its host and port: the path is cut
   from its end first, and the host only once no path is left. The full URL
   is the tooltip. */
.url-host {
  /* Shrinks at 1/10000 of the path's rate rather than not at all: a zero
     shrink would push the short ID out of a narrow sidebar instead. */
  flex: 0 0.0001 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.url-path {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-muted);
}

.url-id {
  flex-shrink: 0;
  color: var(--ink-muted);
}

.connection-meta {
  display: flex;
  justify-content: space-between;
  color: var(--ink-muted);
  font-variant-numeric: tabular-nums;
}

.data-stat {
  margin-left: auto;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--ink-muted);
}

/* ── Compact: glyph and short ID ─────────────────────────────── */

.compact-item {
  align-items: center;
  gap: 2px;
  padding: var(--space-2) var(--space-1);
  font-family: var(--type-data-xs-family);
  font-size: var(--type-data-xs-size);
  line-height: var(--type-data-xs-line);
  text-align: center;
}
.status-glyph {
  line-height: 1;
}
.compact-id {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
}
.compact-rate {
  color: var(--ink-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
