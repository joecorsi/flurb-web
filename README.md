# Flurb web player

A small, mobile-first browser player for audio files stored in Dropbox. It is a static page and uses Dropbox OAuth 2 with PKCE directly from the browser; no client secret or server is used. The app requests only `files.metadata.read` and `files.content.read`. OAuth access tokens are kept in the current browser tab's session storage, and favorites are saved locally in that browser.

The GitHub Pages version will be available at <https://joecorsi.github.io/flurb-web/>.

## Run locally

1. Create a Dropbox API app with **Scoped access**. Enable `files.metadata.read` and `files.content.read` in its Permissions tab.
2. In the app's OAuth 2 settings, add `https://joecorsi.github.io/flurb-web/` as a redirect URI. For local development, also add `http://localhost:8080/`.
3. From this directory, start a local server:

   ```sh
   python3 -m http.server 8080
   ```

4. Open <http://localhost:8080/> and paste the app key from the Dropbox app's Settings page.

Dropbox requires HTTPS for non-localhost redirect URIs. The app key is public; never add a Dropbox app secret to this static client.
