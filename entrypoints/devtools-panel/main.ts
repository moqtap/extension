import { createApp } from 'vue'
import App from './App.vue'
import { loadPrefs } from './prefs'
import './style.css'

// Load prefs before mounting so components can read cached values synchronously
loadPrefs().then(() => {
  createApp(App).mount('#app')
})
