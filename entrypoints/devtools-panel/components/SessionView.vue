<script lang="ts" setup>
import { computed, nextTick, onBeforeUnmount, provide, ref, watch } from 'vue'
import { streamSummary } from '../detail-text'
import {
  formatBytes,
  formatClock,
  formatCount,
  isoTitle,
  shortId,
} from '../format'
import {
  errorCodeLabels,
  messageEvents,
  requestIds,
  requestTimes,
  sessionDraft,
  sessionProblems,
} from '../requests'
import { registryTrackKey, useSessionCatalogs } from '../catalogs'
import { useSessionCmaf } from '../cmaf'
import { datagramSource, streamSource, trackForSource, useSessionLoc } from '../loc'
import { templateOf, templateProblems } from '../timelines'
import {
  catalogConflictProblems,
  catalogProblems,
  consolidateProblems,
  joinInitProblems,
  type PanelProblem,
  type ProblemSeverity,
  type ProblemTarget,
  protocolProblems,
  SESSION_PROBLEMS,
  severityCounts,
} from '../problems'
import type { SessionTab } from '../session-tabs'
import { sessionViews } from '../packaging'
import type { StreamObject } from '../stream-framing'
import { holdsHeaderBytes } from '../import-trace'
import { sessionBytes } from '../sizes'
import { undefinedParameter } from '../undecodable'
import { shownTracks } from '../alias-tracks'
import { formatOfStream, type StreamFormat, trackByteLabels } from '../stream-format'
import type { MessageEntry, SessionEntry, StreamEntry } from '../use-inspector'
import ControlMessageLog from './ControlMessageLog.vue'
import CopyButton from './CopyButton.vue'
import ProblemList from './ProblemList.vue'
import StreamDataViewer from './StreamDataViewer.vue'
import SplitView from './SplitView.vue'
import StreamList from './StreamList.vue'
import TracksTab from './TracksTab.vue'
import DirMark from './DirMark.vue'
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
  /** The panel has a status footer: the stream counts go there */
  appFooter?: boolean
}>()

const emit = defineEmits<{
  problems: [counts: Record<ProblemSeverity, number>]
  /** Drop the recorded streams, keeping the control stream and the messages. */
}>()

/** The view shown; a problem's link moves it. */
const activeTab = defineModel<SessionTab>('tab', { required: true })
/** The toolbar's filter text; a problem's link clears it. */
const filter = defineModel<string>('filter', { required: true })

const selectedStreamId = ref<number | null>(null)
const selectedStreamData = ref<Uint8Array | null>(null)
const loadingStream = ref(false)
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
      codecString: dg.codecString,
      firstDataAt: dg.firstDataAt,
      lastDataAt: dg.lastDataAt,
      chunkCount: dg.datagramCount,
      trackAlias: dg.trackAlias,
      datagramGroupKey: dg.groupKey,
      datagramCount: dg.datagramCount,
      groupId: dg.groupId,
      importedFraming: dg.importedFraming,
    })
  }
  return items
})
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

const draft = computed(() => sessionDraft(props.session))
/** Every track that carried data, the ones known only by alias included. */
const tracks = computed(() => shownTracks(props.session))

/** The session's MSF / CMSF catalogs, read as their streams grow. */
const catalogs = useSessionCatalogs(() => props.session, props.getStreamData)
const selectedCatalog = computed(() =>
  selectedStreamId.value == null || selectedStreamId.value < 0
    ? null
    : catalogs.catalogForStream(selectedStreamId.value),
)
/** The session's LOC tracks, as the catalogs say. */
const loc = useSessionLoc(
  () => props.session,
  () => catalogs.packaging.value,
  props.getStreamData,
  props.getDatagramGroupData,
)
const selectedLoc = computed(() => {
  const id = selectedStreamId.value
  if (id == null) return null
  const groupKey = dgIdToGroupKey.get(id)
  const source = groupKey ? datagramSource(groupKey) : streamSource(id)
  const state = loc.sourceState(source)
  if (!state) return null
  return {
    state,
    objectView: (obj: StreamObject, groupId: number, data: Uint8Array) =>
      loc.objectView(source, obj, groupId, data, state),
  }
})
/** The session's CMAF and timeline tracks, as the catalogs say. */
const cmaf = useSessionCmaf(
  () => props.session,
  () => catalogs.packaging.value,
  props.getStreamData,
  props.getDatagramGroupData,
)
const selectedSource = computed(() => {
  const id = selectedStreamId.value
  if (id == null) return null
  const groupKey = dgIdToGroupKey.get(id)
  return groupKey ? datagramSource(groupKey) : streamSource(id)
})
const selectedCmaf = computed(() => {
  const source = selectedSource.value
  const state = source ? cmaf.sourceState(source) : null
  if (!source || !state) return null
  return {
    state,
    objectView: (obj: StreamObject, data: Uint8Array) =>
      cmaf.objectView(source, obj, data, state),
  }
})
const selectedTimeline = computed(() => {
  const source = selectedSource.value
  const state = source ? cmaf.sourceTimeline(source) : null
  if (!source || !state) return null
  return {
    state,
    objectView: (obj: StreamObject, data: Uint8Array) =>
      cmaf.timelineView(source, obj, data, state),
  }
})
/** The media timeline template the catalogs give the selected stream's track. */
const selectedTemplate = computed(() => {
  const source = selectedSource.value
  const track = source ? trackForSource(props.session, source) : null
  if (!track) return null
  return templateOf(catalogs.packaging.value.get(registryTrackKey(track)))?.template ?? null
})

