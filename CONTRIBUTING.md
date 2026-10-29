# Contributing

## Architecture

```
Page JS -> content.ts (MAIN world, hooks WebTransport)
        -> bridge.content.ts (ISOLATED world, relays messages)
        -> background.ts (service worker, detects draft, decodes, records)
        -> DevTools panel (Vue 3 UI)
```

- `src/detect/`: MoQT detection from stream-opening bytes, draft from the
  negotiated protocol (or a SETUP version number, drafts 07–14)
- `src/codec/`: multi-draft facade over `@moqtap/codec`
- `src/trace/`: `.moqtrace` recording and export
- `src/storage/`: memory-first stream and datagram payload stores, with
  IndexedDB as overflow
- `src/intercept/`: WebTransport constructor hooks
- `src/account/`: sign-in, tokens and the trace library client used for sharing
- `src/cli/`: the moqtap CLI's loopback bridge: discovery, identity check and consent
- `src/impair/`: tab impairment: each tab's CLI port and the WebTransport route through it

Use bun: the lockfile is `bun.lock`, and releases install with
`bun install --frozen-lockfile`.

## Adding a MoQT draft

### 1. Update `@moqtap/codec`

Once `@moqtap/codec` supports the draft, take it with
`bun add @moqtap/codec@^X.Y.Z`, not a `package.json` edit, so `bun.lock`
stays in step.

### 2. Register the draft

- `src/types/common.ts`: add it to `SUPPORTED_DRAFTS`. Every per-draft
  `Record` fails to compile until it is filled in.
- `src/codec/message-ids.ts`: import `MESSAGE_ID_MAP` / `MESSAGE_TYPE_MAP`
  from the new draft subpath and register both.
- `src/codec/varint.ts`: add it to `VARINT_ENCODINGS`, from the draft's own
  integer section (Section 8.1 in drafts 21 and 22, Section 1.4.1 in drafts
  17–20).
- `entrypoints/devtools-panel/stream-framing/index.ts`: register a parser with
  `registerDraftParser('NN', createCodecDraftParser('NN'))`.
- `vitest.config.ts`: add it to `DRAFTS`. Every draft must be listed.
- `src/detect/draft-detect.ts`: bump `NEWEST_SUPPORTED_DRAFT`. Do not add a row
  to `VERSION_TO_DRAFT`, which covers only drafts with a SETUP version number
  (07–14).

### 3. Handle wire format changes

- Renamed control message fields (`request_id`, `track_namespace`,
  `track_name`, `track_alias`) need a new `@moqtap/inspect`, which holds the
  track registry and the field display.
- Data stream framing changes may need new header tags in
  `entrypoints/devtools-panel/stream-framing/codec-adapter.ts`.
- A change to the messages that may open a bidirectional request stream goes in
  `REQUEST_STREAM_OPENERS` in `src/detect/control-streams.ts`, with the per-era
  counts its test pins.

### 4. Update tests

Add the draft to the per-draft lists in `src/codec/message-ids.test.ts`,
`src/codec/track-registry.test.ts`, `src/codec/varint.test.ts` and
`src/detect/control-streams.test.ts`; to `UNI_CONTROL_DRAFTS` in
`src/detect/uni-control-prefix.test.ts` if its control stream is a pair of
unidirectional ones; and add a detection case to
`src/detect/draft-detect.test.ts`. The test count must go up.

### 5. Build and verify

```bash
bun run compile
bun run test
bun run build
```

## Releasing

The annotated tag's message is the release notes. The release workflow
publishes it as the GitHub release body under a `## Release Notes` heading,
followed by `.github/release-footer.md`, so write the notes with `###`
subsections.

```bash
# 1. Bump "version" in package.json and commit it.
# 2. Write the notes as markdown in release-notes.md (gitignored), then:
scripts/tag-release.sh release-notes.md
git push origin master
git push origin "v$(node -p "require('./package.json').version")"
```

To tag by hand, use `git tag -a --cleanup=verbatim -F notes.md vX.Y.Z`.
Without `--cleanup=verbatim`, git strips every markdown heading from the notes.

Use the same notes in the Chrome Web Store and Mozilla Add-ons listings.
`bun run zip:firefox` writes the sources Mozilla asks for to
`.output/*-sources.zip`.
