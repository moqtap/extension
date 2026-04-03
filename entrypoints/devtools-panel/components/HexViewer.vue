<script lang="ts" setup>
import { computed, ref, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import type { StreamObject } from '../stream-framing';
import { detectMediaInfo } from '@/src/detect/bmff-boxes';

const props = withDefaults(defineProps<{
  data: Uint8Array;
  /** Number of leading bytes that are MoQT protocol framing (dimmed in display) */
  headerSize?: number;
  /** Parsed object boundaries for per-object annotation */
  objects?: StreamObject[];
}>(), {
  headerSize: 0,
});

const BYTES_PER_ROW = 16;
/** Fixed row height — enforced via CSS `height` + `box-sizing: border-box` on both
 *  `.hex-row` and `.hex-banner` to guarantee uniform virtual-scroll rows. */
const ROW_HEIGHT = 20;
/** Extra rows rendered above/below the visible viewport to avoid flicker during scroll */
const OVERSCAN = 10;

/**
 * Per-byte annotation:
 *   'header'  — stream-level protocol header (dimmed)
 *   'framing' — per-object framing bytes (objectId, length varints — dimmed)
 *   'even'    — payload byte in an even-indexed object
 *   'odd'     — payload byte in an odd-indexed object
 *   'none'    — no annotation
 */
type ByteKind = 'header' | 'framing' | 'even' | 'odd' | 'none';

// ── Per-object media annotation ──────────────────────────────────
interface ObjectAnnotation {
  objectId: number;
  payloadSize: number;
  boxes: string[] | null;
  variant: string | null;
}

const objectAnnotations = computed((): ObjectAnnotation[] => {
  if (!props.objects) return [];
  return props.objects.map((obj) => {
    const end = Math.min(obj.payloadOffset + obj.payloadLength, props.data.length);
    const payload = end > obj.payloadOffset
      ? props.data.subarray(obj.payloadOffset, end)
      : null;
    const media = payload && payload.length >= 8 ? detectMediaInfo(payload) : null;
    return {
      objectId: obj.objectId,
      payloadSize: obj.payloadLength,
      boxes: media?.boxes ?? null,
      variant: media?.variant ?? null,
    };
  });
});

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const VARIANT_LABELS: Record<string, string> = {
  cmaf: 'CMAF',
  loc: 'LOC',
  fmp4: 'fMP4',
};

/** Box description without "obj N" prefix — for inline banners */
function formatBannerContent(ann: ObjectAnnotation): string {
  const parts: string[] = [];
  if (ann.boxes && ann.boxes.length > 0) {
    const varLabel = ann.variant ? VARIANT_LABELS[ann.variant] ?? '' : '';
    parts.push(varLabel ? `${varLabel}: ${ann.boxes.join(' + ')}` : ann.boxes.join(' + '));
  }
  parts.push(formatSize(ann.payloadSize));
  return parts.join(' \u00b7 ');
}

/** Full label including "obj N" — for sticky overlay */
function formatBannerLabel(ann: ObjectAnnotation): string {
  return `obj ${ann.objectId} \u00b7 ${formatBannerContent(ann)}`;
}

// ── Banner row positions ─────────────────────────────────────────
interface BannerPosition {
  dataRow: number;     // data row this banner appears before
  virtualRow: number;  // virtual row index (accounts for prior banners)
  objectIdx: number;   // index into props.objects
}

const bannerPositions = computed((): BannerPosition[] => {
  if (!props.objects || props.objects.length < 2) return [];

  const positions: BannerPosition[] = [];
  for (let i = 0; i < props.objects.length; i++) {
    const dataRow = Math.floor(props.objects[i].offset / BYTES_PER_ROW);
    positions.push({ dataRow, virtualRow: 0, objectIdx: i });
  }
  // Sort by data row then object index (should already be in order)
  positions.sort((a, b) => a.dataRow - b.dataRow || a.objectIdx - b.objectIdx);
  // Compute virtual positions: virtual = dataRow + index (each prior banner shifts by 1)
  for (let i = 0; i < positions.length; i++) {
    positions[i].virtualRow = positions[i].dataRow + i;
  }
  return positions;
});

// ── Virtual scroll state ─────────────────────────────────────────
const totalDataRows = computed(() => Math.ceil(props.data.length / BYTES_PER_ROW));
const totalVirtualRows = computed(() => totalDataRows.value + bannerPositions.value.length);

const scrollContainer = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(400);

function onScroll() {
  if (!scrollContainer.value) return;
  scrollTop.value = scrollContainer.value.scrollTop;
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  if (scrollContainer.value) {
    viewportHeight.value = scrollContainer.value.clientHeight;
    resizeObserver = new ResizeObserver(() => {
      if (scrollContainer.value) {
        viewportHeight.value = scrollContainer.value.clientHeight;
      }
    });
    resizeObserver.observe(scrollContainer.value);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
});

// Reset scroll when data changes
watch(() => props.data, () => {
  scrollTop.value = 0;
  nextTick(() => {
    if (scrollContainer.value) scrollContainer.value.scrollTop = 0;
  });
});

// ── Virtual row mapping ──────────────────────────────────────────
type ResolvedRow =
  | { type: 'banner'; bannerIdx: number }
  | { type: 'data'; dataRow: number };

function resolveVirtualRow(vRow: number): ResolvedRow {
  const positions = bannerPositions.value;
  let bannersBeforeOrAt = 0;
  for (let i = 0; i < positions.length; i++) {
    if (positions[i].virtualRow === vRow) {
      return { type: 'banner', bannerIdx: i };
    }
    if (positions[i].virtualRow < vRow) {
      bannersBeforeOrAt = i + 1;
    } else {
      break;
    }
  }
  return { type: 'data', dataRow: vRow - bannersBeforeOrAt };
}

// ── Visible row range ────────────────────────────────────────────
const startVRow = computed(() =>
  Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN),
);
const endVRow = computed(() =>
  Math.min(totalVirtualRows.value, Math.ceil((scrollTop.value + viewportHeight.value) / ROW_HEIGHT) + OVERSCAN),
);

