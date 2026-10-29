<script lang="ts" setup>
import Icon from '@/entrypoints/devtools-panel/components/Icon.vue'
import { useCli } from '@/entrypoints/devtools-panel/use-cli'

const cli = useCli()
const trusted = cli.trusted
</script>

<template>
  <main class="settings">
    <section aria-labelledby="cli-title">
      <h1 id="cli-title" class="mq-label">Allowed moqtap CLIs</h1>
      <p class="mq-muted">
        The DevTools panel can send a tab's connections through these CLI identities. Remove one to be asked again.
      </p>
      <ul v-if="trusted.length > 0" class="trusted">
        <li v-for="t in trusted" :key="t.identity" class="trusted-entry">
          <span class="mq-mono">{{ t.fingerprint }}</span>
          <span class="mq-muted">{{ new Date(t.at).toLocaleDateString() }}</span>
          <button
            class="mq-btn mq-btn--quiet mq-btn--icon"
            :aria-label="`Remove ${t.fingerprint}`"
            :title="`Remove ${t.fingerprint}`"
            @click="cli.forget(t.identity)"
          >
            <Icon name="x" />
          </button>
        </li>
      </ul>
      <p v-else class="mq-muted">None.</p>
    </section>
  </main>
</template>

<style scoped>
.settings {
  padding: var(--space-3);
  min-width: 320px;
}
section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
h1,
p,
ul {
  margin: 0;
}
.trusted {
  list-style: none;
  padding: 0;
}
.trusted-entry {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.trusted-entry .mq-mono {
  flex: 1;
}
</style>
