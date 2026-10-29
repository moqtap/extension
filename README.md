# moqtap — WebTransport Inspector

DevTools extension for inspecting WebTransport connections and MoQT protocol traffic.

## Features

- Intercepts all WebTransport connections on a page (main thread, workers, and iframes)
- Auto-detects MoQT from wire bytes, and the draft (07 through 22) from the negotiated `moqt-NN` protocol
- Decodes control messages with full field display, error codes by name for the session's draft, and each response's time since its request
- Problems list in Details covering control messages (error responses, requests left without a response, blocked or exhausted request IDs, GOAWAY, undecodable bytes), catalogs, catalogs that disagree on a track, media timeline templates, and LOC, CMAF and timeline objects: each with its severity and, where they apply, the spec section and links to the objects, catalog objects or messages where it was seen, filterable by severity
- Tracks tab with per-track subscription state, timing, namespace grouping, and each track's packaging, codec and size from its catalog
- MSF and CMSF catalogs: a Catalog view on catalog streams, with the tracks each catalog declares and the rules each catalog object breaks
- Media payloads: a track is read as LOC, CMAF, a media timeline or an event timeline when its catalogs agree on its packaging; a LOC draft can also be picked in the Tracks tab for a track whose catalogs say LOC or whose objects carry Object Properties
  - LOC: each object's properties, decoded under the LOC draft the track's property types allow, and its payload's NAL unit framing
  - CMAF: the track's CMAF header, and each object's boxes, track_IDs, first sample, SAP type and earliest presentation time, checked against CMSF
  - Timelines: media timeline records, event timeline records, and the CMSF SAP type timeline compared with the media track it describes
  - Media timeline templates: the template the catalogs give a track, of any packaging, shown with its streams and in the Tracks tab
- WebTransport datagram interception and decoding (shown in Streams tab)
- Stream content detection: JSON, CBOR, MessagePack, H.264 and H.265 Annex-B, and ISO BMFF boxes
- Hex viewer with inline object boundary annotations and object navigation
- Live bitrate display for active connections
- Filter toolbar for messages (active only, group by namespace, outgoing/incoming direction, message name under any draft's name for it) and streams (text search)
- Follows the DevTools light or dark theme
- Recording toggle and clear controls for stream data
- Stack traces for control messages and stream creation
- Export/import `.moqtrace` trace files
- Optional moqtap account: upload a session to your library and share it by link or with a team
- Impairs the inspected tab through `moqtap intercept --bridge` (Off, Offline, 3G, 4G), each WebTransport session on its own link
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
When neither is available, the session is decoded as the newest supported draft.

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
panel sets a network profile for the inspected tab, from the profiles the CLI
offers. While a profile is set, every WebTransport session the tab opens, in
workers too, goes through the CLI on its own impaired link, including sessions
that offer `protocols` or pass `serverCertificateHashes`. Changing the profile
switches them live, and the profile stays with the tab across reloads until
the tab closes. Off leaves those sessions running unimpaired and sends new
ones directly. The inspector shows each session under the URL the page opened.

Sessions opened before the profile was set stay direct; the panel marks them
not impaired, and a reload impairs them. While any tab has a profile, a
session a page opens as it loads connects once the page knows its tab's
profile.

A session that cannot go through the CLI fails, and the panel says what to
do. A public site needs permission to access local network devices to reach
the CLI on `127.0.0.1`, and a page whose Content Security Policy sets
`connect-src` needs `https://127.0.0.1:*` in it. A worker moqtap cannot
instrument, for example because the page's `worker-src` does not allow
`blob:`, connects directly, and the panel says so.

The panel uses a CLI only after you allow its identity, which `moqtap cert`
prints; a CLI with a different identity asks again. Allowed identities are
listed, and can be removed, in the extension's options.

## License

MIT

Interface icons are from [Lucide](https://lucide.dev) (`lucide-static`, ISC License, copyright Lucide Icons and Contributors; icons derived from Feather are MIT, copyright Cole Bemis). The fonts are IBM Plex, under the SIL Open Font License 1.1: the `latin` woff2 files from npm `@fontsource/ibm-plex-sans` 5.1.1 and `@fontsource/ibm-plex-mono` 5.2.6, unmodified, with IBM's licence text from `@ibm/plex-sans` 1.1.0 (`entrypoints/devtools-panel/design-system/licenses/IBM-Plex-OFL.txt`).
