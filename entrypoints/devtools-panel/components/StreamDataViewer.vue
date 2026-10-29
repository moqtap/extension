<script lang="ts" setup>
import { detectMediaInfo, type PayloadMediaInfo } from '@moqtap/media/bmff'
import { decodeCbor } from '@/src/detect/cbor-decode'
import { decodeMsgpack } from '@/src/detect/msgpack-decode'
import { computed, ref, watch } from 'vue'
import type { CatalogView } from '../catalogs'
import type { CmafObjectView, CmafTrackState } from '../cmaf'
import type { LocObjectView, LocTrackState } from '../loc'
import { formatBytes, plural } from '../format'
import { getCachedPref, savePref } from '../prefs'
import type { HeaderTag, StreamObject } from '../stream-framing'
import type { StreamFormat } from '../stream-format'
import {
  extractAllPayloads,
  parseDatagramGroupFraming,
  parseStreamFraming,
} from '../stream-framing'
import {
  type MediaTimelineTemplate,
  TIMELINE_LABELS,
  type TimelineObjectView,
  type TimelineState,
  templateText,
} from '../timelines'
import type { ImportedFraming, TrackEntry } from '../use-inspector'
import BmffObjectsPanel from './BmffObjectsPanel.vue'
import CatalogPanel from './CatalogPanel.vue'
import CmafObjectsPanel from './CmafObjectsPanel.vue'
import HexViewer from './HexViewer.vue'
import JsonTree from './JsonTree.vue'
import LocObjectsPanel from './LocObjectsPanel.vue'
import NalUnitsPanel from './NalUnitsPanel.vue'
import TimelinePanel from './TimelinePanel.vue'

const props = defineProps<{
  data: Uint8Array
  /** What the stream is read as: its track's packaging, or what its bytes prove */
  format: StreamFormat
  /** Whether this stream belongs to a MoQT session (enables framing parsing) */
  isMoqt?: boolean
  /** Draft version string for draft-specific parsing (e.g. '14') */
  draft?: string
  /** Track registry for resolving trackAlias in framing header */
  tracks?: Map<string, TrackEntry>
  /** True when this data is a datagram group (length-prefixed concatenated datagrams) */
  isDatagramGroup?: boolean
  /** The catalog of this stream's track, merged across all its streams */
  catalog?: CatalogView | null
  /** How an imported stream's framing came about; absent for a live stream */
  importedFraming?: ImportedFraming
  /** The LOC track this stream carries, and how to decode one of its objects */
  loc?: {
    state: LocTrackState
    objectView: (
      obj: StreamObject,
      groupId: number,
      data: Uint8Array,
    ) => LocObjectView
  } | null
  /** The CMAF track this stream carries, and how to parse one of its objects */
  cmaf?: {
    state: CmafTrackState
    objectView: (obj: StreamObject, data: Uint8Array) => CmafObjectView
  } | null
  /** The timeline track this stream carries, and how to read one of its objects */
  timeline?: {
    state: TimelineState
    objectView: (obj: StreamObject, data: Uint8Array) => TimelineObjectView
  } | null
  /** The media timeline template the catalogs give this stream's track (msf-01 7.4.1) */
  template?: MediaTimelineTemplate | null
  /**
   * What to open: an object by its offset in the stream, or a catalog object
   * by its Group and Object IDs. A new `seq` opens it again.
   */
  focus?:
    | { kind: 'object'; offset: number; seq: number }
    | { kind: 'catalog-object'; groupId: number; objectId: number; seq: number }
    | null
}>()

/**
 * `catalog`, `loc`, `cmaf` and `timeline` are offered only on a stream of
 * such a track, `fragments` and `nal` only on one whose bytes prove them; none
 * is saved as the preference.
 */
type ViewMode = 'hex' | 'json' | 'catalog' | 'loc' | 'cmaf' | 'timeline' | 'fragments' | 'nal'

/** The byte classification; null for a stream read as its track's packaging */
const bytes = computed(() => (props.format.from === 'bytes' ? props.format : null))

/** Content types that can be decoded to a JSON tree view */
const STRUCTURED_TYPES: Set<string> = new Set(['json', 'cbor', 'msgpack'])
const hasStructuredContent = computed(
  () => !!bytes.value && STRUCTURED_TYPES.has(bytes.value.contentType),
)

