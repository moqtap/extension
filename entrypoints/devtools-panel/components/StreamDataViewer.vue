<script lang="ts" setup>
import { ref, computed, watch } from 'vue';
import HexViewer from './HexViewer.vue';
import JsonTree from './JsonTree.vue';
import type { StreamContentType, TrackEntry, PayloadMediaInfo } from '../use-inspector';
import { parseStreamFraming, parseDatagramGroupFraming, extractAllPayloads } from '../stream-framing';
import type { HeaderTag } from '../stream-framing';
import { getCachedPref, savePref } from '../prefs';
import { detectMediaInfo } from '@/src/detect/bmff-boxes';
import { decodeCbor } from '@/src/detect/cbor-decode';
import { decodeMsgpack } from '@/src/detect/msgpack-decode';

const props = defineProps<{
  data: Uint8Array;
  contentType: StreamContentType;
  /** Pre-computed media info from background first-chunk detection */
  mediaInfo?: PayloadMediaInfo;
  /** Whether this stream belongs to a MoQT session (enables framing parsing) */
  isMoqt?: boolean;
  /** Draft version string for draft-specific parsing (e.g. '14') */
  draft?: string;
  /** Track registry for resolving trackAlias in framing header */
  tracks?: Map<string, TrackEntry>;
  /** True when this data is a datagram group (length-prefixed concatenated datagrams) */
  isDatagramGroup?: boolean;
}>();

type ViewMode = 'hex' | 'json';

/** Content types that can be decoded to a JSON tree view */
const STRUCTURED_TYPES: Set<string> = new Set(['json', 'cbor', 'msgpack']);
const hasStructuredContent = computed(() => STRUCTURED_TYPES.has(props.contentType));

/** Label for the structured-data tab */
const structuredTabLabel = computed(() => {
  if (props.contentType === 'cbor') return 'CBOR';
  if (props.contentType === 'msgpack') return 'MsgPack';
  return 'JSON';
});

/** User's preferred mode — persisted across sessions */
const preferredMode = getCachedPref('streamViewMode') as ViewMode;

/**
 * Effective view mode. Starts as the preferred mode if structured content is
 * available, otherwise falls back to hex while keeping the preference intact.
 */
const viewMode = ref<ViewMode>(
  preferredMode === 'json' && hasStructuredContent.value ? 'json' : 'hex',
);

/** Lazily parsed JSON — only computed when needed */
const jsonData = ref<unknown | null>(null);
const jsonParsed = ref(false);

/** MoQT framing info */
const framing = computed(() => {
  if (!props.isMoqt) return null;
  if (props.isDatagramGroup) {
    return parseDatagramGroupFraming(props.data, props.draft);
  }
  return parseStreamFraming(props.data, props.draft);
});

/** Header tags for UI display (generic, draft-agnostic) */
const framingTags = computed((): HeaderTag[] => framing.value?.tags ?? []);

/** Header size for hex viewer annotation */
const headerSize = computed(() => framing.value?.headerEnd ?? 0);

/** Resolve trackAlias from framing to a known track */
const resolvedTrack = computed((): TrackEntry | null => {
  const f = framing.value;
  if (!f || !props.tracks) return null;
  const alias = String(f.headerFields.trackAlias);
  for (const track of props.tracks.values()) {
    if (track.trackAlias === alias) return track;
  }
  return null;
});


/** Variant display labels */
const VARIANT_LABELS: Record<string, string> = {
  cmaf: 'CMAF',
  loc: 'LOC',
  fmp4: 'fMP4',
};

/** Per-object BMFF box info — computed at display time from framing + payload */
interface ObjectBoxInfo {
  objectId: number;
  boxes: string[];
  variant: string;
}

const objectBoxes = computed((): ObjectBoxInfo[] => {
  const f = framing.value;
  if (!f || f.objects.length === 0) return [];

  const results: ObjectBoxInfo[] = [];
  for (const obj of f.objects) {
    const end = Math.min(obj.payloadOffset + obj.payloadLength, props.data.length);
    if (end <= obj.payloadOffset) continue;

    const payload = props.data.subarray(obj.payloadOffset, end);
    const media = detectMediaInfo(payload);
    if (media) {
      results.push({
        objectId: obj.objectId,
        boxes: media.boxes,
        variant: media.variant,
      });
    }
  }
  return results;
});

/** Aggregated media info — either from background detection or computed from objects */
const effectiveMediaInfo = computed((): PayloadMediaInfo | null => {
  if (props.mediaInfo) return props.mediaInfo;

  // Aggregate from per-object detection
  const infos = objectBoxes.value;
  if (infos.length === 0) return null;

  const allBoxes: string[] = [];
  let variant = infos[0].variant;
  for (const info of infos) {
    allBoxes.push(...info.boxes);
    // Use the most specific variant found
    if (info.variant === 'cmaf' || info.variant === 'loc') variant = info.variant;
  }
  return { variant: variant as PayloadMediaInfo['variant'], boxes: allBoxes };
});

/** Try to decode a single payload as structured data (JSON, CBOR, or MessagePack) */
function decodePayload(payload: Uint8Array): unknown | null {
  // JSON
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    return JSON.parse(text);
  } catch { /* not JSON */ }

  // CBOR
  const cbor = decodeCbor(payload);
  if (cbor && cbor.bytesRead >= payload.length * 0.5) return cbor.value;

  // MessagePack
  const mp = decodeMsgpack(payload);
  if (mp && mp.bytesRead >= payload.length * 0.5) return mp.value;

  return null;
}

