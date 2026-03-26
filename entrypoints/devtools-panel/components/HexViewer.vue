<script lang="ts" setup>
import { computed } from 'vue';
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

/**
 * Per-byte annotation:
 *   'header'  — stream-level protocol header (dimmed)
 *   'framing' — per-object framing bytes (objectId, length varints — dimmed)
 *   'even'    — payload byte in an even-indexed object
 *   'odd'     — payload byte in an odd-indexed object
 *   'none'    — no annotation
 */
type ByteKind = 'header' | 'framing' | 'even' | 'odd' | 'none';

/** Precompute per-byte annotation for the entire data buffer */
const byteKinds = computed<ByteKind[]>(() => {
  const len = props.data.length;
  const kinds: ByteKind[] = new Array(len).fill('none');
  const hs = props.headerSize;
  const objs = props.objects;

  // Mark stream header bytes
  for (let i = 0; i < Math.min(hs, len); i++) {
    kinds[i] = 'header';
  }

  // Mark object regions
  if (objs && objs.length > 0) {
    for (let idx = 0; idx < objs.length; idx++) {
      const obj = objs[idx];
      const payloadKind: ByteKind = idx % 2 === 0 ? 'even' : 'odd';

      // Object framing bytes (between obj.offset and obj.payloadOffset)
      for (let i = obj.offset; i < Math.min(obj.payloadOffset, len); i++) {
        kinds[i] = 'framing';
      }

      // Object payload bytes
      const payloadEnd = Math.min(obj.payloadOffset + obj.payloadLength, len);
      for (let i = obj.payloadOffset; i < payloadEnd; i++) {
        kinds[i] = payloadKind;
      }
    }
  }

  return kinds;
});

interface HexRow {
  offset: number;
  hex: string[];
  ascii: string;
  kinds: ByteKind[];
}

const rows = computed<HexRow[]>(() => {
  const result: HexRow[] = [];
  const d = props.data;
  const allKinds = byteKinds.value;
  for (let i = 0; i < d.length; i += BYTES_PER_ROW) {
    const slice = d.subarray(i, Math.min(i + BYTES_PER_ROW, d.length));
    const hex: string[] = [];
    const kinds: ByteKind[] = [];
    let ascii = '';
    for (let j = 0; j < BYTES_PER_ROW; j++) {
      if (j < slice.length) {
        hex.push(slice[j].toString(16).padStart(2, '0'));
        ascii += slice[j] >= 0x20 && slice[j] <= 0x7e ? String.fromCharCode(slice[j]) : '.';
        kinds.push(allKinds[i + j]);
      } else {
        hex.push('  ');
        ascii += ' ';
        kinds.push('none');
      }
    }
    result.push({ offset: i, hex, ascii, kinds });
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
    <div class="hex-body">
      <div v-for="row in rows" :key="row.offset" class="hex-row">
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
}

.hex-body {
  flex: 1;
  overflow-y: auto;
  padding: 2px 0;
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