/** The stream detail's header line. */
const detailSummary = computed(() => {
  const s = selectedStream.value
  const source = selectedSource.value
  if (!s) return ''
  return streamSummary({
    trackName: source ? (trackForSource(props.session, source)?.fullName ?? null) : null,
    datagramGroup: !!s.datagramGroupKey,
    bidi: s.datagramGroupKey ? undefined : s.bidi,
    byteCount: s.byteCount,
    chunkCount: s.chunkCount,
    datagramCount: s.datagramCount,
    closed: s.closed,
  })
})

const views = computed(() => sessionViews(props.session))

/** What a stream is read as: its track's packaging, or what its bytes prove. */
function formatOf(stream: StreamEntry): StreamFormat {
  return formatOfStream(props.session, stream, catalogs.packaging.value)
}

/**
 * How the selected stream's track is viewed where Tracks offers the choice
 * (its packaging is known): with its reader, or in Bytes.
 */
const selectedTrackView = computed((): 'reader' | 'hex' | undefined => {
  void views.value.revision.value
  const source = selectedSource.value
  const track = source ? trackForSource(props.session, source) : null
  if (!track) return undefined
  const key = registryTrackKey(track)
  const known =
    selectedFormat.value.from === 'packaging' ||
    catalogs.catalogs.value.some((c) => c.key === key) ||
    byteLabels.value.get(key) != null
  if (!known) return undefined
  return views.value.isHex(key) ? 'hex' : 'reader'
})
const byteLabels = computed(() => trackByteLabels(props.session, catalogs.packaging.value))

const selectedFormat = computed(
  (): StreamFormat =>
    selectedStream.value ? formatOf(selectedStream.value) : { from: 'bytes', contentType: 'binary' },
)

const events = computed(() => messageEvents(props.session.messages))
const times = computed(() => requestTimes(events.value, draft.value))
const errorLabels = computed(() => errorCodeLabels(events.value, draft.value))

/** Each message's track, by its request, so the filter finds a track's messages. */
const messageTracks = computed(() => {
  const byRequest = new Map<string, string>()
  for (const t of props.session.tracks.values()) {
    if (t.subscribeId != null) byRequest.set(String(t.subscribeId), t.fullName)
  }
  const out = new Map<MessageEntry, string>()
  for (const [msg, id] of requestIds(events.value, draft.value)) {
    const name = byRequest.get(id)
    if (name !== undefined) out.set(msg, name)
  }
  return out
})

/**
 * Wall-clock time while the session is open, so a request that is still
 * waiting for its response shows up without another message arriving.
 */
const now = ref(Date.now())
const nowTimer = setInterval(() => {
  if (!props.session.closed && !props.session.imported) now.value = Date.now()
}, 1_000)
onBeforeUnmount(() => clearInterval(nowTimer))

/** When a stream's first bytes came. */
function streamTime(streamId: number): number | null {
  return props.session.streams.get(streamId)?.firstDataAt ?? null
}

/** Every source's problems as one list. */
const shownProblems = computed((): PanelProblem[] =>
  joinInitProblems(consolidateProblems([
    protocolProblems(
      sessionProblems(events.value, {
        draft: draft.value,
        tracks: props.session.tracks.values(),
        endMs:
          props.session.closed || props.session.imported ? undefined : now.value,
      }),
      (p) =>
        p.id === 'session.undecodable'
          ? undefinedParameter(p.message, {
              draft: props.session.draft,
              streams: props.session.streams,
              messages: props.session.messages,
            })
          : null,
    ),
    catalogConflictProblems(props.session.tracks.values(), catalogs.packaging.value),
    catalogProblems(catalogs.catalogs.value, streamTime, (id) => holdsHeaderBytes(props.session, id)),
    templateProblems(props.session.tracks.values(), catalogs.packaging.value),
    loc.problems.value,
    cmaf.problems.value,
  ])),
)