/** Label for the structured-data tab */
const structuredTabLabel = computed(() => {
  if (bytes.value?.contentType === 'cbor') return 'CBOR'
  if (bytes.value?.contentType === 'msgpack') return 'MsgPack'
  return 'JSON'
})

/** User's preferred mode — persisted across sessions */
const preferredMode = getCachedPref('streamViewMode') as ViewMode

/**
 * Effective view mode. Starts as the preferred mode if structured content is
 * available, otherwise falls back to hex while keeping the preference intact.
 */
/** The view a stream of the track opens on, when its track has one of its own. */
function trackMode(): ViewMode | null {
  if (props.catalog) return 'catalog'
  if (props.loc) return 'loc'
  if (props.cmaf) return 'cmaf'
  if (props.timeline) return 'timeline'
  return null
}

const viewMode = ref<ViewMode>(trackMode() ?? 'hex')

// The catalog may land after the stream is open.
watch(
  () => props.catalog?.key,
  (key, previous) => {
    if (key && !previous && viewMode.value === 'hex') viewMode.value = 'catalog'
    if (!key && viewMode.value === 'catalog') viewMode.value = 'hex'
  },
)

// So may the catalog that makes the track LOC or CMAF, or a pin.
for (const [mode, key] of [
  ['loc', () => props.loc?.state.key],
  ['cmaf', () => props.cmaf?.state.key],
  ['timeline', () => props.timeline?.state.key],
] as const) {
  watch(key, (now, previous) => {
    if (now && !previous && viewMode.value === 'hex') viewMode.value = mode
    if (!now && viewMode.value === mode) viewMode.value = 'hex'
  })
}

/** Lazily parsed JSON — only computed when needed */
const jsonData = ref<unknown | null>(null)
const jsonParsed = ref(false)

/** MoQT framing info */
const framing = computed(() => {
  if (!props.isMoqt) return null
  if (props.isDatagramGroup) {
    return parseDatagramGroupFraming(props.data, props.draft)
  }
  return parseStreamFraming(props.data, props.draft)
})

/** The hex view's note on an imported stream's framing bytes. */
const framingNote = computed((): string | undefined => {
  if (props.importedFraming === 'unavailable')
    return 'payloads only'
  return undefined
})

/** Header tags for UI display (generic, draft-agnostic) */
const framingTags = computed((): HeaderTag[] => framing.value?.tags ?? [])

/** Header size for hex viewer annotation */
const headerSize = computed(() => framing.value?.headerEnd ?? 0)

/**
 * Resolve the framing header to a known track — by track alias, or by request
 * id for a fetch stream, which carries no alias.
 */
const resolvedTrack = computed((): TrackEntry | null => {
  const f = framing.value
  if (!f || !props.tracks) return null
  if (f.streamType === 'fetch') {
    const track = props.tracks.get(String(f.headerFields.requestId))
    return track?.via === 'fetch' ? track : null
  }
  const alias = String(f.headerFields.trackAlias)
  for (const track of props.tracks.values()) {
    if (track.trackAlias === alias) return track
  }
  return null
})

/** Variant display labels */
const VARIANT_LABELS: Record<string, string> = {
  cmaf: 'CMAF',
  fmp4: 'fMP4',
}

/** Per-object BMFF box info — computed at display time from framing + payload */
interface ObjectBoxInfo {
  objectId: number
  boxes: string[]
  variant: string
}

const objectBoxes = computed((): ObjectBoxInfo[] => {
  const f = framing.value
  if (!bytes.value || !f || f.objects.length === 0) return []

  const results: ObjectBoxInfo[] = []
  for (const obj of f.objects) {
    const end = Math.min(
      obj.payloadOffset + obj.payloadLength,
      props.data.length,
    )
    if (end <= obj.payloadOffset) continue

    const payload = props.data.subarray(obj.payloadOffset, end)
    const media = detectMediaInfo(payload)
    if (media) {
      results.push({
        objectId: obj.objectId,
        boxes: media.boxes,
        variant: media.variant,
      })
    }
  }
  return results
})

