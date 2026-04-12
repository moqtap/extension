<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import ConnectionList from './components/ConnectionList.vue'
import SessionView from './components/SessionView.vue'
import { getCachedPref, savePref } from './prefs'
import type { SessionEntry } from './use-inspector'
import { useInspector } from './use-inspector'

const {
  sessions,
  selectedSessionId,
  midSessionOpen,
  cspBlockedWorkers,
  workerExclusions,
  selectSession,
  clearSessions,
  getStreamData,
  getDatagramGroupData,
  exportTrace,
  importTrace,
  setStreamRecording,
  clearStreams,
  addWorkerExclusion,
  removeWorkerExclusion,
} = useInspector()

const showExclusions = ref(false)
const newExclusionOrigin = ref('')

function handleAddExclusion() {
  const origin = newExclusionOrigin.value.trim()
  if (!origin) return
  // Normalise: ensure it looks like an origin (https://host)
  try {
    const url = new URL(origin.includes('://') ? origin : `https://${origin}`)
    addWorkerExclusion(url.origin)
    newExclusionOrigin.value = ''
  } catch {
    // Invalid URL — ignore
  }
}

const exclusionCount = computed(
  () => Object.keys(workerExclusions.value).length,
)

/* Reactive tick that drives the bitrate decay animation.
   Gated behind rAF so it pauses when the panel is backgrounded,
   avoiding a burst of reactive recalculations on refocus. */
const bitrateTick = ref(0)
const bitrateTickInterval = setInterval(() => {
  requestAnimationFrame(() => {
    bitrateTick.value++
  })
}, 500)
onBeforeUnmount(() => clearInterval(bitrateTickInterval))

const NARROW_THRESHOLD = 500
const sidebarCollapsed = ref(getCachedPref('sidebarCollapsed'))
const sidebarManual = ref(getCachedPref('sidebarManual'))

// Auto-collapse sidebar on narrow panels unless user manually overrode
onMounted(() => {
  if (!sidebarManual.value && window.innerWidth <= NARROW_THRESHOLD) {
    sidebarCollapsed.value = true
  }
})

let resizeObserver: ResizeObserver | null = null
const inspectorEl = ref<HTMLElement | null>(null)

onMounted(() => {
  const el = inspectorEl.value
  if (!el) return
  resizeObserver = new ResizeObserver((entries) => {
    if (sidebarManual.value) return
    const width = entries[0]?.contentRect.width ?? 0
    if (width > 0) {
      sidebarCollapsed.value = width <= NARROW_THRESHOLD
    }
  })
  resizeObserver.observe(el)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
})

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
  sidebarManual.value = true
  savePref('sidebarCollapsed', sidebarCollapsed.value)
  savePref('sidebarManual', true)
}

function handleImportClick() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.moqtrace'
  input.onchange = () => {
    const file = input.files?.[0]
    if (file) importTrace(file)
  }
  input.click()
}

const sessionList = computed(() => Array.from(sessions.value.values()))

function reloadPage() {
  chrome.devtools.inspectedWindow.reload({})
}
const selectedSession = computed(() =>
  selectedSessionId.value
    ? (sessions.value.get(selectedSessionId.value) ?? null)
    : null,
)

function compactHost(url: string): string {
  try {
    const h = new URL(url).hostname
    const parts = h.split('.')
    const label = parts.length > 2 ? parts[0] : h
    return label.length > 8 ? label.slice(0, 7) : label
  } catch {
    return '?'
  }
}

const COMPACT_DECAY_MS = 5_000