watch(
  () => severityCounts(shownProblems.value),
  (counts) => emit('problems', counts),
  { immediate: true, deep: true },
)

/** What a problem's link asked to open, for the view it opens in. */
const streamFocus = ref<
  | { kind: 'object'; offset: number; seq: number }
  | { kind: 'catalog-object'; groupId: number; objectId: number; seq: number }
  | null
>(null)
const messageFocus = ref<{ message: MessageEntry; seq: number } | null>(null)
let focusSeq = 0

async function openTarget(target: ProblemTarget) {
  focusSeq++
  filter.value = ''
  if (target.kind === 'message') {
    activeTab.value = 'messages'
    await nextTick()
    messageFocus.value = { message: target.message, seq: focusSeq }
    return
  }
  activeTab.value = 'streams'
  if (target.kind === 'catalog-object') {
    streamFocus.value = { ...target, seq: focusSeq }
    await showStreamData(target.streamId)
    return
  }
  const id = target.source.startsWith('d:')
    ? getOrCreateDgId(target.source.slice(2))
    : Number(target.source.slice(2))
  streamFocus.value = { kind: 'object', offset: target.offset, seq: focusSeq }
  await showStreamData(id)
}

/** The session in a line, for copied problems: host, protocol, start in UTC. */
const sessionLine = computed(() => {
  let host = props.session.url
  try {
    host = new URL(props.session.url).host
  } catch {
    // Not a URL: shown as recorded.
  }
  const start = new Date(props.session.createdAt).toISOString().replace('T', ' ').slice(0, 19)
  return `${host}, ${protocolLabel(props.session)}, ${start} UTC`
})

provide(SESSION_PROBLEMS, {
  problems: shownProblems,
  startedAt: () => props.session.createdAt,
  session: sessionLine,
  stateKey: () => props.session.sessionId,
  open: (target) => void openTarget(target),
})

/** Media tracks in the Tracks tab's order, which problem groups follow. */
const trackOrder = computed(() => Array.from(tracks.value.values(), registryTrackKey))