const topSpacer = computed(() => startVRow.value * ROW_HEIGHT);
const bottomSpacer = computed(() => Math.max(0, (totalVirtualRows.value - endVRow.value) * ROW_HEIGHT));

// ── Byte annotation ─────────────────────────────────────────────
const FULL_ANNOTATION_THRESHOLD = 65536;

const fullByteKinds = computed<ByteKind[] | null>(() => {
  if (props.data.length > FULL_ANNOTATION_THRESHOLD) return null;
  return computeByteKinds(0, props.data.length);
});

function computeByteKinds(from: number, to: number): ByteKind[] {
  const len = props.data.length;
  const size = to - from;
  const kinds: ByteKind[] = new Array(size).fill('none');
  const hs = props.headerSize;
  const objs = props.objects;

  const headerEnd = Math.min(hs, len, to);
  for (let i = Math.max(from, 0); i < headerEnd; i++) {
    kinds[i - from] = 'header';
  }

  if (objs && objs.length > 0) {
    for (let idx = 0; idx < objs.length; idx++) {
      const obj = objs[idx];
      const payloadKind: ByteKind = idx % 2 === 0 ? 'even' : 'odd';

      const framingEnd = Math.min(obj.payloadOffset, len, to);
      for (let i = Math.max(obj.offset, from); i < framingEnd; i++) {
        kinds[i - from] = 'framing';
      }

      const payloadEnd = Math.min(obj.payloadOffset + obj.payloadLength, len, to);
      for (let i = Math.max(obj.payloadOffset, from); i < payloadEnd; i++) {
        kinds[i - from] = payloadKind;
      }
    }
  }

  return kinds;
}

// ── Visible entries ──────────────────────────────────────────────
type DataEntry = {
  type: 'data';
  offset: number;
  hex: string[];
  ascii: string;
  kinds: ByteKind[];
};
type BannerEntry = {
  type: 'banner';
  objectIdx: number;
  /** Content description (boxes, size) for inline display */
  content: string;
  /** Full label including "obj N" for sticky overlay */
  label: string;
  /** Byte column (0-15) where the object starts on the next hex row */
  byteColumn: number;
};
type VisibleEntry = DataEntry | BannerEntry;

