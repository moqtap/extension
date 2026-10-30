<script lang="ts" setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AccountMenu from './components/AccountMenu.vue'
import BrandLink from './components/BrandLink.vue'
import ConnectionList from './components/ConnectionList.vue'
import ConnectionPicker from './components/ConnectionPicker.vue'
import Icon from './components/Icon.vue'
import ImpairmentMenu from './components/ImpairmentMenu.vue'
import Infobar from './components/Infobar.vue'
import PopupMenu from './components/PopupMenu.vue'
import SessionView from './components/SessionView.vue'
import SettingsView from './components/SettingsView.vue'
import ShareDialog from './components/ShareDialog.vue'
import SplitView from './components/SplitView.vue'
import TabStrip from './components/TabStrip.vue'
import { DIRECT_NOTICE, impairmentProblem, pickProblem, refusalAction, refusalUpgrade } from './cli-copy'
import { shownTracks } from './alias-tracks'
import { connectionName } from './connection-name'
import { formatCount } from './format'
import { impairmentButtonLabel, shortFingerprint } from './impair-choices'
import { logoPlace, panelLayout, SIDEBAR_COLLAPSED_WIDTH, tabMenuHasConnection } from './layout'
import { getCachedPref, savePref } from './prefs'
import type { ProblemSeverity } from './problems'
import { FIRST_TAB, filters, isSessionTab, type SessionTab, shownTab, tabList } from './session-tabs'
import { isOff } from '@/src/cli/protocol'
import { useAccount } from './use-account'
import { useCli } from './use-cli'
import { useInspector } from './use-inspector'
import logo from './moqtap-logo.svg?raw'

const {
  sessions,
  selectedSessionId,
  missedConnections,
  cspBlockedWorkers,
  workerExclusions,
  selectSession,
  clearSessions,
  getStreamData,
  getDatagramGroupData,
  exportTrace,
  buildSessionTrace,
  importTrace,
  imports,
  setStreamRecording,
  clearStreams,
  addWorkerExclusion,
  removeWorkerExclusion,
} = useInspector()

const account = useAccount()
const accountView = account.view
const cli = useCli(browser.devtools.inspectedWindow.tabId)
const cliView = cli.view
const cliConfirm = computed(() => (cliView.value?.state === 'confirm' ? cliView.value : null))

// ── Layout ────────────────────────────────────────────────────────
const rootEl = ref<HTMLElement | null>(null)
const width = ref(window.innerWidth)
const height = ref(window.innerHeight)
const layout = computed(() => panelLayout(width.value, height.value))
let ro: ResizeObserver | null = null
onMounted(() => {
  ro = new ResizeObserver((entries) => {
    const r = entries[0]?.contentRect
    if (r && r.width > 0) width.value = r.width
    if (r && r.height > 0) height.value = r.height
  })
  if (rootEl.value) ro.observe(rootEl.value)
})
onBeforeUnmount(() => ro?.disconnect())

/** The sidebar shows beside the main pane; the chrome above it lines up with its width. */
const sidebarShown = computed(() => !layout.value.narrow && sessionList.value.length > 0)
const collapsed = ref(getCachedPref('sidebarCollapsed'))
watch(collapsed, (c) => void savePref('sidebarCollapsed', c))
const sideWidth = ref(0)
const sideStyle = computed(() => (sideWidth.value > 0 ? { '--side-w': `${sideWidth.value}px` } : undefined))
const sideHead = computed(() => sidebarShown.value && sideWidth.value > 0)
const logoAt = computed(() => logoPlace(sideHead.value, collapsed.value))

// ── Connections ───────────────────────────────────────────────────
const sessionList = computed(() => Array.from(sessions.value.values()))
const selectedSession = computed(() =>
  selectedSessionId.value ? (sessions.value.get(selectedSessionId.value) ?? null) : null,
)
const live = computed(() => {
  const s = selectedSession.value
  return s !== null && !s.imported
})
const recording = computed(() => selectedSession.value?.streamRecording !== false)
const exportable = computed(() => selectedSession.value?.protocol === 'moqt' && !selectedSession.value.imported)

function toggleRecording() {
  const s = selectedSession.value
  if (s) setStreamRecording(s.sessionId, !recording.value)
}

function reloadPage() {
  browser.devtools.inspectedWindow.reload({})
}