function compactBitrate(s: SessionEntry): string | null {
  void bitrateTick.value // reactive dependency — forces re-eval during decay
  if (s.closed || s.imported) return null
  let total = 0
  let earliest = Infinity
  let latest = 0
  for (const stream of s.streams.values()) {
    total += stream.byteCount
    if (stream.firstDataAt && stream.firstDataAt < earliest)
      earliest = stream.firstDataAt
    if (stream.lastDataAt && stream.lastDataAt > latest)
      latest = stream.lastDataAt
  }
  if (total === 0 || !isFinite(earliest) || latest === 0) return null
  const activeSec = Math.max((latest - earliest) / 1000, 1)
  const activeBps = (total * 8) / activeSec
  const decay = Math.max(0, 1 - (Date.now() - latest) / COMPACT_DECAY_MS)
  if (decay === 0) return null
  const bps = activeBps * decay
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)}M`
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(0)}k`
  if (bps >= 1) return `${Math.round(bps)}`
  return null
}

function compactTooltip(s: SessionEntry): string {
  const proto =
    s.protocol === 'moqt'
      ? `MoQT d${s.draft}`
      : s.protocol === 'detecting'
        ? 'Detecting...'
        : 'WT'
  const status = s.imported ? 'imported' : s.closed ? 'closed' : 'open'
  let url: string
  try {
    url = new URL(s.url).hostname
  } catch {
    url = s.url
  }
  return `${proto} · ${status}\n${url}`
}

function statusColor(s: SessionEntry): string {
  if (s.imported) return 'var(--text-accent, #6ba3d6)'
  if (s.closed) return 'var(--text-error, #f44747)'
  return 'var(--text-success, #89d185)'
}
</script>