const visibleEntries = computed<VisibleEntry[]>(() => {
  const d = props.data;
  const sv = startVRow.value;
  const ev = endVRow.value;

  // Resolve all virtual rows first to determine data row range for annotations
  const resolved: ResolvedRow[] = [];
  let minDataRow = Infinity;
  let maxDataRow = -1;
  for (let v = sv; v < ev; v++) {
    const r = resolveVirtualRow(v);
    resolved.push(r);
    if (r.type === 'data') {
      if (r.dataRow < minDataRow) minDataRow = r.dataRow;
      if (r.dataRow > maxDataRow) maxDataRow = r.dataRow;
    }
  }

  // Compute byte annotations for visible data range
  let kinds: ByteKind[];
  let kindsOffset: number;
  if (fullByteKinds.value) {
    kinds = fullByteKinds.value;
    kindsOffset = 0;
  } else if (minDataRow <= maxDataRow) {
    const byteStart = minDataRow * BYTES_PER_ROW;
    const byteEnd = Math.min((maxDataRow + 1) * BYTES_PER_ROW, d.length);
    kinds = computeByteKinds(byteStart, byteEnd);
    kindsOffset = byteStart;
  } else {
    kinds = [];
    kindsOffset = 0;
  }

  // Build entries
  const entries: VisibleEntry[] = [];
  const annotations = objectAnnotations.value;

  for (const r of resolved) {
    if (r.type === 'banner') {
      const pos = bannerPositions.value[r.bannerIdx];
      const ann = annotations[pos.objectIdx];
      const obj = props.objects![pos.objectIdx];
      entries.push({
        type: 'banner',
        objectIdx: pos.objectIdx,
        content: ann ? formatBannerContent(ann) : formatSize(obj.payloadLength),
        label: ann ? formatBannerLabel(ann) : `obj ${obj.objectId}`,
        byteColumn: obj.offset % BYTES_PER_ROW,
      });
    } else {
      const offset = r.dataRow * BYTES_PER_ROW;
      const slice = d.subarray(offset, Math.min(offset + BYTES_PER_ROW, d.length));
      const hex: string[] = [];
      const rowKinds: ByteKind[] = [];
      let ascii = '';
      for (let j = 0; j < BYTES_PER_ROW; j++) {
        if (j < slice.length) {
          hex.push(slice[j].toString(16).padStart(2, '0'));
          ascii += slice[j] >= 0x20 && slice[j] <= 0x7e ? String.fromCharCode(slice[j]) : '.';
          rowKinds.push(kinds[offset + j - kindsOffset] ?? 'none');
        } else {
          hex.push('  ');
          ascii += ' ';
          rowKinds.push('none');
        }
      }
      entries.push({ type: 'data', offset, hex, ascii, kinds: rowKinds });
    }
  }
  return entries;
});

// ── Sticky object overlay ────────────────────────────────────────
interface StickyInfo {
  label: string;
  /** Index in bannerPositions (for navigation) */
  bannerIdx: number;
  totalObjects: number;
}

/**
 * Always-visible navigation bar when objects with BMFF detection exist.
 * Label section is empty when the current object's inline banner is
 * visible in the scroll viewport; shows object info once the banner has
 * scrolled above the viewport.
 */
const stickyInfo = computed((): StickyInfo | null => {
  const positions = bannerPositions.value;
  if (positions.length < 2) return null;

  // Account for BODY_PAD_TOP: when we scroll to `vRow * ROW_HEIGHT - 2`,
  // the banner is visually at the top but scrollTop puts us just below the
  // previous row boundary. Adding the padding tolerance ensures we consider
  // that banner as "reached".
  const firstVisibleVRow = Math.floor((scrollTop.value + BODY_PAD_TOP) / ROW_HEIGHT);

  // Find the last banner at or above the top of the viewport
  let currentIdx = -1;
  for (let i = 0; i < positions.length; i++) {
    if (positions[i].virtualRow <= firstVisibleVRow) {
      currentIdx = i;
    } else {
      break;
    }
  }

  // Show label only when the banner has scrolled ABOVE the viewport
  let label = '';
  if (currentIdx >= 0 && positions[currentIdx].virtualRow < firstVisibleVRow) {
    // Verify this object's data is still visible (next banner hasn't also scrolled past)
    const nextBannerVRow = currentIdx + 1 < positions.length
      ? positions[currentIdx + 1].virtualRow
      : totalVirtualRows.value;

    if (nextBannerVRow > firstVisibleVRow) {
      const pos = positions[currentIdx];
      const ann = objectAnnotations.value[pos.objectIdx];
      label = ann ? formatBannerLabel(ann) : `obj ${pos.objectIdx}`;
    }
  }

  return {
    label,
    bannerIdx: currentIdx,
    totalObjects: positions.length,
  };
});

