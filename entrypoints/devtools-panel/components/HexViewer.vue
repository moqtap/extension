<script lang="ts" setup>
import { computed, ref, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import type { StreamObject } from '../stream-framing';

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
/** Fixed row height derived from CSS: 11px font × 1.6 line-height + 2×1px padding */
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

interface HexRow {
  offset: number;
  hex: string[];
  ascii: string;
  kinds: ByteKind[];
}

const totalRows = computed(() => Math.ceil(props.data.length / BYTES_PER_ROW));

// ── Virtual scroll state ──────────────────────────────────────────
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

// ── Visible row range ─────────────────────────────────────────────
const startRow = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN));
const endRow = computed(() =>
  Math.min(totalRows.value, Math.ceil((scrollTop.value + viewportHeight.value) / ROW_HEIGHT) + OVERSCAN),
);

const topSpacer = computed(() => startRow.value * ROW_HEIGHT);
const bottomSpacer = computed(() => (totalRows.value - endRow.value) * ROW_HEIGHT);

/**
 * Precompute per-byte annotation only for the visible byte range.
 * For small data (<64KB) we annotate everything once; for larger data
 * we only annotate the visible slice to avoid O(n) work on every scroll.
 */
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

  // Mark stream header bytes within range
  const headerEnd = Math.min(hs, len, to);
  for (let i = Math.max(from, 0); i < headerEnd; i++) {
    kinds[i - from] = 'header';
  }

  // Mark object regions within range
  if (objs && objs.length > 0) {
    for (let idx = 0; idx < objs.length; idx++) {
      const obj = objs[idx];
      const payloadKind: ByteKind = idx % 2 === 0 ? 'even' : 'odd';

      // Object framing bytes
      const framingEnd = Math.min(obj.payloadOffset, len, to);
      for (let i = Math.max(obj.offset, from); i < framingEnd; i++) {
        kinds[i - from] = 'framing';
      }

      // Object payload bytes
      const payloadEnd = Math.min(obj.payloadOffset + obj.payloadLength, len, to);
      for (let i = Math.max(obj.payloadOffset, from); i < payloadEnd; i++) {
        kinds[i - from] = payloadKind;
      }
    }
  }

  return kinds;
}

/** Build HexRow objects only for the visible range */
const visibleRows = computed<HexRow[]>(() => {
  const d = props.data;
  const sr = startRow.value;
  const er = endRow.value;
  const byteStart = sr * BYTES_PER_ROW;
  const byteEnd = Math.min(er * BYTES_PER_ROW, d.length);

  // Get annotation for the visible byte range
  let kinds: ByteKind[];
  let kindsOffset: number;
  if (fullByteKinds.value) {
    kinds = fullByteKinds.value;
    kindsOffset = 0;
  } else {
    kinds = computeByteKinds(byteStart, byteEnd);
    kindsOffset = byteStart;
  }

  const result: HexRow[] = [];
  for (let r = sr; r < er; r++) {
    const offset = r * BYTES_PER_ROW;
    const slice = d.subarray(offset, Math.min(offset + BYTES_PER_ROW, d.length));
    const hex: string[] = [];
    const rowKinds: ByteKind[] = [];
    let ascii = '';
    for (let j = 0; j < BYTES_PER_ROW; j++) {
      if (j < slice.length) {
        hex.push(slice[j].toString(16).padStart(2, '0'));
        ascii += slice[j] >= 0x20 && slice[j] <= 0x7e ? String.fromCharCode(slice[j]) : '.';
        rowKinds.push(kinds[offset + j - kindsOffset]);
      } else {
        hex.push('  ');
        ascii += ' ';
        rowKinds.push('none');
      }
    }
    result.push({ offset, hex, ascii, kinds: rowKinds });
  }
  return result;
});

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
    <div ref="scrollContainer" class="hex-body" @scroll="onScroll">
      <div :style="{ height: topSpacer + 'px' }" />
      <div v-for="row in visibleRows" :key="row.offset" class="hex-row">
        <span class="hex-offset">{{ formatOffset(row.offset) }}</span>
        <span class="hex-bytes">
          <span
            v-for="(b, j) in row.hex"
            :key="j"
            class="hex-byte"
            :class="byteClass(row.kinds[j], j)"
          >{{ b }}</span>
        </span>
        <span class="hex-ascii">{{ row.ascii }}</span>
      </div>
      <div :style="{ height: bottomSpacer + 'px' }" />
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
}

.hex-body {
  flex: 1;
  overflow-y: auto;
  padding: 2px 0;
  min-width: fit-content;
}

.hex-row {
  display: flex;
  gap: 12px;
  padding: 1px 10px;
  line-height: 1.6;
}
.hex-row:hover {
  background: var(--bg-hover);
}

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
  font-size: 10px;
  background: var(--bg-tertiary);
}
</style>