<template>
  <div ref="inspectorEl" class="inspector">
    <div class="sidebar" :class="{ collapsed: sidebarCollapsed }">
      <div class="sidebar-header">
        <button
          class="toolbar-btn collapse-btn"
          :title="sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
          @click="toggleSidebar"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="currentColor"
            :class="{ 'chevron-collapsed': sidebarCollapsed }"
          >
            <rect
              x="1"
              y="2"
              width="14"
              height="12"
              rx="1"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
            />
            <line
              x1="6"
              y1="2"
              x2="6"
              y2="14"
              stroke="currentColor"
              stroke-width="1.2"
            />
            <path
              d="M10.5 6.5L8.5 8l2 1.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <template v-if="!sidebarCollapsed">
          <span class="sidebar-title">Connections</span>
          <div class="sidebar-actions">
            <button
              class="toolbar-btn"
              title="Import .moqtrace"
              @click="handleImportClick"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="currentColor"
              >
                <path
                  d="M3 1h6l4 4v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zm6 1H3v12h9V5.5L9 2zM8 7l3 3h-2v3H7v-3H5l3-3z"
                />
              </svg>
            </button>
            <button
              v-if="sessionList.length > 0"
              class="toolbar-btn"
              title="Clear"
              @click="clearSessions"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
              >
                <circle cx="8" cy="8" r="6.5" />
                <line x1="3.5" y1="12.5" x2="12.5" y2="3.5" />
              </svg>
            </button>
          </div>
        </template>
      </div>
      <!-- Expanded: full connection list -->
      <template v-if="!sidebarCollapsed">
        <ConnectionList
          :sessions="sessionList"
          :selected-id="selectedSessionId"
          @select="selectSession"
        />
        <a
          href="https://moqtap.com"
          target="_blank"
          rel="noopener"
          class="sidebar-footer"
        >
          <img src="/icon/32.png" alt="" class="footer-icon" />
          <span>moqtap.com — more tools</span>
        </a>
      </template>
      <!-- Collapsed: compact session indicators -->
      <template v-else>
        <div class="compact-list">
          <div
            v-for="s in sessionList"
            :key="s.sessionId"
            class="compact-item"
            :class="{ selected: s.sessionId === selectedSessionId }"
            :title="compactTooltip(s)"
            @click="selectSession(s.sessionId)"
          >
            <span
              class="compact-dot"
              :style="{ background: statusColor(s) }"
            ></span>
            <span class="compact-label">{{ compactHost(s.url) }}</span>
            <span v-if="compactBitrate(s)" class="compact-bitrate">{{
              compactBitrate(s)
            }}</span>
          </div>
        </div>
        <a
          href="https://moqtap.com"
          target="_blank"
          rel="noopener"
          class="sidebar-footer compact-footer"
          title="moqtap.com"
        >
          <img src="/icon/32.png" alt="" class="footer-icon" />
        </a>
      </template>
    </div>
    <div class="main">
      <div v-if="midSessionOpen" class="mid-session-banner">
        <span class="banner-icon">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path
              d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm-.5 3h1v5h-1V4zm0 6h1v1h-1v-1z"
            />
          </svg>
        </span>
        <span>
          Monitoring active — new connections will appear automatically. To
          capture connections established before DevTools opened,
          <a href="#" @click.prevent="reloadPage">reload the page</a>.
        </span>
      </div>
      <div v-if="cspBlockedWorkers.length > 0" class="csp-warning-banner">
        <span class="banner-icon">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path
              d="M8.9 1.5l6.6 12A1 1 0 0 1 14.6 15H1.4a1 1 0 0 1-.9-1.5l6.6-12a1 1 0 0 1 1.8 0zM7.5 10h1V6h-1v4zm0 2h1v-1h-1v1z"
            />
          </svg>
        </span>
        <span>
          Worker instrumentation recovered for this site's security policy.
          <a
            v-if="exclusionCount > 0"
            href="#"
            @click.prevent="showExclusions = !showExclusions"
          >
            {{ exclusionCount }} excluded origin{{
              exclusionCount !== 1 ? 's' : ''
            }}
          </a>
        </span>
      </div>
      <div
        v-if="exclusionCount > 0 && !cspBlockedWorkers.length"
        class="exclusion-toggle"
      >
        <a href="#" @click.prevent="showExclusions = !showExclusions">
          {{ exclusionCount }} worker exclusion{{
            exclusionCount !== 1 ? 's' : ''
          }}
        </a>
      </div>
      <div v-if="showExclusions" class="exclusion-panel">
        <div class="exclusion-header">Worker Origin Exclusions</div>
        <div class="exclusion-list">
          <div
            v-for="(entry, origin) in workerExclusions"
            :key="origin"
            class="exclusion-entry"
          >
            <span class="exclusion-origin">{{ origin }}</span>
            <span :class="['exclusion-badge', entry.source]">{{
              entry.source
            }}</span>
            <button
              class="exclusion-remove"
              @click="removeWorkerExclusion(String(origin))"
              title="Remove exclusion"
            >
              x
            </button>
          </div>
          <div v-if="exclusionCount === 0" class="exclusion-empty">
            No excluded origins.
          </div>
        </div>
        <div class="exclusion-add">
          <input
            v-model="newExclusionOrigin"
            placeholder="https://example.com"
            class="exclusion-input"
            @keydown.enter="handleAddExclusion"
          />
          <button class="exclusion-add-btn" @click="handleAddExclusion">
            Add
          </button>
        </div>
      </div>
      <SessionView
        v-if="selectedSession"
        :key="selectedSession.sessionId"
        :session="selectedSession"
        :get-stream-data="getStreamData"
        :get-datagram-group-data="getDatagramGroupData"
        :set-stream-recording="setStreamRecording"
        :clear-streams="clearStreams"
        @export-trace="exportTrace"
      />
      <div v-else class="empty-state">
        No WebTransport connections detected.
        <br />
        Open a page that uses WebTransport to begin.
      </div>
    </div>
  </div>
</template>

<style scoped>
.inspector {
  display: flex;
  height: 100%;
}

.sidebar {
  width: 260px;
  min-width: 200px;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  transition:
    width 0.15s ease,
    min-width 0.15s ease;
}
.sidebar.collapsed {
  width: 56px;
  min-width: 56px;
}

.sidebar-header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 4px 6px 6px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-tertiary);
}
.sidebar.collapsed .sidebar-header {
  padding: 6px 4px;
}

.sidebar-title {
  font-weight: 600;
  font-size: 11px;
  text-transform: uppercase;
  color: var(--text-secondary);
  letter-spacing: 0.5px;
  flex: 1;
}