function parseJson(): unknown | null {
  if (jsonParsed.value) return jsonData.value;
  jsonParsed.value = true;

  // Strategy 1: If we have MoQT framing, extract payloads and try those
  const f = framing.value;
  if (f && f.objects.length > 0) {
    const payloads = extractAllPayloads(props.data, f);
    const results: unknown[] = [];
    for (const payload of payloads) {
      const decoded = decodePayload(payload);
      if (decoded != null) results.push(decoded);
    }
    if (results.length === 1) {
      jsonData.value = results[0];
      return jsonData.value;
    } else if (results.length > 1) {
      jsonData.value = results;
      return jsonData.value;
    }
  }

  // Strategy 2: For CBOR/MessagePack, try the raw data directly
  // (binary formats don't need scanning — they start at byte 0 or after framing)
  if (props.contentType === 'cbor') {
    const cbor = decodeCbor(props.data);
    if (cbor) { jsonData.value = cbor.value; return cbor.value; }
  }
  if (props.contentType === 'msgpack') {
    const mp = decodeMsgpack(props.data);
    if (mp) { jsonData.value = mp.value; return mp.value; }
  }

  // Strategy 3: Scan for JSON start byte and try from there
  // (handles unknown framing or non-MoQT streams with leading binary)
  for (let i = 0; i < Math.min(props.data.length, 256); i++) {
    const b = props.data[i];
    if (b === 0x7b || b === 0x5b) { // { or [
      try {
        const slice = props.data.subarray(i);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(slice);
        jsonData.value = JSON.parse(text);
        return jsonData.value;
      } catch {
        // Not valid JSON from this offset — keep scanning
      }
    }
  }

  jsonData.value = null;
  return null;
}

// When data changes: reset parse state, auto-open JSON if preferred and available
watch(() => props.data, () => {
  jsonParsed.value = false;
  jsonData.value = null;

  const pref = getCachedPref('streamViewMode') as ViewMode;
  if (pref === 'json' && hasStructuredContent.value) {
    // Try to parse; show decoded view if it works, otherwise fall back to hex
    parseJson();
    viewMode.value = jsonData.value !== null ? 'json' : 'hex';
  } else {
    viewMode.value = pref;
  }
});

function switchToHex() {
  viewMode.value = 'hex';
  savePref('streamViewMode', 'hex');
}

function switchToJson() {
  parseJson();
  if (jsonData.value !== null) {
    viewMode.value = 'json';
    savePref('streamViewMode', 'json');
  }
}

// Auto-open decoded view on first render if preferred
if (preferredMode === 'json' && hasStructuredContent.value) {
  parseJson();
  if (jsonData.value !== null) {
    viewMode.value = 'json';
  }
}
</script>

<template>
  <div class="stream-data-viewer">
    <div class="viewer-toolbar">
      <button
        class="vtab"
        :class="{ active: viewMode === 'hex' }"
        @click="switchToHex"
      >
        Hex
      </button>
      <button
        v-if="hasStructuredContent"
        class="vtab"
        :class="{ active: viewMode === 'json' }"
        @click="switchToJson"
      >
        {{ structuredTabLabel }}
      </button>
      <span
        v-if="effectiveMediaInfo"
        class="content-tag fmp4-tag"
        :title="effectiveMediaInfo.boxes.join(' \u00b7 ')"
      >{{ VARIANT_LABELS[effectiveMediaInfo.variant] ?? 'fMP4' }}({{ effectiveMediaInfo.boxes.length }})</span>
      <span v-else-if="contentType === 'fmp4'" class="content-tag fmp4-tag">fMP4</span>
      <span v-if="resolvedTrack" class="content-tag track-tag">{{ resolvedTrack.fullName }}</span>
      <span
        v-for="tag in framingTags"
        :key="tag.label"
        class="content-tag"
        :class="`tag-${tag.kind ?? 'info'}`"
      >{{ tag.label }}={{ tag.value }}</span>
      <span v-if="framing" class="content-tag framing-tag">{{ framing.objects.length }} obj{{ framing.objects.length !== 1 ? 's' : '' }}</span>
      <span class="viewer-size mono">{{ data.length }} bytes</span>
    </div>
    <div class="viewer-body">
      <HexViewer v-if="viewMode === 'hex'" :data="data" :header-size="headerSize" :objects="framing?.objects" />
      <div v-else-if="viewMode === 'json' && jsonData" class="json-container">
        <JsonTree :data="jsonData" :initial-expanded="true" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.stream-data-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.viewer-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border);
}

.vtab {
  background: none;
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text-secondary);
  padding: 1px 8px;
  cursor: pointer;
  font-size: 10px;
  font-family: inherit;
}
.vtab:hover {
  color: var(--text-primary);
}
.vtab.active {
  background: var(--bg-selected);
  color: var(--text-primary);
  border-color: var(--text-accent);
}

.content-tag {
  font-size: 9px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 3px;
}
.fmp4-tag {
  background: var(--content-fmp4-bg);
  color: var(--content-fmp4-color);
  cursor: default;
}
.framing-tag {
  background: var(--tag-neutral-bg);
  color: var(--text-secondary);
  font-weight: 400;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace;
}
.track-tag {
  background: var(--tag-track-bg);
  color: var(--text-warning);
}
.tag-track {
  background: var(--tag-track-bg);
  color: var(--text-warning);
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace;
}
.tag-group {
  background: var(--tag-group-bg);
  color: var(--tag-group-color);
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace;
}
.tag-priority {
  background: var(--tag-neutral-bg);
  color: var(--text-secondary);
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace;
}
.tag-info {
  background: var(--tag-neutral-bg);
  color: var(--text-secondary);
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace;
}

.viewer-size {
  margin-left: auto;
  color: var(--text-secondary);
  font-size: 10px;
}

.viewer-body {
  flex: 1;
  overflow: auto;
}

.json-container {
  padding: 8px;
}
</style>