/**
 * Scroll so the target object's inline banner is at the top of the scroll
 * viewport (directly below the sticky bar, which is a separate element).
 * Subtracts the body's top padding (2px) so the banner has the same visual
 * gap as the first object at the top of the list.
 */
const BODY_PAD_TOP = 2; // must match .hex-body padding-top

function scrollToObject(bannerIdx: number) {
  const positions = bannerPositions.value;
  if (bannerIdx < 0 || bannerIdx >= positions.length) return;
  const el = scrollContainer.value;
  if (!el) return;
  el.scrollTop = Math.max(0, positions[bannerIdx].virtualRow * ROW_HEIGHT - BODY_PAD_TOP);
}

// ── Helpers ──────────────────────────────────────────────────────
function formatOffset(n: number): string {
  return n.toString(16).padStart(8, '0');
}

function byteClass(kind: ByteKind, colIdx: number): Record<string, boolean> {
  return {
    'hex-gap': colIdx === 7,
    'hex-proto': kind === 'header' || kind === 'framing',
    'hex-obj-even': kind === 'even',
    'hex-obj-odd': kind === 'odd',
  };
}

function entryKey(entry: VisibleEntry, _idx: number): string {
  if (entry.type === 'banner') return `b${entry.objectIdx}`;
  return `d${entry.offset}`;
}
</script>

<template>
  <div class="hex-viewer">
    <div class="hex-header-row">
      <span class="hex-offset">Offset</span>
      <span class="hex-bytes">
        <span v-for="i in 16" :key="i" class="hex-byte" :class="{ 'hex-gap': i - 1 === 7 }">{{ (i - 1).toString(16).padStart(2, '0').toUpperCase() }}</span>
      </span>
      <span class="hex-ascii">ASCII</span>
    </div>
    <div class="hex-body-wrapper">
      <div v-if="stickyInfo" class="hex-sticky">
        <span class="sticky-nav">
          <button
            class="sticky-nav-btn"
            :disabled="stickyInfo.bannerIdx < 0"
            @click="scrollToObject(stickyInfo.bannerIdx <= 0 ? 0 : stickyInfo.bannerIdx - 1)"
          >&lsaquo;</button>
          <span class="sticky-nav-pos">{{ stickyInfo.bannerIdx >= 0 ? stickyInfo.bannerIdx + 1 : '\u2013' }}/{{ stickyInfo.totalObjects }}</span>
          <button
            class="sticky-nav-btn"
            :disabled="stickyInfo.bannerIdx >= stickyInfo.totalObjects - 1"
            @click="scrollToObject(stickyInfo.bannerIdx + 1)"
          >&rsaquo;</button>
        </span>
        <span v-if="stickyInfo.label" class="banner-text">{{ stickyInfo.label }}</span>
      </div>
      <div ref="scrollContainer" class="hex-body" @scroll="onScroll">
        <div :style="{ height: topSpacer + 'px' }" />
        <template v-for="(entry, idx) in visibleEntries" :key="entryKey(entry, idx)">
          <div v-if="entry.type === 'banner'" class="hex-banner">
            <span class="banner-content">{{ entry.content }}</span>
            <span class="banner-indicator">
              <span
                v-for="col in 16"
                :key="col"
                class="hex-byte"
                :class="{ 'hex-gap': col - 1 === 7, 'indicator-visible': col - 1 === entry.byteColumn }"
              >{{ col - 1 === entry.byteColumn ? '\u25be' : '' }}</span>
            </span>
          </div>
          <div v-else class="hex-row">
            <span class="hex-offset">{{ formatOffset(entry.offset) }}</span>
            <span class="hex-bytes">
              <span
                v-for="(b, j) in entry.hex"
                :key="j"
                class="hex-byte"
                :class="byteClass(entry.kinds[j], j)"
              >{{ b }}</span>
            </span>
            <span class="hex-ascii">{{ entry.ascii }}</span>
          </div>
        </template>
        <div :style="{ height: bottomSpacer + 'px' }" />
      </div>
    </div>
    <div class="hex-footer">
      {{ data.length }} bytes<template v-if="headerSize > 0"> ({{ headerSize }}B header<template v-if="objects && objects.length > 0">, {{ objects.length }} obj{{ objects.length !== 1 ? 's' : '' }}</template>)</template>
    </div>
  </div>
