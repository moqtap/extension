import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifest: {
    name: 'moqtap — WebTransport Inspector',
    description: 'DevTools extension for inspecting WebTransport connections and MoQT protocol traffic',
    permissions: ['scripting', 'storage'],
    devtools_page: 'devtools.html',
  },
});
