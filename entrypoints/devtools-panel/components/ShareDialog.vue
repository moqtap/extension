<script lang="ts" setup>
import { LibraryError, type LibraryClient } from '@/src/account/library'
import type { AccountView, OrgSummary } from '@/src/account/messages'
import type { Trace } from '@moqtap/trace'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { DEFAULT_SHARE_CONTENT } from '../redact-trace'
import {
  requestDataCollection,
  shareTrace,
  type ShareResult,
} from '../share-trace'
import type { SessionEntry } from '../use-inspector'
import { AccountTokenError } from '../use-account'
import Icon from './Icon.vue'

const props = defineProps<{
  session: SessionEntry
  view: AccountView | null
  library: LibraryClient
  buildTrace: (sessionId: string) => Promise<Trace | null>
}>()
const emit = defineEmits<{ close: []; signIn: []; refreshOrgs: [] }>()

const LINK_DAYS = [1, 7, 30, 90] as const

const orgs = computed<readonly OrgSummary[]>(() =>
  props.view?.status === 'signed-in'
    ? props.view.orgs.filter((o) => o.role !== 'viewer')
    : [],
)
const orgId = ref<string>('')
const org = computed(() => orgs.value.find((o) => o.id === orgId.value) ?? null)
const audience = ref<'link' | 'org'>('link')
const days = ref<number>(7)
const includePayloads = ref(DEFAULT_SHARE_CONTENT.payloads)
const includeAuth = ref(DEFAULT_SHARE_CONTENT.auth)

function defaultTitle(s: SessionEntry): string {
  let host = s.url
  try {
    host = new URL(s.url).host
  } catch {
    // Keep the raw URL.
  }
  return `${host} · draft-${s.draft ?? 'unknown'}`.slice(0, 200)
}
const title = ref(defaultTitle(props.session))

type Phase = 'form' | 'building' | 'uploading' | 'sharing' | 'done'
const phase = ref<Phase>('form')
const error = ref<string | null>(null)
const result = ref<ShareResult | null>(null)
const copied = ref(false)

const dialogEl = ref<HTMLElement | null>(null)
const titleEl = ref<HTMLInputElement | null>(null)

onMounted(() => {
  emit('refreshOrgs')
  void nextTick(() =>
    (titleEl.value ?? dialogEl.value?.querySelector<HTMLElement>('button'))?.focus(),
  )
})

watch(
  orgs,
  (list) => {
    if (!list.some((o) => o.id === orgId.value)) orgId.value = list[0]?.id ?? ''
  },
  { immediate: true },
)
watch(org, (o) => {
  if (o?.kind === 'personal') audience.value = 'link'
})

const orgLabel = (o: OrgSummary) => (o.kind === 'personal' ? `Personal (@${o.slug})` : o.name)

function message(err: unknown): string {
  if (err instanceof AccountTokenError) return err.message
  if (err instanceof LibraryError) {
    if (err.code === 'storage_quota') return 'This library is full. Delete traces or wait for them to expire.'
    if (err.code === 'too_large') return `${err.message}. Try without payloads.`
    if (err.code === 'access_revoked') return 'This browser can no longer share to this library. Choose another one.'
    if (err.status === 403) return "Your role in this library can't upload. Choose another library."
    if (err.status === 429) return 'Too many uploads just now. Try again in a minute.'
    if (err.status >= 500) return "moqtap couldn't be reached. Try again in a moment."
    return err.message
  }
  return 'Upload failed. Check your connection and try again.'
}

function submit() {
  if (org.value === null) return
  // Inside the click, before any await: Firefox asks for consent here.
  const consent = requestDataCollection(includeAuth.value)
  void run(consent)
}