</template>

<style scoped>
.hex-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace;
  font-size: 11px;
  overflow-x: auto;
}

.hex-header-row {
  display: flex;
  gap: 12px;
  padding: 4px 10px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border);
  color: var(--text-secondary);
  font-weight: 600;
  position: sticky;
  top: 0;
  min-width: fit-content;
  flex-shrink: 0;
}

.hex-body-wrapper {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.hex-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 0;
  min-width: fit-content;
}

.hex-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 10px;
  height: 20px;
  box-sizing: border-box;
}
.hex-row:hover {
  background: var(--bg-hover);
}

/* ── Object boundary banner ───────────────────────────────────── */

.hex-banner {
  position: relative;
  display: flex;
  align-items: center;
  /* 8px + 2px border-left = 10px, matching .hex-row padding-left;
     then 72px offset column + 12px gap to align content with hex bytes */
  padding: 0 10px 0 calc(8px + 72px + 12px);
  height: 20px;
  box-sizing: border-box;
  background: var(--bg-tertiary);
  color: var(--content-fmp4-color);
  font-size: 10px;
  border-left: 2px solid var(--content-fmp4-color);
  user-select: none;
  min-width: fit-content;
}

.banner-content {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.banner-indicator {
  position: absolute;
  bottom: -6px;
  /* Align with hex-bytes: padding-left already accounts for offset column */
  left: calc(8px + 2px + 72px + 12px);
  display: flex;
  gap: 4px;
  font-size: 9px;
  line-height: 1;
  pointer-events: none;
}
.banner-indicator .hex-byte {
  color: transparent;
}
.banner-indicator .indicator-visible {
  color: var(--content-fmp4-color);
  position: relative;
  left: -1.7px;
}

/* ── Sticky object overlay ────────────────────────────────────── */

.hex-sticky {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 1px 10px;
  line-height: 1.6;
  background: var(--bg-tertiary);
  color: var(--content-fmp4-color);
  font-size: 10px;
  border-left: 2px solid var(--content-fmp4-color);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  user-select: none;
  min-width: fit-content;
}

.sticky-nav {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 72px;
  flex-shrink: 0;
}

.sticky-nav-btn {
  background: none;
  border: 1px solid var(--border);
  border-radius: 2px;
  color: var(--content-fmp4-color);
  cursor: pointer;
  padding: 0 4px;
  font-size: 12px;
  line-height: 1.3;
  font-family: inherit;
}
.sticky-nav-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.sticky-nav-btn:disabled {
  opacity: 0.3;
  cursor: default;
}

.sticky-nav-pos {
  font-size: 10px;
  color: var(--text-secondary);
  min-width: 28px;
  text-align: center;
}

/* ── Hex content ──────────────────────────────────────────────── */

.hex-offset {
  color: var(--text-secondary);
  min-width: 72px;
}

.hex-bytes {
  display: flex;
  gap: 4px;
  min-width: 400px;
}

.hex-byte {
  width: 18px;
  text-align: center;
}
.hex-gap {
  margin-right: 6px;
}

/** Protocol header & per-object framing bytes are dimmed */
.hex-proto {
  color: var(--text-secondary);
  opacity: 0.5;
}

/** Even-indexed object payloads — default color (no extra styling) */
.hex-obj-even {
  /* default text color — no modification needed */
}

/** Odd-indexed object payloads — subtle tint to distinguish from even */
.hex-obj-odd {
  color: var(--hex-obj-odd);
}

.hex-ascii {
  color: var(--text-success);
  white-space: pre;
  letter-spacing: 1px;
}

.hex-footer {
  padding: 4px 10px;
  border-top: 1px solid var(--border);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 16.8px;
  background: var(--bg-tertiary);
  flex-shrink: 0;
}
</style>
