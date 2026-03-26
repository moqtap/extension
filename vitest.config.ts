import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: [
      { find: '@', replacement: resolve(__dirname, 'src') },
      // Resolve @moqtap/codec subpath exports to .js (package ships .js not .mjs)
      { find: '@moqtap/codec/draft14/session', replacement: resolve(__dirname, 'node_modules/@moqtap/codec/dist/draft14-session.js') },
      { find: '@moqtap/codec/draft7/session', replacement: resolve(__dirname, 'node_modules/@moqtap/codec/dist/draft7-session.js') },
      { find: '@moqtap/codec/session', replacement: resolve(__dirname, 'node_modules/@moqtap/codec/dist/session.js') },
      { find: '@moqtap/codec/draft14', replacement: resolve(__dirname, 'node_modules/@moqtap/codec/dist/draft14.js') },
      { find: '@moqtap/codec/draft7', replacement: resolve(__dirname, 'node_modules/@moqtap/codec/dist/draft7.js') },
      { find: '@moqtap/codec', replacement: resolve(__dirname, 'node_modules/@moqtap/codec/dist/index.js') },
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
});