async function run(consent: Promise<boolean>) {
  error.value = null
  if (!(await consent)) {
    error.value =
      'Sharing needs permission to send the capture to moqtap. Allow it when the browser asks.'
    return
  }
  phase.value = 'building'
  try {
    const trace = await props.buildTrace(props.session.sessionId)
    if (trace === null) throw new Error('not a MoQT session')
    result.value = await shareTrace(
      props.library,
      {
        trace,
        draft: props.session.draft ?? null,
        content: { payloads: includePayloads.value, auth: includeAuth.value },
        controlStreams: new Set(
          [...props.session.streams.values()]
            .filter((s) => s.isControl)
            .map((s) => BigInt(s.streamId)),
        ),
        orgId: org.value!.id,
        title: title.value.trim() === '' ? null : title.value.trim(),
        audience: audience.value === 'link' ? { kind: 'link', days: days.value } : { kind: 'org' },
      },
      (step) => {
        phase.value = step
      },
    )
    phase.value = 'done'
  } catch (err) {
    console.warn('[moqtap] share failed', err)
    error.value = message(err)
    phase.value = 'form'
  }
}

let copiedTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(copiedTimer))

async function copyLink() {
  const url = result.value?.share.url
  if (!url) return
  try {
    await navigator.clipboard.writeText(url)
    copied.value = true
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied.value = false), 1600)
  } catch {
    // The field stays selectable.
  }
}

/** The link's lifetime, as chosen; the share was created moments ago. */
const expiryText = computed(() =>
  days.value === 1 ? 'Expires in 1 day' : `Expires in ${days.value} days`,
)

const busy = computed(() => phase.value !== 'form' && phase.value !== 'done')
const busyText = computed(
  () =>
    ({ building: 'Building trace…', uploading: 'Uploading…', sharing: 'Creating share…' })[
      phase.value as 'building' | 'uploading' | 'sharing'
    ] ?? '',
)
</script>

