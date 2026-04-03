import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifestVersion: 3,
  manifest: {
    name: 'WebTransport Inspector by moqtap',
    description: 'DevTools extension for inspecting WebTransport connections and MoQT protocol traffic',
    permissions: ['storage'],
    devtools_page: 'devtools.html',
    browser_specific_settings: {
      gecko: {
        id: 'wtinspector@moqtap.com',
        data_collection_permissions: {
          required: ['none'],
        },
      },
    },
  },
});