const shownImports = computed(() => imports.value.filter((i) => i.shown))
const percent = (loaded: number, total: number) => (total > 0 ? Math.floor((loaded / total) * 100) : 0)

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

// ── Views ─────────────────────────────────────────────────────────
const remembered = getCachedPref('sessionTab')
const activeTab = ref<SessionTab>(isSessionTab(remembered) ? remembered : FIRST_TAB)
watch(activeTab, (t) => void savePref('sessionTab', t))
const hasTracks = computed(() => selectedSession.value?.protocol === 'moqt')
const viewTab = computed({
  get: () => shownTab(activeTab.value, hasTracks.value),
  set: (t: SessionTab) => (activeTab.value = t),
})
const settingsOpen = ref(false)
const filter = ref('')
const problemCounts = ref<Record<ProblemSeverity, number>>({ error: 0, warning: 0, info: 0 })
const problemTotal = computed(() => problemCounts.value.error + problemCounts.value.warning + problemCounts.value.info)
const tabs = computed(() => {
  const s = selectedSession.value
  if (!s) return []
  return tabList({
    messages: s.messages.length,
    streams: s.streams.size + s.datagramGroups.size,
    tracks: s.protocol === 'moqt' ? shownTracks(s).size : null,
    problems: problemTotal.value,
  })
})
/** The problem count button's name: "2 errors, 1 warning, 3 notes", leaving out a zero. */
const countsLabel = computed(() => {
  const { error, warning, info } = problemCounts.value
  const part = (n: number, one: string) => (n === 0 ? null : `${formatCount(n)} ${n === 1 ? one : `${one}s`}`)
  return [part(error, 'error'), part(warning, 'warning'), part(info, 'note')].filter((p) => p !== null).join(', ')
})
const filterOn = computed(() => selectedSession.value !== null && filters(viewTab.value) && !settingsOpen.value)
/** The filter keeps its place, unseen, wherever it does not apply, so no row changes height. */
const filterSlot = computed(() => selectedSession.value !== null)
const FILTER_LABELS: Record<SessionTab, string> = {
  messages: 'Filter messages',
  streams: 'Filter streams by track',
  tracks: 'Filter tracks',
  problems: 'Filter problems',
  details: 'Filter',
}

function selectTab(t: SessionTab) {
  settingsOpen.value = false
  viewTab.value = t
}
function selectConnection(id: string) {
  settingsOpen.value = false
  selectSession(id)
}

// ── Impairment ────────────────────────────────────────────────────
const impairmentOn = computed(() => cli.tab.value !== null && !isOff(cli.tab.value.profile))
const impairmentIssue = computed(() => impairmentProblem(cli.tab.value, cliView.value))
const impairmentUpgrade = computed(() => refusalUpgrade(cli.tab.value, cliView.value))
/** What the refusal notice offers; null when the problem is not a refusal. */
const refusal = computed(() => refusalAction(cli.tab.value, cliView.value))
const impairmentNotice = computed(() => impairmentIssue.value !== null)
/** A pick's notice can be dismissed; the background forgets it, so the button's warning goes too. */
const pickNotice = computed(() => pickProblem(cli.tab.value))
function dismissRefusal() {
  cli.clearError()
}
/** Open connections that bypass the CLI while the tab has a profile. */
const directSessions = computed(() =>
  impairmentOn.value ? sessionList.value.some((s) => !s.closed && !s.imported && !s.cli) : false,
)
const impairBtn = ref<HTMLButtonElement | null>(null)
const impairOpen = ref(false)
/** The selected connection, when its profile can be picked at the CLI. */
const selectedCli = computed(() => {
  const s = selectedSession.value
  return s && s.cliSession !== undefined && !s.closed && !s.imported ? s : null
})
/** A connection row's own impairment menu. */
const sessionMenu = ref<{ id: string; anchor: HTMLElement } | null>(null)
const sessionMenuLive = computed(() => {
  const id = sessionMenu.value?.id
  return id !== undefined && sessionList.value.some((s) => s.cliSession === id && !s.closed && !s.imported)
})
watch(sessionMenuLive, (alive) => {
  if (!alive) sessionMenu.value = null
})

// ── Notices ───────────────────────────────────────────────────────
const missedDismissed = ref(false)
watch(missedConnections, (n, old) => {
  if (n > old) missedDismissed.value = false
})