<template>
  <div class="mq-scrim share-backdrop" @click.self="!busy && emit('close')">
    <div
      ref="dialogEl"
      class="mq-dialog share-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-title"
      @keydown.esc="!busy && emit('close')"
    >
      <h2 id="share-title" class="mq-dialog__title">Share trace</h2>

      <template v-if="view?.status !== 'signed-in'">
        <p class="mq-dialog__body">
          Sign in to upload and share this session. Capture and inspection
          work without an account.
        </p>
        <div class="mq-dialog__actions">
          <button class="mq-btn mq-btn--secondary" @click="emit('close')">
            Cancel
          </button>
          <button class="mq-btn mq-btn--primary" @click="emit('signIn')">
            {{
              view?.status === 'signed-out' && view.signingIn
                ? 'Signing in…'
                : 'Sign in'
            }}
          </button>
        </div>
      </template>

      <template v-else-if="phase === 'done' && result">
        <template v-if="result.share.url">
          <div class="mq-once">
            <span class="mq-label">Link created</span>
            <div class="mq-linkbox">
              <input
                class="mq-linkbox__value"
                readonly
                aria-label="Share link"
                :value="result.share.url"
                @focus="($event.target as HTMLInputElement).select()"
              />
              <button
                class="mq-btn mq-btn--secondary mq-copy"
                :data-state="copied ? 'copied' : undefined"
                @click="copyLink"
              >
                <Icon name="copy" />
                {{ copied ? 'Copied' : 'Copy' }}
              </button>
            </div>
            <p class="mq-once__note">You won't see this link again. Copy it now.</p>
          </div>
          <div class="mq-row">
            <span class="mq-badge mq-badge--link">Anyone with the link</span>
            <span class="mq-expiry">{{ expiryText }}</span>
          </div>
          <span class="mq-sr" aria-live="polite">{{ copied ? 'Copied' : '' }}</span>
        </template>
        <p v-else class="mq-dialog__body">
          Shared with the members of {{ org ? orgLabel(org) : 'the library' }}.
        </p>
        <div class="mq-dialog__actions">
          <button class="mq-btn mq-btn--primary" @click="emit('close')">
            {{ result.share.url ? "I've copied it" : 'Done' }}
          </button>
        </div>
      </template>

      <form v-else class="share-form" @submit.prevent="submit">
        <div v-if="orgs.length === 0" class="mq-notice mq-notice--warning" role="status">
          <span class="mq-notice__icon" aria-hidden="true">▲</span>
          <p>
            None of the libraries this browser can use lets you upload. Ask
            for a member role, or share from your personal library.
          </p>
        </div>
        <div class="mq-field">
          <label class="mq-label" for="share-library">Library</label>
          <select
            id="share-library"
            v-model="orgId"
            class="mq-select"
            :disabled="busy"
          >
            <option v-for="o in orgs" :key="o.id" :value="o.id">
              {{ orgLabel(o) }}
            </option>
          </select>
        </div>
        <div class="mq-field">
          <label class="mq-label" for="share-title-input">Title</label>
          <input
            id="share-title-input"
            ref="titleEl"
            v-model="title"
            class="mq-input share-input"
            maxlength="200"
            :disabled="busy"
          />
        </div>
        <fieldset class="mq-fieldset" :disabled="busy">
          <legend class="mq-label">Who can open it</legend>
          <div class="share-choice">
            <label class="mq-check">
              <input v-model="audience" type="radio" value="link" />
              <span>Anyone with the link, for</span>
            </label>
            <select
              v-model.number="days"
              class="mq-select share-days"
              aria-label="Link lifetime"
              :disabled="audience !== 'link'"
            >
              <option v-for="d in LINK_DAYS" :key="d" :value="d">
                {{ d }} day{{ d === 1 ? '' : 's' }}
              </option>
            </select>
          </div>
          <label class="mq-check">
            <input
              v-model="audience"
              type="radio"
              value="org"
              :disabled="org?.kind !== 'team'"
            />
            <span>
              Members of this library
              <span v-if="org?.kind !== 'team'" class="mq-check__desc">
                Only for team libraries.</span
              >
            </span>
          </label>
        </fieldset>
        <fieldset class="mq-fieldset" :disabled="busy">
          <legend class="mq-label">Include</legend>
          <label class="mq-toggle">
            <span>
              <span class="toggle-label">Object payloads</span>
              <span class="mq-help">Media and application data the far end sent.</span>
            </span>
            <input v-model="includePayloads" type="checkbox" role="switch" />
          </label>
          <label class="mq-toggle">
            <span>
              <span class="toggle-label">Authorization tokens</span>
              <span class="mq-help">Tokens in SETUP and request parameters, and the URL query.</span>
            </span>
            <input v-model="includeAuth" type="checkbox" role="switch" />
          </label>
        </fieldset>
        <div v-if="includePayloads" class="mq-notice mq-notice--warning" role="status">
          <span class="mq-notice__icon" aria-hidden="true">▲</span>
          <p>
            Payloads can hold media and data the far end sent. Everyone you
            share the trace with can read them.
          </p>
        </div>
        <div v-if="includeAuth" class="mq-notice mq-notice--warning" role="status">
          <span class="mq-notice__icon" aria-hidden="true">▲</span>
          <p>
            Everyone you share the trace with can read these tokens, including
            the one in the page's WebTransport URL.
          </p>
        </div>
        <div v-if="error" class="mq-notice mq-notice--error share-error" role="alert">
          <span class="mq-notice__icon" aria-hidden="true">✕</span>
          <p>{{ error }}</p>
        </div>
        <div class="mq-dialog__actions">
          <span v-if="busy" class="share-busy" role="status">{{ busyText }}</span>
          <button
            type="button"
            class="mq-btn mq-btn--secondary"
            :disabled="busy"
            @click="emit('close')"
          >
            Cancel
          </button>
          <button
            type="submit"
            class="mq-btn mq-btn--primary"
            :disabled="busy || org === null"
          >
            Upload and share
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.share-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-dialog);
}

.share-dialog {
  max-height: calc(100% - var(--space-8));
  overflow-y: auto;
  padding: var(--space-4);
  gap: var(--space-3);
}

.share-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.share-choice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.share-days {
  width: auto;
}

.mq-toggle > span {
  display: flex;
  flex-direction: column;
}
.toggle-label {
  font-weight: 500;
}

.share-busy {
  margin-right: auto;
  color: var(--ink-muted);
}
</style>
