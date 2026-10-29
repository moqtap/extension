<script lang="ts" setup>
import { APP_ORIGIN } from '@/src/account/config'
import type { AccountNotice, AccountView } from '@/src/account/messages'
import { computed, ref } from 'vue'
import Icon from './Icon.vue'
import PopupMenu from './PopupMenu.vue'

const props = defineProps<{ view: AccountView | null }>()
const emit = defineEmits<{ signIn: []; disconnect: [] }>()

const open = ref(false)
/** The account's pages on moqtap. */
const DASHBOARD_URL = `${APP_ORIGIN}/insight`
const ACCOUNT_URL = `${APP_ORIGIN}/account`
const btn = ref<HTMLButtonElement | null>(null)

const NOTICES: Record<AccountNotice, string> = {
  revoked: 'Signed out from another device.',
  'app-signed-out': 'Signed out on moqtap.',
  'sign-in-failed': "Sign-in didn't finish. Try again.",
  'disconnect-unconfirmed':
    "Disconnected here, but moqtap couldn't be reached. Remove this browser under Devices on moqtap too.",
}

const notice = computed(() =>
  props.view?.status === 'signed-out' && props.view.notice !== null ? NOTICES[props.view.notice] : null,
)
const person = computed(() => (props.view?.status === 'signed-in' ? props.view.person : null))
const signedIn = computed(() => props.view?.status === 'signed-in')
const unreachable = computed(() => props.view?.status === 'signed-in' && props.view.unreachable)
const signingIn = computed(() => props.view?.status === 'signed-out' && props.view.signingIn)

const initials = computed(() => {
  const name = person.value?.name
  if (name) {
    const words = name.split(/\s+/).filter(Boolean)
    return words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join('')
  }
  return person.value?.email?.slice(0, 1).toUpperCase() ?? '?'
})

const who = computed(() => {
  const p = person.value
  if (p?.name && p.email) return `${p.name} (${p.email})`
  return p?.name ?? p?.email ?? 'Signed in'
})

const label = computed(() => {
  if (!signedIn.value) return signingIn.value ? 'Signing in…' : 'Sign in'
  return unreachable.value ? `${who.value}. moqtap can't be reached.` : who.value
})
</script>

<template>
  <template v-if="view">
    <button
      ref="btn"
      class="mq-btn mq-btn--quiet mq-btn--icon account-btn"
      :aria-label="label"
      :title="label"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span v-if="signedIn" class="mq-avatar mq-avatar--sm account-avatar" aria-hidden="true">{{ initials }}</span>
      <Icon v-else name="user" />
      <span v-if="unreachable || notice" class="account-dot" aria-hidden="true" />
    </button>
    <PopupMenu v-if="open" :anchor="btn" label="Account" @close="open = false">
      <template v-if="signedIn">
        <div class="mq-menu__label account-line" role="none">{{ who }}</div>
        <div v-if="unreachable" class="mq-menu__label account-warn" role="none">moqtap can't be reached right now.</div>
        <hr role="separator" />
        <a class="mq-menu__item" role="menuitem" :href="DASHBOARD_URL" target="_blank" rel="noopener">Dashboard</a>
        <a class="mq-menu__item" role="menuitem" :href="ACCOUNT_URL" target="_blank" rel="noopener">Account settings</a>
        <hr role="separator" />
        <button class="mq-menu__item" role="menuitem" @click="emit('disconnect')">Disconnect this browser</button>
      </template>
      <template v-else>
        <div v-if="notice" class="mq-menu__label account-line" role="none">{{ notice }}</div>
        <button class="mq-menu__item" role="menuitem" @click="emit('signIn')">
          {{ signingIn ? 'Open sign-in again' : 'Sign in to moqtap' }}
        </button>
      </template>
    </PopupMenu>
  </template>
</template>

<style scoped>
.account-btn {
  position: relative;
}
.account-avatar {
  width: 20px;
  height: 20px;
  font-size: var(--type-data-xs-size);
  background: var(--surface-selected);
  color: var(--ink);
}
.account-dot {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--warning);
}
.account-line {
  max-width: 280px;
  overflow-wrap: anywhere;
}
.account-warn {
  color: var(--warning);
}
</style>