// ── More menu and sharing ─────────────────────────────────────────
const moreBtn = ref<HTMLButtonElement | null>(null)
const moreOpen = ref(false)
/** The session the share dialog is open for. */
const sharingSessionId = ref<string | null>(null)
const sharingSession = computed(() =>
  sharingSessionId.value ? (sessions.value.get(sharingSessionId.value) ?? null) : null,
)
function share() {
  if (selectedSession.value) sharingSessionId.value = selectedSession.value.sessionId
}
function exportSelected() {
  if (selectedSession.value) exportTrace(selectedSession.value.sessionId)
}
// ── Connection context menu ───────────────────────────────────────
const rowMenu = ref<{ id: string; anchor: HTMLElement; at: { x: number; y: number } | null } | null>(null)
/** Clear stream data is for a live connection, which keeps going without the streams it had. */
const rowMenuSession = computed(() => {
  const s = rowMenu.value ? sessions.value.get(rowMenu.value.id) : undefined
  return s && !s.imported ? s : null
})
function openRowMenu(id: string, anchor: HTMLElement, at: { x: number; y: number } | null) {
  const s = sessions.value.get(id)
  if (s && !s.imported) rowMenu.value = { id, anchor, at }
}
function openPickerMenu(anchor: HTMLElement, at: { x: number; y: number } | null) {
  if (selectedSession.value) openRowMenu(selectedSession.value.sessionId, anchor, at)
}
function clearRowStreams() {
  const s = rowMenuSession.value
  if (s && s.streams.size > 0) clearStreams(s.sessionId)
}
function openSettings() {
  settingsOpen.value = true
}
/** As DevTools' own Settings: closing gives the focus back to the gear. */
function closeSettings() {
  settingsOpen.value = false
  void nextTick(() => moreBtn.value?.focus())
}
function onSettingsKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && settingsOpen.value) closeSettings()
}
onMounted(() => window.addEventListener('keydown', onSettingsKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onSettingsKey))
</script>

