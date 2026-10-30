<script lang="ts" setup>
import { computed, inject, nextTick, ref, watch } from 'vue'
import {
  type CatalogObjectRecord,
  type CatalogTrack,
  type CatalogView,
  packagingLabel,
  trackSummary,
} from '../catalogs'
import { formatBitrate, formatBytes, plural } from '../format'
import { catalogProblems, SESSION_PROBLEMS } from '../problems'
import JsonTree from './JsonTree.vue'
import Icon from './Icon.vue'
import ProblemList from './ProblemList.vue'

/**
 * What one catalog track says, as of the objects recorded so far: the tracks
 * it declares, the rules its objects break, its objects, and the catalog as
 * an independent catalog would now state it.
 */
const props = defineProps<{
  catalog: CatalogView
  /** An object to scroll to and mark */
  focus?: { groupId: number; objectId: number; seq: number } | null
}>()

const root = ref<HTMLElement | null>(null)
const objectsOpen = ref(false)

const session = inject(SESSION_PROBLEMS, null)

/** The session's rows about this catalog, as the Problems tab words them. */
const problems = computed(() =>
  session
    ? session.problems.value.filter((p) => p.subject.key === props.catalog.key)
    : catalogProblems([props.catalog], () => null),
)

/**
 * Objects in runs: an object joins the run before it when it is the same
 * kind and differs from the object before it in generatedAt at most.
 */
interface Run {
  first: CatalogObjectRecord
  rest: CatalogObjectRecord[]
  /** Every object after the first is identical, generatedAt included */
  identical: boolean
}

const runs = computed((): Run[] => {
  const out: Run[] = []
  for (const obj of props.catalog.objects) {
    const run = out[out.length - 1]
    const joins =
      run !== undefined &&
      obj.outcome !== 'refused' &&
      run.first.outcome !== 'refused' &&
      obj.kind === run.first.kind &&
      obj.changes !== null &&
      obj.changes.every((c) => c === 'generatedAt')
    if (joins) {
      run.rest.push(obj)
      if (obj.changes!.length > 0) run.identical = false
    } else {
      out.push({ first: obj, rest: [], identical: true })
    }
  }
  return out
})

const objectLabel = (o: { groupId: number; objectId: number }) =>
  `g${o.groupId} · o${o.objectId}`

const focusedRun = computed(() => {
  const f = props.focus
  if (!f) return -1
  return runs.value.findIndex((r) =>
    [r.first, ...r.rest].some(
      (o) => o.groupId === f.groupId && o.objectId === f.objectId,
    ),
  )
})

watch(
  () => props.focus,
  async (focus) => {
    if (!focus || focusedRun.value < 0) return
    objectsOpen.value = true
    await nextTick()
    root.value
      ?.querySelector(`[data-run="${focusedRun.value}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  },
  { immediate: true },
)

function onObjectsToggle(event: Event) {
  objectsOpen.value = (event.target as HTMLDetailsElement).open
}

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

/** `tracks` always, and MSF-01 `publishTracks` when the catalog has any. */
const trackLists = computed(() => {
  const lists = [{ title: 'Tracks', tracks: props.catalog.tracks }]
  if (props.catalog.publishTracks.length > 0) {
    lists.push({ title: 'Publish tracks', tracks: props.catalog.publishTracks })
  }
  return lists
})

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
    </div>

    <div
      v-if="catalog.incomplete.length > 0"
      class="mq-notice mq-notice--warning catalog-notice"
      role="status"
    >
      <Icon name="warning" class="mq-notice__icon" />
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

    <section v-if="problems.length > 0" class="catalog-section">
      <h3 class="catalog-heading">
        Problems
        <span class="mq-tab__count">{{ problems.length }}</span>
      </h3>
      <ProblemList
        embedded
        :problems="problems"
        :started-at="session?.startedAt() ?? 0"
        filter=""
        :session="session?.session.value ?? ''"
        :state-key="`${session?.stateKey() ?? ''}|${catalog.key}`"
        @open="(t) => session?.open(t)"
      />
    </section>

    <section v-if="catalog.objects.length > 0" class="catalog-section">
      <details :open="objectsOpen" @toggle="onObjectsToggle">
        <summary class="catalog-heading object-row">
          <Icon name="chevronRight" class="object-row__chevron" />
          Objects
          <span class="mq-tab__count">{{ catalog.objects.length }}</span>
        </summary>
        <ul class="catalog-objects">
          <li
            v-for="(run, i) in runs"
            :key="`${run.first.groupId}:${run.first.objectId}`"
            :data-run="i"
            :class="{ 'catalog-focused': focusedRun === i }"
          >
            <div class="catalog-object">
              <span class="mono">{{ objectLabel(run.first) }}</span>
              <span class="muted"
                >{{ run.first.kind }} · {{ formatBytes(run.first.size) }}</span
              >
              <template v-if="run.first.outcome === 'refused'">
                <span class="mq-badge mq-badge--error">Not applied</span>
                <span class="muted">A reader keeps the previous catalog.</span>
              </template>
            </div>
            <p v-if="run.first.changes?.length" class="catalog-object-note">
              Changes {{ run.first.changes.join(', ') }} from the object before
            </p>
            <p v-else-if="run.first.changes" class="catalog-object-note">
              Same as the object before
            </p>
            <p v-if="run.rest.length > 0" class="catalog-object-note">
              {{ plural(run.rest.length, 'more object', 'more objects') }},
              {{ objectLabel(run.rest[0]) }} –
              {{ objectLabel(run.rest[run.rest.length - 1]) }}: same as
              {{ objectLabel(run.first)
              }}{{ run.identical ? '' : ' apart from generatedAt' }}
            </p>
          </li>
        </ul>
      </details>
    </section>

    <section v-if="catalog.state.document" class="catalog-section">
      <details>
        <summary class="catalog-heading object-row">
          <Icon name="chevronRight" class="object-row__chevron" />
          Catalog as it stands
        </summary>
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
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
}
.catalog-object-note {
  margin: 0;
  color: var(--ink-muted);
}
summary.object-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.catalog-focused {
  background: var(--surface-selected);
}

.catalog-json {
  padding-top: var(--space-1);
}
</style>
