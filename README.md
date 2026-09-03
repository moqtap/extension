# moqtap — WebTransport Inspector

DevTools extension for inspecting WebTransport connections and MoQT protocol traffic.

## Features

- Intercepts all WebTransport connections on a page (main thread, workers, and iframes)
- Auto-detects MoQT from wire bytes, and the draft from the negotiated `moqt-NN` protocol
- Decodes control messages with full field display
- Tracks tab with per-track subscription state, timing, and namespace grouping
- WebTransport datagram interception and decoding (shown in Streams tab)
- Stream content detection: JSON, CBOR, MessagePack, and ISO BMFF media (CMAF, LOC, fMP4)
- Hex viewer with inline object boundary annotations and object navigation
- Live bitrate display for active connections
- Filter toolbar for messages (active only, group by namespace, TX/RX direction) and streams (text search)
- Recording toggle and clear controls for stream data
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

## How the draft is identified

Two separate questions, answered from two different places.

**Is it MoQT?** The first varint on a candidate stream — `0x40` or `0x20` for a
CLIENT_SETUP through draft-16, `0x2F00` for the SETUP of draft-17 and later.
That is all the message type says; it does not name a draft, and it is not
meant to.

**Which draft?** Draft-20 §3.1: *"MOQT uses ALPN in QUIC and
`WT-Available-Protocols` in WebTransport to perform version negotiation [...]
ALPNs used to identify IETF drafts are created by appending the draft number to
`moqt-`."* This extension observes WebTransport, so the mechanism it sees is
`WT-Available-Protocols` — the `protocols` member of `WebTransportOptions`,
plus the server's pick, exposed as the session's `protocol` attribute. (ALPN on
a WebTransport connection is `h3`; it names HTTP/3, not MoQT.) Drafts before -15
predate that and negotiate `0xff000000 + n` in the SETUP messages instead;
drafts 15 and later put **no version number on the wire at all**.

So: a version number for drafts 07–14, the `moqt-NN` string for 15 and up. When
neither is available the newest supported draft is assumed, and every surface
that shows it says so — `MoQT draft-20 (assumed)` in the details pane, a
trailing `?` on the connection badge, and a "Draft From" row giving the reason.

## Adding a New MoQT Draft

### 1. Update `@moqtap/codec`

The codec package must support the new draft first — the extension delegates
all message encoding/decoding to it. Once it is published with the new draft,
bump the dependency in `package.json`.

### 2. Register the draft (5 files)

**`src/types/common.ts`** — Add to `SUPPORTED_DRAFTS`. `SupportedDraft` derives
from it, so every per-draft `Record` in the codebase stops compiling until it
is filled in.

**`src/codec/message-ids.ts`** — Import `MESSAGE_ID_MAP` / `MESSAGE_TYPE_MAP`
from the new draft subpath and register both.

**`src/codec/varint.ts`** — Add the draft to `VARINT_ENCODINGS`. Check the
draft's §1.4.1 rather than assuming it inherits: draft-17 replaced the RFC 9000
integer and draft-18 revised the replacement.

**`entrypoints/devtools-panel/stream-framing/index.ts`** — Register a parser
via `registerDraftParser('NN', createCodecDraftParser('NN'))`.

**`vitest.config.ts`** — Add the draft to `DRAFTS`, which builds the codec
subpath aliases. Every draft has to be listed, not just the ones a test imports
directly: `src/codec/message-ids.ts` imports all of them.

**`src/detect/draft-detect.ts`** — Bump `NEWEST_SUPPORTED_DRAFT`. Do **not** add
a row to `VERSION_TO_DRAFT`: it stops at draft-14 because that is where wire
version numbers stop, and a new row there would be a value no peer sends.

### 3. Handle wire format changes (if any)

If the draft renames fields in control messages, update the track registry in
`src/codec/track-info.ts`, which reads `subscribeId`, `trackNamespace` and
`trackName` off decoded messages.

If data stream framing changes, the codec adapter in
`entrypoints/devtools-panel/stream-framing/codec-adapter.ts` may need new
fields surfaced as header tags.

If the set of messages that may open a bidirectional request stream changes,
update `REQUEST_STREAM_OPENERS` in `src/detect/control-streams.ts` and the
per-era counts its test pins.

### 4. Update tests

Add the draft to the per-draft lists in `src/codec/message-ids.test.ts`,
`src/codec/track-info.test.ts`, `src/codec/varint.test.ts` and
`src/detect/control-streams.test.ts`, and add a detection case to
`src/detect/draft-detect.test.ts`. The test count must move — if it does not,
the new draft is being skipped rather than exercised.

### 5. Build and verify

```bash
npm run compile      # Type check
npm run test         # All tests pass
npm run build        # Bundle includes new draft support
```

Currently supported drafts: **07 through 20**.

## Architecture

```
Page JS -> content.ts (MAIN world, hooks WebTransport)
        -> bridge.content.ts (ISOLATED world, relays messages)
        -> background.ts (service worker, detects draft, decodes, records)
        -> DevTools panel (Vue 3 UI)
```

Key modules:

- `src/detect/` — MoQT detection from stream-opening bytes, draft from the
  negotiated protocol (or a SETUP version number, drafts 07-14)
- `src/codec/` — Multi-draft facade over `@moqtap/codec`
- `src/session/` — Session state machine (delegates to codec)
- `src/trace/` — `.moqtrace` recording and export
- `src/intercept/` — WebTransport constructor monkey-patching

## License

MIT
