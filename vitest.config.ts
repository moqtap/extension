import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

const DRAFTS = [
  '07',
  '08',
  '09',
  '10',
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
]

/**
 * Resolve @moqtap/codec subpath exports to .js (the package ships .js, not
 * .mjs). Every draft is listed, not just the ones a test imports directly:
 * `src/codec/message-ids.ts` imports all of them, so any test that reaches it
 * fails to resolve unless the whole set is aliased.
 *
 * Order matters — Vite takes the first matching alias, so the bare
 * '@moqtap/codec' entry must come last or it swallows every subpath.
 */
const codecAliases = [
  ...DRAFTS.flatMap((d) => [
    {
      find: `@moqtap/codec/draft${d}/session`,
      replacement: resolve(
        __dirname,
        `node_modules/@moqtap/codec/dist/draft${d}-session.js`,
      ),
    },
    {
      find: `@moqtap/codec/draft${d}`,
      replacement: resolve(
        __dirname,
        `node_modules/@moqtap/codec/dist/draft${d}.js`,
      ),
    },
  ]),
  {
    find: '@moqtap/codec/session',
    replacement: resolve(
      __dirname,
      'node_modules/@moqtap/codec/dist/session.js',
    ),
  },
  {
    find: '@moqtap/codec',
    replacement: resolve(__dirname, 'node_modules/@moqtap/codec/dist/index.js'),
  },
]

export default defineConfig({
  resolve: {
    alias: [
      { find: '@', replacement: resolve(__dirname, 'src') },
      ...codecAliases,
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
    },
  },
})