<template>
  <div
    ref="rootEl"
    class="panel"
    :class="{ 'is-narrow': layout.narrow, 'has-side': sideHead, 'has-filter-row': layout.narrow && filterSlot }"
    :style="sideStyle"
  >
    <div class="tool-bar toolbar" role="toolbar" aria-label="WebTransport" :inert="settingsOpen">
      <div class="side-head">
      <button
        class="mq-btn mq-btn--quiet mq-btn--icon record-btn"
        :class="{ recording: live && recording }"
        :disabled="!live"
        :aria-pressed="live && recording"
        :aria-label="recording ? 'Stop recording stream data' : 'Record stream data'"
        :title="recording ? 'Stop recording stream data' : 'Record stream data'"
        @click="toggleRecording"
      >
        <span class="record-dot" aria-hidden="true" />
      </button>
      <button
        class="mq-btn mq-btn--quiet mq-btn--icon"
        :disabled="sessionList.length === 0"
        aria-label="Clear connections"
        title="Clear connections"
        @click="clearSessions"
      >
        <Icon name="ban" />
      </button>
      <!-- Import acts on the connection list, so it sits with the list's buttons. -->
      <button
        v-if="!layout.narrow"
        class="mq-btn mq-btn--quiet mq-btn--icon"
        aria-label="Import .moqtrace"
        title="Import .moqtrace"
        @click="handleImportClick"
      >
        <Icon name="import" />
      </button>
      <BrandLink v-if="logoAt === 'head'" class="head-brand" />
      <button
        v-if="sideHead"
        class="mq-btn mq-btn--quiet mq-btn--icon side-toggle"
        :aria-label="collapsed ? 'Expand connections' : 'Compact connections'"
        :title="collapsed ? 'Expand connections' : 'Compact connections'"
        :aria-expanded="!collapsed"
        @click="collapsed = !collapsed"
      >
        <Icon :name="collapsed ? 'chevronsRight' : 'chevronsLeft'" />
      </button>
      <span v-else class="bar-sep" aria-hidden="true" />
      </div>
      <div class="bar-main">
      <ConnectionPicker
        v-if="layout.narrow && sessionList.length > 0"
        :sessions="sessionList"
        :selected="selectedSession"
        @select="selectConnection"
        @context="openPickerMenu"
      />
      <button
        v-if="layout.narrow"
        class="mq-btn mq-btn--quiet mq-btn--icon"
        aria-label="Import .moqtrace"
        title="Import .moqtrace"
        @click="handleImportClick"
      >
        <Icon name="import" />
      </button>
      <TabStrip
        v-if="layout.tabsInline && selectedSession && !settingsOpen"
        class="toolbar-tabs"
        :tabs="tabs"
        :active="viewTab"
        panel-id="session-panel"
        @select="selectTab"
      />
      <!-- Kept in place, unseen, on views without a filter, so the controls after it stay put. -->
      <div v-if="filterOn || filterSlot" class="filter-field" :class="{ 'is-idle': !filterOn }">
        <Icon name="filter" class="filter-icon" />
        <input
          v-model="filter"
          class="mq-input filter-input"
          type="search"
          :aria-label="FILTER_LABELS[viewTab]"
          placeholder="Filter"
          spellcheck="false"
          @keydown.esc="filter = ''"
        />
        <button
          v-if="filter"
          class="mq-btn mq-btn--quiet mq-btn--icon filter-clear"
          aria-label="Clear filter"
          title="Clear filter"
          @click="filter = ''"
        >
          <Icon name="x" />
        </button>
      </div>
      <button
        ref="impairBtn"
        class="mq-btn mq-btn--quiet impair-btn"
        :class="{ 'is-on': impairmentOn }"
        aria-haspopup="menu"
        :aria-expanded="impairOpen"
        :aria-label="`Impairment: ${impairmentButtonLabel(cli.tab.value)}`"
        @click="impairOpen = !impairOpen"
      >
        <Icon name="gauge" />
        <span class="impair-name">{{ impairmentButtonLabel(cli.tab.value) }}</span>
        <Icon v-if="impairmentIssue" name="warning" class="impair-flag" />
        <Icon name="chevronDown" class="caret" />
      </button>
      <template
        v-if="selectedSession && problemTotal > 0"
      >
        <span class="bar-sep" aria-hidden="true" />
        <button
          class="mq-btn mq-btn--quiet counts-btn"
          :aria-label="countsLabel"
          title="Show problems"
          @click="selectTab('problems')"
        >
          <span v-if="problemCounts.error > 0" class="count count--error"
            ><Icon name="error" />{{ formatCount(problemCounts.error) }}</span
          >
          <span v-if="problemCounts.warning > 0" class="count count--warning"
            ><Icon name="warning" />{{ formatCount(problemCounts.warning) }}</span
          >
          <span v-if="problemCounts.info > 0" class="count count--info"
            ><Icon name="info" />{{ formatCount(problemCounts.info) }}</span
          >
        </button>
      </template>
      <div v-show="filterSlot" id="tab-tools" class="tab-tools" :class="{ 'is-idle': settingsOpen }" />
      <span v-if="layout.narrow && filterSlot" class="row-break" aria-hidden="true" />
      <span class="toolbar-spacer" />
      <button
        v-if="exportable"
        class="mq-btn mq-btn--quiet mq-btn--icon io-btn"
        aria-label="Export .moqtrace"
        title="Export .moqtrace"
        @click="exportSelected"
      >
        <Icon name="export" />
      </button>
      <button
        v-if="exportable"
        class="mq-btn mq-btn--quiet mq-btn--icon io-btn share-btn"
        aria-label="Upload to moqtap and share"
        title="Upload to moqtap and share"
        @click="share"
      >
        <Icon name="share" />
      </button>
      <span class="bar-sep io-sep" aria-hidden="true" />
      </div>
      <div class="bar-end">
      <AccountMenu :view="accountView" @sign-in="account.signIn" @disconnect="account.disconnect" />
      <button
        ref="moreBtn"
        class="mq-btn mq-btn--quiet mq-btn--icon more-btn"
        aria-label="More options"
        title="More options"
        aria-haspopup="menu"
        :aria-expanded="moreOpen"
        @click="moreOpen = !moreOpen"
      >
        <Icon name="settings" />
      </button>
      </div>
    </div>

    <div class="infobars" :inert="settingsOpen">
      <Infobar v-for="imp in shownImports" :key="imp.id" kind="info">
        <span class="import-line">
          <span class="import-name">Importing {{ imp.filename }}…</span>
          <progress class="import-progress" :value="imp.loaded" :max="imp.total || 1" :aria-label="`Importing ${imp.filename}`" />
          <span class="import-percent">{{ percent(imp.loaded, imp.total) }}%</span>
        </span>
        <template #actions>
          <button class="mq-btn mq-btn--secondary" @click="imp.cancel()">Cancel</button>
        </template>
      </Infobar>
      <Infobar v-if="impairmentNotice" kind="warning" :dismissible="pickNotice" @dismiss="dismissRefusal">
        {{ impairmentIssue }}
        <template v-if="refusal" #actions>
          <a
            v-if="refusal === 'upgrade' && impairmentUpgrade"
            class="mq-btn mq-btn--secondary"
            :href="impairmentUpgrade.url"
            target="_blank"
            rel="noopener"
            >Upgrade</a
          >
          <button v-else class="mq-btn mq-btn--secondary" @click="impairOpen = true">Choose another profile</button>
        </template>
      </Infobar>
      <Infobar v-if="directSessions" kind="info">
        {{ DIRECT_NOTICE }}
        <button class="mq-btn--link inline-btn" @click="reloadPage">Reload the page</button> to impair them.
      </Infobar>
      <Infobar v-if="cliConfirm" kind="info">
        Let moqtap send this tab's connections through this moqtap CLI? Identity
        <span class="mq-mono">{{ shortFingerprint(cliConfirm.fingerprint) }}</span>, as the moqtap CLI prints it.
        <template #actions>
          <button class="mq-btn mq-btn--primary" @click="cli.allow(cliConfirm.identity)">Allow</button>
          <button class="mq-btn mq-btn--secondary" @click="cli.decline(cliConfirm.identity)">Not now</button>
        </template>
      </Infobar>
      <Infobar
        v-if="missedConnections > 0 && !missedDismissed"
        kind="info"
        dismissible
        @dismiss="missedDismissed = true"
      >
        {{ missedConnections === 1 ? 'A connection' : `${missedConnections} connections` }} opened before
        DevTools weren't captured.
        <button class="mq-btn--link inline-btn" @click="reloadPage">Reload the page</button>
        to capture them.
      </Infobar>
      <Infobar v-if="cspBlockedWorkers.length > 0" kind="warning">
        This site's security policy keeps moqtap out of its workers. They run normally, but the
        connections they open aren't captured or impaired.
      </Infobar>
    </div>

    <div v-if="!layout.tabsInline && (sideHead || (selectedSession && !settingsOpen))" class="tab-row">
      <div v-if="sideHead" class="side-cell" />
      <TabStrip
        v-if="selectedSession && !settingsOpen"
        :tabs="tabs"
        :active="viewTab"
        panel-id="session-panel"
        @select="selectTab"
      />
    </div>

    <PopupMenu v-if="impairOpen" :anchor="impairBtn" label="Impairment" @close="impairOpen = false">
      <ImpairmentMenu
        :view="cliView"
        :tab="cli.tab.value"
        :profiles="cli.profiles.value"
        :for-tab="true"
        :session="tabMenuHasConnection(layout, sidebarShown && collapsed) ? (selectedCli?.cliSession ?? null) : null"
        :session-label="selectedCli ? connectionName(selectedCli) : undefined"
        @read-profiles="cli.readProfiles"
        @set-profile="(c) => cli.setProfile(c.profile, c.name)"
        @set-session-profile="(c) => cli.setSessionProfile(selectedCli!.cliSession!, c)"
      />
    </PopupMenu>
    <PopupMenu
      v-if="sessionMenu && sessionMenuLive"
      :anchor="sessionMenu.anchor"
      label="Impairment for this connection"
      @close="sessionMenu = null"
    >
      <ImpairmentMenu
        :view="cliView"
        :tab="cli.tab.value"
        :profiles="cli.profiles.value"
        :for-tab="false"
        :session="sessionMenu.id"
        @read-profiles="cli.readProfiles"
        @set-session-profile="(c) => cli.setSessionProfile(sessionMenu!.id, c)"
      />
    </PopupMenu>
    <PopupMenu
      v-if="rowMenu && rowMenuSession"
      :anchor="rowMenu.anchor"
      :at="rowMenu.at"
      label="Connection"
      @close="rowMenu = null"
    >
      <button
        class="mq-menu__item"
        role="menuitem"
        :aria-disabled="rowMenuSession.streams.size === 0 ? 'true' : undefined"
        title="Remove the recorded streams; messages and new streams stay"
        @click="clearRowStreams"
      >
        Clear stream data
      </button>
    </PopupMenu>
    <PopupMenu v-if="moreOpen" :anchor="moreBtn" label="More options" @close="moreOpen = false">
      <button class="mq-menu__item" role="menuitem" @click="openSettings">Settings</button>
      <hr role="separator" />
      <a class="mq-menu__item brand-item" role="menuitem" href="https://moqtap.com" target="_blank" rel="noopener">
        <span class="mq-logo" v-html="logo" />
        <span class="menu-hint">More tools</span>
      </a>
    </PopupMenu>

    <SettingsView
      v-if="settingsOpen"
      class="settings-overlay"
      :view="cliView"
      :trusted="cli.trusted.value"
      :exclusions="workerExclusions"
      @close="closeSettings"
      @allow="cli.allow"
      @forget="cli.forget"
      @add-exclusion="addWorkerExclusion"
      @remove-exclusion="removeWorkerExclusion"
    />
    <!-- The sidebar is never narrower than its toolbar segment: record, clear, import, logo, toggle. -->
    <SplitView
      v-show="!settingsOpen"
      class="workspace"
      split-id="sidebar"
      label="Resize connections"
      :first="sidebarShown"
      :initial="240"
      unit="px"
      :min-first="176"
      :min-second="320"
      :stack-below="0"
      :fixed="collapsed ? SIDEBAR_COLLAPSED_WIDTH : undefined"
      @size="sideWidth = $event"
    >
      <template #first>
        <aside class="sidebar" aria-label="Connections">
          <ConnectionList
            :sessions="sessionList"
            :impaired="impairmentOn"
            :tab="cli.tab.value"
            :short-labels="cli.shortLabels.value"
            :selected-id="selectedSessionId"
            :collapsed="collapsed"
            @select="selectConnection"
            @impair="(id, anchor) => (sessionMenu = { id, anchor })"
            @context="openRowMenu"
          />
          <div v-if="logoAt === 'side'" class="side-foot"><BrandLink /></div>
        </aside>
      </template>
      <template #second>
      <main class="main">
        <template v-if="selectedSession">
          <h1 class="mq-sr">{{ selectedSession.url }}</h1>
          <SessionView
            :key="selectedSession.sessionId"
            v-model:tab="viewTab"
            v-model:filter="filter"
            :session="selectedSession"
            :app-footer="logoAt === 'footer'"
            :get-stream-data="getStreamData"
            :get-datagram-group-data="getDatagramGroupData"
            @problems="problemCounts = $event"
          />
        </template>
        <div v-else-if="sessionList.length > 0" class="empty-state">
          <p class="empty-title">Select a connection</p>
        </div>
        <div v-else class="empty-state">
          <p class="empty-title">No WebTransport connections yet</p>
          <p class="empty-body">Connections appear here as the page opens them. Reload to capture them from the start.</p>
          <div class="empty-actions">
            <button class="mq-btn mq-btn--secondary" @click="reloadPage">Reload page</button>
            <button class="mq-btn mq-btn--secondary" @click="handleImportClick">Import .moqtrace</button>
          </div>
        </div>
        <!-- Kept mounted: the stream counts teleport into its slot. -->
        <div v-show="logoAt === 'footer'" class="status-footer">
          <div id="status-slot" class="status-slot" />
          <BrandLink class="status-footer-brand" />
        </div>
      </main>
      </template>
    </SplitView>

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
  </div>
