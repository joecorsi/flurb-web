# Flurb web player

A small, mobile-first browser player for audio files stored in Dropbox. It uses Dropbox OAuth 2 with PKCE directly from the browser; no app secret or server is used.

## Dropbox access

- The Dropbox app uses the **Full Dropbox** access type because the library may be an existing folder in the account.
- The app requests only `files.metadata.read` and `files.content.read`.
- On first connection, Flurb lists top-level folder metadata so the user can choose one library folder. The player then lists and plays audio only inside that folder and its subfolders. The Change folder action returns to the folder selector.
- The OAuth token is kept in the current browser tab's session storage. The selected folder is stored locally in that browser.
- The Dropbox app key is public and may be embedded in the web client. Never include the Dropbox app secret or an access token in this repository.

## Run locally

1. In the Dropbox app's **OAuth 2** settings, add `http://localhost:8080/` as a redirect URI.
2. From this directory, start a local server:

   ```sh
   python3 -m http.server 8080
   ```

3. Open <http://localhost:8080/> and connect Dropbox.

The published site is <https://joecorsi.github.io/flurb-web/>. Its redirect URI must be present in the Dropbox app settings.
