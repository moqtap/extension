import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
import { loadPrefs } from './prefs';

// Load prefs before mounting so components can read cached values synchronously
loadPrefs().then(() => {
  createApp(App).mount('#app');
});
