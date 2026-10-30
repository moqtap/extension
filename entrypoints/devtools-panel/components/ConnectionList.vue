<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { connectionTitle } from '../connection-name'
import { formatBitrate, formatBytes, shortSessionId } from '../format'
import { sidebarShowsRate } from '../layout'
import { sessionBytes } from '../sizes'
import type { TabImpairment } from '@/src/cli/messages'
import Icon from './Icon.vue'
import { impairsSession, profileShortLabel, sessionProfile } from '../impair-choices'
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
  /** The tab has an impairment profile. */
  impaired?: boolean
  /** The tab's impairment, for the profile of each session through the CLI. */
  tab?: TabImpairment | null
  /** Scenario short labels, by scenario name. */
  shortLabels?: ReadonlyMap<string, string>
  /** Down to the state and #id; the rest goes to the tooltip. */
  collapsed?: boolean
}>()

const listEl = ref<HTMLElement | null>(null)
const listWidth = ref(0)
const showRate = computed(() => !props.collapsed && sidebarShowsRate(listWidth.value))
let ro: ResizeObserver | null = null
onMounted(() => {
  const el = listEl.value
  if (!el) return
  listWidth.value = el.clientWidth
  ro = new ResizeObserver(() => (listWidth.value = el.clientWidth))
  ro.observe(el)
})
onBeforeUnmount(() => ro?.disconnect())

/** A row's tooltip; it carries the rate when the row has no room for it. */
function rowTitle(session: SessionEntry): string {
  const st = sessionStats.value.get(session.sessionId)!
  return showRate.value || st.rate === '' ? st.title : `${st.title}\n${st.rate}`
}

const NO_LABELS: ReadonlyMap<string, string> = new Map()
const shortLabel = (session: SessionEntry) =>
  profileShortLabel(cliProfile(session)?.profile ?? null, props.shortLabels ?? NO_LABELS)

const emit = defineEmits<{
  select: [id: string]
  /** Pick the profile of the session with this CLI id, in a menu at `anchor`. */
  impair: [cliSession: string, anchor: HTMLElement]
}>()

/** The profile of an open session through the CLI, or null when it has none to pick. */
function cliProfile(session: SessionEntry) {
  if (session.cliSession === undefined || session.closed || session.imported) return null
  return sessionProfile(props.tab ?? null, session.cliSession)
}

function impairLabel(session: SessionEntry): string {
  const p = cliProfile(session)
  if (p === null || p.name === null) return 'Impairment for this connection'
  return `Impairment for this connection: ${p.name}${p.own ? '' : ', same as tab'}`
}

