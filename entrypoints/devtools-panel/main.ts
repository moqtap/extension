import { createApp } from 'vue'
import App from './App.vue'
import './design-system/tokens.css'
import './design-system/components/bundle.css'
import { applyHost, currentHost } from './host'
import { loadPrefs } from './prefs'
import './style.css'
import './host.css'
import { followDevtoolsTheme } from './theme'

applyHost(document.documentElement, currentHost())
followDevtoolsTheme(document.documentElement)

// Load prefs before mounting so components can read cached values synchronously
loadPrefs().then(() => {
  createApp(App).mount('#app')
})
