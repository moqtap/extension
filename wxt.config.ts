import { defineConfig } from 'wxt'

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifestVersion: 3,
  zip: {
    // `zip:firefox` also writes the sources zip that goes to AMO reviewers.
    // It is built from the working tree, not from git, so anything lying
    // around locally ends up in it unless listed here. WXT already drops
    // dotfiles, node_modules, .output and *.test.* files; the rest is what a
    // reviewer does not need to reproduce the build.
    excludeSources: [
      // Unreleased notes staged for scripts/tag-release.sh.
      'release-notes.md',
      // Release tooling and the test setup.
      'scripts/**',
      'vitest.config.ts',
      'src/codec/test-helpers.ts',
      // Gitignored build and test output.
      'coverage/**',
      'dist/**',
      'logs/**',
      '**/*.log',
      'stats.html',
      'stats-*.json',
      '**/*.js.map',
    ],
  },
  manifest: {
    name: 'WebTransport Inspector by moqtap',
    description:
      'DevTools extension for inspecting WebTransport connections and MoQT protocol traffic',
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
})
