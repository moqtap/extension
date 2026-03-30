# moqtap — WebTransport Inspector

DevTools extension for inspecting WebTransport connections and MoQT protocol traffic.

## Features

- Intercepts all WebTransport connections on a page (main thread + workers)
- Auto-detects MoQT protocol and draft version from wire bytes
- Decodes control messages with full field display
- Tracks subscriptions with namespace/track name display
- Stream data viewer with hex and JSON modes
- Live bitrate display for active connections
- Stack traces for control messages and stream creation
- Export/import `.moqtrace` trace files
- Graceful handling of non-MoQT WebTransport connections

## Development

```bash
npm install
npm run dev          # Dev mode with hot reload
npm run build        # Production build
npm run test         # Run test suite
npm run compile      # Type check
```

Load the built extension from `.output/chrome-mv3/` in `chrome://extensions` (developer mode).

## Adding a New MoQT Draft

When a new MoQT draft is published (e.g. draft-18), follow these steps:

### 1. Update `@moqtap/codec`

The codec package must support the new draft first. The extension delegates all message encoding/decoding to `@moqtap/codec`. Once the codec is published with draft-18 support, bump the dependency version in `package.json`.

### 2. Register the draft (3 files)

**`src/types/common.ts`** — Add to the `SupportedDraft` union type.

**`src/detect/draft-detect.ts`** — Add the wire version to `VERSION_TO_DRAFT`.

If the new draft changes the CLIENT_SETUP message type ID (unlikely between minor drafts), also update `detectFromControlStream()`.

**`src/session/version.ts`** — Add display constants.

### 3. Handle wire format changes (if any)

If the new draft changes field names in control messages, update `entrypoints/background.ts` `extractTrackInfo()` which reads fields like `subscribeId`, `trackNamespace`, `trackName` from decoded messages.

If data stream framing changes (header fields, object layout), update `entrypoints/devtools-panel/stream-framing.ts`.

### 4. Update tests

Add the new wire version to `src/detect/draft-detect.test.ts` to verify detection works.

### 5. Build and verify

```bash
npm run test         # All tests pass
npm run build        # Bundle includes new draft support
```

## Architecture

```
Page JS -> content.ts (MAIN world, hooks WebTransport)
        -> bridge.content.ts (ISOLATED world, relays messages)
        -> background.ts (service worker, detects draft, decodes, records)
        -> DevTools panel (Vue 3 UI)
```

Key modules:
- `src/detect/` — Draft auto-detection from CLIENT_SETUP wire bytes
- `src/codec/` — Multi-draft facade over `@moqtap/codec`
- `src/session/` — Session state machine (delegates to codec)
- `src/trace/` — `.moqtrace` recording and export
- `src/intercept/` — WebTransport constructor monkey-patching

## License

MIT