</template>

<style scoped>
.panel {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
}
/* Settings cover the whole panel, toolbar included, as DevTools' own do. */
.settings-overlay {
  position: absolute;
  inset: 0;
  z-index: 10;
}

/* ── Toolbar ───────────────────────────────────────────────────── */

.toolbar {
  flex-wrap: wrap;
  row-gap: 0;
  gap: 2px;
}
/* Without a sidebar the groups are one wrapping row. */
.side-head,
.bar-main,
.bar-end {
  display: contents;
}
:is(.side-head, .bar-main, .bar-end) > * {
  flex-shrink: 0;
}
/* With one, the sidebar's buttons sit over it, as wide as it is; the rest
   wraps beside them and the account and gear keep the first row's end. */
.has-side .toolbar {
  flex-wrap: nowrap;
  align-items: stretch;
  gap: 0;
  padding: 0;
}
.has-side .side-head {
  display: flex;
  align-items: flex-start;
  gap: 2px;
  flex: 0 0 calc(var(--side-w) + 1px);
  min-width: 0;
  padding: 0 4px;
  border-right: 1px solid var(--line);
  overflow: hidden;
}
.side-foot {
  display: flex;
  justify-content: center;
  align-items: center;
  flex: none;
  height: var(--header-tool);
}
.side-toggle {
  margin-left: auto;
}
.has-side .side-head > * {
  margin-top: calc((var(--header-tool) - var(--control-tool)) / 2);
}
.has-side .bar-main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  align-content: flex-start;
  row-gap: 0;
  gap: 2px;
  flex: 1 1 0;
  min-width: 0;
  min-height: var(--header-tool);
  padding: 0 0 0 2px;
}
.has-side .bar-end {
  display: flex;
  align-items: center;
  align-self: flex-start;
  gap: 2px;
  height: var(--header-tool);
  padding-right: 4px;
}
.toolbar-spacer {
  flex: 1 1 0;
}
.toolbar-tabs {
  flex: 1 1 0;
  align-self: stretch;
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
.record-btn:disabled .record-dot {
  border-color: var(--ink-disabled);
}
.toolbar .mq-btn[disabled] {
  background: transparent;
  border-color: transparent;
}
/* Pills: room at the round ends for the label. */
.toolbar .mq-btn--quiet {
  padding: 0 6px;
}
.toolbar .mq-btn--icon {
  padding: 0;
}
.toolbar .record-btn[aria-pressed='true'] {
  background: transparent;
}

/* As Network's, it takes the row's free room, here up to 480 px, and is the
   first to give way when there is none, down to 120 px. */
.filter-field {
  position: relative;
  display: flex;
  align-items: center;
  flex: 100 1000 200px;
  min-width: 120px;
  max-width: 480px;
}
.filter-icon {
  position: absolute;
  left: 6px;
  color: var(--ink-muted);
  pointer-events: none;
}
.filter-icon :deep(svg) {
  width: 12px;
  height: 12px;
}
.filter-field.is-idle {
  visibility: hidden;
}
/* As Network's filter. Chrome: a filled 20 px pill, 3 px clear of the bar,
   darker on hover, ringed when focused. Firefox: no fill, the bar's full
   height, a 1 px focus border. */
.panel .filter-input {
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  height: var(--filter-h);
  padding: 0 24px 0 22px;
  border-color: transparent;
  background: transparent;
}
.panel .filter-input:focus-visible {
  outline: none;
}
:global(html.host--chrome) {
  --filter-h: 20px;
}
:global(html.host--chrome .panel .filter-input) {
  border-radius: var(--radius-full);
  background: var(--filter-bg);
}
:global(html.host--chrome .panel .filter-input:hover) {
  background: var(--filter-hover);
}
:global(html.host--chrome .panel .filter-input:focus) {
  background: var(--filter-bg);
  box-shadow: inset 0 0 0 2px var(--focus-ring);
}
:global(html.host--firefox) {
  --filter-h: var(--header-tool);
}
:global(html.host--firefox .panel .filter-input) {
  border-radius: 0;
}
:global(html.host--firefox .panel .filter-input:focus) {
  border-color: var(--focus-ring);
}
.filter-input::-webkit-search-cancel-button {
  display: none;
}
/* As Network's clear button: a 16 px round target inside the field, 4 px clear
   of the text and the edge. Outranks the tool bar's icon button rule, which
   would put it back in the row. */
.filter-field .filter-clear.mq-btn--icon {
  position: absolute;
  top: 50%;
  right: 4px;
  width: 16px;
  height: 16px;
  min-height: 0;
  margin-top: -8px;
  --icon-hit: 16px;
}
.filter-clear :deep(svg) {
  width: 12px;
  height: 12px;
}
/* Narrow: the first row keeps its controls (the picker gives way); the
   filter, the view's own tools and import/export take the second, which is
   there whenever a connection is selected so no view changes the height. */
.row-break {
  order: 9;
  flex: 0 0 100%;
  height: 0;
}
.is-narrow .filter-field {
  order: 10;
  flex: 1 1 60px;
  min-width: 60px;
  max-width: none;
  margin-bottom: 2px;
}
/* The view's tools before the filter's spare room, but never so wide that
   they wrap the row: the filter's least width and import/export stay. */
.is-narrow .tab-tools {
  order: 11;
  flex: 0 1 var(--tab-tools-w);
  max-width: calc(100% - 140px);
  margin-bottom: 2px;
}
.has-filter-row .io-btn {
  order: 12;
  margin-bottom: 2px;
}
/* Last on its row: its centre 18 px from the edge, as the gear's. */
.has-filter-row .share-btn {
  margin-right: 2px;
}
.is-narrow .io-sep {
  display: none;
}
/* The picker takes the free room ahead of the spacer, up to what its name
   needs; a small basis keeps the row from wrapping. The host gives way, never the #id. */
.bar-main > :deep(.picker-btn) {
  flex: 100 1 72px;
  max-width: max-content;
}
/* Narrow, the profile name gives way too, so the first row keeps the gear. */
.is-narrow .impair-btn {
  flex: 100 1 64px;
  min-width: 0;
  max-width: max-content;
}
.is-narrow .impair-name {
  max-width: 140px;
}

.impair-btn {
  gap: var(--space-1);
  max-width: 200px;
}
/* The button's line height is 1; a clipped name needs room for descenders. */
.impair-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: normal;
}
.impair-btn.is-on {
  color: var(--tap);
}
.impair-flag {
  color: var(--warning);
}
.impair-flag :deep(svg) {
  width: 14px;
  height: 14px;
}
.caret :deep(svg) {
  width: 12px;
  height: 12px;
}

