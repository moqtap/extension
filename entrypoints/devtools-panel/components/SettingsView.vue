<script lang="ts" setup>
import type { CliView, TrustedCli } from '@/src/cli/messages'
import type { ExclusionEntry } from '@/src/messaging/types'
import { computed, nextTick, onMounted, ref } from 'vue'
import { START_COMMAND } from '../cli-copy'
import { shortFingerprint } from '../impair-choices'
import CopyButton from './CopyButton.vue'
import Icon from './Icon.vue'

/** The panel's settings, as DevTools' own: a page of sections, closed back to the connections. */
const props = defineProps<{
  view: CliView | null
  trusted: readonly TrustedCli[]
  exclusions: Record<string, ExclusionEntry>
}>()
const emit = defineEmits<{
  close: []
  allow: [identity: string]
  forget: [identity: string]
  addExclusion: [origin: string]
  removeExclusion: [origin: string]
}>()

const closeBtn = ref<HTMLButtonElement | null>(null)
onMounted(() => void nextTick(() => closeBtn.value?.focus()))

const found = computed(() =>
  props.view?.state === 'connected' ||
  props.view?.state === 'confirm' ||
  props.view?.state === 'declined' ||
  props.view?.state === 'not-allowed'
    ? props.view
    : null,
)
const notAllowed = computed(() => (props.view?.state === 'not-allowed' ? props.view : null))
const allowCommand = computed(() =>
  notAllowed.value ? `MOQTAP_BRIDGE_EXTENSION_IDS=${notAllowed.value.extensionId}` : '',
)
const connected = computed(() => props.view?.state === 'connected')
const origins = computed(() => Object.keys(props.exclusions).sort())

const newOrigin = ref('')
const originError = ref<string | null>(null)
function addOrigin() {
  const value = newOrigin.value.trim()
  if (!value) return
  try {
    emit('addExclusion', new URL(value.includes('://') ? value : `https://${value}`).origin)
    newOrigin.value = ''
    originError.value = null
  } catch {
    originError.value = 'That is not an origin. Enter one like https://example.com.'
  }
}
</script>

<template>
  <section class="settings" aria-labelledby="settings-title" @keydown.esc="emit('close')">
    <div class="tool-bar settings-bar">
      <h2 id="settings-title" class="settings-title">Settings</h2>
      <button
        ref="closeBtn"
        class="mq-btn mq-btn--quiet mq-btn--icon"
        aria-label="Close settings"
        title="Close settings"
        @click="emit('close')"
      >
        <Icon name="x" />
      </button>
    </div>
    <div class="settings-body">
      <section class="settings-section" aria-labelledby="settings-cli">
        <h3 id="settings-cli" class="settings-heading">moqtap CLI</h3>
        <template v-if="found">
          <p>
            Version {{ found.cliVersion }}, identity <span class="mq-mono">{{ shortFingerprint(found.fingerprint) }}</span>
          </p>
          <p v-if="connected" class="mq-muted">This browser sends impaired tabs' connections through it.</p>
          <template v-else-if="notAllowed">
            <p class="mq-muted">It doesn't accept this build of the extension. Restart it with:</p>
            <div class="settings-command">
              <code class="mq-mono">{{ allowCommand }}</code>
              <CopyButton :value="allowCommand" what="setting" />
            </div>
          </template>
          <template v-else>
            <p class="mq-muted">
              Check that the identity matches what <code>moqtap cert</code> prints, then allow it to impair
              this browser's tabs.
            </p>
            <div>
              <button class="mq-btn mq-btn--primary" @click="emit('allow', found.identity)">Allow</button>
            </div>
          </template>
        </template>
        <p v-else-if="view?.state === 'unsupported'">This browser cannot verify the moqtap CLI.</p>
        <template v-else>
          <p>Not running. Start it with:</p>
          <div class="settings-command">
            <code class="mq-mono">{{ START_COMMAND }}</code>
            <CopyButton :value="START_COMMAND" what="command" />
          </div>
        </template>
      </section>

      <section class="settings-section" aria-labelledby="settings-allowed">
        <h3 id="settings-allowed" class="settings-heading">Allowed CLI identities</h3>
        <p class="mq-muted">These moqtap CLIs can impair this browser's tabs. One you remove has to be allowed again.</p>
        <ul v-if="trusted.length > 0" class="settings-list">
          <li v-for="t in trusted" :key="t.identity" class="settings-entry">
            <span class="mq-mono entry-main">{{ shortFingerprint(t.fingerprint) }}</span>
            <span class="mq-muted">Allowed {{ new Date(t.at).toLocaleDateString() }}</span>
            <button class="mq-btn mq-btn--secondary" @click="emit('forget', t.identity)">Remove</button>
          </li>
        </ul>
        <p v-else>None.</p>
      </section>

      <section class="settings-section" aria-labelledby="settings-workers">
        <h3 id="settings-workers" class="settings-heading">Worker exclusions</h3>
        <p class="mq-muted">
          Workers on these sites run untouched: the connections they open aren't captured or impaired. A site
          is added here when its security policy keeps moqtap out of its workers.
        </p>
        <ul v-if="origins.length > 0" class="settings-list">
          <li v-for="origin in origins" :key="origin" class="settings-entry">
            <span class="mq-mono entry-main">{{ origin }}</span>
            <span class="mq-muted">{{ exclusions[origin]!.source === 'auto' ? 'Added automatically' : 'Added by you' }}</span>
            <button class="mq-btn mq-btn--secondary" @click="emit('removeExclusion', origin)">Remove</button>
          </li>
        </ul>
        <form class="settings-add" @submit.prevent="addOrigin">
          <label class="mq-sr" for="settings-origin">Origin to exclude</label>
          <input
            id="settings-origin"
            v-model="newOrigin"
            placeholder="https://example.com"
            class="mq-input mq-input--mono"
            :aria-invalid="originError ? 'true' : undefined"
            aria-describedby="settings-origin-error"
          />
          <button type="submit" class="mq-btn mq-btn--secondary">Add origin</button>
        </form>
        <p v-if="originError" id="settings-origin-error" class="mq-error-text">{{ originError }}</p>
      </section>
    </div>
  </section>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--bg);
}
.settings-bar {
  justify-content: space-between;
  padding-left: var(--space-3);
}
.settings-title {
  margin: 0;
  font-size: inherit;
  font-weight: 600;
}
.settings-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding: var(--space-3) var(--space-3) var(--space-5);
  overflow-y: auto;
}
.settings-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-width: 640px;
}
.settings-heading {
  margin: 0;
  font-size: inherit;
  font-weight: 600;
}
.settings-command,
.settings-add {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.settings-add .mq-input {
  flex: 0 1 280px;
  min-width: 0;
}
.settings-list {
  list-style: none;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.settings-entry {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-3);
}
.entry-main {
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
