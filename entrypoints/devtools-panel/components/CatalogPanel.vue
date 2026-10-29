<script lang="ts" setup>
import { computed, nextTick, ref, watch } from 'vue'
import {
  type CatalogTrack,
  type CatalogView,
  packagingLabel,
  trackSummary,
} from '../catalogs'
import { formatBitrate, formatBytes, plural } from '../format'
import JsonTree from './JsonTree.vue'

/**
 * What one catalog track says, as of the objects recorded so far: the tracks
 * it declares, each object with the rules it broke, and the catalog as an
 * independent catalog would now state it.
 */
const props = defineProps<{
  catalog: CatalogView
  /** An object to scroll to and mark */
  focus?: { groupId: number; objectId: number; seq: number } | null
}>()

const root = ref<HTMLElement | null>(null)
const focused = computed(() =>
  props.focus ? `${props.focus.groupId}:${props.focus.objectId}` : null,
)

watch(
  () => props.focus,
  async (focus) => {
    if (!focus) return
    await nextTick()
    root.value
      ?.querySelector(`[data-object="${focus.groupId}:${focus.objectId}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  },
  { immediate: true },
)

const DRAFT_LABELS: Record<string, string> = {
  'msf-00': 'MSF-00',
  'msf-01': 'MSF-01',
  'cmsf-00': 'CMSF-00',
  'cmsf-01': 'CMSF-01',
}

const draftLabel = computed(() => {
  const { draft, candidates } = props.catalog.state
  const drafts = draft ? [draft] : candidates
  return drafts.length ? drafts.map((d) => DRAFT_LABELS[d] ?? d).join(' or ') : null
})

const errorCount = computed(() =>
  props.catalog.objects.reduce((n, obj) => n + obj.problems.length, 0),
)

/** `tracks` always, and MSF-01 `publishTracks` when the catalog has any. */
const trackLists = computed(() => {
  const lists = [{ title: 'Tracks', tracks: props.catalog.tracks }]
  if (props.catalog.publishTracks.length > 0) {
    lists.push({ title: 'Publish tracks', tracks: props.catalog.publishTracks })
  }
  return lists
})

/** Objects worth a line of their own: anything other than a clean apply. */
const notableObjects = computed(() =>
  props.catalog.objects.filter(
    (o) => o.outcome !== 'applied' || o.problems.length > 0,
  ),
)

const OUTCOME_LABELS: Record<string, string> = {
  applied: 'applied',
  refused: 'refused',
  skipped: 'not applied',
}

const OUTCOME_CLASSES: Record<string, string> = {
  applied: 'mq-badge--ok',
  refused: 'mq-badge--error',
  skipped: 'mq-badge--check',
}

/** A track's namespace, shown only where it is not the catalog's own. */
function ownNamespace(track: CatalogTrack): string | null {
  if (track.namespace == null || track.namespace === props.catalog.namespace) {
    return null
  }
  return track.namespace
}

function bitrate(track: CatalogTrack): string {
  const bps = track.bitrate ?? track.avgBitrate
  return bps == null ? '—' : formatBitrate(bps)
}

function live(track: CatalogTrack): string {
  if (track.isLive == null) return '—'
  return track.isLive ? 'live' : 'ended'
}

/** The rest of a track, for a tooltip: what the row has no room for. */
function trackTitle(track: CatalogTrack): string {
  const parts: string[] = []
  if (track.mimeType) parts.push(track.mimeType)
  if (track.label) parts.push(`label ${track.label}`)
  if (track.lang) parts.push(`lang ${track.lang}`)
  if (track.renderGroup != null) parts.push(`render group ${track.renderGroup}`)
  if (track.altGroup != null) parts.push(`alt group ${track.altGroup}`)
  if (track.depends.length > 0)
    parts.push(`depends ${track.depends.join(', ')}`)
  if (track.initData) parts.push(`init ${formatBytes(track.initData.length)}`)
  if (track.encryptionScheme)
    parts.push(`encrypted (${track.encryptionScheme})`)
  return parts.join(' · ')
}
</script>

<template>
  <div ref="root" class="catalog-panel">
    <div class="catalog-summary">
      <span class="mq-badge mq-badge--mono" :title="catalog.namespace">{{
        catalog.namespace
          ? `${catalog.namespace} / ${catalog.name}`
          : catalog.name
      }}</span>
      <span v-if="draftLabel" class="mq-badge mq-badge--draft">{{
        draftLabel
      }}</span>
      <span
        v-if="catalog.state.isComplete"
        class="mq-badge mq-badge--ok"
        title="The catalog said isComplete: no track will be added"
        >complete</span
      >
      <span
        v-if="catalog.incomplete.length > 0"
        class="mq-badge mq-badge--check"
        :title="catalog.incomplete.join('\n')"
        >incomplete</span
      >
      <span class="mq-badge mq-badge--mono">{{
        plural(catalog.objects.length, 'object')
      }}</span>
      <span v-if="errorCount > 0" class="mq-badge mq-badge--error">{{
        plural(errorCount, 'error')
      }}</span>
    </div>

    <div
      v-if="catalog.incomplete.length > 0"
      class="mq-notice mq-notice--warning catalog-notice"
      role="status"
    >
      <span class="mq-notice__icon" aria-hidden="true">▲</span>
      <div>
        <p class="mq-notice__title">Not every catalog object was recorded</p>
        <p v-for="(reason, i) in catalog.incomplete" :key="i">{{ reason }}</p>
      </div>
    </div>

    <section
      v-for="list in trackLists"
      :key="list.title"
      class="catalog-section"
    >
      <h3 class="catalog-heading">
        {{ list.title }}
        <span class="mq-tab__count">{{ list.tracks.length }}</span>
      </h3>
      <p v-if="list.tracks.length === 0" class="catalog-empty">
        {{
          catalog.state.document
            ? 'The catalog declares no tracks.'
            : 'No catalog has been read yet.'
        }}
      </p>
      <table v-else class="mq-table catalog-tracks">
        <thead>
          <tr>
            <th>Track</th>
            <th>Packaging</th>
            <th>Role</th>
            <th>Format</th>
            <th class="mq-r">Bitrate</th>
            <th>Live</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="track in list.tracks"
            :key="`${track.namespace}/${track.name}`"
            :title="trackTitle(track) || undefined"
          >
            <td class="mono">
              <span v-if="ownNamespace(track)" class="muted"
                >{{ ownNamespace(track) }} / </span
              >{{ track.name }}
            </td>
            <td>
              <span v-if="track.packaging" class="mq-badge mq-badge--mono">{{
                packagingLabel(track.packaging)
              }}</span>
              <template v-else>—</template>
            </td>
            <td>{{ track.role ?? '—' }}</td>
            <td class="mono">{{ trackSummary(track) || '—' }}</td>
            <td class="mono mq-r">{{ bitrate(track) }}</td>
            <td>{{ live(track) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="notableObjects.length > 0" class="catalog-section">
      <h3 class="catalog-heading">
        Objects
        <span class="mq-tab__count">{{ notableObjects.length }}</span>
      </h3>
      <ul class="catalog-objects">
        <li
          v-for="obj in notableObjects"
          :key="`${obj.groupId}:${obj.objectId}`"
          :data-object="`${obj.groupId}:${obj.objectId}`"
          :class="{ 'catalog-focused': focused === `${obj.groupId}:${obj.objectId}` }"
        >
          <div class="catalog-object">
            <span class="mono">g{{ obj.groupId }} · o{{ obj.objectId }}</span>
            <span class="muted"
              >{{ obj.kind }} · {{ formatBytes(obj.size) }}</span
            >
            <span class="mq-badge" :class="OUTCOME_CLASSES[obj.outcome]">{{
              OUTCOME_LABELS[obj.outcome]
            }}</span>
          </div>
          <ul v-if="obj.problems.length > 0" class="problem-list">
            <li
              v-for="(p, i) in obj.problems"
              :key="i"
              class="problem"
              :class="`problem--${p.severity}`"
            >
              <span class="problem__glyph"
                ><span aria-hidden="true">✕</span
                ><span class="mq-sr">Error</span></span
              >
              <span class="problem__text">
                <span class="problem__title">{{ p.message }}</span>
                <span class="problem__detail"
                  ><template v-if="p.path"
                    ><span class="mono">{{ p.path }}</span> · </template
                  >{{ p.section }}</span
                >
              </span>
            </li>
          </ul>
        </li>
      </ul>
    </section>

    <section v-if="catalog.state.document" class="catalog-section">
      <details>
        <summary class="catalog-heading">Catalog as it stands</summary>
        <div class="catalog-json">
          <JsonTree :data="catalog.state.document" :initial-expanded="true" />
        </div>
      </details>
    </section>
  </div>
</template>

<style scoped>
.catalog-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-2);
}

.catalog-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
}

.catalog-notice p + p {
  margin-top: var(--space-1);
}

.catalog-heading {
  font-family: var(--type-tool-label-family);
  font-size: var(--type-tool-label-size);
  line-height: var(--type-tool-label-line);
  font-weight: var(--type-tool-label-weight);
  color: var(--ink-muted);
  margin-bottom: var(--space-1);
}
summary.catalog-heading {
  cursor: pointer;
}

.catalog-empty {
  color: var(--ink-muted);
}

.catalog-tracks {
  font-size: var(--type-data-size);
}
.catalog-tracks th,
.catalog-tracks td {
  padding-left: var(--space-2);
  padding-right: var(--space-2);
  white-space: nowrap;
}

.mono {
  font-family: var(--font-mono);
}
.muted {
  color: var(--ink-muted);
}

.catalog-objects {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.catalog-object {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}
.catalog-focused {
  background: var(--surface-selected);
}

/* One line per problem, as the Details tab lists a session's. */
.problem-list {
  list-style: none;
  padding: 0 0 0 var(--space-3);
  margin: var(--space-1) 0 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.problem {
  display: grid;
  grid-template-columns: 1em 1fr;
  gap: var(--space-2);
  align-items: baseline;
}
.problem__glyph {
  text-align: center;
}
.problem--error .problem__glyph {
  color: var(--danger);
}
.problem--warning .problem__glyph {
  color: var(--warning);
}
.problem__text {
  min-width: 0;
  overflow-wrap: anywhere;
}
.problem__detail {
  display: block;
  color: var(--ink-muted);
}

.catalog-json {
  padding-top: var(--space-1);
}
</style>
