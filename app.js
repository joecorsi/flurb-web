(() => {
  "use strict";
  const API = "https://api.dropboxapi.com/2";
  const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "aif", "aifc", "aiff", "au", "alac", "wma", "wm", "m4b", "m4p", "m4r", "mid"]);
  const $ = (selector) => document.querySelector(selector);
  function renderLucideIcons(root = document) {
    if (window.lucide?.createIcons) window.lucide.createIcons({ root });
  }
  const els = {
    audio: $("#audio"), search: $("#search"), clearSearch: $("#clear-search"), home: $("#home-button"), breadcrumbs: $("#breadcrumbs"),
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
    folderPicker: false,
    folderPath: "",
    folderName: "All files",
    folderHistory: [],
    folderCache: new Map(),
    artworkLinks: new Map(),
    artworkLoading: new Set(),
    artworkElements: new Map(),
    artworkObserver: null,
    artworkQueue: [],
    activeArtworkDownloads: 0,
    titleScrollGesture: false,
    navigationRequest: 0,
    entries: [],
    tracks: [],
    displayLimit: 100,
    current: null,
    viewerTrack: null,
    loadingTrack: false,
    shuffle: false,
    repeat: "off",
    favorites: new Set(JSON.parse(localStorage.getItem("flurb.dropbox.favorites") || "[]")),
    favoriteItems: new Map(),
    playRequest: 0,
    listObserver: null,
    toastTimer: null
  };
  try {
    const savedItems = JSON.parse(localStorage.getItem("flurb.dropbox.favoriteItems") || "[]");
    if (Array.isArray(savedItems)) state.favoriteItems = new Map(savedItems.filter((track) => track?.id).map((track) => [track.id, track]));
  } catch (_) {}
  try {
    const savedPlaylists = JSON.parse(localStorage.getItem("flurb.dropbox.playlists") || "[]");
    if (Array.isArray(savedPlaylists)) state.playlists = savedPlaylists.filter((playlist) => playlist?.id && playlist?.name && Array.isArray(playlist.tracks));
  } catch (_) {}
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
  async function downloadTrackFile(track, retried = false) {
    const accessToken = await ensureAccessToken();
    const response = await fetch("https://content.dropboxapi.com/2/files/download", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Dropbox-API-Arg": JSON.stringify({ path: track.id })
      }
    });
    if (response.status === 401 && state.refreshToken && !retried) {
      await ensureAccessToken(true);
      return downloadTrackFile(track, true);
    }
    if (response.status === 401) clearDropboxTokens();
    if (!response.ok) throw new Error(`Track artwork request failed (${response.status}).`);
    return response.arrayBuffer();
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
    const connected = Boolean(state.token);
    els.search.disabled = !connected || state.folderPicker || !state.libraryFolder;
    els.clearSearch.disabled = els.search.disabled || !els.search.value;
    els.home.disabled = !connected || state.folderPicker || !state.libraryFolder;
    if (els.settingsLink) els.settingsLink.hidden = connected;
    updateQuickActions();
  }
  function playerArtist(track) {
    const root = state.libraryFolder?.path_lower || "";
    const relative = track.path_lower?.slice(root.length).split("/").filter(Boolean) || [];
    return relative.length > 1 ? relative[0] : state.folderName;
  }
  function playerAlbum(track) {
    const root = state.libraryFolder?.path_lower || "";
    const relative = track.path_lower?.slice(root.length).split("/").filter(Boolean) || [];
    return relative.length > 2 ? relative[1] : relative.length > 1 ? relative[0] : state.folderName;
  }
  function updateMediaMetadata(track) {
    if (!track || !navigator.mediaSession || !window.MediaMetadata) return;
    const metadata = {
      title: track.name.replace(/\.[^.]+$/, ""),
      artist: playerArtist(track),
      album: playerAlbum(track)
    };
    const artwork = state.artworkLinks.get(track.id);
    if (artwork) metadata.artwork = [{ src: artwork }];
    try { navigator.mediaSession.metadata = new MediaMetadata(metadata); } catch (_) {}
  }
  function setPlayerMetadata(track) {
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
    if (state.viewMode === "playlists" && state.activePlaylistId) {
      state.activePlaylistId = null;
      renderBreadcrumbs();
      renderTracks();
      return;
    }
    const root = state.libraryFolder?.path_lower;
    if (!root || state.folderPicker || state.folderPath === root) return;
    const previous = state.folderHistory.pop();
    if (!previous || !(previous.path === root || previous.path.startsWith(`${root}/`))) {
      state.folderHistory = [];
      return loadLibraryFolder(root, state.libraryFolder.name).catch((error) => showNotice(friendlyError(error), "error"));
    }
    loadLibraryFolder(previous.path, previous.name).catch((error) => showNotice(friendlyError(error), "error"));
  }
  function goHomeLibrary() {
    if (state.viewMode === "playlists") {
      state.activePlaylistId = null;
      state.folderHistory = [];
      renderBreadcrumbs();
      renderTracks();
      return;
    }
    if (!state.libraryFolder?.path_lower || state.folderPicker) return;
    state.folderHistory = [];
    history.replaceState({ flurbRootGuard: true }, "", location.href);
    loadLibraryFolder(state.libraryFolder.path_lower, state.libraryFolder.name).catch((error) => showNotice(friendlyError(error), "error"));
  }
  function installHistoryNavigation() {
    history.replaceState({ flurbRootGuard: true }, "", location.href);
    history.pushState({ flurbRootGuard: true }, "", location.href);
    window.addEventListener("popstate", () => {
      const root = state.libraryFolder?.path_lower;
      const atLibraryRoot = !root || state.folderPicker || !state.folderPath || state.folderPath === root;
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
    els.recentCount.textContent = String(state.entries.filter(isAudio).length);
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
    state.viewMode = view;
    state.activePlaylistId = null;
    state.folderHistory = [];
    localStorage.setItem("flurb.dropbox.actionView", view);
    els.viewMenu.hidden = true;
    els.viewButton.setAttribute("aria-expanded", "false");
    state.displayLimit = 100;
    updateQuickActions();
    if (state.libraryFolder?.path_lower) {
      history.replaceState({ flurbRootGuard: true }, "", location.href);
      loadLibraryFolder(state.libraryFolder.path_lower, state.libraryFolder.name).catch((error) => showNotice(friendlyError(error), "error"));
    } else renderTracks();
  }
  async function connectLibrary() {
    updateConnection();
    try {
      if (state.libraryFolder?.id && state.libraryFolder?.path_lower) await loadLibraryFolder();
      else await openFolderPicker();
    } catch (error) {
      setLibraryLoading(false);
      showNotice(friendlyError(error), "error");
    }
  }
  async function listFolder(path, recursive = false) {
    let response = await dropbox("/files/list_folder", { path, recursive, include_deleted: false });
    let entries = [...(response.entries || [])];
    while (response.has_more) {
      response = await dropbox("/files/list_folder/continue", { cursor: response.cursor });
      entries.push(...(response.entries || []));
    }
    return entries;
  }
  const isFolder = (entry) => entry[".tag"] === "folder";
  const isAudio = (entry) => {
    if (entry[".tag"] !== "file") return false;
    const extension = entry.name.split(".").pop().toLowerCase();
    return AUDIO_EXTENSIONS.has(extension);
  };
  const hasId3ArtworkSupport = (track) => track.name.toLowerCase().endsWith(".mp3");
  function renderBreadcrumbs() {
    els.breadcrumbs.replaceChildren();
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
    const root = state.libraryFolder?.path_lower;
    if (!root || state.folderPicker) { els.breadcrumbs.replaceChildren(); return; }
    const rootCrumb = { path: root, name: state.libraryFolder.name };
    const folders = [rootCrumb, ...state.folderHistory, ...(state.folderPath && state.folderPath !== root ? [{ path: state.folderPath, name: state.folderName }] : [])]
      .filter((item, index, all) => item.path && (index === 0 || item.path.startsWith(`${root}/`)) && all.findIndex((entry) => entry.path === item.path) === index);
    foldersDepth = folders.length - 1;
    folders.forEach((item, index) => addCrumb(index === 0 ? rootLabel : item.name, index === folders.length - 1, index === 0 ? goHomeLibrary : () => {
      state.folderHistory = folders.slice(1, index).map(({ path: folderPath, name }) => ({ path: folderPath, name }));
      loadLibraryFolder(item.path, item.name).catch((error) => showNotice(friendlyError(error), "error"));
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
  function queueTrackArtwork(track) {
    if (!track || state.artworkLinks.has(track.id) || state.artworkLoading.has(track.id)) return;
    state.artworkLoading.add(track.id);
    state.artworkQueue.push(track);
    pumpArtworkQueue();
  }
  function updatePlayerArtwork(track) {
    const link = track && state.artworkLinks.get(track.id);
    if (link) els.playerArtwork.src = link;
    else els.playerArtwork.removeAttribute("src");
    els.playerArtworkShell.classList.toggle("has-artwork", Boolean(link));
    els.playerArtworkButton.disabled = !track;
  }
  function updateViewerArtwork(track) {
    const link = track && state.artworkLinks.get(track.id);
    els.artworkViewerImage.alt = track ? `${track.name.replace(/\.[^.]+$/, "")} artwork` : "";
    if (link) els.artworkViewerImage.src = link;
    else els.artworkViewerImage.removeAttribute("src");
    els.artworkViewerCover.classList.toggle("has-artwork", Boolean(link));
  }
  function openArtworkViewer(track) {
    if (!track) return;
    state.viewerTrack = track;
    updateViewerArtwork(track);
    els.artworkViewer.hidden = false;
    document.body.classList.add("is-artwork-viewing");
    els.playerArtworkButton.setAttribute("aria-label", "Close track artwork");
    const stickyBottom = els.librarySticky.getBoundingClientRect().bottom;
    const playerTop = els.player.getBoundingClientRect().top;
    els.artworkViewer.style.top = `${Math.max(0, stickyBottom)}px`;
    els.artworkViewer.style.bottom = `${Math.max(0, window.innerHeight - playerTop)}px`;
    if (hasId3ArtworkSupport(track)) queueTrackArtwork(track);
  }
  function closeArtworkViewer() {
    els.artworkViewer.hidden = true;
    document.body.classList.remove("is-artwork-viewing");
    els.playerArtworkButton.setAttribute("aria-label", "View current track artwork");
    state.viewerTrack = null;
  }
  function pumpArtworkQueue() {
    while (state.activeArtworkDownloads < 2 && state.artworkQueue.length) {
      const track = state.artworkQueue.shift();
      state.activeArtworkDownloads += 1;
      downloadTrackFile(track).then((buffer) => {
        const cover = extractId3Artwork(buffer);
        if (!cover) return;
        const objectUrl = URL.createObjectURL(cover);
        state.artworkLinks.set(track.id, objectUrl);
        state.artworkElements.get(track.id)?.forEach((image) => {
          image.src = objectUrl;
          image.classList.add("has-artwork");
          image.parentElement?.classList.add("has-artwork");
        });
        if (state.current?.id === track.id) {
          updateMediaMetadata(track);
          updatePlayerArtwork(track);
        }
        if (state.viewerTrack?.id === track.id) updateViewerArtwork(track);
      }).catch(() => {}).finally(() => {
        state.artworkLoading.delete(track.id);
        state.activeArtworkDownloads -= 1;
        pumpArtworkQueue();
      });
    }
  }
  async function openFolderPicker() {
    state.navigationRequest += 1;
    els.audio.pause();
    els.audio.removeAttribute("src");
    els.audio.load();
    state.current = null;
    state.loadingTrack = false;
    els.nowTitle.textContent = "Nothing playing yet";
    updateTitleMarquee();
    els.nowAlbum.textContent = "";
    els.nowFavorite.disabled = true;
    updateFavoriteButton();
    updateTransport();
    state.folderPicker = true;
    state.folderHistory = [];
    els.breadcrumbs.replaceChildren();
    els.search.disabled = true;
    state.folderPath = "";
    state.folderName = "Choose a folder";
    state.displayLimit = 100;
    els.search.value = "";
    state.entries = [];
    state.tracks = [];
    els.tableBody.replaceChildren();
    els.emptyState.hidden = true;
    try {
      // This one-time picker reads only top-level metadata to let the user select a folder.
      const allEntries = await listFolder("");
      state.entries = allEntries.filter(isFolder);
      state.tracks = [];
      renderFolderPicker();
      if (!state.entries.length) showNotice("No folders were found in your Dropbox root.", "error");
    } catch (error) {
      showNotice(friendlyError(error), "error");
    }
  }
  async function selectLibraryFolder(folder) {
    state.libraryFolder = { id: folder.id, path_lower: folder.path_lower, name: folder.name };
    localStorage.setItem("flurb.dropbox.libraryFolder", JSON.stringify(state.libraryFolder));
    state.folderPicker = false;
    state.folderHistory = [];
    state.folderCache.clear();
    updateConnection();
    await loadLibraryFolder(state.libraryFolder.path_lower, state.libraryFolder.name);
  }
  function isInsideLibrary(track) {
    const root = state.libraryFolder?.path_lower;
    return Boolean(root && track.path_lower && (track.path_lower === root || track.path_lower.startsWith(`${root}/`)));
  }
  async function loadLibraryFolder(path, name) {
    if (!state.libraryFolder?.id || !state.libraryFolder?.path_lower) return openFolderPicker();
    const root = state.libraryFolder.path_lower;
    path = path || root;
    if (!(path === root || path.startsWith(`${root}/`))) throw new Error("That folder is outside the selected Flurb library.");
    const request = ++state.navigationRequest;
    if (path !== state.folderPath) els.search.value = "";
    syncSearchState();
    els.clearSearch.disabled = !els.search.value;
    state.folderPicker = false;
    state.folderPath = path;
    state.folderName = name || (path === root ? state.libraryFolder.name : path.split("/").pop());
    renderBreadcrumbs();
    state.displayLimit = 100;
    if (state.folderCache.has(path)) {
      state.entries = state.folderCache.get(path);
      state.tracks = state.entries.filter(isAudio).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
      updateQuickActions();
      renderTracks();
      hideNotice();
      return;
    }
    try {
      // Browse one level at a time. Every request is checked against the one selected library root.
      const entries = await listFolder(path, false);
      if (request !== state.navigationRequest) return;
      state.entries = entries.filter((entry) => (isFolder(entry) || isAudio(entry)) && isInsideLibrary(entry));
      state.folderCache.set(path, state.entries);
      state.tracks = state.entries.filter(isAudio).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
      updateQuickActions();
      renderTracks();
      hideNotice();
      if (!state.tracks.length && !state.entries.some(isFolder)) showNotice("No playable tracks found in this folder.");
    } catch (error) {
      if (request !== state.navigationRequest) return;
      const message = friendlyError(error);
      if (/no longer available/i.test(message)) {
        state.libraryFolder = null;
        localStorage.removeItem("flurb.dropbox.libraryFolder");
        await openFolderPicker();
        return;
      }
      throw error;
    }
  }
  function filteredTracks() {
    const query = els.search.value.trim().toLocaleLowerCase();
    return visibleTracks().filter((track) => !query || track.name.toLocaleLowerCase().includes(query));
  }
  function visibleTracks() {
    if (state.viewMode === "favorites") {
      const known = new Map(state.favoriteItems);
      state.tracks.forEach((track) => { if (state.favorites.has(track.id) && !known.has(track.id)) known.set(track.id, track); });
      return [...known.values()].filter((track) => state.favorites.has(track.id) && isInsideLibrary(track));
    }
    if (state.viewMode === "recent") return state.entries.filter(isAudio).sort((a, b) => new Date(b.server_modified || 0) - new Date(a.server_modified || 0));
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
      const letter = libraryLetter(row.item.name);
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
      const target = [...els.tableBody.querySelectorAll(".library-letter-row")].find((row) => row.dataset.letter === first);
      if (!target) return;
      const sticky = document.querySelector(".library-sticky");
      const offset = target.getBoundingClientRect().top - (sticky?.getBoundingClientRect().height || 0);
      window.scrollBy({ top: offset, behavior: "smooth" });
    });
  }
  function renderTracks() {
    setLibraryLoading(false);
    state.listObserver?.disconnect();
    state.artworkObserver?.disconnect();
    state.artworkElements.clear();
    els.tableBody.replaceChildren();
    els.emptyState.hidden = true;
    const query = els.search.value.trim().toLocaleLowerCase();
    const tracks = filteredTracks();
    let folders = state.entries.filter(isFolder).filter((folder) => !query || folder.name.toLocaleLowerCase().includes(query));
    if (state.viewMode === "favorites" || state.viewMode === "playlists") folders = [];
    if (state.viewMode === "recent") folders = folders.sort((a, b) => new Date(b.server_modified || 0) - new Date(a.server_modified || 0)).slice(0, 20);
    els.trackCount.textContent = `· ${tracks.length} track${tracks.length === 1 ? "" : "s"} · ${folders.length} folder${folders.length === 1 ? "" : "s"}`;
    const atViewRoot = state.viewMode === "playlists"
      ? !state.activePlaylistId
      : !state.folderPicker && Boolean(state.libraryFolder?.path_lower) && state.folderPath === state.libraryFolder.path_lower;
    if (state.viewMode === "playlists" && !state.activePlaylistId) {
      const create = document.createElement("button"); create.type = "button"; create.className = "library-row artist-row playlist-create"; create.textContent = "+ New playlist";
      create.addEventListener("click", createPlaylist); els.tableBody.append(create);
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
      if (query) scrollToSearchLetter();
      return;
    }
    const rows = [
      ...folders.map((folder) => ({ kind: "folder", item: folder })),
      ...tracks.map((track) => ({ kind: "track", item: track }))
    ].sort((a, b) => state.viewMode === "recent"
      ? new Date(b.item.server_modified || 0) - new Date(a.item.server_modified || 0)
      : a.item.name.localeCompare(b.item.name, undefined, { numeric: true, sensitivity: "base" }));
    if (!rows.length) {
      els.emptyState.hidden = false;
      els.emptyState.querySelector("p").textContent = query ? "No results" : state.viewMode === "favorites" ? "No favorites" : state.viewMode === "playlists" ? "This playlist is empty" : "No tracks";
      els.emptyState.querySelector("span").textContent = "";
      return;
    }
    const renderedRows = atViewRoot
      ? groupRowsByLetter(rows, state.viewMode === "library")
      : rows;
    const searchHeaderIndex = renderedRows.findIndex((row) => row.kind === "letter" && row.letter === searchLetter());
    if (searchHeaderIndex >= state.displayLimit) state.displayLimit = searchHeaderIndex + 1;
    renderedRows.slice(0, state.displayLimit).forEach(({ kind, item, letter }, index) => {
      if (kind === "letter") els.tableBody.append(makeLibraryLetterRow(letter));
      else els.tableBody.append(kind === "folder" ? makeFolderRow(item, index) : makeTrackRow(item, index));
    });
    renderLucideIcons(els.tableBody);
    const remaining = renderedRows.length - state.displayLimit;
    if (remaining > 0) {
      const row = document.createElement("div");
      row.className = "list-sentinel";
      els.tableBody.append(row);
      state.listObserver = new IntersectionObserver((items) => {
        if (!items.some((item) => item.isIntersecting)) return;
        state.listObserver?.disconnect();
        state.displayLimit += 100;
        renderTracks();
      }, { rootMargin: "500px 0px" });
      state.listObserver.observe(row);
    }
    if (query && atViewRoot) scrollToSearchLetter();
  }
  function renderFolderPicker() {
    state.listObserver?.disconnect();
    els.tableBody.replaceChildren();
    els.emptyState.hidden = true;
    els.trackCount.textContent = "· choose one folder";
    const folders = state.entries.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    folders.slice(0, state.displayLimit).forEach((folder, index) => els.tableBody.append(makeFolderRow(folder, index)));
    renderLucideIcons(els.tableBody);
    if (folders.length > state.displayLimit) {
      const sentinel = document.createElement("div");
      sentinel.className = "list-sentinel";
      els.tableBody.append(sentinel);
      state.listObserver = new IntersectionObserver((items) => {
        if (!items.some((item) => item.isIntersecting)) return;
        state.listObserver?.disconnect();
        state.displayLimit += 100;
        renderFolderPicker();
      }, { rootMargin: "500px 0px" });
      state.listObserver.observe(sentinel);
    }
  }
  function persistPlaylists() {
    localStorage.setItem("flurb.dropbox.playlists", JSON.stringify(state.playlists));
    updateQuickActions();
  }
  function createPlaylist() {
    const name = window.prompt("Playlist name");
    if (!name?.trim()) return;
    const playlist = { id: crypto.randomUUID(), name: name.trim(), tracks: [] };
    state.playlists.push(playlist); persistPlaylists();
    state.activePlaylistId = playlist.id; renderBreadcrumbs(); renderTracks();
  }
  function makePlaylistRow(playlist) {
    const row = document.createElement("button"); row.type = "button"; row.className = "library-row artist-row playlist-row";
    const copy = document.createElement("span"); copy.className = "track-copy";
    const title = document.createElement("span"); title.className = "track-name"; title.textContent = playlist.name;
    const meta = document.createElement("span"); meta.className = "track-meta"; meta.textContent = `${playlist.tracks.length} tracks`;
    copy.append(title, meta); row.append(copy);
    row.addEventListener("click", () => { state.activePlaylistId = playlist.id; renderBreadcrumbs(); renderTracks(); });
    return row;
  }
  function addTrackToPlaylist(track, playlist) {
    if (!playlist.tracks.some((item) => item.id === track.id)) playlist.tracks.push(track);
    persistPlaylists(); toast(`Added to ${playlist.name}`); renderTracks();
  }
  function showAlbumInLibrary(track) {
    const path = track.path_lower || "";
    const parent = path.slice(0, path.lastIndexOf("/"));
    const root = state.libraryFolder?.path_lower || "";
    if (!parent || !(parent === root || parent.startsWith(`${root}/`))) return;
    const name = parent === root ? state.libraryFolder.name : parent.split("/").pop();
    const relativeSegments = parent === root ? [] : parent.slice(root.length).split("/").filter(Boolean);
    const displayParent = (track.path_display || parent).slice(0, (track.path_display || parent).lastIndexOf("/"));
    const displaySegments = displayParent.split("/").filter(Boolean).slice(-relativeSegments.length);
    let breadcrumbPath = root;
    state.folderHistory = relativeSegments.slice(0, -1).map((segment, index) => {
      breadcrumbPath += `/${segment}`;
      return { path: breadcrumbPath, name: displaySegments[index] || segment };
    });
    state.viewMode = "library"; state.activePlaylistId = null;
    localStorage.setItem("flurb.dropbox.actionView", "library"); updateQuickActions();
    loadLibraryFolder(parent, name).catch((error) => showNotice(friendlyError(error), "error"));
  }
  function makeFolderRow(folder, index = 0) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "library-row folder-row artist-row";
    row.setAttribute("aria-label", state.folderPicker ? `Select ${folder.name} as your library` : `Open ${folder.name}`);
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
    meta.textContent = state.folderPicker ? "SELECT FOLDER" : state.folderPath === state.libraryFolder?.path_lower ? "ARTIST" : "FOLDER";
    copy.append(title, meta);
    row.append(leading, copy);
    row.addEventListener("click", () => {
      if (state.folderPicker) selectLibraryFolder(folder).catch((e) => showNotice(friendlyError(e), "error"));
      else {
        if (state.folderPath && folder.path_lower !== state.folderPath) {
          state.folderHistory.push({ path: state.folderPath, name: state.folderName });
          history.pushState({ flurbFolder: folder.path_lower }, "", location.href);
        }
        loadLibraryFolder(folder.path_lower, folder.name).catch((e) => showNotice(friendlyError(e), "error"));
      }
    });
    return row;
  }
  function makeTrackRow(track, index) {
    const row = document.createElement("div");
    row.setAttribute("role", "listitem");
    row.setAttribute("tabindex", "0");
    row.setAttribute("aria-label", `Play ${track.name.replace(/\.[^.]+$/, "")}`);
    row.className = `library-row track-row${state.current?.id === track.id ? " is-playing" : ""}`;
    const artworkShell = document.createElement("span");
    artworkShell.className = "track-artwork-shell";
    const artwork = document.createElement("img");
    artwork.className = "track-artwork";
    artwork.alt = "";
    artwork.width = 44;
    artwork.height = 44;
    const placeholder = document.createElement("i");
    placeholder.className = "artwork-placeholder";
    placeholder.setAttribute("data-lucide", "music-2");
    placeholder.setAttribute("aria-hidden", "true");
    artworkShell.append(artwork, placeholder);
    if (hasId3ArtworkSupport(track)) registerTrackArtwork(artwork, track);
    const copy = document.createElement("div");
    copy.className = "track-copy";
    const title = document.createElement("span");
    title.className = "track-name";
    title.textContent = track.name.replace(/\.[^.]+$/, "");
    const meta = document.createElement("span");
    meta.className = "track-meta";
    meta.textContent = playerArtist(track);
    copy.append(title, meta);
    const actions = document.createElement("div");
    actions.className = "track-actions";
    const favorite = document.createElement("button");
    favorite.type = "button";
    favorite.className = `icon-button track-favorite${state.favorites.has(track.id) ? " active" : ""}`;
    favorite.setAttribute("aria-label", state.favorites.has(track.id) ? `Remove ${track.name} from favorites` : `Favorite ${track.name}`);
    favorite.innerHTML = '<i data-lucide="heart" aria-hidden="true"></i>';
    favorite.addEventListener("click", (event) => { event.stopPropagation(); toggleFavorite(track); });
    const overflow = document.createElement("div"); overflow.className = "track-overflow";
    const more = document.createElement("button"); more.type = "button"; more.className = "icon-button track-more"; more.setAttribute("aria-label", `More actions for ${track.name}`); more.innerHTML = '<i data-lucide="ellipsis" aria-hidden="true"></i>';
    const menu = document.createElement("div"); menu.className = "track-overflow-menu"; menu.hidden = true;
    const add = document.createElement("button"); add.type = "button"; add.textContent = "Add to playlist";
    const submenu = document.createElement("div"); submenu.className = "playlist-submenu"; submenu.hidden = true;
    state.playlists.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((playlist) => {
      const choice = document.createElement("button"); choice.type = "button"; choice.textContent = playlist.name;
      choice.addEventListener("click", (event) => { event.stopPropagation(); menu.hidden = true; addTrackToPlaylist(track, playlist); }); submenu.append(choice);
    });
    const create = document.createElement("button"); create.type = "button"; create.textContent = "+ New playlist…";
    create.addEventListener("click", (event) => { event.stopPropagation(); const name = window.prompt("Playlist name"); if (!name?.trim()) return; let playlist = state.playlists.find((item) => item.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase()); if (!playlist) { playlist = { id: crypto.randomUUID(), name: name.trim(), tracks: [] }; state.playlists.push(playlist); } menu.hidden = true; addTrackToPlaylist(track, playlist); }); submenu.append(create);
    add.addEventListener("click", (event) => { event.stopPropagation(); submenu.hidden = !submenu.hidden; });
    const album = document.createElement("button"); album.type = "button"; album.textContent = "Show album in library"; album.addEventListener("click", (event) => { event.stopPropagation(); menu.hidden = true; showAlbumInLibrary(track); });
    menu.append(add, submenu, album); more.addEventListener("click", (event) => { event.stopPropagation(); document.querySelectorAll(".track-overflow-menu").forEach((other) => { if (other !== menu) other.hidden = true; }); menu.hidden = !menu.hidden; });
    overflow.append(more, menu);
    actions.append(favorite, overflow);
    row.append(artworkShell, copy, actions);
    row.addEventListener("click", (event) => {
      if (!event.target.closest("button")) playTrack(track, true);
    });
    row.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && event.target === row) {
        event.preventDefault();
        playTrack(track, true);
      }
    });
    return row;
  }
  async function playTrack(track, showArtwork = false) {
    if (!state.token) return toast("Open Dropbox setup first");
    if (!isInsideLibrary(track)) return showNotice("That track is outside the selected Flurb folder.", "error");
    const requestId = ++state.playRequest;
    els.audio.pause();
    state.loadingTrack = true;
    state.current = track;
    updatePlayerArtwork(track);
    if (showArtwork) openArtworkViewer(track);
    els.nowTitle.textContent = track.name.replace(/\.[^.]+$/, "");
    updateTitleMarquee();
    setPlayerMetadata(track);
    if (state.loadingTrack) els.nowAlbum.innerHTML = '<span class="player-loading" role="status" aria-label="Loading track"><i></i></span>';
    els.nowFavorite.disabled = false;
    updateFavoriteButton();
    updateTransport();
    renderTracks();
    try {
      const result = await dropbox("/files/get_temporary_link", { path: track.id });
      if (requestId !== state.playRequest) return;
      els.audio.src = result.link;
      await els.audio.play();
      hideNotice();
      updateTransport();
      renderTracks();
    } catch (error) {
      if (requestId === state.playRequest) showNotice(`Could not play this track. ${friendlyError(error)}`, "error");
    } finally {
      if (requestId === state.playRequest) {
        state.loadingTrack = false;
        if (state.current) setPlayerMetadata(state.current);
        updateTransport();
      }
    }
  }
  function playNext(direction = 1) {
    const playlist = visibleTracks();
    if (!playlist.length) return;
    const currentIndex = playlist.findIndex((track) => track.id === state.current?.id);
    let nextIndex;
    if (state.shuffle && direction > 0 && playlist.length > 1) {
      do { nextIndex = Math.floor(Math.random() * playlist.length); } while (nextIndex === currentIndex);
    } else if (currentIndex < 0) {
      nextIndex = direction > 0 ? 0 : playlist.length - 1;
    } else {
      nextIndex = (currentIndex + direction + playlist.length) % playlist.length;
    }
    playTrack(playlist[nextIndex]);
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
    els.playerArtworkButton.disabled = !hasTrack;
    els.nowPlayingLink.setAttribute("aria-label", hasTrack ? `Open folder containing ${state.current.name.replace(/\.[^.]+$/, "")}` : "Nothing playing");
    els.previous.disabled = !hasTrack;
    els.next.disabled = !hasTrack;
    els.progress.disabled = !hasTrack || !Number.isFinite(els.audio.duration);
    els.play.classList.toggle("playing", !els.audio.paused);
    els.play.setAttribute("aria-label", els.audio.paused ? "Play" : "Pause");
    if (navigator.mediaSession) navigator.mediaSession.playbackState = !hasTrack ? "none" : els.audio.paused ? "paused" : "playing";
  }
  function updateFavoriteButton() {
    const active = Boolean(state.current && state.favorites.has(state.current.id));
    els.nowFavorite.classList.toggle("active", active);
    els.nowFavorite.setAttribute("aria-label", active ? "Remove current track from favorites" : "Favorite current track");
  }
  function syncSearchState() {
    document.body.classList.toggle("is-searching", document.activeElement === els.search || Boolean(els.search.value.trim()));
  }
  function toggleFavorite(track) {
    if (state.favorites.has(track.id)) {
      state.favorites.delete(track.id);
      state.favoriteItems.delete(track.id);
    } else {
      state.favorites.add(track.id);
      state.favoriteItems.set(track.id, track);
    }
    localStorage.setItem("flurb.dropbox.favorites", JSON.stringify([...state.favorites]));
    localStorage.setItem("flurb.dropbox.favoriteItems", JSON.stringify([...state.favoriteItems.values()]));
    updateFavoriteButton();
    updateQuickActions();
    renderTracks();
  }
  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return "0:00";
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  }
  function formatBytes(bytes = 0) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  els.search.addEventListener("input", () => {
    els.clearSearch.disabled = !els.search.value;
    syncSearchState();
    state.displayLimit = 100;
    renderTracks();
  });
  els.search.addEventListener("focus", syncSearchState);
  els.search.addEventListener("blur", syncSearchState);
  els.clearSearch.addEventListener("click", () => {
    els.search.value = "";
    els.clearSearch.disabled = true;
    syncSearchState();
    state.displayLimit = 100;
    renderTracks();
    els.search.focus();
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
    else openArtworkViewer(state.current);
  });
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
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.data?.type !== "flurb-library-selected") return;
    try { state.libraryFolder = JSON.parse(localStorage.getItem("flurb.dropbox.libraryFolder") || "null"); } catch (_) { state.libraryFolder = null; }
    state.folderHistory = []; state.folderCache.clear(); closeSettings(); updateConnection();
    if (state.libraryFolder?.path_lower) loadLibraryFolder(state.libraryFolder.path_lower, state.libraryFolder.name).catch((error) => showNotice(friendlyError(error), "error"));
  });
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
  els.shuffle.addEventListener("click", () => {
    state.shuffle = !state.shuffle;
    els.shuffle.classList.toggle("active", state.shuffle);
    els.shuffle.setAttribute("aria-label", `Shuffle ${state.shuffle ? "on" : "off"}`);
    toast(`Shuffle ${state.shuffle ? "on" : "off"}`);
  });
  els.repeat.addEventListener("click", () => {
    state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
    els.repeat.classList.toggle("active", state.repeat !== "off");
    els.repeat.setAttribute("aria-label", `Repeat ${state.repeat}`);
    els.repeat.title = `Repeat ${state.repeat}`;
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
    else if (state.repeat === "all" || state.shuffle || visibleTracks().findIndex((t) => t.id === state.current?.id) < visibleTracks().length - 1) playNext(1);
    else updateTransport();
  });
  els.audio.addEventListener("error", () => {
    if (state.current && !els.audio.paused) showNotice("The audio stream was interrupted. Try playing the track again.", "error");
  });



  installHistoryNavigation();
  if (state.token && state.libraryFolder?.path_lower) setLibraryLoading(true);
  renderLucideIcons();
  updateConnection();
  updateTransport();
  handleOAuthReturn().then((handled) => { if (!handled && state.token) connectLibrary().catch(() => setLibraryLoading(false)); });
})();
