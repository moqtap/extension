# moqtap — WebTransport Inspector

DevTools extension for inspecting WebTransport connections and MoQT protocol traffic.

## Features

- Intercepts all WebTransport connections on a page (main thread, workers, and iframes)
- Auto-detects MoQT from wire bytes, and the draft (07 through 22) from the negotiated `moqt-NN` protocol
- Decodes control messages with full field display, error codes by name for the session's draft, and each response's time since its request
- Lists a session's problems in Details: error responses, requests left without a response, blocked or exhausted request IDs, GOAWAY and undecodable bytes
- Tracks tab with per-track subscription state, timing, namespace grouping, and each track's packaging, codec and size from its catalog
- MSF and CMSF catalogs: a Catalog view on catalog streams, with the tracks each catalog declares
- WebTransport datagram interception and decoding (shown in Streams tab)
- Stream content detection: JSON, CBOR, MessagePack, and ISO BMFF media (CMAF, fMP4)
- Hex viewer with inline object boundary annotations and object navigation
- Live bitrate display for active connections
- Filter toolbar for messages (active only, group by namespace, outgoing/incoming direction, message name under any draft's name for it) and streams (text search)
- Follows the DevTools light or dark theme
- Recording toggle and clear controls for stream data
- Stack traces for control messages and stream creation
- Export/import `.moqtrace` trace files
- Optional moqtap account: upload a session to your library and share it by link or with a team
- Sets the network link (none, offline, 3G, 4G) of a running `moqtap intercept --bridge` from the panel
- Graceful handling of non-MoQT WebTransport connections

## Development

```bash
bun install
bun run dev          # Dev mode with hot reload
bun run build        # Production build
bun run test         # Run test suite
bun run compile      # Type check
```

Load the built extension from `.output/chrome-mv3/` in `chrome://extensions` (developer mode).

A development build signs in to production unless `MOQTAP_APP_ORIGIN` and
`MOQTAP_API_ORIGIN` name another deployment.

See [CONTRIBUTING.md](CONTRIBUTING.md) for adding a draft and releasing.

## How the draft is identified

MoQT is recognised from the message type that opens a stream. The draft comes
from the negotiated `moqt-NN` WebTransport protocol for drafts 15 and later
(draft-21 Section 6.2), and from the SETUP version number for drafts 07–14.
When neither is available, the newest supported draft is assumed, and every
surface that shows it says so: `MoQT draft-22 (assumed)` in the details pane, a
trailing `?` on the connection badge, and a "Draft From" row giving the reason.

## Account and sharing

Sharing is the only feature that sends anything off the machine, and only
when you click **Upload and share**. The panel builds the session's
`.moqtrace`, removes object payloads and authorization tokens (Authorization
Token parameters in control messages, the query of a SETUP path, and the query
and fragment of the session URL) unless you include them, and uploads it to
`api.moqtap.com`. With payloads included, catalogs and other JSON payloads,
gzip-compressed ones too, always lose their content keys (`trackBaseKey`), and
lose their credentials (`token`, `authInfo`, and the query and fragment of
connection and DRM system URLs) unless you include authorization. A payload
that may hold either but cannot be read is left out. Firefox asks for data
collection consent the first time you share, and again the first time you
include authorization.

Sign-in goes through `app.moqtap.com` with an OAuth authorization code and
PKCE. The bridge content script relays the result only from
`app.moqtap.com`; the refresh token stays in the extension's IndexedDB and
the access token in `storage.session`, and neither reaches a web page.
While you are signed in on `app.moqtap.com`, opening it signs the extension
in through a background tab, and signing out there signs it out.
**Disconnect this browser** stops that until you sign in again.

## Impairment with the moqtap CLI

With `moqtap intercept --bridge` running, **Impairment** at the top of the
panel sets a network profile for the inspected tab: Off, Offline, 3G or 4G.
While a profile is set, the WebTransport sessions the tab opens, in workers
too, go through the CLI and are each impaired on their own; changing the
profile switches the tab's open sessions live. Off sends new sessions directly again
and closes the ones going through the CLI, as does closing the tab. The
inspector shows each session under the URL the page opened.

While a profile is set, a session that cannot go through the CLI fails, and
the panel says what to do. A public site needs permission to access local
network devices to reach the CLI on `127.0.0.1`, and a page whose
Content Security Policy sets `connect-src` needs `https://127.0.0.1:*` in it.
A page that passes `serverCertificateHashes` needs the CLI started with `-k`.
A session that offers WebTransport `protocols` cannot go through the CLI; set
the profile to Off to connect it. A session opened as the page loads, before a
CLI session is ready for it, fails too; connect again once the page has
loaded.

Two kinds of session connect directly while a profile is set, and the panel
says so: one the page opens just after navigating to another site, before the
profile reaches it, which a reload fixes, and one in a worker moqtap cannot
instrument, for example because the page's `worker-src` does not allow
`blob:`.

The panel uses a CLI only after you allow its identity, which `moqtap cert`
prints; a CLI with a different identity asks again. Allowed identities are
listed, and can be removed, in the extension's options.

## License

MIT

Interface icons are from [Lucide](https://lucide.dev) (`lucide-static`, ISC License, copyright Lucide Icons and Contributors; icons derived from Feather are MIT, copyright Cole Bemis). The fonts are IBM Plex, under the SIL Open Font License 1.1: the `latin` woff2 files from npm `@fontsource/ibm-plex-sans` 5.1.1 and `@fontsource/ibm-plex-mono` 5.2.6, unmodified, with IBM's licence text from `@ibm/plex-sans` 1.1.0 (`entrypoints/devtools-panel/design-system/licenses/IBM-Plex-OFL.txt`).