/* A slot as wide on every view, empty or not, so no view moves the filter. */
/* Holds a control's height while empty, so switching tabs doesn't move the panel. */
.tab-tools {
  display: flex;
  align-items: center;
  flex: 0 0 var(--tab-tools-w);
  width: var(--tab-tools-w);
  min-width: 0;
  min-height: var(--control-tool);
  overflow: hidden;
  --tab-tools-w: 200px;
}
.tab-tools.is-idle {
  visibility: hidden;
}

/* Network's gear: full toolbar height, 28 px wide, its centre 18 px from the edge. */
.toolbar .more-btn {
  width: 28px;
  height: var(--header-tool);
  margin-right: 0;
}

.counts-btn {
  gap: var(--space-2);
}
.count {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-variant-numeric: tabular-nums;
}
.count :deep(svg) {
  width: 14px;
  height: 14px;
}
.count--error :deep(.ext-icon) {
  color: var(--danger);
}
.count--warning :deep(.ext-icon) {
  color: var(--warning);
}
.count--info :deep(.ext-icon) {
  color: var(--info);
}

.infobars {
  flex-shrink: 0;
}
.import-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.import-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.import-percent {
  flex: none;
  font-variant-numeric: tabular-nums;
}
.import-progress {
  flex: 0 1 160px;
  min-width: 48px;
  height: 4px;
  appearance: none;
  border: none;
  border-radius: 2px;
  background: var(--line);
  color: var(--info);
  overflow: hidden;
}
.import-progress::-webkit-progress-bar {
  background: var(--line);
}
.import-progress::-webkit-progress-value {
  background: var(--info);
}
.import-progress::-moz-progress-bar {
  background: var(--info);
}

