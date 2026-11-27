(() => {
  "use strict";
  const API = "https://api.dropboxapi.com/2";
  const CATALOG_ROOT = "/catalog";
  const { FlurbCloud } = window;
  const ARTWORK_HEADER_BYTES = 64 * 1024;
  const appleTimestamp = () => Date.now() / 1000 - 978307200;
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
    playlistsOption: $('[data-view="playlists"]'), playlistsCount: $("#playlists-count"), libraryOption: $('[data-view="library"]'),
    trackList: $("#track-list"), tableBody: $("#table-body"), emptyState: $("#empty-state"), trackCount: $("#track-count"), notice: $("#notice"), noticeMessage: $("#notice-message"),
    player: $("#player"), play: $("#play-button"),
    previous: $("#previous-button"), next: $("#next-button"), shuffle: $("#shuffle-button"), repeat: $("#repeat-button"), progress: $("#progress"),
    elapsed: $("#elapsed-time"), duration: $("#duration-time"), nowTitle: $("#now-title"), nowAlbum: $("#now-album"), nowFavorite: $("#now-favorite"),
    toast: $("#toast"), settingsLink: $("#settings-link")
  };
  const state = {
    token: localStorage.getItem("flurb.dropbox.accessToken") || sessionStorage.getItem("flurb.dropbox.accessToken") || "",
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
    artworkLoading: new Set(),
    artworkElements: new Map(),
    artworkObserver: null,
    artworkQueue: [],
    activeArtworkDownloads: 0,
    titleScrollGesture: false,
    entries: [],
    tracks: [],
    displayLimit: 100,
    searchScroll: null,
    recentGridReturn: null,
    recentAlbumCache: null,
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
    if (!force && state.token && (!state.tokenExpiresAt || Date.now() < state.tokenExpiresAt - 60_000)) return state.token;
    if (!state.refreshToken) {
      if (state.token && !force) return state.token;
      throw new Error("Reconnect Dropbox once to enable a lasting session.");
    }
    if (!state.refreshPromise) {
      state.refreshPromise = (async () => {
        const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: state.refreshToken, client_id: "b7db4q3upd3kspx" });
        const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form
        });
        const result = await response.json().catch(() => ({}));
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
    if (state.viewMode === "playlists" && state.activePlaylistId) {
      state.activePlaylistId = null;
      renderBreadcrumbs();
      renderTracks();
      return;
    }
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
    if (state.viewMode === "playlists") {
      state.activePlaylistId = null;
      state.folderHistory = [];
      renderBreadcrumbs();
      renderTracks();
      return;
    }
    if (!state.cloud) return;
    state.folderHistory = [];
    history.replaceState({ flurbRootGuard: true }, "", location.href);
    loadLibraryFolder();
  }
  function installHistoryNavigation() {
    history.replaceState({ flurbRootGuard: true }, "", location.href);
    history.pushState({ flurbRootGuard: true }, "", location.href);
    window.addEventListener("popstate", () => {
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
      const form = new URLSearchParams({ code, grant_type: "authorization_code", client_id: "b7db4q3upd3kspx", code_verifier: pending.verifier, redirect_uri: pending.redirectUri });
      const response = await fetch("https://api.dropbox.com/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error_description || result.error || "Dropbox sign-in failed.");
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
    els.recentCount.textContent = String(state.catalog.size);
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
    if (view !== state.viewMode) {
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
    const rootCrumb = { path: root, name: "Library" };
    const folders = [rootCrumb, ...state.folderHistory, ...(state.folderPath && state.folderPath !== root ? [{ path: state.folderPath, name: state.folderName }] : [])]
      .filter((item, index, all) => item.path && (index === 0 || item.path.startsWith(`${root}/`)) && all.findIndex((entry) => entry.path === item.path) === index);
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
  function registerTrackArtwork(image, track) {
    image._flurbTrack = track;
    let elements = state.artworkElements.get(track.id);
    if (!elements) state.artworkElements.set(track.id, elements = new Set());
    elements.add(image);
    const cached = state.artworkLinks.get(track.id);
    if (cached) {
      image.src = cached;
      image.classList.add("has-artwork");
      image.parentElement?.classList.add("has-artwork");
      return;
    }
    if (!state.artworkObserver && "IntersectionObserver" in window) {
      state.artworkObserver = new IntersectionObserver((observations) => {
        observations.forEach((observation) => {
          if (!observation.isIntersecting) return;
          state.artworkObserver.unobserve(observation.target);
          queueTrackArtwork(observation.target._flurbTrack);
        });
      }, { rootMargin: "220px 0px" });
    }
    if (state.artworkObserver) state.artworkObserver.observe(image);
    else queueTrackArtwork(track);
  }
  function queueTrackArtwork(track, prioritize = false) {
    if (!track || !supportsArtwork(track) || !state.token || !state.libraryFolder) return;
    const key = track.id;
    if (state.completedMetadata.has(key)) return;
    const queue = state.artworkQueue;
    if (state.artworkLoading.has(key)) {
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
  async function readMp3Artwork(track) {
    const first = await fetchTrackFile(track, `bytes=0-${ARTWORK_HEADER_BYTES - 1}`);
    const buffer = await first.arrayBuffer();
    const cover = extractId3Artwork(buffer);
    const tagEnd = id3TagEnd(buffer);
    if (cover || first.status !== 206 || tagEnd <= buffer.byteLength) return cover;
    const tag = await fetchTrackFile(track, `bytes=0-${tagEnd - 1}`);
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
  async function readFlacArtwork(track) {
    let start = 0;
    let bytes = new Uint8Array();
    async function read(offset, length) {
      if (offset < start || offset + length > start + bytes.length) {
        const response = await fetchTrackFile(track, `bytes=${offset}-${offset + Math.max(length, ARTWORK_HEADER_BYTES) - 1}`);
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
  function pumpArtworkQueue() {
    while (state.activeArtworkDownloads < 2 && state.artworkQueue.length) {
      const track = state.artworkQueue.shift();
      const folder = state.libraryFolder;
      state.activeArtworkDownloads += 1;
      const readArtwork = /\.flac$/i.test(track.name) ? readFlacArtwork : readMp3Artwork;
      readArtwork(track).then((cover) => {
        if (folder !== state.libraryFolder) return;
        state.completedMetadata.add(track.id);
        if (!cover) {
          const images = state.artworkElements.get(track.id);
          for (const image of [...(images || [])]) {
            if (!image.isConnected || !image._flurbArtworkMissing) continue;
            images.delete(image);
            image._flurbArtworkMissing();
          }
          return;
        }
        const link = URL.createObjectURL(cover);
        state.artworkLinks.set(track.id, link);
        state.artworkElements.get(track.id)?.forEach((image) => {
          image.src = link;
          image.classList.add("has-artwork");
          image.parentElement?.classList.add("has-artwork");
        });
        if (state.current?.id === track.id) {
          updateMediaMetadata(state.current);
          updatePlayerArtwork(state.current);
        }
        if (state.viewerTrack?.id === track.id) updateViewerArtwork(state.viewerTrack);
      }).catch(() => {}).finally(() => {
        state.artworkLoading.delete(track.id);
        state.activeArtworkDownloads -= 1;
        pumpArtworkQueue();
      });
    }
  }
  const addedDate = (track) => Number(track.flurb_added ?? track.added) || 0;
  const recentlyAdded = (a, b) => addedDate(b) - addedDate(a);
  const artistName = (track) => track.album_artist?.trim() || track.artist?.trim() || "Unknown Artist";
  const artistPath = (track) => `${CATALOG_ROOT}/${encodeURIComponent(artistName(track))}`;
  const albumPath = (track) => track.album?.trim()
    ? `${artistPath(track)}/${encodeURIComponent(track.album.trim())}` : artistPath(track);

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
    state.cloudSnapshot = snapshot;
    state.recentAlbumCache = null;
    state.catalog = new Map();
    state.catalogFolders = new Map();
    state.favorites = new Set();
    const root = catalogFolder(CATALOG_ROOT, "Library");
    for (const raw of snapshot.tracks.values()) {
      const track = { ...raw, name: raw.path.split("/").at(-1) };
      state.catalog.set(track.id, track);
      if (track.favorite) state.favorites.add(track.id);
      const artist = catalogFolder(artistPath(track), artistName(track), root);
      const album = albumPath(track);
      const folder = album === artist.path_lower ? artist : catalogFolder(album, track.album.trim(), artist);
      folder.tracks.push(track);
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
    }
    if (state.libraryQueue) state.libraryQueue = [...state.catalog.values()];
    refreshCatalogView(false);
    scroll.scrollTo({ top: offset, behavior: "instant" });
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
    } finally { runningCloud = false; }
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
    const tracks = query && state.viewMode === "library" && state.folderPath === CATALOG_ROOT
      ? [...state.catalog.values()] : visibleTracks();
    return tracks.filter((track) => !query || [trackTitle(track), track.name].some((name) => name.toLocaleLowerCase().includes(query)));
  }
  function visibleTracks() {
    if (state.viewMode === "favorites") return [...state.favorites].map((id) => state.catalog.get(id));
    if (state.viewMode === "recent") {
      return state.folderPath === CATALOG_ROOT
        ? [...state.catalog.values()].sort(recentlyAdded)
        : state.tracks.slice().sort(albumTrackOrder);
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
  function buildRecentAlbums() {
    const albums = new Map();
    for (const track of state.catalog.values()) {
      const path = albumPath(track);
      if (!albums.has(path)) {
        albums.set(path, {
          path, name: track.album?.trim() || "Unknown Album", artist: artistName(track),
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
    if (!query) return state.recentAlbumCache;
    return state.recentAlbumCache.filter((album) =>
      [album.name, album.artist].some((name) => name.toLocaleLowerCase().includes(query)) ||
      album.tracks.some((track) => trackTitle(track).toLocaleLowerCase().includes(query)));
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
    const cached = album.tracks.find((track) => state.artworkLinks.has(track.id));
    if (cached) registerTrackArtwork(image, cached);
    else {
      const candidates = album.tracks.filter((track) => supportsArtwork(track) && !state.completedMetadata.has(track.id))
        .sort(albumTrackOrder).slice(0, 3);
      image._flurbArtworkMissing = () => {
        const next = candidates.shift();
        if (next) registerTrackArtwork(image, next);
      };
      image._flurbArtworkMissing();
    }
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
    els.tableBody.replaceChildren();
    const showAlbumGrid = Boolean(state.cloudSnapshot && state.viewMode === "recent" && state.folderPath === CATALOG_ROOT);
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
      create.addEventListener("click", () => createPlaylist()); els.tableBody.append(create);
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
    if (state.viewMode !== "playlists" && state.viewMode !== "recent") rows.sort((a, b) =>
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

  async function createPlaylist(track = null) {
    const name = window.prompt("Playlist name")?.trim();
    if (!name) return;
    const id = crypto.randomUUID();
    const now = appleTimestamp();
    const saved = await editCloud((cache) => {
      if (track && !cache.tracks.has(track.id)) return [];
      return [
        { kind: "playlist", key: id, patch: { id, name, smart_rule: null, manual_order: null, created_at: now } },
        { kind: "members", key: id, patch: { tracks: track ? [track.id] : [] } },
        playlistModified(id, now)
      ];
    });
    if (!saved) return;
    if (track) toast(`Added to ${name}`);
    else if (state.playlists.some((playlist) => playlist.id === id)) {
      state.activePlaylistId = id;
      refreshCatalogView();
    }
  }
  function makePlaylistRow(playlist) {
    const row = document.createElement("button"); row.type = "button"; row.className = "library-row artist-row playlist-row";
    row.setAttribute("aria-label", `Open ${playlist.name}`);
    const copy = document.createElement("span"); copy.className = "track-copy";
    const title = document.createElement("span"); title.className = "track-name"; title.textContent = playlist.name;
    const meta = document.createElement("span"); meta.className = "track-meta"; meta.textContent = `${playlist.tracks.length} tracks`;
    copy.append(title, meta); row.append(copy);
    row.addEventListener("click", () => { state.activePlaylistId = playlist.id; renderBreadcrumbs(); renderTracks(); });
    return row;
  }
  async function addTrackToPlaylist(track, playlist) {
    let added = false;
    const saved = await editCloud((cache) => {
      const current = cache.playlists.get(playlist.id);
      const tracks = cache.members.get(playlist.id) || [];
      if (!current || current.smart_rule || !cache.tracks.has(track.id) || tracks.includes(track.id)) return [];
      added = true;
      return [
        { kind: "members", key: playlist.id, patch: { tracks: [...tracks, track.id] } },
        playlistModified(playlist.id, appleTimestamp())
      ];
    });
    if (saved && added) toast(`Added to ${playlist.name}`);
  }
  function showAlbumInLibrary(track) {
    if (!state.catalog.has(track.id)) return;
    const path = albumPath(state.catalog.get(track.id));
    state.viewMode = "library";
    state.activePlaylistId = null;
    localStorage.setItem("flurb.dropbox.actionView", "library");
    state.folderHistory = folderAncestors(path);
    loadLibraryFolder(path);
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
    const submenu = document.createElement("div"); submenu.className = "playlist-submenu"; submenu.hidden = true;
    state.playlists.filter((playlist) => !playlist.smart_rule).sort((a, b) => a.name.localeCompare(b.name)).forEach((playlist) => {
      const choice = document.createElement("button"); choice.type = "button"; choice.textContent = playlist.name;
      choice.addEventListener("click", (event) => { event.stopPropagation(); menu.hidden = true; addTrackToPlaylist(track, playlist); }); submenu.append(choice);
    });
    const create = document.createElement("button"); create.type = "button"; create.textContent = "+ New playlist…";
    create.addEventListener("click", (event) => { event.stopPropagation(); menu.hidden = true; createPlaylist(track); });
    submenu.append(create);
    const album = document.createElement("button"); album.type = "button"; album.textContent = "Show album in library"; album.addEventListener("click", (event) => { event.stopPropagation(); menu.hidden = true; showAlbumInLibrary(track); });
    menu.append(add, submenu, album); more.addEventListener("click", (event) => { event.stopPropagation(); document.querySelectorAll(".track-overflow-menu").forEach((other) => { if (other !== menu) other.hidden = true; }); menu.hidden = !menu.hidden; });
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
    state.token = localStorage.getItem("flurb.dropbox.accessToken") || sessionStorage.getItem("flurb.dropbox.accessToken") || "";
    state.refreshToken = localStorage.getItem("flurb.dropbox.refreshToken") || "";
    state.tokenExpiresAt = Number(localStorage.getItem("flurb.dropbox.tokenExpiresAt") || 0);
    state.completedMetadata.clear();
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
    if (event.data?.type === "flurb-turso-changed") loadCloudConfig();
    if (event.data?.type === "flurb-turso-status-request") sendCloudStatus();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === "flurb.turso.connection") loadCloudConfig();
    if (event.key === "flurb.dropbox.libraryFolder") refreshDropboxFolder();
  });
  window.addEventListener("online", syncCloud);
  window.addEventListener("offline", syncCloud);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncCloud(); });
  setInterval(syncCloud, 5000);
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
