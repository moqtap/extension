<script lang="ts" setup>
import type { CliView, TabImpairment } from '@/src/cli/messages'
import { isOff, OFF, sameProfile, type ProfileChoice, type Profiles } from '@/src/cli/protocol'
import { computed, onMounted, ref, useId, watch } from 'vue'
import { PRO_URL, refusalUpgrade, sessionImpairmentProblem } from '../cli-copy'
import { cliHeader, menuTree, profileChoices, sessionProfile } from '../impair-choices'
import ImpairmentNodes from './ImpairmentNodes.vue'

const props = defineProps<{
  view: CliView | null
  tab: TabImpairment | null
  profiles: Profiles | null | undefined
  /** Show the tab's profiles. */
  forTab: boolean
  /** The CLI id of a connection whose profile can be picked here. */
  session: string | null
  /** How that connection is named in the menu. */
  sessionLabel?: string
}>()
const emit = defineEmits<{
  setProfile: [choice: ProfileChoice]
  setSessionProfile: [choice: ProfileChoice | null]
  readProfiles: []
}>()

onMounted(() => emit('readProfiles'))

/** The last profiles read, kept while they are read again so the items stay put. */
const known = ref(props.profiles)
watch(
  () => props.profiles,
  (p) => {
    if (p !== undefined) known.value = p
  },
)

const connected = computed(() => props.view?.state === 'connected')
const header = computed(() => cliHeader(props.view))

const tabCurrent = computed(() => props.tab?.profile ?? OFF)
const tabGroups = computed(() =>
  menuTree(profileChoices(known.value, props.tab && { name: props.tab.name, profile: props.tab.profile })),
)

const own = computed(() => (props.session === null ? null : sessionProfile(props.tab, props.session)))
const sessionGroups = computed(() => {
  const c = own.value
  return menuTree(profileChoices(known.value, c && c.own && c.profile !== null ? c : null))
})
const sessionProblem = computed(() =>
  props.session === null ? null : sessionImpairmentProblem(props.tab, props.session, props.view),
)
const sessionUpgrade = computed(() =>
  props.session === null ? null : refusalUpgrade(props.tab, props.view, props.session),
)

function sessionChecked(c: ProfileChoice): boolean {
  const p = own.value
  return p !== null && p.own && p.profile !== null && sameProfile(c.profile, p.profile)
}

/** Why the CLI could not read the sign-in, with what to do. */
const accountError = computed(() => known.value?.account.error ?? null)
const proId = useId()

const tabDisabled = (c: ProfileChoice) => !isOff(c.profile) && !connected.value
const tabChecked = (c: ProfileChoice) => sameProfile(c.profile, tabCurrent.value)
const sessionDisabled = () => !connected.value

function pickTab(c: ProfileChoice) {
  if (!connected.value && !isOff(c.profile)) return
  if (!sameProfile(c.profile, tabCurrent.value)) emit('setProfile', c)
}
function pickSession(c: ProfileChoice | null) {
  if (!connected.value) return
  if (c === null ? own.value?.own : !sessionChecked(c)) emit('setSessionProfile', c)
}
</script>

<template>
  <div class="mq-menu__label cli-line" role="none">{{ header }}</div>
  <template v-if="forTab">
    <hr role="separator" />
    <div v-if="session !== null" class="mq-menu__label" role="none">This tab</div>
    <template v-for="(group, g) in tabGroups" :key="g">
      <hr v-if="g > 0" role="separator" />
      <ImpairmentNodes :nodes="group" :checked="tabChecked" :disabled="tabDisabled" @pick="pickTab" />
    </template>
  </template>
  <template v-if="session !== null">
    <hr role="separator" />
    <div class="mq-menu__label" role="none">{{ sessionLabel ?? 'This connection' }}</div>
    <button
      class="mq-menu__item"
      role="menuitemradio"
      :aria-checked="own !== null && !own.own"
      :aria-disabled="!connected ? 'true' : undefined"
      @click="pickSession(null)"
    >
      Same as tab ({{ tab?.name ?? 'Off' }})
    </button>
    <template v-for="(group, g) in sessionGroups" :key="g">
      <hr v-if="g > 0" role="separator" />
      <ImpairmentNodes :nodes="group" :checked="sessionChecked" :disabled="sessionDisabled" @pick="pickSession" />
    </template>
    <div v-if="sessionProblem" class="mq-menu__label menu-note menu-problem" role="none">{{ sessionProblem }}</div>
    <a
      v-if="sessionUpgrade"
      class="mq-menu__item"
      role="menuitem"
      :href="sessionUpgrade.url"
      target="_blank"
      rel="noopener"
      >Upgrade to {{ sessionUpgrade.plan }}</a
    >
  </template>
  <template v-if="accountError">
    <hr role="separator" />
    <div class="mq-menu__label menu-note menu-problem" role="none">{{ accountError }}</div>
  </template>
  <template v-else-if="known?.more">
    <hr role="separator" />
    <div :id="proId" class="mq-menu__label menu-note" role="none">
      Pro runs your own scenarios here: networks that change on a timeline, in folders you arrange.
    </div>
    <a
      class="mq-menu__item"
      role="menuitem"
      :href="PRO_URL"
      target="_blank"
      rel="noopener"
      :aria-describedby="proId"
      >See plans</a
    >
  </template>
</template>

<style scoped>
.cli-line {
  max-width: 320px;
  overflow-wrap: anywhere;
  color: var(--ink-muted);
}
.menu-note {
  max-width: 280px;
  color: var(--ink-muted);
}
.popup-menu .menu-problem {
  color: var(--warning);
}
</style>