function protocolLabel(session: SessionEntry): string {
  switch (session.protocol) {
    case 'moqt':
      return `MoQT draft-${session.draft}`
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

/** Where the two ends agreed the MoQT version: in the WebTransport handshake's protocol, or in SETUP. */
function versionAgreedIn(session: SessionEntry): string | null {
  const isMoqt = session.protocol === 'moqt' || session.protocol === 'moqt-unknown-draft'
  if (!isMoqt || session.draftAssumed) return null
  return session.draftFromProtocol ? 'WebTransport handshake' : 'SETUP messages'
}

const totalBytes = computed(() => sessionBytes(props.session))

/** A track's Show streams: Streams, filtered by its name. */
function openTrackStreams(trackName: string) {
  filter.value = trackName
  activeTab.value = 'streams'
}

/** A stream picked from the list opens with nothing in focus. */
function inspectStream(streamId: number) {
  streamFocus.value = null
  void showStreamData(streamId)
}

async function showStreamData(streamId: number) {
  selectedStreamId.value = streamId

  // Determine if this is a datagram group (synthetic negative ID)
  const dgGroupKey = dgIdToGroupKey.get(streamId)
  const stream = dgGroupKey
    ? streamList.value.find((s) => s.streamId === streamId)
    : props.session.streams.get(streamId)

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
  streamFocus.value = null
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
    <div
      id="session-panel"
      class="session-body"
      role="tabpanel"
      :aria-labelledby="`tab-${activeTab}`"
    >
      <ControlMessageLog
        v-if="activeTab === 'messages'"
        :messages="session.messages"
        :tracks="messageTracks"
        :started-at="session.createdAt"
        :draft="draft"
        :response-times="times.byResponse"
        :error-labels="errorLabels"
        :focus="messageFocus"
        :filter="filter"
      />
      <SplitView
        v-else-if="activeTab === 'streams'"
        split-id="streams"
        label="Resize stream detail"
        :second="selectedStreamId != null"
        :initial="0.4"
        :min-first="140"
        :min-second="200"
      >
        <template #first>
          <StreamList
            :streams="streamList"
            :selected-id="selectedStreamId"
            :tracks="tracks"
            :messages="session.messages"
            :format-of="formatOf"
            :filter="filter"
            :app-footer="appFooter"
            @inspect="inspectStream"
          />
        </template>
        <template #second>
          <section class="stream-detail" aria-labelledby="stream-detail-title">
            <div class="tool-bar detail-header">
              <h2 id="stream-detail-title" class="detail-title">
                <template v-if="selectedStream?.datagramGroupKey"
                  >Datagram group {{ selectedStream.groupId }}</template
                >
                <template v-else>Stream {{ selectedStreamId }}</template>
              </h2>
              <DirMark v-if="selectedStream" :dir="selectedStream.direction" />
              <span v-if="selectedStream" class="detail-meta" :title="detailSummary">{{ detailSummary }}</span>
              <button
                v-if="hasNewData"
                class="mq-btn mq-btn--quiet detail-refresh"
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
              :format="selectedFormat"
              :is-moqt="session.protocol === 'moqt'"
              :draft="session.draft"
              :tracks="session.tracks"
              :is-datagram-group="!!selectedStream?.datagramGroupKey"
              :imported-framing="selectedStream?.importedFraming"
              :catalog="selectedCatalog"
              :loc="selectedLoc"
              :cmaf="selectedCmaf"
              :timeline="selectedTimeline"
              :template="selectedTemplate"
              :focus="streamFocus"
              :track-view="selectedTrackView"
              class="detail-viewer"
            />
            <p v-else class="pane-message">No data recorded for this stream.</p>
          </section>
        </template>
      </SplitView>
      <TracksTab
        v-else-if="activeTab === 'tracks'"
        :session="session"
        :times="times"
        :catalogs="catalogs.catalogs.value"
        :packaging="catalogs.packaging.value"
        :loc="loc"
        :cmaf="cmaf"
        :filter="filter"
        @open-streams="openTrackStreams"
      />
      <div v-else-if="activeTab === 'problems'" class="problems-panel">
        <p v-if="shownProblems.length === 0" class="pane-message">No problems.</p>
        <ProblemList
          v-else
          :problems="shownProblems"
          :started-at="session.createdAt"
          :filter="filter"
          :session="sessionLine"
          :state-key="session.sessionId"
          :track-order="trackOrder"
          @open="openTarget"
        />
      </div>
      <div v-else-if="activeTab === 'details'" class="details-panel">
        <dl class="mq-kv details-list">
          <dt>URL</dt>
          <dd class="detail-copy">
            <span class="mq-addr">{{ session.url }}</span>
            <CopyButton :value="session.url" what="URL" />
          </dd>
          <template v-if="collectorDetail">
            <dt>Collector</dt>
            <dd>{{ collectorDetail }}</dd>
          </template>
          <dt>Protocol</dt>
          <dd>{{ protocolLabel(session) }}</dd>
          <template v-if="versionAgreedIn(session)">
            <dt>Version agreed in</dt>
            <dd>{{ versionAgreedIn(session) }}</dd>
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
            <dd class="mq-mono">
              {{ session.options.serverCertificateHashes }}
            </dd>
          </template>
          <dt>Session ID</dt>
          <dd class="detail-copy">
            <span class="mq-mono" :title="session.sessionId">{{
              shortId(session.sessionId)
            }}</span>
            <CopyButton :value="session.sessionId" what="session ID" />
          </dd>
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
          <template v-if="totalBytes !== null">
            <dt>Total data</dt>
            <dd class="mq-mono mq-num">{{ formatBytes(totalBytes) }}</dd>
          </template>
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

.session-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  container-type: inline-size;
}

/* ── Stream detail ─────────────────────────────────────────────── */

.stream-detail {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface);
}

.detail-header {
  gap: var(--space-1);
  flex-wrap: nowrap;
}

.detail-title {
  flex: none;
  padding-left: var(--space-1);
  font-size: inherit;
  font-weight: 400;
  color: var(--ink);
  white-space: nowrap;
}

.detail-header .dir {
  display: inline-flex;
  flex: none;
}
.detail-header .dir :deep(svg) {
  width: 12px;
  height: 12px;
}

.detail-meta {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-muted);
  font-variant-numeric: tabular-nums;
}

.detail-refresh {
  flex: none;
  gap: var(--space-1);
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

/* ── Problems and details ───────────────────────────────────────── */

.problems-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.details-panel {
  padding: var(--space-3);
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.details-list {
  max-width: 900px;
}

/* A value with its copy control beside it, centred on the text's line and no
   taller than it, so the row keeps every other row's height. */
.detail-copy {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.detail-copy > span:first-child {
  min-width: 0;
}
.detail-copy :deep(.mq-copy) {
  flex: none;
  width: 20px;
  height: 20px;
  margin-block: -4px;
}
.detail-copy :deep(.mq-copy svg) {
  width: 14px;
  height: 14px;
}
</style>
