<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import AccountChip from './components/AccountChip.vue'
import CliLink from './components/CliLink.vue'
import ConnectionList from './components/ConnectionList.vue'
import SessionView from './components/SessionView.vue'
import ShareDialog from './components/ShareDialog.vue'
import { getCachedPref, savePref } from './prefs'
import { useAccount } from './use-account'
import { useCli } from './use-cli'
import { useInspector } from './use-inspector'
import Icon from './components/Icon.vue'
import logo from './moqtap-logo.svg?raw'

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
  buildSessionTrace,
  importTrace,
  setStreamRecording,
  clearStreams,
  addWorkerExclusion,
  removeWorkerExclusion,
} = useInspector()

const account = useAccount()
const cli = useCli()
const cliView = cli.view
const cliConfirm = computed(() =>
  cliView.value?.state === 'confirm' ? cliView.value : null,
)
const accountView = account.view
/** The session the share dialog is open for. */
const sharingSessionId = ref<string | null>(null)
const sharingSession = computed(() =>
  sharingSessionId.value
    ? (sessions.value.get(sharingSessionId.value) ?? null)
    : null,
)

const showExclusions = ref(false)
const newExclusionOrigin = ref('')
const exclusionError = ref<string | null>(null)

function handleAddExclusion() {
  const origin = newExclusionOrigin.value.trim()
  if (!origin) return
  // Normalise: ensure it looks like an origin (https://host)
  try {
    const url = new URL(origin.includes('://') ? origin : `https://${origin}`)
    addWorkerExclusion(url.origin)
    newExclusionOrigin.value = ''
    exclusionError.value = null
  } catch {
    exclusionError.value = 'That is not an origin. Enter one like https://example.com.'
  }
}

const exclusionCount = computed(
  () => Object.keys(workerExclusions.value).length,
)

// Below this width the connections sidebar drops to its compact form.
const NARROW_THRESHOLD = 560
const sidebarCollapsed = ref(getCachedPref('sidebarCollapsed'))
const sidebarManual = ref(getCachedPref('sidebarManual'))