.sidebar-actions {
  display: flex;
  gap: 2px;
}

.collapse-btn svg {
  transition: transform 0.15s ease;
}
.chevron-collapsed {
  transform: scaleX(-1);
}

.toolbar-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
  display: flex;
  align-items: center;
}
.toolbar-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.main {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.mid-session-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.4;
}
.mid-session-banner .banner-icon {
  color: var(--text-accent);
  flex-shrink: 0;
  display: flex;
}
.mid-session-banner a {
  color: var(--text-accent);
  text-decoration: underline;
  cursor: pointer;
}
.mid-session-banner a:hover {
  color: var(--text-primary);
}

.csp-warning-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--csp-warning-bg);
  border-bottom: 1px solid var(--border);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.4;
}
.csp-warning-banner .banner-icon {
  color: var(--text-warning, #ffb347);
  flex-shrink: 0;
  display: flex;
}
.csp-warning-banner a,
.exclusion-toggle a {
  color: var(--text-link, #6eb5ff);
  text-decoration: none;
}
.csp-warning-banner a:hover,
.exclusion-toggle a:hover {
  text-decoration: underline;
}
.exclusion-toggle {
  padding: 4px 12px;
  font-size: 11px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}
.exclusion-panel {
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
  font-size: 11px;
  padding: 8px 12px;
}
.exclusion-header {
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--text-primary);
}
.exclusion-list {
  max-height: 140px;
  overflow-y: auto;
}
.exclusion-entry {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}
.exclusion-origin {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}
.exclusion-badge {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
  text-transform: uppercase;
  font-weight: 600;
}
.exclusion-badge.auto {
  background: var(--text-warning, #ffb347);
  color: #000;
}
.exclusion-badge.manual {
  background: var(--text-link, #6eb5ff);
  color: #000;
}
.exclusion-remove {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 11px;
  padding: 0 4px;
  line-height: 1;
}
.exclusion-remove:hover {
  color: var(--text-error, #ff6b6b);
}
.exclusion-empty {
  color: var(--text-secondary);
  font-style: italic;
  padding: 4px 0;
}
.exclusion-add {
  display: flex;
  gap: 4px;
  margin-top: 6px;
}
.exclusion-input {
  flex: 1;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  color: var(--text-primary);
  padding: 2px 6px;
  font-size: 11px;
  border-radius: 3px;
}
.exclusion-add-btn {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  color: var(--text-primary);
  padding: 2px 8px;
  font-size: 11px;
  border-radius: 3px;
  cursor: pointer;
}
.exclusion-add-btn:hover {
  background: var(--border);
}

.sidebar-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 4px 10px;
  border-top: 1px solid var(--border);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 12px;
  text-decoration: none;
  flex-shrink: 0;
  transition: color 0.15s;
}
.sidebar-footer:hover {
  color: var(--text-accent);
}
.footer-icon {
  width: 14px;
  height: 14px;
  opacity: 0.7;
}
.sidebar-footer:hover .footer-icon {
  opacity: 1;
}

/* ── Compact (collapsed) sidebar ──────────────────────────────── */

.compact-list {
  flex: 1;
  overflow-y: auto;
}

.compact-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 6px 4px;
  min-height: 38px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
}
.compact-item:hover {
  background: var(--bg-hover);
}
.compact-item.selected {
  background: var(--bg-selected);
}

.compact-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.compact-label {
  font-size: 9px;
  color: var(--text-secondary);
  text-align: center;
  line-height: 1.1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.compact-bitrate {
  font-size: 9px;
  color: var(--text-success, #89d185);
  font-family:
    'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New',
    monospace;
  line-height: 1;
}

.compact-footer {
  padding: 4.4px;
  justify-content: center;
}
.compact-footer .footer-icon {
  width: 16px;
  height: 16px;
}

/* Make the expand/collapse button fill the full collapsed panel width */
.sidebar.collapsed .collapse-btn {
  width: 100%;
  justify-content: center;
}
</style>
