<script lang="ts" setup>
import { detectMediaInfo, type PayloadMediaInfo } from '@moqtap/media/bmff'
import { decodeCbor } from '@/src/detect/cbor-decode'
import type { StreamContentType } from '@/src/detect/content-detect'
import { decodeMsgpack } from '@/src/detect/msgpack-decode'
import { computed, ref, watch } from 'vue'
import type { CatalogView } from '../catalogs'
import { formatBytes, plural } from '../format'
import { getCachedPref, savePref } from '../prefs'
import type { HeaderTag } from '../stream-framing'
import {
  extractAllPayloads,
  parseDatagramGroupFraming,
  parseStreamFraming,
} from '../stream-framing'
import type { TrackEntry } from '../use-inspector'
import CatalogPanel from './CatalogPanel.vue'
import HexViewer from './HexViewer.vue'
import JsonTree from './JsonTree.vue'

const props = defineProps<{
  data: Uint8Array
  contentType: StreamContentType
  /** RFC 6381 codec string, when the payload is a raw elementary stream */
  codecString?: string
  /** Pre-computed media info from background first-chunk detection */
  mediaInfo?: PayloadMediaInfo
  /** Whether this stream belongs to a MoQT session (enables framing parsing) */
  isMoqt?: boolean
  /** Draft version string for draft-specific parsing (e.g. '14') */
  draft?: string
  /** Track registry for resolving trackAlias in framing header */
  tracks?: Map<string, TrackEntry>
  /** True when this data is a datagram group (length-prefixed concatenated datagrams) */
  isDatagramGroup?: boolean
  /**
   * The catalog this stream carries objects of, when it is on a catalog
   * track. It is the whole track's catalog, merged across its streams, not
   * just this stream's objects.
   */
  catalog?: CatalogView | null
}>()

/**
 * `catalog` is offered only on a catalog stream and is never saved as the
 * preference: it would mean nothing on the next stream opened.
 */
type ViewMode = 'hex' | 'json' | 'catalog'

/** Content types that can be decoded to a JSON tree view */
const STRUCTURED_TYPES: Set<string> = new Set(['json', 'cbor', 'msgpack'])
const hasStructuredContent = computed(() =>
  STRUCTURED_TYPES.has(props.contentType),
)

/** Label for the structured-data tab */
const structuredTabLabel = computed(() => {
  if (props.contentType === 'cbor') return 'CBOR'
  if (props.contentType === 'msgpack') return 'MsgPack'
  return 'JSON'
})

/** User's preferred mode — persisted across sessions */
const preferredMode = getCachedPref('streamViewMode') as ViewMode

/**
 * Effective view mode. Starts as the preferred mode if structured content is
 * available, otherwise falls back to hex while keeping the preference intact.
 */
const viewMode = ref<ViewMode>(
  props.catalog
    ? 'catalog'
    : preferredMode === 'json' && hasStructuredContent.value
      ? 'json'
      : 'hex',
)

// The catalog is read in the background of the panel and may land after the
// stream is open; a catalog stream opens on what its catalog says.
watch(
  () => props.catalog?.key,
  (key, previous) => {
    if (key && !previous && viewMode.value === 'hex') viewMode.value = 'catalog'
    if (!key && viewMode.value === 'catalog') viewMode.value = 'hex'
  },
)

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
  if (!f || f.objects.length === 0) return []

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
  if (props.mediaInfo) return props.mediaInfo

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
  if (props.contentType === 'cbor') {
    const cbor = decodeCbor(props.data)
    if (cbor) {
      jsonData.value = cbor.value
      return cbor.value
    }
  }
  if (props.contentType === 'msgpack') {
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

    // Reloading a catalog stream keeps it on its catalog.
    if (viewMode.value === 'catalog' && props.catalog) return

    const pref = getCachedPref('streamViewMode') as ViewMode
    if (pref === 'json' && hasStructuredContent.value) {
      // Try to parse; show decoded view if it works, otherwise fall back to hex
      parseJson()
      viewMode.value = jsonData.value !== null ? 'json' : 'hex'
    } else {
      viewMode.value = pref
    }
  },
)

function switchToHex() {
  viewMode.value = 'hex'
  savePref('streamViewMode', 'hex')
}

function switchToCatalog() {
  if (props.catalog) viewMode.value = 'catalog'
}

function switchToJson() {
  parseJson()
  if (jsonData.value !== null) {
    viewMode.value = 'json'
    savePref('streamViewMode', 'json')
  }
}

// Auto-open decoded view on first render if preferred
if (!props.catalog && preferredMode === 'json' && hasStructuredContent.value) {
  parseJson()
  if (jsonData.value !== null) {
    viewMode.value = 'json'
  }
}
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
      </div>
      <span
        v-if="effectiveMediaInfo"
        class="mq-badge mq-badge--mono"
        :title="effectiveMediaInfo.boxes.join(' · ')"
        >{{ VARIANT_LABELS[effectiveMediaInfo.variant] ?? 'fMP4' }} ·
        {{ effectiveMediaInfo.boxes.length }} boxes</span
      >
      <span v-else-if="contentType === 'fmp4'" class="mq-badge mq-badge--mono"
        >fMP4</span
      >
      <span
        v-else-if="contentType === 'h264' || contentType === 'h265'"
        class="mq-badge mq-badge--mono"
        :title="codecString ?? undefined"
        >{{ codecString ?? (contentType === 'h265' ? 'H.265' : 'H.264') }}</span
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
    <div class="viewer-body">
      <HexViewer
        v-if="viewMode === 'hex'"
        :data="data"
        :header-size="headerSize"
        :objects="framing?.objects"
      />
      <div v-else-if="viewMode === 'json' && jsonData" class="json-container">
        <JsonTree :data="jsonData" :initial-expanded="true" />
      </div>
      <CatalogPanel
        v-else-if="viewMode === 'catalog' && catalog"
        :catalog="catalog"
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

.viewer-body {
  flex: 1;
  overflow: auto;
}

.json-container {
  padding: var(--space-2);
}
</style>