/** Aggregated media info — either from background detection or computed from objects */
const effectiveMediaInfo = computed((): PayloadMediaInfo | null => {
  if (!bytes.value) return null
  if (bytes.value.mediaInfo) return bytes.value.mediaInfo

  // Aggregate from per-object detection
  const infos = objectBoxes.value
  if (infos.length === 0) return null

  const allBoxes: string[] = []
  let variant = infos[0].variant
  for (const info of infos) {
    allBoxes.push(...info.boxes)
    // CMAF is the more specific variant: one branded object marks the stream
    if (info.variant === 'cmaf') variant = info.variant
  }
  return { variant: variant as PayloadMediaInfo['variant'], boxes: allBoxes }
})

/** Objects with ISO BMFF boxes, or a non-MoQT stream that starts with them. */
const fragmentsAvailable = computed((): boolean => {
  if (!bytes.value) return false
  if (framing.value) return effectiveMediaInfo.value !== null
  return !props.isMoqt && detectMediaInfo(props.data) !== null
})

/** The codec of an Annex-B stream that has objects, or is not MoQT. */
const nalCodec = computed((): 'h264' | 'h265' | null => {
  const type = bytes.value?.contentType
  if (type !== 'h264' && type !== 'h265') return null
  return framing.value || !props.isMoqt ? type : null
})

/** The decoded view the stream's bytes offer, other than a JSON tree. */
function byteMode(): ViewMode | null {
  if (fragmentsAvailable.value) return 'fragments'
  if (nalCodec.value) return 'nal'
  return null
}

/** Try to decode a single payload as structured data (JSON, CBOR, or MessagePack) */
function decodePayload(payload: Uint8Array): unknown | null {
  // JSON
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(payload)
    return JSON.parse(text)
  } catch {
    /* not JSON */
  }

  // CBOR
  const cbor = decodeCbor(payload)
  if (cbor && cbor.bytesRead >= payload.length * 0.5) return cbor.value

  // MessagePack
  const mp = decodeMsgpack(payload)
  if (mp && mp.bytesRead >= payload.length * 0.5) return mp.value

  return null
}

function parseJson(): unknown | null {
  if (jsonParsed.value) return jsonData.value
  jsonParsed.value = true

  // Strategy 1: If we have MoQT framing, extract payloads and try those
  const f = framing.value
  if (f && f.objects.length > 0) {
    const payloads = extractAllPayloads(props.data, f)
    const results: unknown[] = []
    for (const payload of payloads) {
      const decoded = decodePayload(payload)
      if (decoded != null) results.push(decoded)
    }
    if (results.length === 1) {
      jsonData.value = results[0]
      return jsonData.value
    } else if (results.length > 1) {
      jsonData.value = results
      return jsonData.value
    }
  }

  // Strategy 2: For CBOR/MessagePack, try the raw data directly
  // (binary formats don't need scanning — they start at byte 0 or after framing)
  if (bytes.value?.contentType === 'cbor') {
    const cbor = decodeCbor(props.data)
    if (cbor) {
      jsonData.value = cbor.value
      return cbor.value
    }
  }
  if (bytes.value?.contentType === 'msgpack') {
    const mp = decodeMsgpack(props.data)
    if (mp) {
      jsonData.value = mp.value
      return mp.value
    }
  }

  // Strategy 3: Scan for JSON start byte and try from there
  // (handles unknown framing or non-MoQT streams with leading binary)
  for (let i = 0; i < Math.min(props.data.length, 256); i++) {
    const b = props.data[i]
    if (b === 0x7b || b === 0x5b) {
      // { or [
      try {
        const slice = props.data.subarray(i)
        const text = new TextDecoder('utf-8', { fatal: true }).decode(slice)
        jsonData.value = JSON.parse(text)
        return jsonData.value
      } catch {
        // Not valid JSON from this offset — keep scanning
      }
    }
  }

  jsonData.value = null
  return null
}

// When data changes: reset parse state, auto-open JSON if preferred and available
watch(
  () => props.data,
  () => {
    jsonParsed.value = false
    jsonData.value = null

    // Reloading a stream keeps it on its track's view.
    if (viewMode.value === 'catalog' && props.catalog) return
    if (viewMode.value === 'loc' && props.loc) return
    if (viewMode.value === 'cmaf' && props.cmaf) return
    if (viewMode.value === 'timeline' && props.timeline) return
    if (viewMode.value === 'fragments' && fragmentsAvailable.value) return
    if (viewMode.value === 'nal' && nalCodec.value) return
    viewMode.value = 'hex'
    if (getCachedPref('streamViewMode') === 'json') openDecoded()
  },
)

