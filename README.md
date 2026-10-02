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
bun install
bun run dev          # Dev mode with hot reload
bun run build        # Production build
bun run test         # Run test suite
bun run compile      # Type check
```

bun, not npm: the lockfile is `bun.lock` and the release workflow installs
with `bun install --frozen-lockfile`.

Load the built extension from `.output/chrome-mv3/` in `chrome://extensions` (developer mode).

## How the draft is identified

Two separate questions, answered from two different places.

**Is it MoQT?** The first varint on a candidate stream — `0x40` or `0x20` for a
CLIENT_SETUP through draft-16, `0x2F00` for the SETUP of draft-17 and later.
That is all the message type says; it does not name a draft, and it is not
meant to.

**Which draft?** Draft-21 §6.2: *"MOQT uses ALPN in QUIC and
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
that shows it says so — `MoQT draft-22 (assumed)` in the details pane, a
trailing `?` on the connection badge, and a "Draft From" row giving the reason.

## Adding a New MoQT Draft

### 1. Update `@moqtap/codec`

The codec package must support the new draft first — the extension delegates
all message encoding/decoding to it. Once it is published with the new draft,
take it with `bun add @moqtap/codec@^X.Y.Z` rather than editing
`package.json`: the release workflow installs with `--frozen-lockfile`, which
fails on a `bun.lock` the edit left behind.

### 2. Register the draft (6 files)

**`src/types/common.ts`** — Add to `SUPPORTED_DRAFTS`. `SupportedDraft` derives
from it, so every per-draft `Record` in the codebase stops compiling until it
is filled in.

**`src/codec/message-ids.ts`** — Import `MESSAGE_ID_MAP` / `MESSAGE_TYPE_MAP`
from the new draft subpath and register both.

**`src/codec/varint.ts`** — Add the draft to `VARINT_ENCODINGS`. Read the
draft's own integer section rather than assuming it inherits — §8.1 in
drafts 21 and 22, §1.4.1 in drafts 17–20: draft-17 replaced the RFC 9000 integer and
draft-18 revised the replacement.

**`entrypoints/devtools-panel/stream-framing/index.ts`** — Register a parser
via `registerDraftParser('NN', createCodecDraftParser('NN'))`.

**`vitest.config.ts`** — Add the draft to `DRAFTS`, which builds the codec
subpath aliases. Every draft has to be listed, not just the ones a test imports
directly: `src/codec/message-ids.ts` imports all of them.

**`src/detect/draft-detect.ts`** — Bump `NEWEST_SUPPORTED_DRAFT`; a test pins
it to the last entry of `SUPPORTED_DRAFTS`, because a build that decodes a
draft but assumes the one below it guesses just as confidently. Do **not** add
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
`src/detect/control-streams.test.ts`; to `UNI_CONTROL_DRAFTS` in
`src/detect/uni-control-prefix.test.ts` if its control stream is a pair of
unidirectional ones; and add a detection case to
`src/detect/draft-detect.test.ts`. The test count must move — if it does not,
the new draft is being skipped rather than exercised.

### 5. Build and verify

```bash
bun run compile      # Type check
bun run test         # All tests pass
bun run build        # Bundle includes new draft support
```

Currently supported drafts: **07 through 22**.

Draft-21 needed no step 3: it restructures draft-20 and changes nothing a
decoder can observe, so its tables, framing and varint are draft-20's and the
negotiated `moqt-21` string is the only thing that tells the two apart.

Draft-22 needed none either. Its one wire change is LOCATION_FILTER, which now
carries an explicit Location Filter Type, and the panel decodes control
messages through `@moqtap/codec`, so the codec's draft-22 module is the whole
of the change; its tables, framing and varint are draft-21's.

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
- `src/trace/` — `.moqtrace` recording and export
- `src/storage/` — Memory-first stream and datagram payload stores, with
  IndexedDB as overflow
- `src/intercept/` — WebTransport constructor monkey-patching

## Releasing

There is no `CHANGELOG.md`. What changed in a release is written into the
annotated tag, and the release workflow publishes that message as the GitHub
release body. The notes live next to the thing they describe, they are
immutable once pushed, and there is no "Unreleased" section anywhere to fall
out of date.

The published body is assembled as:

```markdown
## Release Notes

<the tag message, verbatim>

## Chrome Installation
...                     <- .github/release-footer.md, @@TAG@@ substituted
```

So write the notes with `###` subsections: they sit under the `## Release
Notes` heading the workflow adds, and `##` would make them siblings of it and
of the install sections below.

```bash
# 1. Bump "version" in package.json and commit it.
# 2. Write the notes as markdown in release-notes.md (gitignored), then:
scripts/tag-release.sh release-notes.md
git push origin master
git push origin "v$(node -p "require('./package.json').version")"
```

Tag by hand only if you must, and then exactly like this:

```bash
git tag -a --cleanup=verbatim -F notes.md v0.5.0
```

`--cleanup=verbatim` is not optional. Without it `git tag` strips every line
beginning with `#`, which is every markdown heading in the notes, silently.
`scripts/tag-release.sh` gets that right and also refuses a tag that already
exists, a dirty tree, or a version that does not match `package.json`. The
workflow re-checks the last of those, and fails the release on a lightweight
tag rather than publishing an empty body.

The same notes go in the Chrome Web Store and Mozilla Add-ons listings at
submission time. Mozilla wants sources for the minified bundle:
`bun run zip:firefox` writes `.output/*-sources.zip` alongside the extension.

## License

MIT
