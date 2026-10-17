import { resolve } from 'node:path'
import { defineConfig } from 'wxt'
import { originsFor } from './src/account/origins'

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifestVersion: 3,
  // Which deployment the account feature talks to, compiled in as constants
  // (src/account/origins.ts): app.moqtap.com and api.moqtap.com unless a
  // non-production build sets MOQTAP_APP_ORIGIN and MOQTAP_API_ORIGIN.
  vite: (env) => {
    const origins = originsFor(env.mode, process.env)
    return {
      define: {
        __MOQTAP_APP_ORIGIN__: JSON.stringify(origins.app),
        __MOQTAP_API_ORIGIN__: JSON.stringify(origins.api),
      },
    }
  },
  hooks: {
    // The panel bundles IBM Plex from its design-system copy and Lucide icon
    // paths; both licences ask for their notice to ship with the copies.
    'build:publicAssets': (wxt, files) => {
      files.push({
        absoluteSrc: resolve(
          wxt.config.root,
          'entrypoints/devtools-panel/design-system/licenses/IBM-Plex-OFL.txt',
        ),
        relativeDest: 'licenses/IBM-Plex-OFL.txt',
      })
      files.push({
        absoluteSrc: resolve(wxt.config.root, 'node_modules/lucide-static/LICENSE'),
        relativeDest: 'licenses/Lucide-ISC.txt',
      })
    },
  },
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
      'src/account/test-fakes.ts',
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
  manifest: (env) => ({
    // A non-production build says which deployment it signs in to.
    name:
      env.mode === 'production'
        ? 'WebTransport Inspector by moqtap'
        : `WebTransport Inspector by moqtap (${env.mode})`,
    description:
      'DevTools extension for inspecting WebTransport connections and MoQT protocol traffic',
    permissions: ['storage'],
    devtools_page: 'devtools.html',
    browser_specific_settings: {
      gecko: {
        id: 'wtinspector@moqtap.com',
        // Capture is the MAIN-world content script (entrypoints/content.ts),
        // which Firefox runs from 128; below that the extension sees no
        // traffic. storage.session, for the access token and the sign-in
        // flow, needs only 115. data_collection_permissions is read from 140
        // and ignored before it, where share-trace.ts skips the consent prompt.
        strict_min_version: '128.0',
        data_collection_permissions: {
          required: ['none'],
          // Sent only when the user shares a trace: the capture is the
          // website's content, and with "include authorization" ticked it
          // carries the site's tokens. Requested at that click.
          optional: ['websiteContent', 'authenticationInfo'],
        },
      },
    },
  }),
})