/** The decoded view the bytes offer, when there is one. */
function openDecoded() {
  const mode = byteMode()
  if (mode) {
    viewMode.value = mode
    return
  }
  if (!hasStructuredContent.value) return
  parseJson()
  if (jsonData.value !== null) viewMode.value = 'json'
}

// A catalog or pin that lands takes the byte views away.
watch([fragmentsAvailable, nalCodec, hasStructuredContent], () => {
  if (
    (viewMode.value === 'fragments' && !fragmentsAvailable.value) ||
    (viewMode.value === 'nal' && !nalCodec.value) ||
    (viewMode.value === 'json' && !hasStructuredContent.value)
  ) {
    viewMode.value = 'hex'
  }
})

function switchToHex() {
  viewMode.value = 'hex'
  savePref('streamViewMode', 'hex')
}

function switchToCatalog() {
  if (props.catalog) viewMode.value = 'catalog'
}

function switchToLoc() {
  if (props.loc) viewMode.value = 'loc'
}

function switchToCmaf() {
  if (props.cmaf) viewMode.value = 'cmaf'
}

function switchToTimeline() {
  if (props.timeline) viewMode.value = 'timeline'
}

// A problem's link shows its object in the track's own view.
watch(
  () => props.focus,
  (focus) => {
    if (!focus) return
    if (focus.kind === 'catalog-object') {
      if (props.catalog) viewMode.value = 'catalog'
      return
    }
    const mode = trackMode()
    if (mode && mode !== 'catalog') viewMode.value = mode
  },
  { immediate: true },
)

const objectFocus = computed(() =>
  props.focus?.kind === 'object' ? { offset: props.focus.offset, seq: props.focus.seq } : null,
)
const catalogFocus = computed(() =>
  props.focus?.kind === 'catalog-object'
    ? { groupId: props.focus.groupId, objectId: props.focus.objectId, seq: props.focus.seq }
    : null,
)

function switchToJson() {
  parseJson()
  if (jsonData.value !== null) {
    viewMode.value = 'json'
    savePref('streamViewMode', 'json')
  }
}

function switchToFragments() {
  if (fragmentsAvailable.value) viewMode.value = 'fragments'
}

function switchToNal() {
  if (nalCodec.value) viewMode.value = 'nal'
}

// Auto-open decoded view on first render if preferred
if (!trackMode() && preferredMode === 'json') openDecoded()
</script>