/** The gauge is blue while a known profile impairs the connection. */
const impairActive = (session: SessionEntry) => impairsSession(cliProfile(session))

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
        label: 'Collected',
        class: 'mq-badge--ok',
        title: `@moqtap/collector ${c.version} is instrumenting this connection`,
      }
    case 'dormant':
      return {
        label: 'SDK idle',
        class: 'mq-badge--check',
        title:
          `@moqtap/collector ${c.version} is on the page but not transmitting. ` +
          'init() has no key, so nothing is collected.',
      }
    case 'predates':
      return {
        label: 'SDK late',
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

interface SessionStats {
  /** Bitrate while open, "0 bps" with no traffic; size once closed, empty when unknown */
  rate: string
  urlHost: string
  urlPath: string
  title: string
}

/** Pre-compute per-session stats once per tick, avoiding double iteration in template */
const sessionStats = computed(() => {
  void bitrateTick.value // reactive dependency — forces re-eval during decay
  const map = new Map<string, SessionStats>()
  const now = Date.now()
  for (const session of props.sessions) {
    const live = !session.closed && !session.imported
    const bytes = live ? null : sessionBytes(session)
    const rate = live
      ? formatBitrate(computeRecentBitrate(session, now) ?? 0)
      : bytes === null
        ? ''
        : formatBytes(bytes)

    const { host: urlHost, path: urlPath } = formatUrl(session.url)
    map.set(session.sessionId, {
      rate,
      urlHost,
      urlPath,
      title: connectionTitle({
        url: session.url,
        protocol: session.protocol,
        draft: session.draft,
        closed: session.closed,
        imported: session.imported,
        frameId: session.frameId,
        createdAt: session.createdAt,
        streams: session.streams.size,
      }),
    })
  }
  return map
})

</script>

<template>
  <ul ref="listEl" class="connection-list" :class="{ 'is-collapsed': collapsed }" aria-label="Connections">
    <li
      v-for="(session, i) in sessions"
      :key="session.sessionId"
      class="connection-row"
      :class="{ 'row-selected': session.sessionId === selectedId, 'row-alt': i % 2 === 1 }"
    >
      <button
        class="connection-item"
        :aria-current="session.sessionId === selectedId ? 'true' : undefined"
        :title="rowTitle(session)"
        @click="emit('select', session.sessionId)"
      >
        <span
          class="state-dot"
          :class="{ 'is-open': !session.closed && !session.imported }"
          aria-hidden="true"
        />
        <span v-if="!collapsed" class="url-text">
          <span class="url-host">{{ sessionStats.get(session.sessionId)!.urlHost }}</span
          ><span v-if="sessionStats.get(session.sessionId)!.urlPath" class="url-path">{{
            sessionStats.get(session.sessionId)!.urlPath
          }}</span>
        </span>
        <span class="url-id">{{ shortSessionId(session.sessionId) }}</span>
        <span
          v-if="notImpaired(session)"
          class="row-warning-icon"
          title="Opened before the profile was set. Reload the page to impair it."
          ><Icon name="warning" /><span class="mq-sr">Not impaired</span></span
        >
        <span
          v-if="collectorBadge(session) && collectorBadge(session)!.class === 'mq-badge--check'"
          class="row-warning-icon"
          :title="collectorBadge(session)!.title"
          ><Icon name="warning" /><span class="mq-sr">{{ collectorBadge(session)!.label }}</span></span
        >
      </button>
      <button
        v-if="!collapsed && cliProfile(session)"
        class="impair-btn"
        :class="{ 'is-active': impairActive(session) }"
        aria-haspopup="menu"
        :aria-label="impairLabel(session)"
        :title="impairLabel(session)"
        @click="emit('impair', session.cliSession!, $event.currentTarget as HTMLElement)"
      >
        <Icon name="gauge" />
        <span v-if="shortLabel(session)" class="impair-short">{{ shortLabel(session) }}</span>
      </button>
      <span v-if="showRate" class="data-stat">{{ sessionStats.get(session.sessionId)!.rate }}</span>
    </li>
  </ul>
</template>

<style scoped>
.connection-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  list-style: none;
  padding: 0;
  margin: 0;
}

/* One fixed-height line per connection, with or without traffic. */
.connection-row {
  display: flex;
  align-items: center;
  height: var(--row-side, var(--row-tool));
  padding-right: var(--space-2);
  gap: var(--space-1);
}
.connection-row.row-alt:not(.row-selected) {
  background: var(--host-zebra, transparent);
}
.connection-row:hover:not(.row-selected) {
  background: var(--surface-hover);
}

.connection-item {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex: 1 1 0;
  min-width: 0;
  height: 100%;
  padding: 0 0 0 var(--space-2);
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: default;
}

.state-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  border: 1px solid var(--ink-muted);
}
.state-dot.is-open {
  background: var(--tap);
  border-color: var(--tap);
}
html.host--firefox .row-selected .state-dot.is-open {
  background: currentColor;
  border-color: currentColor;
}

.url-text {
  display: flex;
  flex: 1;
  min-width: 0;
}

/* An address in a one-line slot keeps its host and port: the path is cut
   from its end first, and the host only once no path is left. */
.url-host {
  flex: 0 0.0001 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.url-host:last-child {
  flex-shrink: 1;
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
  overflow: hidden;
  font-family: var(--font-mono);
  color: var(--ink-muted);
}
.row-selected :is(.url-path, .url-id, .data-stat) {
  color: inherit;
}

.row-warning-icon {
  display: inline-flex;
  flex: none;
  color: var(--warning);
}
.row-warning-icon :deep(svg),
.impair-btn :deep(svg) {
  width: 12px;
  height: 12px;
}

.impair-btn {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
  height: calc(var(--row-side, var(--row-tool)) - 6px);
  padding: 0 3px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--ink-muted);
  font: inherit;
  cursor: pointer;
}
.impair-btn:hover {
  background: var(--surface-hover);
}
.impair-btn.is-active {
  color: var(--tap);
}
html.host--firefox .row-selected .impair-btn.is-active {
  color: inherit;
}

.data-stat {
  flex: none;
  min-width: 52px;
  text-align: right;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--ink-muted);
}
</style>
