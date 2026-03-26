<script lang="ts" setup>
import { ref, computed, watch } from 'vue';
import HexViewer from './HexViewer.vue';
import JsonTree from './JsonTree.vue';
import type { StreamContentType, TrackEntry } from '../use-inspector';
import { parseStreamFraming, extractAllPayloads } from '../stream-framing';
import type { HeaderTag } from '../stream-framing';
import { getCachedPref, savePref } from '../prefs';

const props = defineProps<{
  data: Uint8Array;
  contentType: StreamContentType;
  /** Whether this stream belongs to a MoQT session (enables framing parsing) */
  isMoqt?: boolean;
  /** Draft version string for draft-specific parsing (e.g. '14') */
  draft?: string;
  /** Track registry for resolving trackAlias in framing header */
  tracks?: Map<string, TrackEntry>;
}>();

type ViewMode = 'hex' | 'json';

/** User's preferred mode — persisted across sessions */
const preferredMode = getCachedPref('streamViewMode') as ViewMode;

/**
 * Effective view mode. Starts as the preferred mode if JSON content is
 * available, otherwise falls back to hex while keeping the preference intact.
 */
const viewMode = ref<ViewMode>(
  preferredMode === 'json' && props.contentType === 'json' ? 'json' : 'hex',
);

/** Lazily parsed JSON — only computed when needed */
const jsonData = ref<unknown | null>(null);
const jsonParsed = ref(false);

/** MoQT framing info */
const framing = computed(() => {
  if (!props.isMoqt) return null;
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


function parseJson(): unknown | null {
  if (jsonParsed.value) return jsonData.value;
  jsonParsed.value = true;

  // Strategy 1: If we have MoQT framing, extract payloads and try those
  const f = framing.value;
  if (f && f.objects.length > 0) {
    const payloads = extractAllPayloads(props.data, f);
    const results: unknown[] = [];
    for (const payload of payloads) {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
        results.push(JSON.parse(text));
      } catch {
        // Not JSON — skip
      }
    }
    if (results.length === 1) {
      jsonData.value = results[0];
      return jsonData.value;
    } else if (results.length > 1) {
      jsonData.value = results;
      return jsonData.value;
    }
  }

  // Strategy 2: Scan for JSON start byte and try from there
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
  if (pref === 'json' && props.contentType === 'json') {
    // Try to parse; show JSON if it works, otherwise fall back to hex
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

// Auto-open JSON on first render if preferred
if (preferredMode === 'json' && props.contentType === 'json') {
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
        v-if="contentType === 'json'"
        class="vtab"
        :class="{ active: viewMode === 'json' }"
        @click="switchToJson"
      >
        JSON
      </button>
      <span v-if="contentType === 'fmp4'" class="content-tag fmp4-tag">fMP4</span>
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
