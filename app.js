(() => {
  "use strict";
  const API = "https://api.dropboxapi.com/2";
  const CATALOG_ROOT = "/catalog";
  const DROPBOX_SIGNED_OUT = "flurb.dropbox.signedOutAt";
  const readDropboxToken = () => localStorage.getItem(DROPBOX_SIGNED_OUT) ? ""
    : localStorage.getItem("flurb.dropbox.accessToken") || sessionStorage.getItem("flurb.dropbox.accessToken") || "";
  const { FlurbCloud, FlurbArtworkCache } = window;
  const ARTWORK_HEADER_BYTES = 64 * 1024;
  const ARTWORK_REVISION_INTERVAL = 60000;
  const APPLE_EPOCH_OFFSET = 978307200;
  const appleTimestamp = () => Date.now() / 1000 - APPLE_EPOCH_OFFSET;
  const $ = (selector) => document.querySelector(selector);
  function renderLucideIcons(root = document) {
    if (window.lucide?.createIcons) window.lucide.createIcons({ root });
  }
  const els = {
    audio: $("#audio"), search: $("#search"), clearSearch: $("#clear-search"), home: $("#home-button"), breadcrumbs: $("#breadcrumbs"), shuffleLibrary: $("#shuffle-library"),
    librarySticky: $("#library-sticky"), playerArtworkButton: $("#player-artwork-button"), playerArtwork: $("#player-artwork"), playerArtworkShell: $("#player-artwork-shell"),
    artworkViewer: $("#artwork-viewer"), artworkViewerImage: $("#artwork-viewer-image"), artworkViewerCover: $("#artwork-viewer-cover"),
    settingsButton: $("#settings-button"), settingsOverlay: $("#settings-overlay"), settingsClose: $("#settings-close"), nowPlayingLink: $("#now-playing-link"), nowTitleViewport: $("#now-title-viewport"), emptyGlyph: $(".empty-glyph"),
    viewButton: $("#view-button"), viewLabel: $("#view-label"), viewMenu: $("#view-menu"),
    recentOption: $('[data-view="recent"]'), recentCount: $("#recent-count"), favoritesOption: $('[data-view="favorites"]'), favoritesCount: $("#favorites-count"),
    playlistsOption: $('[data-view="playlists"]'), playlistsCount: $("#playlists-count"), libraryOption: $('[data-view="library"]'), libraryCount: $("#library-count"),
    trackList: $("#track-list"), tableBody: $("#table-body"), emptyState: $("#empty-state"), trackCount: $("#track-count"), notice: $("#notice"), noticeMessage: $("#notice-message"),
    player: $("#player"), play: $("#play-button"),
    previous: $("#previous-button"), next: $("#next-button"), shuffle: $("#shuffle-button"), repeat: $("#repeat-button"), progress: $("#progress"),
    elapsed: $("#elapsed-time"), duration: $("#duration-time"), nowTitle: $("#now-title"), nowAlbum: $("#now-album"), nowFavorite: $("#now-favorite"),
    toast: $("#toast"), settingsLink: $("#settings-link"),
    playlistPicker: $("#playlist-picker"), playlistPickerList: $("#playlist-picker-list"),
    playlistPickerMessage: $("#playlist-picker-message"), playlistPickerClose: $("#playlist-picker-close"),
    playlistPickerCreate: $("#playlist-picker-create"),
    newPlaylist: $("#new-playlist"), newPlaylistForm: $("#new-playlist-form"),
    newPlaylistName: $("#new-playlist-name"), newPlaylistCancel: $("#new-playlist-cancel"),
    newPlaylistSubmit: $("#new-playlist-submit"), newPlaylistMessage: $("#new-playlist-message")
  };
  const state = {
    token: readDropboxToken(),
    refreshToken: localStorage.getItem("flurb.dropbox.refreshToken") || "",
    tokenExpiresAt: Number(localStorage.getItem("flurb.dropbox.tokenExpiresAt") || 0),
    refreshPromise: null,
    libraryFolder: null,
    viewMode: ["recent", "favorites", "playlists", "library"].includes(localStorage.getItem("flurb.dropbox.actionView")) ? localStorage.getItem("flurb.dropbox.actionView") : "recent",
    activePlaylistId: null,
    playlists: [],
    cloud: null,
    cloudSnapshot: null,
    cloudStatus: "",
    catalog: new Map(),
    catalogFolders: new Map(),
    folderPath: CATALOG_ROOT,
    folderName: "Library",
    folderHistory: [],
    artworkLinks: new Map(),
    completedMetadata: new Set(),
    artworkCheckedAt: new Map(),
    artworkRechecks: new Set(),
    artworkLoading: new Set(),
    artworkElements: new Map(),
    artworkObserver: null,
    artworkQueue: [],
    activeArtworkDownloads: 0,
    preloadingArtwork: false,
    recentArtworkPreload: null,
    recentArtworkElements: new Map(),
    titleScrollGesture: false,
    entries: [],
    tracks: [],
    displayLimit: 100,
    searchScroll: null,
    recentGridReturn: null,
    recentAlbumCache: null,
    recentAlbumWindow: null,
    current: null,
    viewerTrack: null,
    loadingTrack: false,
    shuffle: false,
    libraryQueue: null,
    repeat: "off",
    favorites: new Set(),
    playRequest: 0,
    listObserver: null,
    toastTimer: null
  };
  try { state.libraryFolder = JSON.parse(localStorage.getItem("flurb.dropbox.libraryFolder") || "null"); } catch (_) {}
  els.audio.volume = 0.8;

  function showNotice(message, kind = "info") {
    els.noticeMessage.textContent = message;
    els.notice.classList.add("visible");
    els.notice.classList.toggle("error", kind === "error");
  }
  function hideNotice() { els.notice.classList.remove("visible", "error"); }
  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("visible");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => els.toast.classList.remove("visible"), 2600);
  }
  function friendlyError(error) {
    const text = String(error?.message || error || "Something went wrong.");
    if (/expired_access_token|invalid_access_token|401/i.test(text)) return "Your Dropbox session expired.";
    if (/missing_scope|insufficient_scope/i.test(text)) return "This Dropbox app needs files.metadata.read and files.content.read permissions.";
    if (/path\/not_found/i.test(text)) return "The selected library folder is no longer available.";
    return text;
  }
  function clearDropboxTokens() {
    state.token = "";
    state.refreshToken = "";
    state.tokenExpiresAt = 0;
    ["flurb.dropbox.accessToken", "flurb.dropbox.refreshToken", "flurb.dropbox.tokenExpiresAt", "flurb.dropbox.loginAt"].forEach((key) => {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    });
    updateConnection();
  }
  async function ensureAccessToken(force = false) {
    if (localStorage.getItem(DROPBOX_SIGNED_OUT)) throw new Error("Connect Dropbox in Settings.");
    if (!force && state.token && (!state.tokenExpiresAt || Date.now() < state.tokenExpiresAt - 60_000)) return state.token;
    if (!state.refreshToken) {
      if (state.token && !force) return state.token;
      throw new Error("Reconnect Dropbox once to enable a lasting session.");
    }
    if (!state.refreshPromise) {
      const credential = state.refreshToken;
      state.refreshPromise = (async () => {
        const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: credential, client_id: "b7db4q3upd3kspx" });
        const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form
        });
        const result = await response.json().catch(() => ({}));
        if (credential !== localStorage.getItem("flurb.dropbox.refreshToken") || localStorage.getItem(DROPBOX_SIGNED_OUT)) {
          throw new Error("Dropbox connection changed.");
        }
        if (!response.ok) {
          if (/invalid_grant|invalid_refresh_token/i.test(`${result.error || ""} ${result.error_description || ""}`)) clearDropboxTokens();
          throw new Error(result.error_description || result.error || "Could not renew your Dropbox session.");
        }
        state.token = result.access_token;
        state.tokenExpiresAt = Date.now() + (Number(result.expires_in) || 14_400) * 1000;
        localStorage.setItem("flurb.dropbox.accessToken", state.token);
        localStorage.setItem("flurb.dropbox.tokenExpiresAt", String(state.tokenExpiresAt));
        sessionStorage.setItem("flurb.dropbox.accessToken", state.token);
        sessionStorage.setItem("flurb.dropbox.tokenExpiresAt", String(state.tokenExpiresAt));
        return state.token;
      })().finally(() => { state.refreshPromise = null; });
    }
    return state.refreshPromise;
  }
  async function fetchTrackFile(track, range = null, retried = false, path = dropboxTrackPath(track)) {
    const accessToken = await ensureAccessToken();
    const response = await fetch("https://content.dropboxapi.com/2/files/download", {
      method: range ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Dropbox-API-Arg": JSON.stringify({ path }).replace(/[\u007f-\uffff]/g, (character) =>
          `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`),
        ...(range ? { Range: range } : {})
      }
    });
    if (response.status === 401 && state.refreshToken && !retried) {
      await ensureAccessToken(true);
      return fetchTrackFile(track, range, true, path);
    }
    if (response.status === 401) clearDropboxTokens();
    if (!response.ok) throw new Error(`Track metadata request failed (${response.status}).`);
    return response;
  }
  async function dropbox(path, body = {}, retried = false) {
    const accessToken = await ensureAccessToken();
    const response = await fetch(`${API}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch (_) {}
    if (!response.ok) {
      if (response.status === 401 && state.refreshToken && !retried) {
        await ensureAccessToken(true);
        return dropbox(path, body, true);
      }
      if (response.status === 401) {
        clearDropboxTokens();
      }
      const requestId = response.headers.get("x-dropbox-request-id");
      const detail = payload.error_summary || payload.error?.[".tag"] || raw || `Dropbox request failed (${response.status}).`;
      throw new Error(requestId ? `${detail} (request ${requestId})` : detail);
    }
    return payload;
  }
  function updateConnection() {
    els.search.disabled = !state.cloud;
    els.clearSearch.disabled = els.search.disabled || !els.search.value;
    els.home.disabled = !state.cloud;
    updateQuickActions();
  }
  function playerArtist(track) {
    return track.artist || track.album_artist || "Unknown Artist";
  }
  function playerAlbum(track) {
    return track.album || "";
  }
  function trackTitle(track) {
    return track.title || track.name.replace(/\.[^.]+$/, "");
  }
  function dropboxTrackPath(track) {
    if (!state.libraryFolder?.path_lower || !FlurbCloud.safePath(track.path)) {
      throw new Error("Select this device’s Dropbox music folder in Settings.");
    }
    return `${state.libraryFolder.path_lower}/${track.path}`.normalize("NFC");
  }
  function updateMediaMetadata(track) {
    if (!track || !navigator.mediaSession || !window.MediaMetadata) return;
    const metadata = {
      title: trackTitle(track),
      artist: playerArtist(track),
      album: playerAlbum(track)
    };
    const artwork = state.artworkLinks.get(track.id);
    if (artwork) metadata.artwork = [{ src: artwork }];
    try { navigator.mediaSession.metadata = new MediaMetadata(metadata); } catch (_) {}
  }
  function updatePlayerTitle(track) {
    const title = trackTitle(track);
    if (els.nowTitle.textContent !== title) {
      els.nowTitle.textContent = title;
      updateTitleMarquee();
    }
    els.nowPlayingLink.setAttribute("aria-label", `Open folder containing ${title}`);
  }
  function setPlayerMetadata(track) {
    updatePlayerTitle(track);
    els.nowAlbum.textContent = playerArtist(track);
    updateMediaMetadata(track);
  }
  function updateTitleMarquee() {
    const viewport = els.nowTitleViewport;
    const title = els.nowTitle;
    viewport.classList.remove("is-overflowing", "is-manual-scrolling");
    viewport.scrollLeft = 0;
    title.style.width = "100%";
    title.style.removeProperty("transform");
    requestAnimationFrame(() => {
      const distance = Math.max(0, title.scrollWidth - viewport.clientWidth);
      if (distance > 2) {
        viewport.style.setProperty("--title-overflow", `-${distance}px`);
        viewport.classList.add("is-overflowing");
      } else viewport.style.removeProperty("--title-overflow");
    });
  }
  function goBackOneFolder() {
    if (state.viewMode === "recent" && state.folderPath !== CATALOG_ROOT) return returnToRecentGrid();
    if (state.viewMode === "playlists" && state.activePlaylistId) return selectPlaylistView(null);
    const root = CATALOG_ROOT;
    if (state.folderPath === root) return;
    const previous = state.folderHistory.pop();
    if (!previous || !(previous.path === root || previous.path.startsWith(`${root}/`))) {
      state.folderHistory = [];
      return loadLibraryFolder();
    }
    loadLibraryFolder(previous.path);
  }
  function goHomeLibrary() {
    if (state.viewMode === "recent" && state.folderPath !== CATALOG_ROOT) return returnToRecentGrid();
    if (state.viewMode === "playlists") return selectPlaylistView(null);
    if (!state.cloud) return;
    state.folderHistory = [];
    history.replaceState({ flurbRootGuard: true }, "", location.href);
    loadLibraryFolder();
  }
  function captureView() {
    return {
      view: state.viewMode,
      path: state.folderPath,
      playlistId: state.activePlaylistId,
      recentGridReturn: state.recentGridReturn,
      query: els.search.value,
      searchScroll: state.searchScroll,
      limit: state.displayLimit,
      top: catalogScroller().scrollTop
    };
  }
  function restoreView(view) {
    state.viewMode = view.view;
    state.folderPath = state.catalogFolders.has(view.path) ? view.path : CATALOG_ROOT;
    state.folderHistory = view.view === "library" ? folderAncestors(state.folderPath) : [];
    state.activePlaylistId = state.playlists.some((playlist) => playlist.id === view.playlistId) ? view.playlistId : null;
    state.recentGridReturn = view.recentGridReturn;
    state.searchScroll = view.searchScroll;
    state.displayLimit = view.limit;
    els.search.value = view.query;
    localStorage.setItem("flurb.dropbox.actionView", view.view);
    syncSearchState();
    refreshCatalogView(false);
    catalogScroller().scrollTo({ top: view.top, behavior: "instant" });
  }
  function installHistoryNavigation() {
    history.replaceState({ flurbRootGuard: true }, "", location.href);
    history.pushState({ flurbRootGuard: true }, "", location.href);
    window.addEventListener("popstate", (event) => {
      if (event.state?.flurbView) return restoreView(event.state.flurbView);
      const root = CATALOG_ROOT;
      const atLibraryRoot = !state.folderPath || state.folderPath === root;
      if (state.viewMode === "playlists" && state.activePlaylistId) {
        goBackOneFolder();
        return;
      }
      if (atLibraryRoot) {
        // Keep iOS standalone-app edge swipes inside Flurb at the library boundary.
        history.pushState({ flurbRootGuard: true }, "", location.href);
        return;
      }
      goBackOneFolder();
    });
  }
  async function handleOAuthReturn() {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    if (!code && !params.has("error")) return false;
    history.replaceState({}, document.title, location.pathname + location.hash);
    if (params.has("error")) {
      showNotice("Dropbox sign-in was not completed.", "error");
      return true;
    }
    let pending;
    try { pending = JSON.parse(localStorage.getItem("flurb.dropbox.pkce") || sessionStorage.getItem("flurb.dropbox.pkce") || "null"); } catch (_) {}
    localStorage.removeItem("flurb.dropbox.pkce");
    sessionStorage.removeItem("flurb.dropbox.pkce");
    if (!pending || params.get("state") !== pending.csrf) {
      showNotice("Dropbox sign-in could not be verified.", "error");
      return true;
    }
    try {
      const signedOutAt = localStorage.getItem(DROPBOX_SIGNED_OUT);
      const form = new URLSearchParams({ code, grant_type: "authorization_code", client_id: "b7db4q3upd3kspx", code_verifier: pending.verifier, redirect_uri: pending.redirectUri });
      const response = await fetch("https://api.dropbox.com/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error_description || result.error || "Dropbox sign-in failed.");
      if (signedOutAt !== localStorage.getItem(DROPBOX_SIGNED_OUT)) return true;
      state.token = result.access_token;
      if (result.refresh_token) {
        state.refreshToken = result.refresh_token;
        localStorage.setItem("flurb.dropbox.refreshToken", state.refreshToken);
      }
      state.tokenExpiresAt = Date.now() + (Number(result.expires_in) || 14_400) * 1000;
      localStorage.setItem("flurb.dropbox.loginAt", String(Date.now()));
      localStorage.setItem("flurb.dropbox.accessToken", state.token);
      localStorage.setItem("flurb.dropbox.tokenExpiresAt", String(state.tokenExpiresAt));
      sessionStorage.setItem("flurb.dropbox.accessToken", state.token);
      sessionStorage.setItem("flurb.dropbox.tokenExpiresAt", String(state.tokenExpiresAt));
      localStorage.removeItem(DROPBOX_SIGNED_OUT);
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage({ type: "flurb-dropbox-connected" }, location.origin);
        window.close();
        return true;
      }
      location.replace(new URL("./settings.html?connected=1", location.href).href);
    } catch (error) {
      showNotice(friendlyError(error), "error");
    }
    return true;
  }
  function updateQuickActions() {
    const playlist = state.playlists.find((item) => item.id === state.activePlaylistId);
    els.viewLabel.textContent = state.viewMode === "recent" ? "Recently added" : state.viewMode === "favorites" ? "Favorites" : state.viewMode === "playlists" ? "Playlists" : "Library";
    els.recentCount.textContent = String(recentAlbums("").length);
    els.libraryCount.textContent = String(state.catalog.size);
    els.favoritesCount.textContent = String(state.favorites.size);
    els.playlistsCount.textContent = String(state.playlists.length);
    els.recentOption.setAttribute("aria-checked", String(state.viewMode === "recent"));
    els.favoritesOption.setAttribute("aria-checked", String(state.viewMode === "favorites"));
    els.playlistsOption.setAttribute("aria-checked", String(state.viewMode === "playlists"));
    els.libraryOption.setAttribute("aria-checked", String(state.viewMode === "library"));
    els.home.title = state.viewMode === "playlists" ? playlist ? "Back to playlists" : "Playlists" : `Back to ${els.viewLabel.textContent}`;
    els.home.setAttribute("aria-label", els.home.title);
  }
  function setViewMode(view) {
    if (view !== state.viewMode || state.activePlaylistId) {
      els.search.value = "";
      state.searchScroll = null;
      state.recentGridReturn = null;
      syncSearchState();
      els.clearSearch.disabled = true;
    }
    state.viewMode = view;
    state.activePlaylistId = null;
    state.folderHistory = [];
    localStorage.setItem("flurb.dropbox.actionView", view);
    els.viewMenu.hidden = true;
    els.viewButton.setAttribute("aria-expanded", "false");
    state.displayLimit = 100;
    history.replaceState({ flurbRootGuard: true }, "", location.href);
    loadLibraryFolder();
  }
  const supportsArtwork = (track) => /\.(mp3|flac)$/i.test(track.name);
  function renderBreadcrumbs() {
    els.breadcrumbs.replaceChildren();
    els.shuffleLibrary.hidden = state.viewMode !== "library" || state.folderPath !== CATALOG_ROOT || !state.catalog.size;
    const scroller = document.createElement("span");
    scroller.className = "breadcrumbs-path";
    els.breadcrumbs.append(scroller);
    const rootLabel = state.viewMode === "recent" ? "recent" : state.viewMode === "favorites" ? "favorites" : state.viewMode === "playlists" ? "playlists" : "lib";
    let foldersDepth = 0;
    const addCrumb = (name, current, onClick, depth = 0, isRoot = false) => {
      const crumb = document.createElement("button");
      crumb.type = "button";
      const rootIcon = ({ recent: "clock-3", favorites: "heart", playlists: "list-music", library: "library" })[state.viewMode];
      crumb.className = `breadcrumb${isRoot ? " breadcrumb-root" : ""}${isRoot && state.viewMode === "favorites" ? " favorites-root" : ""}${current ? " current" : ""}`;
      if (isRoot) {
        crumb.innerHTML = `<i data-lucide="${rootIcon}" aria-hidden="true"></i>`;
        crumb.setAttribute("aria-label", name);
        crumb.title = name;
      } else {
        crumb.textContent = name;
      }
      const distanceFromCurrent = state.viewMode === "playlists" ? (current ? 0 : 1) : Math.max(0, foldersDepth - depth);
      const opacity = Math.max(0.1, 1 - distanceFromCurrent * 0.15);
      crumb.style.setProperty("--breadcrumb-opacity", String(opacity));
      if (opacity < 0.45) crumb.classList.add("is-dark");
      if (current) crumb.setAttribute("aria-current", "page");
      crumb.addEventListener("click", () => {
        if (!els.artworkViewer.hidden) closeArtworkViewer();
        onClick();
      });
      scroller.append(crumb);
      if (isRoot) renderLucideIcons(crumb);
    };
    if (state.viewMode === "playlists") {
      const playlist = state.playlists.find((item) => item.id === state.activePlaylistId);
      addCrumb(rootLabel, !playlist, goHomeLibrary, 0, true);
      if (playlist) addCrumb(playlist.name, true, goHomeLibrary, 1);
      return;
    }
    const root = CATALOG_ROOT;
    if (!state.cloud) { els.breadcrumbs.replaceChildren(); return; }
    const folders = [{ path: root, name: "Library" }];
    if (state.viewMode === "library") folders.push(...folderAncestors(state.folderPath));
    if (state.folderPath !== root) folders.push({ path: state.folderPath, name: state.folderName });
    foldersDepth = folders.length - 1;
    folders.forEach((item, index) => addCrumb(index === 0 ? rootLabel : item.name, index === folders.length - 1, index === 0 ? goHomeLibrary : () => {
      state.folderHistory = folders.slice(1, index).map(({ path: folderPath, name }) => ({ path: folderPath, name }));
      loadLibraryFolder(item.path);
    }, index, index === 0));
    scroller.scrollLeft = scroller.scrollWidth;
  }
  function setLibraryLoading(loading) {
    const wasLoading = els.emptyState.classList.contains("is-loading");
    if (loading) {
      els.emptyState.classList.add("is-loading");
      els.emptyState.hidden = false;
      els.emptyState.querySelector("p").textContent = "Loading library…";
      const host = els.emptyGlyph;
      host.innerHTML = '<i id="empty-icon" data-lucide="loader-circle" class="library-loading-icon" aria-hidden="true"></i>';
      renderLucideIcons(host);
    } else if (wasLoading) {
      els.emptyState.classList.remove("is-loading");
      const host = els.emptyGlyph;
      host.innerHTML = '<i id="empty-icon" data-lucide="disc-3" aria-hidden="true"></i>';
      els.emptyState.querySelector("p").textContent = "No tracks";
      renderLucideIcons(host);
    }
  }
  function openSettings() {
    els.settingsOverlay.hidden = false;
    els.settingsClose.focus();
    sendCloudStatus();
  }
  function closeSettings() {
    els.settingsOverlay.hidden = true;
    els.settingsButton.focus();
  }
  function id3FrameSize(bytes, offset, version) {
    if (version === 4) return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) | ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
    return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
  }
  function descriptionEnd(bytes, start, encoding) {
    if (encoding === 1 || encoding === 2) {
      for (let index = start; index + 1 < bytes.length; index += 2) {
        if (bytes[index] === 0 && bytes[index + 1] === 0) return index + 2;
      }
      return bytes.length;
    }
    const end = bytes.indexOf(0, start);
    return end < 0 ? bytes.length : end + 1;
  }
  function removeId3Unsynchronization(data) {
    const clean = new Uint8Array(data.length);
    let length = 0;
    for (let index = 0; index < data.length; index += 1) {
      clean[length++] = data[index];
      if (data[index] === 0xff && data[index + 1] === 0) index += 1;
    }
    return clean.subarray(0, length);
  }
  function extractId3Artwork(buffer) {
    let bytes = new Uint8Array(buffer);
    if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null;
    const version = bytes[3];
    if (version < 2 || version > 4) return null;
    let tagSize = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    let tagEnd = Math.min(bytes.length, 10 + tagSize);
    if (version === 2 && (bytes[5] & 0x40)) return null;
    if (bytes[5] & 0x80) {
      const tag = removeId3Unsynchronization(bytes.subarray(10, tagEnd));
      const clean = new Uint8Array(10 + tag.length);
      clean.set(bytes.subarray(0, 10));
      clean.set(tag, 10);
      bytes = clean;
      tagSize = tag.length;
      tagEnd = 10 + tagSize;
    }
    let offset = 10;
    if ((bytes[5] & 0x40) && version === 3 && offset + 4 <= tagEnd) {
      offset += 4 + new DataView(bytes.buffer, offset, 4).getUint32(0, false);
    } else if ((bytes[5] & 0x40) && version === 4 && offset + 4 <= tagEnd) {
      offset += id3FrameSize(bytes, offset, 4);
    }
    while (offset < tagEnd) {
      const headerSize = version === 2 ? 6 : 10;
      if (offset + headerSize > tagEnd || bytes[offset] === 0) break;
      const frameId = String.fromCharCode(...bytes.subarray(offset, offset + (version === 2 ? 3 : 4)));
      const frameSize = version === 2
        ? (bytes[offset + 3] << 16) | (bytes[offset + 4] << 8) | bytes[offset + 5]
        : id3FrameSize(bytes, offset + 4, version);
      if (!frameSize || offset + headerSize + frameSize > tagEnd) break;
      const payloadStart = offset + headerSize;
      let payload = bytes.subarray(payloadStart, payloadStart + frameSize);
      const frameFlags = version === 2 ? 0 : bytes[offset + 9];
      if ((version === 3 && (frameFlags & 0xc0)) || (version === 4 && (frameFlags & 0x0c))) {
        offset += headerSize + frameSize;
        continue;
      }
      if (version === 3 && (frameFlags & 0x20)) payload = payload.subarray(1);
      if (version === 4 && (frameFlags & 0x40)) payload = payload.subarray(1);
      if (version === 4 && (frameFlags & 0x01)) payload = payload.subarray(4);
      if (version === 4 && (bytes[offset + 9] & 0x02)) payload = removeId3Unsynchronization(payload);
      if (frameId === (version === 2 ? "PIC" : "APIC") && payload.length > 5) {
        const encoding = payload[0];
        let imageStart;
        let mime;
        if (version === 2) {
          const imageFormat = String.fromCharCode(...payload.subarray(1, 4)).toLowerCase();
          mime = imageFormat === "png" ? "image/png" : "image/jpeg";
          imageStart = descriptionEnd(payload, 5, encoding);
        } else {
          const mimeEnd = payload.indexOf(0, 1);
          if (mimeEnd < 0 || mimeEnd + 2 >= payload.length) return null;
          mime = new TextDecoder().decode(payload.subarray(1, mimeEnd)).toLowerCase();
          imageStart = descriptionEnd(payload, mimeEnd + 2, encoding);
        }
        if (imageStart < payload.length && mime.startsWith("image/")) {
          return new Blob([payload.subarray(imageStart)], { type: mime });
        }
      }
      offset += headerSize + frameSize;
    }
    return null;
  }
  function setArtworkImage(image, link, trackId) {
    image._flurbArtworkId = trackId;
    image.src = link;
    image.classList.add("has-artwork");
    image.parentElement?.classList.add("has-artwork");
  }
  function registerTrackArtwork(image, track) {
    image._flurbTrack = track;
    let elements = state.artworkElements.get(track.id);
    if (!elements) state.artworkElements.set(track.id, elements = new Set());
    elements.add(image);
    const cached = state.artworkLinks.get(track.id);
    if (cached) setArtworkImage(image, cached, track.id);
    if (!state.artworkObserver && "IntersectionObserver" in window) {
      state.artworkObserver = new IntersectionObserver((observations) => {
        observations.forEach((observation) => {
          if (!observation.isIntersecting) return;
          state.artworkObserver.unobserve(observation.target);
          const image = observation.target;
          showCachedArtwork(image).then((track) => {
            if (image.isConnected && track) {
              queueTrackArtwork(track, true, state.completedMetadata.has(track.id) && artworkCheckDue(track.id));
            }
          });
        });
      }, { rootMargin: "220px 0px" });
    }
    if (state.artworkObserver) state.artworkObserver.observe(image);
    else queueTrackArtwork(track);
  }
  function queueTrackArtwork(track, prioritize = false, recheck = false) {
    if (!track || !supportsArtwork(track) || !state.token || !state.libraryFolder) return;
    const key = track.id;
    if (state.completedMetadata.has(key) && !recheck) return;
    const queue = state.artworkQueue;
    if (state.artworkLoading.has(key)) {
      if (recheck) state.artworkRechecks.add(key);
      if (prioritize) {
        const index = queue.findIndex((queued) => queued.id === key);
        if (index > 0) queue.unshift(queue.splice(index, 1)[0]);
      }
      return;
    }
    state.artworkLoading.add(key);
    if (prioritize) queue.unshift(track);
    else queue.push(track);
    pumpArtworkQueue();
  }
  function updatePlayerArtwork(track) {
    const link = track && state.artworkLinks.get(track.id);
    if (link) els.playerArtwork.src = link;
    else els.playerArtwork.removeAttribute("src");
    els.playerArtworkShell.classList.toggle("has-artwork", Boolean(link));
    els.playerArtworkButton.disabled = !link;
  }
  function updateViewerArtwork(track) {
    const link = track && state.artworkLinks.get(track.id);
    els.artworkViewerImage.alt = track ? `${trackTitle(track)} artwork` : "";
    if (link) els.artworkViewerImage.src = link;
    else els.artworkViewerImage.removeAttribute("src");
    els.artworkViewerCover.classList.toggle("has-artwork", Boolean(link));
  }
  function openArtworkViewer(track) {
    if (!track || !state.artworkLinks.has(track.id)) return;
    state.viewerTrack = track;
    updateViewerArtwork(track);
    els.artworkViewer.hidden = false;
    document.body.classList.add("is-artwork-viewing");
    els.playerArtworkButton.setAttribute("aria-label", "Close track artwork");
    const stickyBottom = els.librarySticky.getBoundingClientRect().bottom;
    const playerTop = els.player.getBoundingClientRect().top;
    els.artworkViewer.style.top = `${Math.max(0, stickyBottom)}px`;
    els.artworkViewer.style.bottom = `${Math.max(0, window.innerHeight - playerTop)}px`;
    if (supportsArtwork(track)) queueTrackArtwork(track);
  }
  function closeArtworkViewer() {
    els.artworkViewer.hidden = true;
    document.body.classList.remove("is-artwork-viewing");
    els.playerArtworkButton.setAttribute("aria-label", "View current track artwork");
    state.viewerTrack = null;
  }
  function id3TagEnd(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33 ||
        bytes[3] < 2 || bytes[3] > 4) return 0;
    return 10 + id3FrameSize(bytes, 6, 4);
  }
  function artworkRevision(response) {
    try { return JSON.parse(response.headers.get("Dropbox-API-Result"))?.rev || null; }
    catch (_) { return null; }
  }
  async function readMp3Artwork(track, path, onRevision) {
    const first = await fetchTrackFile(track, `bytes=0-${ARTWORK_HEADER_BYTES - 1}`, false, path);
    onRevision(artworkRevision(first));
    const buffer = await first.arrayBuffer();
    const cover = extractId3Artwork(buffer);
    const tagEnd = id3TagEnd(buffer);
    if (cover || first.status !== 206 || tagEnd <= buffer.byteLength) return cover;
    const tag = await fetchTrackFile(track, `bytes=0-${tagEnd - 1}`, false, path);
    onRevision(artworkRevision(tag));
    return extractId3Artwork(await tag.arrayBuffer());
  }
  function flacPicture(bytes) {
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (data.byteLength < 32) return null;
    const typeEnd = 8 + data.getUint32(4);
    if (typeEnd + 4 > data.byteLength) return null;
    const descriptionEnd = typeEnd + 4 + data.getUint32(typeEnd);
    const imageStart = descriptionEnd + 20;
    if (imageStart > data.byteLength) return null;
    const mime = new TextDecoder().decode(bytes.subarray(8, typeEnd));
    const imageEnd = imageStart + data.getUint32(imageStart - 4);
    if (!mime.startsWith("image/") || imageEnd <= imageStart || imageEnd > data.byteLength) return null;
    return { type: data.getUint32(0), cover: new Blob([bytes.subarray(imageStart, imageEnd)], { type: mime }) };
  }
  async function readFlacArtwork(track, path, onRevision) {
    let start = 0;
    let bytes = new Uint8Array();
    async function read(offset, length) {
      if (offset < start || offset + length > start + bytes.length) {
        const response = await fetchTrackFile(track, `bytes=${offset}-${offset + Math.max(length, ARTWORK_HEADER_BYTES) - 1}`, false, path);
        onRevision(artworkRevision(response));
        bytes = new Uint8Array(await response.arrayBuffer());
        start = response.status === 206 ? offset : 0;
      }
      return bytes.subarray(offset - start, offset - start + length);
    }
    const magic = await read(0, 4);
    if (String.fromCharCode(...magic) !== "fLaC") return null;
    let offset = 4;
    let alternate = null;
    for (let blocks = 0; blocks < 128; blocks += 1) {
      const header = await read(offset, 4);
      if (header.length < 4) return alternate;
      const [flags, high, middle, low] = header;
      const size = (high << 16) | (middle << 8) | low;
      if ((flags & 0x7f) === 6) {
        const picture = flacPicture(await read(offset + 4, size));
        if (picture?.type === 3) return picture.cover;
        alternate ||= picture?.cover || null;
      }
      if (flags & 0x80) return alternate;
      offset += 4 + size;
    }
    return alternate;
  }
  function updateTrackRowTitle(row, track) {
    const title = trackTitle(track);
    const playing = Boolean(row.querySelector(".playing-speaker"));
    row.setAttribute("aria-label", `${playing ? "Now playing" : "Play"} ${title}`);
    row.querySelector(".track-name").textContent = title;
    row.querySelector(".track-favorite").setAttribute("aria-label",
      state.favorites.has(track.id) ? `Remove ${title} from favorites` : `Favorite ${title}`);
    row.querySelector(".track-more").setAttribute("aria-label", `More actions for ${title}`);
  }
  function isRecentlyAddedGrid() {
    return Boolean(state.cloudSnapshot && state.viewMode === "recent" && state.folderPath === CATALOG_ROOT);
  }
  function nextRecentArtworkTrack() {
    if (!isRecentlyAddedGrid() || !state.token || !state.libraryFolder || !navigator.onLine) return null;
    const albums = recentAlbums("");
    if (state.recentArtworkPreload?.albums !== albums) {
      state.recentArtworkPreload = { albums, index: 0, candidates: null };
    }
    const preload = state.recentArtworkPreload;
    while (preload.index < albums.length) {
      const album = albums[preload.index];
      preload.candidates ??= artworkCandidates(album);
      if (!album.tracks.some((track) => state.artworkLinks.has(track.id))) {
        while (preload.candidates.length) {
          const track = preload.candidates[0];
          // A visible tile is already trying this track. Wait for its result.
          if (state.artworkLoading.has(track.id)) return null;
          preload.candidates.shift();
          if (!state.completedMetadata.has(track.id)) return track;
        }
      }
      preload.index += 1;
      preload.candidates = null;
    }
    return null;
  }
  function publishArtwork(track, cover) {
    const previous = state.artworkLinks.get(track.id);
    const link = cover ? URL.createObjectURL(cover) : null;
    if (link) state.artworkLinks.set(track.id, link);
    else state.artworkLinks.delete(track.id);
    const bound = state.artworkElements.get(track.id);
    const images = new Set(bound);
    const albumImage = state.recentArtworkElements.get(recentAlbumPath(track));
    if (albumImage && (!albumImage._flurbArtworkId || albumImage._flurbArtworkId === track.id)) images.add(albumImage);
    for (const image of images) {
      if (!image.isConnected || (image._flurbArtworkId && image._flurbArtworkId !== track.id)) continue;
      if (link) {
        state.artworkObserver?.unobserve(image);
        setArtworkImage(image, link, track.id);
      } else {
        image._flurbArtworkId = null;
        image.removeAttribute("src");
        image.classList.remove("has-artwork");
        image.parentElement?.classList.remove("has-artwork");
        bound?.delete(image);
        image._flurbArtworkMissing?.();
      }
    }
    if (state.current?.id === track.id) {
      updateMediaMetadata(state.current);
      updatePlayerArtwork(state.current);
    }
    if (state.viewerTrack?.id === track.id) updateViewerArtwork(state.viewerTrack);
    if (previous) URL.revokeObjectURL(previous);
  }
  function artworkCacheKey(folder, path) {
    return JSON.stringify([folder.id, path]);
  }
  function artworkTrackIsCurrent(track, folder) {
    return folder === state.libraryFolder && state.catalog.get(track.id)?.path === track.path;
  }
  async function showCachedArtwork(image) {
    const folder = state.libraryFolder;
    const initial = image._flurbTrack;
    if (!folder?.path_lower || !initial || !supportsArtwork(initial)) return initial;
    const shown = state.catalog.get(image._flurbArtworkId);
    if (shown && state.artworkLinks.has(shown.id)) return shown;
    const candidates = image._flurbArtworkCandidates || [initial];
    const records = await Promise.all(candidates.map((track) =>
      FlurbArtworkCache.get(artworkCacheKey(folder, dropboxTrackPath(track))).catch(() => null)));
    if (!image.isConnected || folder !== state.libraryFolder) return null;
    for (const [index, track] of candidates.entries()) {
      if (!artworkTrackIsCurrent(track, folder)) continue;
      if (!state.artworkLinks.has(track.id) && !state.completedMetadata.has(track.id) && records[index]?.cover) {
        publishArtwork(track, records[index].cover);
      }
      const link = state.artworkLinks.get(track.id);
      if (link) {
        setArtworkImage(image, link, track.id);
        return track;
      }
    }
    return initial;
  }
  async function loadArtwork(track, folder) {
    const path = dropboxTrackPath(track);
    const key = artworkCacheKey(folder, path);
    const isCurrent = () => artworkTrackIsCurrent(track, folder);
    const cached = await FlurbArtworkCache.get(key).catch(() => null);
    if (!isCurrent()) return;
    if (cached?.cover && !state.artworkLinks.has(track.id)) publishArtwork(track, cached.cover);
    if (!navigator.onLine || !state.token) return;

    let revision = null;
    if (cached?.revision) {
      const metadata = await dropbox("/files/get_metadata", { path });
      revision = metadata.rev;
      if (!isCurrent()) return;
      if (revision && revision === cached.revision) {
        state.completedMetadata.add(track.id);
        state.artworkCheckedAt.set(track.id, Date.now());
        if (!cached.cover) publishArtwork(track, null);
        return;
      }
    }
    const readArtwork = /\.flac$/i.test(track.name) ? readFlacArtwork : readMp3Artwork;
    const cover = await readArtwork(track, path, (value) => { if (value) revision = value; });
    if (!isCurrent()) return;
    state.completedMetadata.add(track.id);
    state.artworkCheckedAt.set(track.id, Date.now());
    publishArtwork(track, cover);
    if (!revision) {
      try { revision = (await dropbox("/files/get_metadata", { path })).rev; }
      catch (_) {}
    }
    if (isCurrent()) await FlurbArtworkCache.put(key, cover, revision || null).catch(() => {});
  }
  function pumpArtworkQueue() {
    while (state.activeArtworkDownloads < 2) {
      let track = state.artworkQueue.shift();
      const preload = !track;
      if (preload) {
        // Leave room for visible artwork and the player when preloading.
        if (state.preloadingArtwork) return;
        track = nextRecentArtworkTrack();
        if (!track) return;
        state.preloadingArtwork = true;
        state.artworkLoading.add(track.id);
      }
      state.activeArtworkDownloads += 1;
      loadArtwork(track, state.libraryFolder).catch(() => {}).finally(() => {
        state.artworkLoading.delete(track.id);
        state.activeArtworkDownloads -= 1;
        if (preload) state.preloadingArtwork = false;
        if (state.artworkRechecks.delete(track.id)) queueTrackArtwork(state.catalog.get(track.id), true, true);
        pumpArtworkQueue();
      });
    }
  }
  function artworkCheckDue(id) {
    return Date.now() - (state.artworkCheckedAt.get(id) || 0) >= ARTWORK_REVISION_INTERVAL;
  }
  function checkVisibleArtwork(force = false) {
    if (!state.token || !state.libraryFolder || !navigator.onLine || document.hidden) return;
    const ids = new Set([state.current?.id]);
    const list = els.trackList.getBoundingClientRect();
    const collect = (image, id) => {
      const rect = image.getBoundingClientRect();
      if (rect.height && rect.bottom > Math.max(0, list.top) && rect.top < Math.min(innerHeight, list.bottom)) ids.add(id);
    };
    for (const [id, images] of state.artworkElements) for (const image of images) collect(image, id);
    for (const image of state.recentArtworkElements.values()) collect(image, image._flurbArtworkId);
    for (const id of ids) {
      if (!id || (!force && (state.artworkLoading.has(id) || !artworkCheckDue(id)))) continue;
      queueTrackArtwork(state.catalog.get(id), false, true);
    }
  }
  function addedDate(track) {
    if (Number.isFinite(track.flurb_added)) return track.flurb_added;
    return Number.isFinite(track.added) ? track.added : -Infinity;
  }
  function recentCutoff() {
    const cutoff = state.cloudSnapshot?.recentCutoff;
    if (Number.isSafeInteger(cutoff?.timestamp)) return cutoff.timestamp;
    // Match Rust's minute bucket and Apple-epoch Date Added values.
    const now = Math.floor(Date.now() / 60000) * 60 - APPLE_EPOCH_OFFSET;
    return now - (cutoff?.period === "week" ? 7 : 30) * 86400;
  }
  const recentlyAdded = (a, b) => addedDate(b) - addedDate(a);
  const artistName = (track) => track.album_artist?.trim() || track.artist?.trim() || "Unknown Artist";
  const artistPath = (track) => `${CATALOG_ROOT}/${encodeURIComponent(artistName(track))}`;
  const albumPath = (track) => track.album?.trim()
    ? `${artistPath(track)}/${encodeURIComponent(track.album.trim())}` : artistPath(track);

  function compilationAlbumPath(track) {
    const album = track.album?.trim().normalize("NFC").toLowerCase();
    if (!track.compilation || !album || album === "unknown album") return null;
    // Like Rust's album browser, use the compilation title regardless of performer.
    // One artwork tile represents the whole release, including all discs.
    return `${CATALOG_ROOT}/@compilation-${encodeURIComponent(album)}`;
  }

  function catalogFolder(path, name, parent) {
    if (state.catalogFolders.has(path)) return state.catalogFolders.get(path);
    const folder = { path_lower: path, name, folders: [], tracks: [] };
    state.catalogFolders.set(path, folder);
    if (parent) parent.folders.push(folder);
    return folder;
  }

  function applyCloudSnapshot(snapshot, config) {
    if (config !== state.cloud || snapshot.generation <= (state.cloudSnapshot?.generation ?? -1)) return;
    const scroll = catalogScroller();
    const offset = scroll.scrollTop;
    const updatedArtworkInventory = state.cloudSnapshot &&
      snapshot.artworkInventory !== state.cloudSnapshot.artworkInventory;
    state.cloudSnapshot = snapshot;
    state.recentAlbumCache = null;
    const oldCatalog = state.catalog;
    const artworkUpdates = [];
    state.catalog = new Map();
    state.catalogFolders = new Map();
    state.favorites = new Set();
    const root = catalogFolder(CATALOG_ROOT, "Library");
    for (const raw of snapshot.tracks.values()) {
      const track = { ...raw, name: raw.path.split("/").at(-1) };
      state.catalog.set(track.id, track);
      const old = oldCatalog.get(track.id);
      if (old && (state.completedMetadata.has(track.id) || state.artworkLoading.has(track.id) || state.artworkLinks.has(track.id)) &&
          Object.keys(track).some((field) => field !== "favorite" && old[field] !== track[field])) {
        if (old.path !== track.path) {
          const link = state.artworkLinks.get(track.id);
          if (link) URL.revokeObjectURL(link);
          state.artworkLinks.delete(track.id);
        }
        state.completedMetadata.delete(track.id);
        artworkUpdates.push(track);
      }
      if (track.favorite) state.favorites.add(track.id);
      const artist = catalogFolder(artistPath(track), artistName(track), root);
      const album = albumPath(track);
      const folder = album === artist.path_lower ? artist : catalogFolder(album, track.album.trim(), artist);
      folder.tracks.push(track);
      const compilation = compilationAlbumPath(track);
      if (compilation) catalogFolder(compilation, track.album.trim()).tracks.push(track);
    }
    state.playlists = [...snapshot.playlists.values()].map((playlist) => {
      const members = playlist.smart_rule === "hearted" ? [...state.favorites] : snapshot.members.get(playlist.id) || [];
      return { ...playlist, tracks: members.map((id) => state.catalog.get(id)).filter(Boolean) };
    });
    if (state.activePlaylistId && !snapshot.playlists.has(state.activePlaylistId)) state.activePlaylistId = null;
    if (!state.catalogFolders.has(state.folderPath)) {
      state.folderPath = state.folderHistory.reverse().find((folder) => state.catalogFolders.has(folder.path))?.path || CATALOG_ROOT;
      state.folderHistory = folderAncestors(state.folderPath);
      state.recentGridReturn = null;
    }
    if (state.current && state.catalog.has(state.current.id)) {
      state.current = state.catalog.get(state.current.id);
      if (state.loadingTrack) updatePlayerTitle(state.current);
      else setPlayerMetadata(state.current);
      updatePlayerArtwork(state.current);
    }
    if (state.libraryQueue) state.libraryQueue = [...state.catalog.values()];
    refreshCatalogView(false);
    scroll.scrollTo({ top: offset, behavior: "instant" });
    for (const track of artworkUpdates) queueTrackArtwork(track, false, true);
    if (updatedArtworkInventory) {
      state.artworkCheckedAt.clear();
      checkVisibleArtwork(true);
    }
  }

  function folderAncestors(path) {
    const segments = path.split("/").slice(2, -1);
    const folders = [];
    let parent = CATALOG_ROOT;
    for (const segment of segments) {
      parent += `/${segment}`;
      const folder = state.catalogFolders.get(parent);
      if (folder) folders.push({ path: parent, name: folder.name });
    }
    return folders;
  }

  function refreshCatalogView(scrollSearch = true) {
    const folder = state.catalogFolders.get(state.folderPath);
    state.folderName = folder?.name || "Library";
    state.entries = state.viewMode === "library" ? folder?.folders || [] : [];
    state.tracks = folder?.tracks || [];
    updateConnection();
    updateFavoriteButton();
    renderBreadcrumbs();
    renderTracks(scrollSearch);
  }

  function loadLibraryFolder(path = CATALOG_ROOT) {
    if (path !== state.folderPath) {
      els.search.value = "";
      state.searchScroll = null;
      syncSearchState();
    }
    state.folderPath = path;
    state.displayLimit = 100;
    refreshCatalogView();
  }

  function sendCloudStatus() {
    $("#settings-frame").contentWindow?.postMessage({ type: "flurb-turso-status", message: state.cloudStatus }, location.origin);
  }

  function setCloudSpinner(syncing) {
    els.settingsButton.classList.toggle("is-syncing", syncing);
    els.settingsButton.setAttribute("aria-label", syncing ? "Settings, syncing with Turso" : "Settings");
    els.settingsButton.title = syncing ? "Settings, syncing with Turso" : "Settings";
  }

  let runningCloud;
  let cloudSyncRequested = false;
  async function syncCloud() {
    cloudSyncRequested = true;
    if (runningCloud || !state.cloud) return;
    runningCloud = true;
    try {
      while (cloudSyncRequested && state.cloud) {
        cloudSyncRequested = false;
        const config = state.cloud;
        try {
          applyCloudSnapshot(await FlurbCloud.load(config), config);
          if (!navigator.onLine) {
            state.cloudStatus = "Offline. Edits are saved on this device.";
            sendCloudStatus();
            continue;
          }
          setCloudSpinner(true);
          await FlurbCloud.sync(config, (snapshot) => applyCloudSnapshot(snapshot, config));
          if (config === state.cloud) {
            const pending = state.cloudSnapshot?.pending.length || 0;
            state.cloudStatus = pending ? `${pending} local changes waiting to sync.` : "Synced with Turso.";
            sendCloudStatus();
          }
        } catch (error) {
          if (config !== state.cloud) continue;
          state.cloudStatus = navigator.onLine
            ? `Turso sync paused. ${error.message || "Could not reach Turso."}`
            : "Offline. Edits are saved on this device.";
          sendCloudStatus();
          if (!state.cloudSnapshot?.cursor && !state.catalog.size && navigator.onLine) showNotice(state.cloudStatus, "error");
        }
      }
    } finally {
      setCloudSpinner(false);
      runningCloud = false;
    }
  }

  async function loadCloudConfig() {
    const config = FlurbCloud.readConfig();
    if (config?.origin === state.cloud?.origin && config?.id === state.cloud?.id) {
      syncCloud();
      return;
    }
    state.cloud = config;
    state.cloudSnapshot = null;
    state.recentAlbumCache = null;
    state.cloudStatus = config ? "Connecting to Turso…" : "";
    state.folderPath = CATALOG_ROOT;
    state.folderHistory = [];
    state.activePlaylistId = null;
    state.recentGridReturn = null;
    state.libraryQueue = null;
    updateLibraryShuffleButton();
    hideNotice();
    state.catalog = new Map();
    state.catalogFolders = new Map();
    state.favorites = new Set();
    state.playlists = [];
    refreshCatalogView();
    sendCloudStatus();
    if (!config) return;
    try {
      applyCloudSnapshot(await FlurbCloud.load(config), config);
    } catch (error) {
      showNotice(error.message || "Could not open the Turso cache.", "error");
    }
    syncCloud();
  }

  async function editCloud(buildEvents) {
    const config = state.cloud;
    if (!config) {
      openSettings();
      return false;
    }
    try {
      applyCloudSnapshot(await FlurbCloud.edit(config, buildEvents), config);
      syncCloud();
      return config === state.cloud;
    } catch (error) {
      showNotice(error.message || "Could not save the edit.", "error");
      return false;
    }
  }
  function filteredTracks() {
    const query = els.search.value.trim().toLocaleLowerCase();
    return visibleTracks().filter((track) => !query ||
      [trackTitle(track), track.name, playerArtist(track)].some((name) => name.toLocaleLowerCase().includes(query)));
  }
  function visibleTracks() {
    if (state.viewMode === "favorites") {
      const compare = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;
      return [...state.favorites].map((id) => state.catalog.get(id)).sort((a, b) =>
        compare(playerArtist(a), playerArtist(b)) || compare(trackTitle(a), trackTitle(b)));
    }
    if (state.viewMode === "recent") {
      const cutoff = recentCutoff();
      const root = state.folderPath === CATALOG_ROOT;
      const tracks = root ? [...state.catalog.values()] : state.tracks;
      return tracks.filter((track) => addedDate(track) >= cutoff).sort(root ? recentlyAdded : albumTrackOrder);
    }
    if (state.viewMode === "playlists") return state.playlists.find((playlist) => playlist.id === state.activePlaylistId)?.tracks || [];
    return state.tracks;
  }
  function libraryLetter(name) {
    const first = String(name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").charAt(0).toUpperCase();
    return /^[A-Z]$/.test(first) ? first : "Unknown";
  }
  function makeLibraryLetterRow(letter) {
    const row = document.createElement("div");
    row.className = `library-row library-letter-row${letter === "Unknown" ? " is-unknown" : ""}`;
    row.dataset.letter = letter;
    row.setAttribute("role", "separator");
    row.setAttribute("aria-label", letter);
    const marker = document.createElement("span");
    marker.className = "library-letter-marker";
    marker.textContent = letter;
    row.append(marker);
    return row;
  }
  function groupRowsByLetter(rows, includeUnknown) {
    const groups = new Map();
    rows.forEach((row) => {
      const letter = libraryLetter(row.kind === "track" ? trackTitle(row.item) : row.item.name);
      if (letter === "Unknown" && !includeUnknown) {
        if (!groups.has("#")) groups.set("#", []);
        groups.get("#").push(row);
        return;
      }
      if (!groups.has(letter)) groups.set(letter, []);
      groups.get(letter).push(row);
    });
    const letters = [...groups.keys()].filter((letter) => letter !== "#").sort((a, b) => a === "Unknown" ? 1 : b === "Unknown" ? -1 : a.localeCompare(b));
    const ordered = [];
    letters.forEach((letter) => ordered.push({ kind: "letter", letter }, ...groups.get(letter)));
    ordered.push(...(groups.get("#") || []));
    return ordered;
  }
  function searchLetter() {
    const first = els.search.value.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").charAt(0).toUpperCase();
    return /^[A-Z]$/.test(first) ? first : "";
  }
  function scrollToSearchLetter() {
    const first = searchLetter();
    if (!first) return;
    requestAnimationFrame(() => {
      if (first !== searchLetter()) return;
      const target = [...els.tableBody.querySelectorAll(".library-letter-row")].find((row) => row.dataset.letter === first);
      if (!target) return;
      if (window.matchMedia("(max-width: 699px)").matches) {
        const listRect = els.trackList.getBoundingClientRect();
        const targetTop = target.getBoundingClientRect().top - listRect.top + els.trackList.scrollTop;
        els.trackList.scrollTo({ top: targetTop, behavior: "smooth" });
        return;
      }
      const sticky = document.querySelector(".library-sticky");
      const offset = target.getBoundingClientRect().top - (sticky?.getBoundingClientRect().height || 0);
      window.scrollBy({ top: offset, behavior: "smooth" });
    });
  }
  const trackNumber = (value) => Number(value) || Number.MAX_SAFE_INTEGER;
  function albumTrackOrder(a, b) {
    return (Number(a.disc_number) || 1) - (Number(b.disc_number) || 1) ||
      trackNumber(a.track_number) - trackNumber(b.track_number) ||
      trackTitle(a).localeCompare(trackTitle(b), undefined, { numeric: true, sensitivity: "base" });
  }
  function catalogScroller() {
    return window.matchMedia("(max-width: 699px)").matches ? els.trackList : document.scrollingElement;
  }
  function openRecentAlbum(album) {
    state.recentGridReturn = {
      top: catalogScroller().scrollTop,
      query: els.search.value,
      searchScroll: state.searchScroll,
      limit: state.displayLimit
    };
    history.pushState({ flurbFolder: album.path }, "", location.href);
    loadLibraryFolder(album.path);
    catalogScroller().scrollTo({ top: 0, behavior: "instant" });
  }
  function returnToRecentGrid() {
    const previous = state.recentGridReturn;
    state.recentGridReturn = null;
    state.folderPath = CATALOG_ROOT;
    state.displayLimit = previous?.limit ?? 100;
    els.search.value = previous?.query ?? "";
    state.searchScroll = previous?.searchScroll ?? null;
    syncSearchState();
    refreshCatalogView(false);
    catalogScroller().scrollTo({ top: previous?.top ?? 0, behavior: "instant" });
  }
  function recentAlbumPath(track) {
    return compilationAlbumPath(track) || albumPath(track);
  }
  function artworkCandidates(album) {
    return album.tracks.filter(supportsArtwork).sort(albumTrackOrder).slice(0, 3);
  }
  function buildRecentAlbums() {
    const albums = new Map();
    for (const track of state.catalog.values()) {
      const compilation = compilationAlbumPath(track);
      const path = recentAlbumPath(track);
      if (!albums.has(path)) {
        albums.set(path, {
          path, name: track.album?.trim() || "Unknown Album", artist: compilation ? "Various Artists" : artistName(track),
          added: addedDate(track), tracks: []
        });
      }
      const album = albums.get(path);
      album.added = Math.max(album.added, addedDate(track));
      album.tracks.push(track);
    }
    return [...albums.values()].sort((a, b) => b.added - a.added || a.name.localeCompare(b.name));
  }
  function recentAlbums(query) {
    state.recentAlbumCache ??= buildRecentAlbums();
    const source = state.recentAlbumCache;
    const cutoff = recentCutoff();
    const previous = state.recentAlbumWindow;
    if (previous?.source !== source || previous.cutoff !== cutoff) {
      const albums = source.filter((album) => album.added >= cutoff);
      state.recentAlbumWindow = {
        source, cutoff,
        albums: previous?.source === source && albums.length === previous.albums.length ? previous.albums : albums
      };
    }
    const albums = state.recentAlbumWindow.albums;
    if (!query) return albums;
    return albums.filter((album) =>
      [album.name, album.artist].some((name) => name.toLocaleLowerCase().includes(query)));
  }
  function refreshRecentCutoff() {
    if (!state.cloudSnapshot || state.recentAlbumWindow?.cutoff === recentCutoff()) return;
    updateQuickActions();
    if (state.viewMode === "recent") {
      const scroll = catalogScroller();
      const top = scroll.scrollTop;
      renderTracks(false);
      scroll.scrollTo({ top, behavior: "instant" });
    }
  }
  function makeRecentAlbumTile(album) {
    const item = document.createElement("div");
    item.setAttribute("role", "listitem");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recent-album-cover";
    button.setAttribute("aria-label", `Open ${album.name} by ${album.artist}`);
    const image = document.createElement("img");
    image.alt = "";
    state.recentArtworkElements.set(album.path, image);
    const fallback = document.createElement("span");
    fallback.className = "recent-album-label";
    fallback.setAttribute("aria-hidden", "true");
    const title = document.createElement("strong");
    title.textContent = album.name;
    const artist = document.createElement("span");
    artist.textContent = album.artist;
    fallback.append(title, artist);
    button.append(image, fallback);
    item.append(button);
    button.addEventListener("click", () => openRecentAlbum(album));
    const candidates = artworkCandidates(album);
    image._flurbArtworkCandidates = candidates;
    image._flurbArtworkMissing = () => {
      const cached = album.tracks.find((track) => state.artworkLinks.has(track.id));
      const next = cached || candidates.find((track) => !state.completedMetadata.has(track.id));
      if (next) registerTrackArtwork(image, next);
    };
    image._flurbArtworkMissing();
    return item;
  }
  function observeMoreRows(count) {
    if (count <= state.displayLimit) return;
    const row = document.createElement("div");
    row.className = "list-sentinel";
    row.setAttribute("aria-hidden", "true");
    els.tableBody.append(row);
    state.listObserver = new IntersectionObserver((items) => {
      if (!items.some((item) => item.isIntersecting)) return;
      state.listObserver?.disconnect();
      state.displayLimit += 100;
      renderTracks(false);
    }, { rootMargin: "500px 0px" });
    state.listObserver.observe(row);
  }
  function renderTracks(scrollSearch = true) {
    setLibraryLoading(false);
    state.listObserver?.disconnect();
    state.artworkObserver?.disconnect();
    state.artworkElements.clear();
    state.recentArtworkElements.clear();
    els.tableBody.replaceChildren();
    const showAlbumGrid = isRecentlyAddedGrid();
    els.trackList.classList.toggle("is-recent-albums", showAlbumGrid);
    els.emptyState.hidden = true;
    if (!state.cloud) {
      els.emptyState.hidden = false;
      els.emptyState.querySelector("p").textContent = "Connect your Turso library";
      els.settingsLink.hidden = false;
      return;
    }
    els.settingsLink.hidden = true;
    if (!state.cloudSnapshot) { setLibraryLoading(true); return; }
    const query = els.search.value.trim().toLocaleLowerCase();
    if (showAlbumGrid) {
      const albums = recentAlbums(query);
      requestAnimationFrame(pumpArtworkQueue);
      els.trackCount.textContent = `· ${albums.length} album${albums.length === 1 ? "" : "s"}`;
      if (!albums.length) {
        els.emptyState.hidden = false;
        els.emptyState.querySelector("p").textContent = query ? "No results" : "No albums";
        return;
      }
      for (const album of albums.slice(0, state.displayLimit)) els.tableBody.append(makeRecentAlbumTile(album));
      observeMoreRows(albums.length);
      return;
    }
    const tracks = filteredTracks();
    const folders = state.entries.filter((folder) => !query || folder.name.toLocaleLowerCase().includes(query));
    els.trackCount.textContent = `· ${tracks.length} track${tracks.length === 1 ? "" : "s"} · ${folders.length} folder${folders.length === 1 ? "" : "s"}`;
    const atViewRoot = state.viewMode === "playlists"
      ? !state.activePlaylistId
      : state.folderPath === CATALOG_ROOT;
    if (state.viewMode === "playlists" && !state.activePlaylistId) {
      const create = document.createElement("button"); create.type = "button"; create.className = "library-row artist-row playlist-create"; create.textContent = "+ New playlist";
      create.addEventListener("click", () => openNewPlaylist()); els.tableBody.append(create);
      const playlists = state.playlists.filter((playlist) => !query || playlist.name.toLocaleLowerCase().includes(query)).slice().sort((a, b) => a.name.localeCompare(b.name));
      const playlistRows = playlists.map((item) => ({ kind: "playlist", item }));
      const renderedPlaylists = groupRowsByLetter(playlistRows, false);
      const searchHeaderIndex = renderedPlaylists.findIndex((row) => row.kind === "letter" && row.letter === searchLetter());
      if (searchHeaderIndex >= state.displayLimit) state.displayLimit = searchHeaderIndex + 1;
      renderedPlaylists.slice(0, state.displayLimit).forEach(({ kind, item, letter }) => {
        if (kind === "letter") els.tableBody.append(makeLibraryLetterRow(letter));
        else els.tableBody.append(makePlaylistRow(item));
      });
      els.trackCount.textContent = `· ${state.playlists.length} playlist${state.playlists.length === 1 ? "" : "s"}`;
      if (!state.playlists.length) { els.emptyState.hidden = false; els.emptyState.querySelector("p").textContent = "No playlists"; }
      if (scrollSearch && query) scrollToSearchLetter();
      return;
    }
    const rows = [
      ...folders.map((folder) => ({ kind: "folder", item: folder })),
      ...tracks.map((track) => ({ kind: "track", item: track }))
    ];
    if (state.viewMode === "library") rows.sort((a, b) =>
      (a.kind === "track" ? trackTitle(a.item) : a.item.name).localeCompare(
        b.kind === "track" ? trackTitle(b.item) : b.item.name, undefined, { numeric: true, sensitivity: "base" }));

    if (!rows.length) {
      els.emptyState.hidden = false;
      els.emptyState.querySelector("p").textContent = query ? "No results" : state.viewMode === "favorites" ? "No favorites" : state.viewMode === "playlists" ? "This playlist is empty" : "No tracks";
      els.emptyState.querySelector("span").textContent = "";
      return;
    }
    const renderedRows = atViewRoot && state.viewMode === "library"
      ? groupRowsByLetter(rows, state.viewMode === "library")
      : rows;
    const searchHeaderIndex = renderedRows.findIndex((row) => row.kind === "letter" && row.letter === searchLetter());
    if (searchHeaderIndex >= state.displayLimit) state.displayLimit = searchHeaderIndex + 1;
    renderedRows.slice(0, state.displayLimit).forEach(({ kind, item, letter }, index) => {
      if (kind === "letter") els.tableBody.append(makeLibraryLetterRow(letter));
      else els.tableBody.append(kind === "folder" ? makeFolderRow(item, index) : makeTrackRow(item, index));
    });
    renderLucideIcons(els.tableBody);
    observeMoreRows(renderedRows.length);
    if (scrollSearch && query && atViewRoot) scrollToSearchLetter();
  }
  function playlistModified(id, now) {
    return { kind: "metadata", key: `playlist_modified_v1:${id}`, patch: { value: String(now) } };
  }

  let newPlaylistTrack = null;
  let newPlaylistBusy = false;

  function openNewPlaylist(track = null) {
    newPlaylistTrack = track;
    els.newPlaylistForm.reset();
    els.newPlaylistMessage.textContent = "";
    els.newPlaylist.showModal();
  }
  async function createPlaylist(name, track) {
    const id = crypto.randomUUID();
    const now = appleTimestamp();
    let created = false;
    const saved = await editCloud((cache) => {
      if (track && !cache.tracks.has(track.id)) return [];
      created = true;
      return [
        { kind: "playlist", key: id, patch: { id, name, smart_rule: null, manual_order: null, created_at: now } },
        { kind: "members", key: id, patch: { tracks: track ? [track.id] : [] } },
        playlistModified(id, now)
      ];
    });
    if (!saved || !created) return false;
    if (track) toast(`Added to ${name}`);
    else if (state.playlists.some((playlist) => playlist.id === id)) selectPlaylistView(id);
    return true;
  }
  function selectPlaylistView(id) {
    if (id === state.activePlaylistId) return;
    state.activePlaylistId = id;
    state.displayLimit = 100;
    els.search.value = "";
    state.searchScroll = null;
    syncSearchState();
    refreshCatalogView();
  }
  function makePlaylistRow(playlist) {
    const row = document.createElement("button"); row.type = "button"; row.className = "library-row artist-row playlist-row";
    row.setAttribute("aria-label", `Open ${playlist.name}`);
    const copy = document.createElement("span"); copy.className = "track-copy";
    const title = document.createElement("span"); title.className = "track-name"; title.textContent = playlist.name;
    const meta = document.createElement("span"); meta.className = "track-meta"; meta.textContent = `${playlist.tracks.length} tracks`;
    copy.append(title, meta); row.append(copy);
    row.addEventListener("click", () => selectPlaylistView(playlist.id));
    return row;
  }
  async function addTrackToPlaylist(track, playlist) {
    let result = "unavailable";
    const saved = await editCloud((cache) => {
      const current = cache.playlists.get(playlist.id);
      const tracks = cache.members.get(playlist.id) || [];
      if (!current || current.smart_rule || !cache.tracks.has(track.id)) return [];
      if (tracks.includes(track.id)) {
        result = "duplicate";
        return [];
      }
      result = "added";
      return [
        { kind: "members", key: playlist.id, patch: { tracks: [...tracks, track.id] } },
        playlistModified(playlist.id, appleTimestamp())
      ];
    });
    return saved ? result : "failed";
  }
  let playlistPickerTrack = null;
  let playlistPickerBusy = false;

  function openPlaylistPicker(track) {
    playlistPickerTrack = track;
    playlistPickerBusy = false;
    els.playlistPickerMessage.textContent = "";
    els.playlistPickerMessage.classList.remove("is-error");
    els.playlistPickerList.removeAttribute("aria-busy");
    els.playlistPickerList.replaceChildren();
    const playlists = state.playlists.filter((playlist) => !playlist.smart_rule)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    for (const playlist of playlists) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = playlist.name;
      button.addEventListener("click", () => selectPlaylist(playlist));
      els.playlistPickerList.append(button);
    }
    els.playlistPickerList.scrollTop = 0;
    if (!playlists.length) els.playlistPickerMessage.textContent = "No editable playlists yet.";
    els.playlistPicker.showModal();
  }
  async function selectPlaylist(playlist) {
    const track = playlistPickerTrack;
    if (!track || playlistPickerBusy) return;
    playlistPickerBusy = true;
    els.playlistPickerList.setAttribute("aria-busy", "true");
    const result = await addTrackToPlaylist(track, playlist);
    if (playlistPickerTrack !== track || !els.playlistPicker.open) return;
    playlistPickerBusy = false;
    els.playlistPickerList.removeAttribute("aria-busy");
    if (result === "added") {
      els.playlistPicker.close();
      toast(`Added to ${playlist.name}`);
      return;
    }
    els.playlistPickerMessage.classList.add("is-error");
    els.playlistPickerMessage.textContent = result === "duplicate"
      ? `This track is already in ${playlist.name}.`
      : result === "unavailable" ? "This track or playlist is no longer available." : "Could not add this track. Try again.";
  }
  function showAlbumInLibrary(track) {
    if (!state.catalog.has(track.id)) return;
    const origin = captureView();
    const path = albumPath(state.catalog.get(track.id));
    history.replaceState({ ...history.state, flurbView: origin }, "", location.href);
    restoreView({ view: "library", path, playlistId: null, recentGridReturn: null, query: "", searchScroll: null, limit: 100, top: 0 });
    history.pushState({ flurbView: captureView() }, "", location.href);
  }
  function makeFolderRow(folder, index = 0) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "library-row folder-row artist-row";
    row.setAttribute("aria-label", `Open ${folder.name}`);
    const leading = document.createElement("span");
    leading.className = "track-leading folder-leading";
    leading.innerHTML = '<i class="folder-icon" data-lucide="folder" aria-hidden="true"></i>';
    const copy = document.createElement("span");
    copy.className = "track-copy";
    const title = document.createElement("span");
    title.className = "track-name";
    title.textContent = folder.name;
    const meta = document.createElement("span");
    meta.className = "track-meta";
    meta.textContent = state.folderPath === CATALOG_ROOT ? "ARTIST" : "FOLDER";
    copy.append(title, meta);
    row.append(leading, copy);
    row.addEventListener("click", () => {
      state.folderHistory = folderAncestors(folder.path_lower);
      history.pushState({ flurbFolder: folder.path_lower }, "", location.href);
      loadLibraryFolder(folder.path_lower);
    });
    return row;
  }
  function makeTrackRow(track, index) {
    const row = document.createElement("div");
    row.setAttribute("role", "listitem");
    row.setAttribute("tabindex", "0");
    const isCurrent = state.current?.id === track.id;
    const isPlaying = isCurrent && !els.audio.paused && !els.audio.ended;
    row.dataset.trackId = track.id;
    row.className = `library-row track-row${isCurrent ? " is-playing" : ""}`;
    const artworkShell = document.createElement("span");
    artworkShell.className = "track-artwork-shell";
    const placeholder = document.createElement("i");
    placeholder.className = "artwork-placeholder";
    placeholder.setAttribute("data-lucide", isPlaying ? "volume-2" : "music-2");
    placeholder.setAttribute("aria-hidden", "true");
    if (isPlaying) {
      artworkShell.classList.add("playing-speaker");
      artworkShell.append(placeholder);
    } else {
      const artwork = document.createElement("img");
      artwork.className = "track-artwork";
      artwork.alt = "";
      artwork.width = 44;
      artwork.height = 44;
      artworkShell.append(artwork, placeholder);
      registerTrackArtwork(artwork, track);
    }
    const copy = document.createElement("div");
    copy.className = "track-copy";
    const title = document.createElement("span");
    title.className = "track-name";
    const meta = document.createElement("span");
    meta.className = "track-meta";
    meta.textContent = playerArtist(track);
    copy.append(title, meta);
    const actions = document.createElement("div");
    actions.className = "track-actions";
    const favorite = document.createElement("button");
    favorite.type = "button";
    favorite.className = `icon-button track-favorite${state.favorites.has(track.id) ? " active" : ""}`;
    favorite.innerHTML = '<i data-lucide="heart" aria-hidden="true"></i>';
    favorite.addEventListener("click", (event) => { event.stopPropagation(); toggleFavorite(track); });
    const overflow = document.createElement("div"); overflow.className = "track-overflow";
    const more = document.createElement("button"); more.type = "button"; more.className = "icon-button track-more"; more.innerHTML = '<i data-lucide="ellipsis" aria-hidden="true"></i>';
    const menu = document.createElement("div"); menu.className = "track-overflow-menu"; menu.hidden = true;
    const add = document.createElement("button"); add.type = "button"; add.textContent = "Add to playlist";
    add.addEventListener("click", (event) => {
      event.stopPropagation();
      menu.hidden = true;
      openPlaylistPicker(track);
    });
    const album = document.createElement("button");
    album.type = "button";
    album.textContent = "Show album in library";
    album.addEventListener("click", (event) => {
      event.stopPropagation();
      menu.hidden = true;
      showAlbumInLibrary(track);
    });
    menu.append(add, album);
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      document.querySelectorAll(".track-overflow-menu").forEach((other) => { if (other !== menu) other.hidden = true; });
      menu.hidden = !menu.hidden;
      menu.classList.remove("opens-up");
      if (!menu.hidden && menu.getBoundingClientRect().bottom > Math.min(window.innerHeight, els.player.getBoundingClientRect().top)) {
        menu.classList.add("opens-up");
      }
    });
    overflow.append(more, menu);
    actions.append(favorite, overflow);
    row.append(artworkShell, copy, actions);
    updateTrackRowTitle(row, track);
    row.addEventListener("click", (event) => {
      if (!event.target.closest("button")) playTrack(track);
    });
    row.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && event.target === row) {
        event.preventDefault();
        playTrack(track);
      }
    });
    return row;
  }
  async function playTrack(track, libraryQueue = null) {
    if (!state.token || !state.libraryFolder) {
      openSettings();
      return;
    }
    if (!state.catalog.has(track.id)) return;
    track = state.catalog.get(track.id);
    const path = dropboxTrackPath(track);
    state.libraryQueue = libraryQueue;
    updateLibraryShuffleButton();
    const requestId = ++state.playRequest;
    els.audio.pause();
    state.loadingTrack = true;
    state.current = track;
    updatePlayerArtwork(track);
    queueTrackArtwork(track, true);
    setPlayerMetadata(track);
    if (state.loadingTrack) els.nowAlbum.innerHTML = '<span class="player-loading" role="status" aria-label="Loading track"><i></i></span>';
    els.nowFavorite.disabled = false;
    updateFavoriteButton();
    updateTransport();
    renderTracks();
    try {
      const result = await dropbox("/files/get_temporary_link", { path });
      if (requestId !== state.playRequest) return;
      els.audio.src = result.link;
      await els.audio.play();
      hideNotice();
      updateTransport();
      renderTracks();
    } catch (error) {
      if (requestId === state.playRequest) {
        const reason = /path\/not_found/.test(error.message) ? "This file is missing from this device’s Dropbox music folder." : friendlyError(error);
        showNotice(`Could not play this track. ${reason}`, "error");
      }
    } finally {
      if (requestId === state.playRequest) {
        state.loadingTrack = false;
        if (state.current) setPlayerMetadata(state.current);
        updateTransport();
      }
    }
  }
  function setShuffle(enabled) {
    state.shuffle = enabled;
    els.shuffle.classList.toggle("active", enabled);
    els.shuffle.setAttribute("aria-label", `Shuffle ${enabled ? "on" : "off"}`);
    els.shuffle.setAttribute("aria-pressed", String(enabled));
    updateLibraryShuffleButton();
  }
  function updateLibraryShuffleButton() {
    els.shuffleLibrary.setAttribute("aria-pressed", String(Boolean(state.shuffle && state.libraryQueue)));
  }
  function shuffleLibrary() {
    if (els.shuffleLibrary.hidden) return;
    if (!state.token || !state.libraryFolder) return openSettings();
    const queue = [...state.catalog.values()];
    if (!queue.length) return toast("No playable tracks in this library");
    const candidates = queue.filter((track) => track.id !== state.current?.id);
    const track = candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : queue[0];
    setShuffle(true);
    playTrack(track, queue);
  }
  function playNext(direction = 1) {
    const playlist = state.libraryQueue || visibleTracks();
    if (!playlist.length) return;
    const currentIndex = playlist.findIndex((track) => track.id === state.current?.id);
    let nextIndex;
    if (state.shuffle && direction > 0 && playlist.length > 1) {
      const choices = playlist.length - (currentIndex >= 0 ? 1 : 0);
      nextIndex = Math.floor(Math.random() * choices);
      if (currentIndex >= 0 && nextIndex >= currentIndex) nextIndex += 1;
    } else if (currentIndex < 0) {
      nextIndex = direction > 0 ? 0 : playlist.length - 1;
    } else {
      nextIndex = (currentIndex + direction + playlist.length) % playlist.length;
    }
    playTrack(playlist[nextIndex], state.libraryQueue);
  }
  function registerMediaSessionActions() {
    const session = navigator.mediaSession;
    if (!session?.setActionHandler) return;
    const actions = {
      play: () => els.audio.play().catch((error) => showNotice(friendlyError(error), "error")),
      pause: () => els.audio.pause(),
      previoustrack: () => playNext(-1),
      nexttrack: () => playNext(1),
      seekto: (details) => { if (Number.isFinite(details.seekTime)) els.audio.currentTime = details.seekTime; }
    };
    Object.entries(actions).forEach(([action, handler]) => { try { session.setActionHandler(action, handler); } catch (_) {} });
    // iOS Safari can retain its default 10-second controls unless these are explicitly removed.
    ["seekbackward", "seekforward"].forEach((action) => { try { session.setActionHandler(action, null); } catch (_) {} });
  }
  function updateTransport() {
    const hasTrack = Boolean(state.current);
    els.play.disabled = !hasTrack || state.loadingTrack;
    els.nowPlayingLink.disabled = !hasTrack;
    els.playerArtworkButton.disabled = !state.current || !state.artworkLinks.has(state.current.id);
    els.nowPlayingLink.setAttribute("aria-label", hasTrack ? `Open folder containing ${trackTitle(state.current)}` : "Nothing playing");
    els.previous.disabled = !hasTrack;
    els.next.disabled = !hasTrack;
    els.progress.disabled = !hasTrack || !Number.isFinite(els.audio.duration);
    els.play.classList.toggle("playing", !els.audio.paused);
    els.play.setAttribute("aria-label", els.audio.paused ? "Play" : "Pause");
    if (navigator.mediaSession) navigator.mediaSession.playbackState = !hasTrack ? "none" : els.audio.paused ? "paused" : "playing";
  }
  function updateFavoriteButton() {
    const active = Boolean(state.current && state.favorites.has(state.current.id));
    els.nowFavorite.disabled = !state.current || !state.catalog.has(state.current.id);
    els.nowFavorite.classList.toggle("active", active);
    els.nowFavorite.setAttribute("aria-label", active ? "Remove current track from favorites" : "Favorite current track");
  }
  let keyboardBaselineHeight = window.visualViewport?.height || window.innerHeight;
  let keyboardOpen = false;
  function syncSearchState() {
    document.body.classList.toggle("is-searching", Boolean(els.search.value.trim()));
    const viewport = window.visualViewport;
    if (!viewport || !window.matchMedia("(max-width: 699px)").matches) {
      keyboardOpen = false;
      keyboardBaselineHeight = viewport?.height || window.innerHeight;
    } else {
      const heightLost = keyboardBaselineHeight - viewport.height;
      const bottomInset = window.innerHeight - viewport.offsetTop - viewport.height;
      if (keyboardOpen) {
        // Blur can fire before Safari has moved the visual viewport back down.
        keyboardOpen = heightLost > 70 || bottomInset > 40;
      } else if (document.activeElement === els.search) {
        keyboardOpen = heightLost > 100 || bottomInset > 100;
        keyboardBaselineHeight = Math.max(keyboardBaselineHeight, viewport.height);
      } else {
        keyboardBaselineHeight = viewport.height;
      }
    }
    document.body.classList.toggle("is-keyboard-open", keyboardOpen);
  }
  function syncMobileViewport() {
    const viewport = window.visualViewport;
    const viewportTop = Math.max(0, viewport?.offsetTop || 0);
    const viewportBottom = Math.max(0, window.innerHeight - viewportTop - (viewport?.height || window.innerHeight));
    els.librarySticky.style.top = `${viewportTop}px`;
    document.documentElement.style.setProperty("--visual-viewport-top", `${viewportTop}px`);
    document.documentElement.style.setProperty("--visual-viewport-bottom", `${viewportBottom}px`);
    const stickyHeight = els.librarySticky.getBoundingClientRect().height;
    if (stickyHeight > 0) document.documentElement.style.setProperty("--library-sticky-height", `${stickyHeight}px`);
    const playerHeight = els.player.getBoundingClientRect().height;
    if (playerHeight > 0) document.documentElement.style.setProperty("--player-height", `${playerHeight}px`);
  }
  let viewportSyncPending = false;
  function scheduleViewportSync() {
    if (viewportSyncPending) return;
    viewportSyncPending = true;
    requestAnimationFrame(() => {
      viewportSyncPending = false;
      syncSearchState();
      syncMobileViewport();
    });
  }
  function toggleFavorite(track) {
    return editCloud((cache) => {
      const current = cache.tracks.get(track.id);
      return current ? [{ kind: "track", key: track.id, patch: { favorite: current.favorite ? 0 : 1 } }] : [];
    });
  }
  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return "0:00";
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  }
  function renderProgress() {
    const duration = els.audio.duration;
    if (Number.isFinite(duration) && duration > 0) {
      els.progress.value = String((els.audio.currentTime / duration) * 100);
      els.elapsed.textContent = formatTime(els.audio.currentTime);
      els.duration.textContent = formatTime(duration);
    } else {
      els.progress.value = "0";
      els.elapsed.textContent = "0:00";
      els.duration.textContent = "0:00";
    }
    els.progress.style.setProperty("--progress", `${Number(els.progress.value)}%`);
    if (Number.isFinite(duration) && duration > 0 && navigator.mediaSession?.setPositionState) {
      try { navigator.mediaSession.setPositionState({ duration, playbackRate: els.audio.playbackRate || 1, position: Math.min(els.audio.currentTime, duration) }); } catch (_) {}
    }
    updateTransport();
  }
  function updateSearchResults() {
    const searching = Boolean(els.search.value.trim());
    const scroller = window.matchMedia("(max-width: 699px)").matches
      ? els.trackList : document.scrollingElement;
    els.clearSearch.disabled = !els.search.value;
    syncSearchState();
    if (searching) {
      state.searchScroll ??= { top: scroller.scrollTop, limit: state.displayLimit };
      state.displayLimit = 100;
      renderTracks();
    } else {
      const saved = state.searchScroll;
      state.searchScroll = null;
      if (saved) state.displayLimit = saved.limit;
      renderTracks();
      if (saved) scroller.scrollTo({ top: saved.top, behavior: "instant" });
    }
  }
  els.search.addEventListener("input", updateSearchResults);
  els.search.addEventListener("focus", syncSearchState);
  els.search.addEventListener("blur", scheduleViewportSync);
  window.visualViewport?.addEventListener("resize", scheduleViewportSync);
  window.visualViewport?.addEventListener("scroll", scheduleViewportSync);
  window.addEventListener("resize", scheduleViewportSync);
  window.addEventListener("scroll", scheduleViewportSync, { passive: true });
  window.addEventListener("orientationchange", scheduleViewportSync);
  syncMobileViewport();
  if ("ResizeObserver" in window) {
    const viewportSizeObserver = new ResizeObserver(scheduleViewportSync);
    viewportSizeObserver.observe(els.librarySticky);
    viewportSizeObserver.observe(els.player);
  }
  els.clearSearch.addEventListener("pointerdown", (event) => event.preventDefault());
  els.clearSearch.addEventListener("click", () => {
    els.search.value = "";
    updateSearchResults();
  });
  els.viewButton.addEventListener("click", () => {
    els.viewMenu.hidden = !els.viewMenu.hidden;
    els.viewButton.setAttribute("aria-expanded", String(!els.viewMenu.hidden));
  });
  els.recentOption.addEventListener("click", () => setViewMode("recent"));
  els.favoritesOption.addEventListener("click", () => setViewMode("favorites"));
  els.playlistsOption.addEventListener("click", () => setViewMode("playlists"));
  els.libraryOption.addEventListener("click", () => setViewMode("library"));
  document.addEventListener("click", (event) => {
    if (!els.viewMenu.hidden && !event.target.closest(".mode-picker")) {
      els.viewMenu.hidden = true;
      els.viewButton.setAttribute("aria-expanded", "false");
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const openTrackMenus = [...document.querySelectorAll(".track-overflow-menu")].filter((menu) => !menu.hidden);
    if (openTrackMenus.length && !event.target.closest(".track-overflow")) {
      const tappedTrack = event.target.closest(".track-row");
      openTrackMenus.forEach((menu) => { menu.hidden = true; });
      if (tappedTrack) { event.preventDefault(); event.stopImmediatePropagation(); }
    }
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.artworkViewer.hidden) { closeArtworkViewer(); return; }
    if (event.key === "Escape" && !els.settingsOverlay.hidden) { closeSettings(); return; }
    if (event.key === "Escape" && !els.viewMenu.hidden) {
      els.viewMenu.hidden = true;
      els.viewButton.setAttribute("aria-expanded", "false");
      els.viewButton.focus();
    }
  });
  els.playlistPickerClose.addEventListener("click", () => els.playlistPicker.close());
  els.playlistPicker.addEventListener("click", (event) => {
    if (event.target === els.playlistPicker) els.playlistPicker.close();
  });
  els.playlistPicker.addEventListener("close", () => {
    const track = playlistPickerTrack;
    playlistPickerTrack = null;
    playlistPickerBusy = false;
    if (track) els.tableBody.querySelector(`[data-track-id="${CSS.escape(track.id)}"] .track-more`)?.focus({ preventScroll: true });
  });
  els.playlistPickerCreate.addEventListener("click", () => {
    if (!playlistPickerTrack || playlistPickerBusy) return;
    const track = playlistPickerTrack;
    els.playlistPicker.close();
    openNewPlaylist(track);
  });
  els.newPlaylistForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (newPlaylistBusy) return;
    const name = els.newPlaylistName.value.trim();
    if (!name) {
      els.newPlaylistMessage.textContent = "Enter a playlist name.";
      els.newPlaylistName.focus();
      return;
    }
    newPlaylistBusy = true;
    els.newPlaylistName.readOnly = true;
    els.newPlaylistSubmit.disabled = els.newPlaylistCancel.disabled = true;
    els.newPlaylistMessage.textContent = "";
    try {
      if (await createPlaylist(name, newPlaylistTrack)) els.newPlaylist.close();
      else els.newPlaylistMessage.textContent = "Could not create the playlist. Try again.";
    } finally {
      newPlaylistBusy = false;
      els.newPlaylistName.readOnly = false;
      els.newPlaylistSubmit.disabled = els.newPlaylistCancel.disabled = false;
    }
  });
  els.newPlaylistCancel.addEventListener("click", () => els.newPlaylist.close());
  els.newPlaylist.addEventListener("cancel", (event) => { if (newPlaylistBusy) event.preventDefault(); });
  els.settingsLink.addEventListener("click", (event) => { event.preventDefault(); openSettings(); });
  els.home.addEventListener("click", goHomeLibrary);
  els.settingsButton.addEventListener("click", openSettings);
  els.settingsClose.addEventListener("click", closeSettings);
  els.settingsOverlay.querySelector("[data-close-settings]").addEventListener("click", closeSettings);
  els.settingsOverlay.addEventListener("click", (event) => { if (event.target === els.settingsOverlay) closeSettings(); });
  let titlePointerStart = null;
  els.nowTitleViewport.addEventListener("pointerdown", (event) => {
    if (!els.nowTitleViewport.classList.contains("is-overflowing")) return;
    titlePointerStart = { x: event.clientX, y: event.clientY };
    els.nowTitleViewport.classList.add("is-manual-scrolling");
    els.nowTitleViewport.scrollLeft = 0;
  });
  document.addEventListener("pointermove", (event) => {
    if (titlePointerStart && Math.abs(event.clientX - titlePointerStart.x) > 6 && Math.abs(event.clientX - titlePointerStart.x) > Math.abs(event.clientY - titlePointerStart.y)) state.titleScrollGesture = true;
  });
  const finishTitlePointer = () => {
    if (!titlePointerStart) return;
    titlePointerStart = null;
    setTimeout(() => { state.titleScrollGesture = false; }, 350);
  };
  document.addEventListener("dragstart", (event) => {
    if (event.target instanceof HTMLImageElement) event.preventDefault();
  });
  document.addEventListener("pointerup", finishTitlePointer);
  document.addEventListener("pointercancel", finishTitlePointer);
  els.nowPlayingLink.addEventListener("click", (event) => {
    if (state.titleScrollGesture) { event.preventDefault(); state.titleScrollGesture = false; return; }
    if (state.current) {
      if (!els.artworkViewer.hidden) closeArtworkViewer();
      showAlbumInLibrary(state.current);
    }
  });
  els.playerArtworkButton.addEventListener("click", () => {
    if (!els.artworkViewer.hidden) closeArtworkViewer();
    else if (state.current && state.artworkLinks.has(state.current.id)) openArtworkViewer(state.current);
  });
  let artworkSwipeStart = null;
  els.artworkViewer.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" || els.artworkViewer.hidden) return;
    artworkSwipeStart = { x: event.clientX, y: event.clientY };
  });
  els.artworkViewer.addEventListener("pointerup", (event) => {
    if (!artworkSwipeStart) return;
    const dx = event.clientX - artworkSwipeStart.x;
    const dy = event.clientY - artworkSwipeStart.y;
    artworkSwipeStart = null;
    if (dy > 80 && dy > Math.abs(dx) * 1.2) closeArtworkViewer();
  });
  els.artworkViewer.addEventListener("pointercancel", () => { artworkSwipeStart = null; });
  window.addEventListener("resize", () => {
    if (!els.artworkViewer.hidden && state.viewerTrack) {
      updateViewerArtwork(state.viewerTrack);
      const stickyBottom = els.librarySticky.getBoundingClientRect().bottom;
      const playerTop = els.player.getBoundingClientRect().top;
      els.artworkViewer.style.top = `${Math.max(0, stickyBottom)}px`;
      els.artworkViewer.style.bottom = `${Math.max(0, window.innerHeight - playerTop)}px`;
    }
  });
  window.addEventListener("resize", updateTitleMarquee);
  function refreshDropboxFolder() {
    try { state.libraryFolder = JSON.parse(localStorage.getItem("flurb.dropbox.libraryFolder") || "null"); } catch (_) { state.libraryFolder = null; }
    state.token = readDropboxToken();
    state.refreshToken = localStorage.getItem("flurb.dropbox.refreshToken") || "";
    state.tokenExpiresAt = Number(localStorage.getItem("flurb.dropbox.tokenExpiresAt") || 0);
    if (!state.token && state.current) {
      state.playRequest += 1;
      state.current = null;
      state.libraryQueue = null;
      state.loadingTrack = false;
      els.audio.pause();
      els.audio.removeAttribute("src");
      els.audio.load();
      closeArtworkViewer();
      els.nowTitle.textContent = "Nothing playing yet";
      els.nowAlbum.textContent = "";
      updateTitleMarquee();
      updateLibraryShuffleButton();
      updateFavoriteButton();
      updateTransport();
      if (navigator.mediaSession) navigator.mediaSession.metadata = null;
    }
    state.completedMetadata.clear();
    state.artworkCheckedAt.clear();
    state.artworkRechecks.clear();
    state.recentArtworkPreload = null;
    for (const queued of state.artworkQueue.splice(0)) state.artworkLoading.delete(queued.id);
    for (const link of state.artworkLinks.values()) URL.revokeObjectURL(link);
    state.artworkLinks.clear();
    updatePlayerArtwork(state.current);
    renderTracks();
  }
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.source !== $("#settings-frame").contentWindow) return;
    if (event.data?.type === "flurb-library-selected") {
      refreshDropboxFolder();
      closeSettings();
    }
    if (event.data?.type === "flurb-dropbox-session-changed") refreshDropboxFolder();
    if (event.data?.type === "flurb-turso-changed") loadCloudConfig();
    if (event.data?.type === "flurb-turso-status-request") sendCloudStatus();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === "flurb.turso.connection") loadCloudConfig();
    if (event.key === "flurb.dropbox.libraryFolder" || event.key === DROPBOX_SIGNED_OUT) refreshDropboxFolder();
  });
  window.addEventListener("online", () => {
    syncCloud();
    state.recentArtworkPreload = null;
    pumpArtworkQueue();
    checkVisibleArtwork();
  });
  window.addEventListener("offline", syncCloud);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    syncCloud();
    checkVisibleArtwork();
  });
  setInterval(() => {
    refreshRecentCutoff();
    syncCloud();
  }, 5000);
  setInterval(checkVisibleArtwork, ARTWORK_REVISION_INTERVAL);
  els.play.addEventListener("click", () => {
    if (!state.current) return;
    if (els.audio.paused) els.audio.play().catch((e) => showNotice(friendlyError(e), "error"));
    else els.audio.pause();
    updateTransport();
    renderTracks();
  });
  els.previous.addEventListener("click", () => {
    if (els.audio.currentTime > 3) els.audio.currentTime = 0;
    else playNext(-1);
  });
  els.next.addEventListener("click", () => playNext(1));
  els.shuffleLibrary.addEventListener("click", () => shuffleLibrary());
  els.shuffle.addEventListener("click", () => {
    setShuffle(!state.shuffle);
    toast(`Shuffle ${state.shuffle ? "on" : "off"}`);
  });
  els.repeat.addEventListener("click", () => {
    state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
    els.repeat.classList.toggle("active", state.repeat !== "off");
    els.repeat.setAttribute("aria-label", `Repeat ${state.repeat}`);
    els.repeat.title = `Repeat ${state.repeat}`;
    els.repeat.innerHTML = `<i data-lucide="${state.repeat === "one" ? "repeat-1" : "repeat"}" aria-hidden="true"></i>`;
    renderLucideIcons(els.repeat);
    toast(`Repeat ${state.repeat}`);
  });
  els.nowFavorite.addEventListener("click", () => { if (state.current) toggleFavorite(state.current); });
  els.progress.addEventListener("input", () => {
    els.progress.style.setProperty("--progress", `${Number(els.progress.value)}%`);
    if (Number.isFinite(els.audio.duration)) els.audio.currentTime = (Number(els.progress.value) / 100) * els.audio.duration;
  });
  els.audio.addEventListener("timeupdate", renderProgress);
  els.audio.addEventListener("loadedmetadata", () => { renderProgress(); renderTracks(); });
  els.audio.addEventListener("play", () => { updateTransport(); renderTracks(); });
  els.audio.addEventListener("playing", registerMediaSessionActions);
  els.audio.addEventListener("pause", () => { updateTransport(); renderTracks(); });
  els.audio.addEventListener("ended", () => {
    if (state.repeat === "one") { els.audio.currentTime = 0; els.audio.play(); }
    else {
      const playlist = state.libraryQueue || visibleTracks();
      if (state.repeat === "all" || state.shuffle || playlist.findIndex((t) => t.id === state.current?.id) < playlist.length - 1) playNext(1);
      else {
        updateTransport();
        renderTracks();
      }
    }
  });
  els.audio.addEventListener("error", () => {
    if (state.current && !els.audio.paused) showNotice("The audio stream was interrupted. Try playing the track again.", "error");
  });



  installHistoryNavigation();
  renderLucideIcons();
  updateConnection();
  updateTransport();
  refreshCatalogView();
  loadCloudConfig();
  handleOAuthReturn();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});

})();
