<script lang="ts" setup>
import type { AccountNotice, AccountView } from '@/src/account/messages'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import Icon from './Icon.vue'

const props = defineProps<{ view: AccountView | null; compact?: boolean }>()
const emit = defineEmits<{ signIn: []; disconnect: [] }>()

const menuOpen = ref(false)
const root = ref<HTMLElement | null>(null)
const menuItem = ref<HTMLButtonElement | null>(null)

const NOTICES: Record<AccountNotice, string> = {
  revoked: 'Signed out from another device.',
  'app-signed-out': 'Signed out on moqtap.',
  'sign-in-failed': "Sign-in didn't finish. Try again.",
  'disconnect-unconfirmed':
    "Disconnected here, but moqtap couldn't be reached. Remove this browser under Devices on moqtap too.",
}

const notice = computed(() =>
  props.view?.status === 'signed-out' && props.view.notice !== null
    ? NOTICES[props.view.notice]
    : null,
)

const label = computed(() => {
  const v = props.view
  if (v?.status !== 'signed-in') return ''
  return v.handle !== null ? `@${v.handle}` : 'Signed in'
})

const initials = computed(() => {
  const v = props.view
  if (v?.status !== 'signed-in' || v.handle === null) return '?'
  return v.handle.slice(0, 2).toUpperCase()
})

const chipTitle = computed(() =>
  props.view?.status === 'signed-in' && props.view.unreachable
    ? `Signed in as ${label.value}. moqtap can't be reached right now.`
    : `Signed in as ${label.value}`,
)

function onDocPointer(e: PointerEvent) {
  if (root.value && !root.value.contains(e.target as Node)) menuOpen.value = false
}
function onDocKey(e: KeyboardEvent) {
  if (e.key === 'Escape') menuOpen.value = false
}
watch(menuOpen, (open) => {
  if (open) {
    document.addEventListener('pointerdown', onDocPointer)
    document.addEventListener('keydown', onDocKey)
    void nextTick(() => menuItem.value?.focus())
  } else {
    document.removeEventListener('pointerdown', onDocPointer)
    document.removeEventListener('keydown', onDocKey)
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer)
  document.removeEventListener('keydown', onDocKey)
})

function disconnect() {
  menuOpen.value = false
  emit('disconnect')
}
</script>

<template>
  <div v-if="view" ref="root" class="account" :class="{ compact }">
    <template v-if="view.status === 'signed-out'">
      <button
        class="mq-btn mq-btn--secondary account-btn"
        :class="compact ? 'mq-btn--icon' : 'mq-btn--block'"
        :aria-label="compact ? (view.signingIn ? 'Signing in…' : 'Sign in') : undefined"
        :title="
          view.signingIn
            ? 'Finish signing in in the moqtap tab, or click to open it again'
            : 'Sign in to share traces. Capture and inspection work without an account.'
        "
        @click="emit('signIn')"
      >
        <Icon v-if="compact" name="logIn" />
        <template v-else>{{ view.signingIn ? 'Signing in…' : 'Sign in' }}</template>
      </button>
      <p v-if="notice && !compact" class="account-notice" role="status">
        {{ notice }}
      </p>
    </template>
    <template v-else>
      <!--
        Compact, the chip shows only the initials. Its name is the hidden line
        rather than an aria-label, so the name never omits text on screen.
      -->
      <button
        class="account-chip"
        :title="chipTitle"
        aria-haspopup="menu"
        :aria-expanded="menuOpen"
        @click="menuOpen = !menuOpen"
      >
        <span class="mq-avatar mq-avatar--sm" aria-hidden="true">{{ initials }}</span>
        <span v-if="!compact" class="account-label mq-mono">{{ label }}</span>
        <span v-else class="mq-sr">{{ chipTitle }}</span>
        <span
          v-if="view.unreachable"
          class="account-warn"
          :aria-hidden="compact ? 'true' : undefined"
          >▲<span v-if="!compact" class="mq-sr"> moqtap can't be reached</span></span
        >
      </button>
      <div v-if="menuOpen" class="mq-menu account-menu" role="menu">
        <button
          ref="menuItem"
          class="mq-menu__item account-menu-item"
          role="menuitem"
          @click="disconnect"
        >
          Disconnect this browser
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.account {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
  border-top: 1px solid var(--line);
}
.account.compact {
  align-items: center;
  padding: var(--space-2) var(--space-1);
}

.account-chip {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  max-width: 100%;
  height: var(--control-tool);
  padding: 0 var(--space-1) 0 2px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-full);
  background: var(--surface);
  cursor: pointer;
  align-self: flex-start;
}
.compact .account-chip {
  align-self: center;
  padding: 0 2px;
}
.account-chip:hover {
  background: var(--surface-hover);
}

/* The small avatar's initials at the panel's smallest type size rather than
   the component's 10px: nothing in the panel goes below data-xs. */
.account-chip .mq-avatar--sm {
  font-size: var(--type-data-xs-size);
}

.account-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-warn {
  color: var(--warning);
}

.account-notice {
  color: var(--ink-muted);
}

.account-menu {
  position: absolute;
  bottom: calc(100% - var(--space-1));
  left: var(--space-2);
  margin: 0;
  min-width: 200px;
  z-index: var(--z-menu);
}
.account-menu-item {
  width: 100%;
  border: 0;
  background: transparent;
  text-align: left;
}
</style>
