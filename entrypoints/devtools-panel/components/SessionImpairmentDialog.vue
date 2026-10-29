<script lang="ts" setup>
import type { CliView, TabImpairment } from '@/src/cli/messages'
import { sameProfile, type ProfileChoice, type Profiles } from '@/src/cli/protocol'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { sessionImpairmentProblem } from '../cli-copy'
import { profileChoices, sessionProfile } from '../impair-choices'

const props = defineProps<{
  view: CliView | null
  tab: TabImpairment | null
  profiles: Profiles | null | undefined
  /** The session's id at the CLI. */
  session: string
}>()
const emit = defineEmits<{
  close: []
  /** null: the tab's profile. */
  setProfile: [choice: ProfileChoice | null]
  readProfiles: []
}>()

const dialogEl = ref<HTMLElement | null>(null)
onMounted(() => {
  emit('readProfiles')
  void nextTick(() => dialogEl.value?.querySelector<HTMLElement>('input:checked:not(:disabled), button')?.focus())
})

const connected = computed(() => props.view?.state === 'connected')
const current = computed(() => sessionProfile(props.tab, props.session))
const choices = computed(() => {
  const c = current.value
  return profileChoices(props.profiles, c.own && c.profile !== null ? c : null)
})

const problem = computed(() => sessionImpairmentProblem(props.tab, props.session, props.view))

/** The checked radio: '' for the tab's profile, else a choice's name; null for none. */
function currentKey(): string | null {
  const p = current.value.profile
  if (!current.value.own) return ''
  return p === null ? null : (choices.value.find((c) => sameProfile(c.profile, p))?.name ?? null)
}
const picked = ref(currentKey())
// Every answer from the background resets the radios, so a pick the CLI did not take is unchecked again.
watch(
  () => props.tab,
  () => (picked.value = currentKey()),
)

function isCurrent(c: ProfileChoice): boolean {
  const p = current.value.profile
  return current.value.own && p !== null && sameProfile(c.profile, p)
}

function choose(c: ProfileChoice | null) {
  if (c === null ? current.value.own : !isCurrent(c)) emit('setProfile', c)
}
</script>

<template>
  <div class="mq-scrim impair-backdrop" @click.self="emit('close')">
    <div
      ref="dialogEl"
      class="mq-dialog impair-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="session-impair-title"
      @keydown.esc="emit('close')"
    >
      <h2 id="session-impair-title" class="mq-dialog__title">Impairment</h2>
      <fieldset class="mq-fieldset">
        <legend class="mq-label">Profile for this connection</legend>
        <label class="mq-check">
          <input
            type="radio"
            name="session-impair-profile"
            v-model="picked"
            value=""
            :disabled="!connected"
            @change="choose(null)"
          />
          <span>Same as tab ({{ tab?.name ?? 'Off' }})</span>
        </label>
        <label v-for="c in choices" :key="c.name" class="mq-check">
          <input
            type="radio"
            name="session-impair-profile"
            v-model="picked"
            :value="c.name"
            :disabled="!connected"
            @change="choose({ name: c.name, profile: c.profile })"
          />
          <span>{{ c.name }}</span>
        </label>
      </fieldset>
      <div v-if="problem" class="mq-notice mq-notice--warning" role="status">
        <span class="mq-notice__icon" aria-hidden="true">▲</span>
        <p>{{ problem }}</p>
      </div>
      <div class="mq-dialog__actions">
        <button class="mq-btn mq-btn--secondary" @click="emit('close')">Close</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.impair-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-dialog);
}
.impair-dialog {
  max-height: calc(100% - var(--space-8));
  overflow-y: auto;
  padding: var(--space-4);
  gap: var(--space-3);
}
</style>