<template>
  <div class="stream-data-viewer">
    <div class="filter-bar viewer-toolbar">
      <div class="view-modes" role="group" aria-label="Show stream as">
        <button
          class="mq-btn mq-btn--quiet"
          :aria-pressed="viewMode === 'hex'"
          @click="switchToHex"
        >
          Hex
        </button>
        <button
          v-if="hasStructuredContent"
          class="mq-btn mq-btn--quiet"
          :aria-pressed="viewMode === 'json'"
          @click="switchToJson"
        >
          {{ structuredTabLabel }}
        </button>
        <button
          v-if="catalog"
          class="mq-btn mq-btn--quiet"
          :aria-pressed="viewMode === 'catalog'"
          title="What this catalog track says, across all its streams"
          @click="switchToCatalog"
        >
          Catalog
        </button>
        <button
          v-if="loc && framing"
          class="mq-btn mq-btn--quiet"
          :aria-pressed="viewMode === 'loc'"
          title="Each object's LOC properties and payload"
          @click="switchToLoc"
        >
          LOC
        </button>
        <button
          v-if="cmaf && framing"
          class="mq-btn mq-btn--quiet"
          :aria-pressed="viewMode === 'cmaf'"
          title="Each object's CMAF boxes, track_IDs, timing and SAP"
          @click="switchToCmaf"
        >
          CMAF
        </button>
        <button
          v-if="timeline && framing"
          class="mq-btn mq-btn--quiet"
          :aria-pressed="viewMode === 'timeline'"
          title="Each object's timeline records"
          @click="switchToTimeline"
        >
          {{ TIMELINE_LABELS[timeline.state.kind] }}
        </button>
        <button
          v-if="fragmentsAvailable"
          class="mq-btn mq-btn--quiet"
          :aria-pressed="viewMode === 'fragments'"
          title="Each object's boxes and movie fragments"
          @click="switchToFragments"
        >
          Fragments
        </button>
        <button
          v-if="nalCodec"
          class="mq-btn mq-btn--quiet"
          :aria-pressed="viewMode === 'nal'"
          title="Each object's NAL units"
          @click="switchToNal"
        >
          NAL units
        </button>
      </div>
      <span
        v-if="effectiveMediaInfo"
        class="mq-badge mq-badge--mono"
        :title="effectiveMediaInfo.boxes.join(' · ')"
        >{{ VARIANT_LABELS[effectiveMediaInfo.variant] ?? 'fMP4' }} ·
        {{ effectiveMediaInfo.boxes.length }} boxes</span
      >
      <span v-else-if="bytes?.contentType === 'fmp4'" class="mq-badge mq-badge--mono"
        >fMP4</span
      >
      <span
        v-else-if="bytes?.contentType === 'h264' || bytes?.contentType === 'h265'"
        class="mq-badge mq-badge--mono"
        :title="bytes.codecString ?? undefined"
        >{{ bytes.codecString ?? (bytes.contentType === 'h265' ? 'H.265' : 'H.264') }}</span
      >
      <span
        v-if="resolvedTrack"
        class="mq-badge mq-badge--mono track-badge"
        :title="resolvedTrack.fullName"
        >{{ resolvedTrack.fullName }}</span
      >
      <span
        v-for="tag in framingTags"
        :key="tag.label"
        class="mq-badge mq-badge--mono"
        >{{ tag.label }}={{ tag.value }}</span
      >
      <span v-if="framing" class="mq-badge mq-badge--mono">{{
        plural(framing.objects.length, 'object')
      }}</span>
      <span class="viewer-size">{{ formatBytes(data.length) }}</span>
    </div>
    <p v-if="template" class="viewer-template" title="The catalog's media timeline template">
      template · {{ templateText(template) }}
    </p>
    <div class="viewer-body">
      <HexViewer
        v-if="
          viewMode === 'hex' ||
          ((viewMode === 'loc' || viewMode === 'cmaf' || viewMode === 'timeline') &&
            !framing)
        "
        :data="data"
        :header-size="headerSize"
        :objects="framing?.objects"
        :note="framingNote"
        :mark-properties="!!loc"
        :media-boxes="!!bytes"
      />
      <div v-else-if="viewMode === 'json' && jsonData" class="json-container">
        <JsonTree :data="jsonData" :initial-expanded="true" />
      </div>
      <BmffObjectsPanel
        v-else-if="viewMode === 'fragments' && fragmentsAvailable"
        :data="data"
        :framing="framing"
      />
      <NalUnitsPanel
        v-else-if="viewMode === 'nal' && nalCodec"
        :data="data"
        :framing="framing"
        :codec="nalCodec"
      />
      <CatalogPanel
        v-else-if="viewMode === 'catalog' && catalog"
        :catalog="catalog"
        :focus="catalogFocus"
      />
      <LocObjectsPanel
        v-else-if="viewMode === 'loc' && loc && framing"
        :data="data"
        :framing="framing"
        :state="loc.state"
        :object-view="loc.objectView"
        :focus="objectFocus"
      />
      <CmafObjectsPanel
        v-else-if="viewMode === 'cmaf' && cmaf && framing"
        :data="data"
        :framing="framing"
        :state="cmaf.state"
        :object-view="cmaf.objectView"
        :focus="objectFocus"
      />
      <TimelinePanel
        v-else-if="viewMode === 'timeline' && timeline && framing"
        :data="data"
        :framing="framing"
        :state="timeline.state"
        :object-view="timeline.objectView"
        :focus="objectFocus"
      />
    </div>
  </div>
</template>

<style scoped>
.stream-data-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.view-modes {
  display: flex;
  gap: var(--space-1);
  margin-right: var(--space-1);
}

.track-badge {
  max-width: 24ch;
  overflow: hidden;
  text-overflow: ellipsis;
}

.viewer-size {
  margin-left: auto;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--ink-muted);
}

.viewer-template {
  margin: 0;
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--line);
  font-family: var(--font-mono);
  color: var(--ink-muted);
  overflow-wrap: anywhere;
}

.viewer-body {
  flex: 1;
  overflow: auto;
}

.json-container {
  padding: var(--space-2);
}
</style>