// Auto-collapse sidebar on narrow panels unless user manually overrode
onMounted(() => {
  if (!sidebarManual.value && window.innerWidth < NARROW_THRESHOLD) {
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
      sidebarCollapsed.value = width < NARROW_THRESHOLD
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
  browser.devtools.inspectedWindow.reload({})
}
const selectedSession = computed(() =>
  selectedSessionId.value
    ? (sessions.value.get(selectedSessionId.value) ?? null)
    : null,
)
</script>

<template>
  <div ref="inspectorEl" class="inspector">
    <aside
      class="sidebar"
      :class="{ collapsed: sidebarCollapsed }"
      aria-label="Connections"
    >
      <div class="tool-bar sidebar-header">
        <button
          class="mq-btn mq-btn--quiet mq-btn--icon collapse-btn"
          :aria-label="sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
          :title="sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
          :aria-expanded="!sidebarCollapsed"
          @click="toggleSidebar"
        >
          <Icon :name="sidebarCollapsed ? 'panelLeftOpen' : 'panelLeftClose'" />
        </button>
        <template v-if="!sidebarCollapsed">
          <h2 class="tool-bar__title sidebar-title">Connections</h2>
          <button
            class="mq-btn mq-btn--quiet mq-btn--icon"
            aria-label="Import .moqtrace"
            title="Import .moqtrace"
            @click="handleImportClick"
          >
            <Icon name="import" />
          </button>
          <button
            v-if="sessionList.length > 0"
            class="mq-btn mq-btn--quiet mq-btn--icon"
            aria-label="Clear connections"
            title="Clear connections"
            @click="clearSessions"
          >
            <Icon name="ban" />
          </button>
        </template>
      </div>
      <ConnectionList
        :sessions="sessionList"
        :selected-id="selectedSessionId"
        :compact="sidebarCollapsed"
        @select="selectSession"
      />
      <CliLink
        :view="cliView"
        :compact="sidebarCollapsed"
        @set-link="cli.setLink"
        @reconsider="cli.reconsider"
      />
      <AccountChip
        :view="accountView"
        :compact="sidebarCollapsed"
        @sign-in="account.signIn"
        @disconnect="account.disconnect"
      />
      <a
        v-if="!sidebarCollapsed"
        href="https://moqtap.com"
        target="_blank"
        rel="noopener"
        class="sidebar-footer"
      >
        <span class="mq-logo" v-html="logo" />
        <span class="sidebar-footer__more">More tools</span>
      </a>
    </aside>
    <main class="main">
      <div
        v-if="cliConfirm"
        class="mq-notice mq-notice--info main-notice cli-confirm"
        role="status"
      >
        <span class="mq-notice__icon" aria-hidden="true">i</span>
        <p>
          Let moqtap set this CLI's network link? Identity
          <span class="mq-mono cli-fp">{{ cliConfirm.fingerprint }}</span>, shown by
          <code>moqtap cert</code>.
        </p>
        <div class="mq-row">
          <button class="mq-btn mq-btn--primary" @click="cli.allow(cliConfirm.identity)">
            Allow
          </button>
          <button class="mq-btn mq-btn--secondary" @click="cli.decline(cliConfirm.identity)">
            Not now
          </button>
        </div>
      </div>
      <div v-if="midSessionOpen" class="mq-notice mq-notice--info main-notice" role="status">
        <span class="mq-notice__icon" aria-hidden="true">i</span>
        <p>
          New connections appear as they open. To capture ones made before
          DevTools opened,
          <a href="#" class="mq-link" @click.prevent="reloadPage">reload the page</a>.
        </p>
      </div>
      <div
        v-if="cspBlockedWorkers.length > 0"
        class="mq-notice mq-notice--warning main-notice"
        role="status"
      >
        <span class="mq-notice__icon" aria-hidden="true">▲</span>
        <p>
          This site's security policy blocks worker capture. Its workers run
          normally, but connections opened inside them aren't captured.
          <a
            v-if="exclusionCount > 0"
            href="#"
            class="mq-link"
            @click.prevent="showExclusions = !showExclusions"
          >
            {{ exclusionCount }} excluded origin{{
              exclusionCount !== 1 ? 's' : ''
            }}
          </a>
        </p>
      </div>
      <div
        v-if="exclusionCount > 0 && !cspBlockedWorkers.length"
        class="exclusion-toggle"
      >
        <a href="#" class="mq-link" @click.prevent="showExclusions = !showExclusions">
          {{ exclusionCount }} worker exclusion{{
            exclusionCount !== 1 ? 's' : ''
          }}
        </a>
      </div>
      <section v-if="showExclusions" class="exclusion-panel" aria-labelledby="exclusions-title">
        <h2 id="exclusions-title" class="exclusion-header">Worker origin exclusions</h2>
        <ul class="exclusion-list">
          <li
            v-for="(entry, origin) in workerExclusions"
            :key="origin"
            class="exclusion-entry"
          >
            <span class="exclusion-origin mq-mono">{{ origin }}</span>
            <span class="mq-badge">{{ entry.source }}</span>
            <button
              class="mq-btn mq-btn--quiet mq-btn--icon"
              :aria-label="`Remove ${origin}`"
              :title="`Remove ${origin}`"
              @click="removeWorkerExclusion(String(origin))"
            >
              <Icon name="x" />
            </button>
          </li>
          <li v-if="exclusionCount === 0" class="mq-muted">No excluded origins.</li>
        </ul>
        <form class="exclusion-add" @submit.prevent="handleAddExclusion">
          <label class="mq-sr" for="exclusion-origin">Origin to exclude</label>
          <input
            id="exclusion-origin"
            v-model="newExclusionOrigin"
            placeholder="https://example.com"
            class="mq-input mq-input--mono"
            :aria-invalid="exclusionError ? 'true' : undefined"
            aria-describedby="exclusion-error"
          />
          <button type="submit" class="mq-btn mq-btn--secondary">Add origin</button>
        </form>
        <p v-if="exclusionError" id="exclusion-error" class="mq-error-text">
          {{ exclusionError }}
        </p>
      </section>
      <h1 v-if="selectedSession" class="mq-sr">{{ selectedSession.url }}</h1>
      <SessionView
        v-if="selectedSession"
        :key="selectedSession.sessionId"
        :session="selectedSession"
        :get-stream-data="getStreamData"
        :get-datagram-group-data="getDatagramGroupData"
        :set-stream-recording="setStreamRecording"
        :clear-streams="clearStreams"
        @export-trace="exportTrace"
        @share-trace="sharingSessionId = $event"
      />
      <div v-else class="mq-empty empty-state">
        <span class="mq-empty__mark">0 connections</span>
        <h1 class="mq-empty__title">No WebTransport connections yet</h1>
        <p>
          Open a page that uses WebTransport. Its connections appear here as
          they open.
        </p>
        <div class="mq-row">
          <button class="mq-btn mq-btn--secondary" @click="handleImportClick">
            Import .moqtrace
          </button>
        </div>
      </div>
      <ShareDialog
        v-if="sharingSession"
        :key="sharingSession.sessionId"
        :session="sharingSession"
        :view="accountView"
        :library="account.library"
        :build-trace="buildSessionTrace"
        @close="sharingSessionId = null"
        @sign-in="account.signIn"
        @refresh-orgs="account.refreshOrgs"
      />
    </main>
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
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  transition:
    width 180ms ease,
    min-width 180ms ease;
}
.sidebar.collapsed {
  width: 56px;
  min-width: 56px;
}

.sidebar-title {
  flex: 1;
  margin: 0;
  font-size: inherit;
}
.sidebar.collapsed .sidebar-header {
  justify-content: center;
}

.main {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.main-notice {
  margin: var(--space-2) var(--space-2) 0;
  grid-template-columns: 20px 1fr;
}
.cli-confirm {
  grid-template-columns: 20px 1fr auto;
  align-items: center;
}
.cli-fp {
  white-space: nowrap;
}

.exclusion-toggle {
  padding: var(--space-1) var(--space-3);
  border-bottom: 1px solid var(--line);
}

.exclusion-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}
.exclusion-header {
  font-size: inherit;
  font-weight: 600;
}
.exclusion-list {
  list-style: none;
  padding: 0;
  max-height: 140px;
  overflow-y: auto;
}
.exclusion-entry {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.exclusion-origin {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.exclusion-add {
  display: flex;
  gap: var(--space-1);
}

.sidebar-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-2);
  border-top: 1px solid var(--line);
  color: var(--ink-muted);
  text-decoration: none;
  flex-shrink: 0;
}
.mq-logo {
  display: inline-flex;
  align-items: center;
  line-height: 0;
  color: var(--ink);
}
.mq-logo :deep(svg) {
  display: block;
  height: 13.47px;
  width: auto;
}
.sidebar-footer:hover .sidebar-footer__more {
  color: var(--ink);
  text-decoration: underline;
}

.empty-state {
  flex: 1;
  justify-content: center;
}
</style>
