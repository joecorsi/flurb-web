# Flurb web player

Flurb Web is a static browser player. It synchronizes the catalog, favorites, and playlists with a library published by Flurb Rust to Turso. Dropbox serves audio from the music folder selected on each device.

## Connect a library

1. In Flurb Rust, connect your Turso database and wait for the library to finish publishing.
2. In Flurb Web, open Settings and enter the same database URL and a database-scoped token with read/write access. Use a token created for that database, for example with `turso db tokens create <database-name>`.
3. Connect Dropbox and select the folder that contains the same music tree. A track whose shared path is `Artist/Album/Track.mp3` uses that path inside the selected folder.

Recently added follows the cutoff published by Flurb Rust. Until a compatible Rust build publishes a cutoff, it uses the same 30-day default.

Flurb Web stores the Turso token in this browser's IndexedDB and sends it only to the selected Turso database. Disconnect in Settings removes the token from the browser. Expired tokens can be replaced by reconnecting to the same database. Old Dropbox-only favorites and playlists are not imported into an existing shared library.

## Offline and sync

After a successful online visit, the app shell and last synchronized catalog can be opened offline. Favorite and playlist edits are saved locally with a durable outbox. Audio playback requires Dropbox connectivity.

The app pushes new edits promptly and checks for incoming changes approximately every five seconds while open. It uses Flurb Rust's Turso change log, sequence cursor, and retry IDs. Independent fields merge, same-field changes follow server sequence, deletion wins over stale partial edits, and an ordered playlist's membership is one document. Changes and cursor checkpoints are written together in IndexedDB.

## Run locally

```sh
python3 -m http.server 8080
```

Open <http://localhost:8080/>. For Dropbox sign-in, register that URL as an OAuth 2 redirect URI for the Dropbox app. The published redirect URI is <https://joecorsi.github.io/flurb-web/>.
