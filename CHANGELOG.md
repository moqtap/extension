# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file starts at 0.4.0. Earlier releases are on the
[GitHub releases page](https://github.com/moqtap/extension/releases).

## [0.4.0] - 2026-09-03

### Added
- draft-ietf-moq-transport-20. `@moqtap/codec` 0.9.0 and
  `@moqtap/test-vectors` 0.13.0; draft-20 message tables, varint encoding,
  stream framing and request-stream openers. Its control message registry is
  draft-19's plus exactly one row — `PUBLISH_STATE_NOTIFY` (`0x22`), which
  rides an already-open subscription stream rather than opening one — with no
  codepoint moved or removed. `FETCH` kept `0x16` but its body was rewritten,
  so there is no in-band signal to catch a draft-19 decoder reading a draft-20
  FETCH; the draft has to be right, which is what the detection fixes below are
  about.
- The negotiated application protocol is now captured on both sides:
  `WT-Available-Protocols` (the offer, already displayed) and the server's
  pick, read off the session once `ready` resolves. Both appear in the details
  pane, alongside a "Draft From" row saying which of them named the draft.

### Changed
- `DetectionResult` carries `evidence` — `wire-version`, `negotiated-protocol`
  or `unidentified` — in place of an always-present `versions: number[]` that
  drafts 15+ could only fill by inventing one.
- Renamed for the transport this extension actually observes: `LATEST_ALPN_DRAFT`
  is `NEWEST_SUPPORTED_DRAFT`, `LATEST_ALPN_DRAFT_VERSION` is gone, and the
  "ALPN-era" phrasing now says `WT-Available-Protocols` where the WebTransport
  mechanism is meant. ALPN on a WebTransport connection is `h3`.
- `SupportedDraft` derives from a runtime `SUPPORTED_DRAFTS` list, so draft
  detection can narrow a draft string without importing every draft's codec
  tables.

### Fixed
- **Draft-17+ SETUP was filed as bulk media and evicted on busy sessions.**
  The content script matched a unidirectional control stream on `6f 00`, which
  is `0x2F00` under the RFC 9000 varint; draft-17 replaced that with MoQT's own
  varint (§1.4.1), which writes `af 00`. Nothing ever matched, so
  `isControlPlane` fell through to the `bidi` flag — false for a unidirectional
  stream — and the whole SETUP exchange went into the 500-entry bulk FIFO, the
  exact failure the split buffer exists to prevent. The detection layer had
  this right and had a test for it; the content script kept its own copy and
  had none. Both now share one definition in
  `src/detect/uni-control-prefix.ts`, pinned by a test that checks the bytes
  against the draft-17 through -20 SETUP vectors in `@moqtap/test-vectors`
  rather than against another hand-written constant. Drafts ≤16 were
  unaffected: their control stream is bidirectional.
- **Sessions were reported as draft-19 whatever draft they actually spoke.**
  The extension captured `WT-Available-Protocols` and showed it in the session
  table, then ignored it and told the rest of itself the session was draft-19 —
  so a `moqt-20` connection was displayed as `moqt-20` and decoded as
  draft-19. Draft-20 §3.1 makes that string the version negotiation for
  WebTransport, and detection now reads it: `moqt-NN` means draft NN, taking
  the server's selection over the offer. **Sessions previously mislabelled
  draft-19 will now report their true draft**, and one speaking a draft this
  build has no tables for is reported as unsupported rather than decoded as
  draft-19.
- **A fabricated version number was presented as an observed one.** Every
  draft-17+ session reported `versions: [0xff000013]`. The `0xff0000NN` scheme
  belongs to drafts before -15; from draft-15 the version is negotiated in the
  protocol string and no version number appears on the wire at all, so
  `0xff000013` is not something a draft-19 peer ever sends. Nothing is
  synthesized now: a detection result says how it knows the draft — a version
  read off the wire, a negotiated protocol string, or nothing, in which case
  the draft is a fallback and the UI labels it `(assumed)`. `VERSION_TO_DRAFT`
  stops at draft-14, where the wire values stop.
- **CLIENT_SETUP on drafts 15 and 16 was parsed as though it had a version
  list.** It has none — the payload is setup options straight after the length
  — so the parser read the option count and option type IDs and reported them
  as offered versions. Those drafts are now identified from their protocol
  string, and when there is none the result says no draft could be identified
  instead of listing bytes that were never versions.
- The header comment claiming drafts 17, 18 and 19 are "wire-indistinguishable
  on the first message" was wrong and doing no work. Their SETUP bodies can
  differ — draft-19 added Setup Options `0x06` and `0x08` — and nothing here
  parses a body anyway. Only the true, narrow claim remains: the message type
  varint `0x2F00` alone does not separate them, and is not what names the
  draft.
- **Every event in an exported trace was stamped `timestamp: 0`.** The exporter
  had no per-stream timing, so a delivery timeline drawn from an extension
  capture was degenerate: every object in the session landed at the same
  instant. A stream is stored as one concatenated buffer, so by export time the
  chunk boundaries that carried the timing are gone; `src/trace/arrivals.ts`
  keeps them as `(cumulative end offset, arrival time)`, which is enough to
  resolve an object's payload offset back to the chunk that carried it. The
  index coalesces chunks sharing a millisecond and halves itself past a cap
  rather than truncating, so a long capture loses resolution instead of losing
  its recent data, and a resolved time errs late — it never claims an object
  was delivered before it could have been. Times are the page-side `capturedAt`
  rather than panel receipt, so a burst of buffered postMessages arriving at
  once on tab refocus still carries the spread of times they were really seen
  at. Events are sorted by time before `seq` is assigned, `seq` being what the
  format says to order by. `streamType` distinguishes subgroup, fetch and
  datagram instead of claiming subgroup for all three. Streams replayed from
  IndexedDB after a service worker restart, and imported traces, have no index —
  nobody watched those chunks arrive — and fall back to the stream's first-data
  time.
- **A control stream stopped being read at its first undecodable message.** A
  control message declares its length before its payload, so a message still
  arriving is the one decode failure that runs out of bytes; every other names
  bytes that are already whole and still wrong — a varint the draft leaves
  undefined, a message type it does not have, a parameter outside the message's
  own definition. The reader treated them alike and broke out of the loop,
  which for an incomplete message is right and for the rest holds the same
  bytes forever: the stream stalled silently on the first malformed message and
  every later message on it went unread. Relays that are not spec-conforming
  are exactly the ones worth inspecting, so the reader has to survive them.
  `isIncomplete` splits the two, written out per code so a code added to the
  codec fails to compile rather than silently becoming one or the other. A run
  that cannot decode is now reported once, with the offending bytes attached
  and capped so the violation can be read off the wire, and the stream stops
  there instead of spinning. In an exported trace it becomes the format's error
  event — where a protocol violation belongs, and what the CLI's observer
  already writes for a locally-observed parse failure. The bytes do not survive
  that step: the error event has no field to carry them, and `raw` belongs to
  the control message event, which this deliberately is not.
- **Control messages in an imported trace displayed as raw hex unless this
  extension had written it.** Names were read from `msg.type`, a key inside the
  decoded body that exists only because the JS codec's decoded messages happen
  to be discriminated unions carrying it. Nothing in the `.moqtrace` format
  promises that key, and a trace written by the Rust CLI has none — while `mt`,
  the normative wire field, sat unused beside it. Names now resolve from
  `(mt, draft)` through the codec's per-draft `MESSAGE_TYPE_MAP`, with
  `msg.type` kept as a fallback and hex as the last resort; the wire id
  outranks the body on disagreement. A draft the tables do not cover degrades
  rather than guesses — the format defines `moq-transport-rfc9999` alongside
  `moq-transport-NN`, and neither it nor an out-of-range number selects a
  table, so both fall through to the body and then to hex, never to a name from
  the wrong draft.
