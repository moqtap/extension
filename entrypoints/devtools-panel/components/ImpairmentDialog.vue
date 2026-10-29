<script lang="ts" setup>
import type { CliView, TabImpairment } from '@/src/cli/messages'
import { isOff, OFF, sameProfile, type ProfileChoice, type Profiles } from '@/src/cli/protocol'
import { computed, nextTick, onMounted, ref } from 'vue'
import { DIRECT_NOTICE, impairmentProblem, PRO_URL, START_COMMAND } from '../cli-copy'
import CopyButton from './CopyButton.vue'

const props = defineProps<{
  view: CliView | null
  tab: TabImpairment | null
  /** The CLI's answer to GET profiles; undefined while it is read. */
  profiles: Profiles | null | undefined
  /** Open connections in the tab bypass the CLI. */
  direct: boolean
}>()
const emit = defineEmits<{
  close: []
  setProfile: [choice: ProfileChoice]
  allow: [identity: string]
  readProfiles: []
}>()

const dialogEl = ref<HTMLElement | null>(null)
onMounted(() => {
  emit('readProfiles')
  void nextTick(() => dialogEl.value?.querySelector<HTMLElement>('input:checked, button')?.focus())
})

const found = computed(() =>
  props.view?.state === 'connected' || props.view?.state === 'confirm' || props.view?.state === 'declined'
    ? props.view
    : null,
)
const connected = computed(() => props.view?.state === 'connected')
const current = computed(() => props.tab?.profile ?? OFF)
const choices = computed<readonly ProfileChoice[]>(() => {
  const out = [...(props.profiles?.profiles ?? [])]
  if (!out.some((c) => isOff(c.profile))) out.unshift({ name: 'Off', profile: OFF })
  const tab = props.tab
  if (tab !== null && !out.some((c) => sameProfile(c.profile, tab.profile))) {
    out.push({ name: tab.name, profile: tab.profile })
  }
  return out
})
/** Why the CLI could not read the sign-in, with what to do. */
const accountError = computed(() => props.profiles?.account.error ?? null)
const problem = computed(() => impairmentProblem(props.tab, props.view))
const showDirect = computed(() => props.direct && !isOff(current.value))

function choose(c: ProfileChoice) {
  if (!sameProfile(c.profile, current.value)) emit('setProfile', c)
}
</script>

<template>
  <div class="mq-scrim impair-backdrop" @click.self="emit('close')">
    <div
      ref="dialogEl"
      class="mq-dialog impair-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="impair-title"
      @keydown.esc="emit('close')"
    >
      <h2 id="impair-title" class="mq-dialog__title">Impairment</h2>

      <section class="impair-cli" aria-label="moqtap CLI">
        <template v-if="found">
          <p class="mq-dialog__body">
            moqtap CLI {{ found.cliVersion }}, identity
            <span class="mq-mono">{{ found.fingerprint }}</span>
          </p>
          <template v-if="!connected">
            <p class="mq-dialog__body">
              Check that the identity matches what <code>moqtap cert</code> prints, then allow
              moqtap to send this tab's connections through it.
            </p>
            <div class="mq-row">
              <button class="mq-btn mq-btn--primary" @click="emit('allow', found.identity)">
                Allow
              </button>
            </div>
          </template>
        </template>
        <p v-else-if="view?.state === 'unsupported'" class="mq-dialog__body">
          This browser cannot verify the moqtap CLI. Update it to use impairment.
        </p>
        <template v-else>
          <p class="mq-dialog__body">The moqtap CLI isn't running. Start it with:</p>
          <div class="impair-command">
            <code class="mq-mono">{{ START_COMMAND }}</code>
            <CopyButton :value="START_COMMAND" what="command" />
          </div>
        </template>
      </section>

      <fieldset class="mq-fieldset">
        <legend class="mq-label">Profile for this tab</legend>
        <label v-for="c in choices" :key="c.name" class="mq-check">
          <input
            type="radio"
            name="impair-profile"
            :checked="sameProfile(c.profile, current)"
            :disabled="!isOff(c.profile) && !connected"
            @change="choose(c)"
          />
          <span>{{ c.name }}</span>
        </label>
      </fieldset>
      <div v-if="accountError" class="mq-notice mq-notice--warning" role="status">
        <span class="mq-notice__icon" aria-hidden="true">▲</span>
        <p>{{ accountError }}</p>
      </div>
      <a v-else-if="profiles?.more" class="mq-link" :href="PRO_URL" target="_blank" rel="noopener">More profiles with Pro</a>

      <div v-if="problem" class="mq-notice mq-notice--warning" role="status">
        <span class="mq-notice__icon" aria-hidden="true">▲</span>
        <p>{{ problem }}</p>
      </div>
      <div v-if="showDirect" class="mq-notice mq-notice--info" role="status">
        <span class="mq-notice__icon" aria-hidden="true">i</span>
        <p>{{ DIRECT_NOTICE }} Reload the page to impair them.</p>
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
.impair-cli {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.impair-command {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
</style>
