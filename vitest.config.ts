import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      { find: '@', replacement: resolve(__dirname, 'src') },
      // Resolve @moqtap/codec subpath exports to .js (package ships .js not .mjs)
      {
        find: '@moqtap/codec',
        replacement: resolve(
          __dirname,
          'node_modules/@moqtap/codec/dist/index.js',
        ),
      },
      {
        find: '@moqtap/codec/session',
        replacement: resolve(
          __dirname,
          'node_modules/@moqtap/codec/dist/session.js',
        ),
      },
      {
        find: '@moqtap/codec/draft07',
        replacement: resolve(
          __dirname,
          'node_modules/@moqtap/codec/dist/draft07.js',
        ),
      },
      {
        find: '@moqtap/codec/draft07/session',
        replacement: resolve(
          __dirname,
          'node_modules/@moqtap/codec/dist/draft07-session.js',
        ),
      },
      {
        find: '@moqtap/codec/draft14',
        replacement: resolve(
          __dirname,
          'node_modules/@moqtap/codec/dist/draft14.js',
        ),
      },
      {
        find: '@moqtap/codec/draft14/session',
        replacement: resolve(
          __dirname,
          'node_modules/@moqtap/codec/dist/draft14-session.js',
        ),
      },
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
