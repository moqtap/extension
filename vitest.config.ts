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
  '20',
  '21',
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
      // wxt maps `@` to the project root (`.wxt/tsconfig.json`), and every one
      // of the 34 `@/...` imports in this repo is written against that --
      // `@/src/codec/...`, `@/entrypoints/...`. Pointing it at `src` here meant
      // test resolution and build resolution disagreed, and anything under
      // `entrypoints/` could not be imported by a test at all.
      { find: '@', replacement: resolve(__dirname, '.') },
      ...codecAliases,
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    // `entrypoints/` was outside the suite entirely, which is how an export
    // path that wrote `objectId: 0` for every object shipped unnoticed.
    include: ['src/**/*.test.ts', 'entrypoints/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'entrypoints/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
    },
  },
})