.tab-row {
  display: flex;
  height: var(--header-tool);
  background: var(--host-bar, var(--surface));
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}
.side-cell {
  display: flex;
  align-items: center;
  flex: 0 0 calc(var(--side-w) + 1px);
  min-width: 0;
  padding: 0 var(--space-2);
  border-right: 1px solid var(--line);
  overflow: hidden;
}

/* ── Workspace ─────────────────────────────────────────────────── */

.workspace {
  flex: 1;
  min-height: 0;
}
.sidebar {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface);
}
.main {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

/* With no sidebar the panel has a status footer on every tab: the stream counts on Streams, the logo always. */
.status-footer {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-1) var(--space-2);
  background: var(--surface);
  border-top: 1px solid var(--line);
  flex-shrink: 0;
}
.status-slot {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
.status-footer-brand {
  margin: -2px 0;
}

/* As Network's empty state: centred both ways, a title over a line of text and the actions. */
.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-4);
  text-align: center;
  overflow: auto;
}
.empty-title {
  font-size: calc(var(--host-text) + 4px);
  line-height: 1.3;
  font-weight: 500;
  color: var(--ink);
}
.empty-body {
  max-width: 44ch;
  color: var(--ink-muted);
}
.empty-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
.inline-btn {
  font: inherit;
  border: 0;
  cursor: pointer;
}

.brand-item {
  align-items: center;
  gap: var(--space-2);
  text-decoration: none;
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
</style>
