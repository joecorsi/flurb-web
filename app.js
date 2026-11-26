(() => {
  "use strict";
  const API = "https://api.dropboxapi.com/2";
  const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "aif", "aifc", "aiff", "au", "alac", "wma", "wm", "m4b", "m4p", "m4r", "mid"]);
  const ARTWORK_EXTENSIONS = new Set(["jpg", "jpeg", "png", "tif", "tiff", "gif", "webp", "ppm", "bmp"]);
  const $ = (selector) => document.querySelector(selector);
  const els = {
    audio: $("#audio"), search: $("#search"), home: $("#home-button"),
    trackList: $("#track-list"), tableBody: $("#table-body"), emptyState: $("#empty-state"), trackCount: $("#track-count"), notice: $("#notice"), noticeMessage: $("#notice-message"),
    recent: $("#recent-button"), recentCount: $("#recent-count"), favoritesButton: $("#favorites-button"), favoritesCount: $("#favorites-count"), player: $("#player"), play: $("#play-button"),
    previous: $("#previous-button"), next: $("#next-button"), shuffle: $("#shuffle-button"), repeat: $("#repeat-button"), progress: $("#progress"),
    elapsed: $("#elapsed-time"), duration: $("#duration-time"), nowTitle: $("#now-title"), nowAlbum: $("#now-album"), nowFavorite: $("#now-favorite"),
    toast: $("#toast"), settingsLink: $("#settings-link")
  };
  const state = {
    token: localStorage.getItem("flurb.dropbox.accessToken") || sessionStorage.getItem("flurb.dropbox.accessToken") || "",
    libraryFolder: null,
    viewMode: "library",
    folderPicker: false,
    folderPath: "",
    folderName: "All files",
    folderHistory: [],
    folderCache: new Map(),
    folderArtworkEntry: null,
    artworkLinks: new Map(),
    artworkLoading: new Set(),
    navigationRequest: 0,
    entries: [],
    tracks: [],
    displayLimit: 100,
    current: null,
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
  async function dropbox(path, body = {}) {
    const response = await fetch(`${API}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${state.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch (_) {}
    if (!response.ok) {
      if (response.status === 401) {
        state.token = "";
        sessionStorage.removeItem("flurb.dropbox.accessToken");
        localStorage.removeItem("flurb.dropbox.accessToken");
        updateConnection();
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
    els.home.disabled = !connected || state.folderPicker || !state.libraryFolder;
    if (els.settingsLink) els.settingsLink.hidden = connected;
    updateQuickActions();
  }
  function playerArtist(track) {
    const root = state.libraryFolder?.path_lower || "";
    const relative = track.path_lower?.slice(root.length).split("/").filter(Boolean) || [];
    return relative.length > 1 ? relative[0] : state.folderName;
  }
  function setPlayerMetadata(track) {
    els.nowAlbum.textContent = playerArtist(track);
  }
  function goBackOneFolder() {
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
      const response = await fetch("https://api.dropboxapi.com/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error_description || result.error || "Dropbox sign-in failed.");
      state.token = result.access_token;
      localStorage.setItem("flurb.dropbox.accessToken", state.token);
      sessionStorage.setItem("flurb.dropbox.accessToken", state.token);
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
    els.recent.classList.toggle("active", state.viewMode === "recent");
    els.recent.setAttribute("aria-pressed", String(state.viewMode === "recent"));
    els.favoritesButton.classList.toggle("active", state.viewMode === "favorites");
    els.favoritesButton.setAttribute("aria-pressed", String(state.viewMode === "favorites"));
    els.recentCount.textContent = String(state.entries.filter(isAudio).length);
    els.favoritesCount.textContent = String(state.favorites.size);
  }
  async function connectLibrary() {
    updateConnection();
    try {
      if (state.libraryFolder?.id && state.libraryFolder?.path_lower) await loadLibraryFolder();
      else await openFolderPicker();
    } catch (error) {
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
  const isArtwork = (entry) => entry[".tag"] === "file" && ARTWORK_EXTENSIONS.has(entry.name.split(".").pop().toLowerCase());
  const isAudio = (entry) => {
    if (entry[".tag"] !== "file") return false;
    const extension = entry.name.split(".").pop().toLowerCase();
    return AUDIO_EXTENSIONS.has(extension);
  };
  function chooseFolderArtwork(entries) {
    const images = entries.filter(isArtwork);
    const priority = ["cover", "folder", "front", "album", "albumart", "artwork"];
    for (const label of priority) {
      const match = images.find((image) => image.name.replace(/\.[^.]+$/, "").toLowerCase() === label);
      if (match) return match;
    }
    return images.length === 1 ? images[0] : null;
  }
  function loadFolderArtwork(folderPath, imageFile) {
    if (!imageFile || state.artworkLinks.has(imageFile.id) || state.artworkLoading.has(imageFile.id)) return;
    state.artworkLoading.add(imageFile.id);
    fetch("https://content.dropboxapi.com/2/files/get_thumbnail_v2", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${state.token}`,
        "Dropbox-API-Arg": JSON.stringify({
          resource: { ".tag": "path", path: imageFile.id },
          format: { ".tag": "jpeg" }
        })
      }
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Artwork request failed (${response.status}).`);
      const objectUrl = URL.createObjectURL(await response.blob());
      state.artworkLinks.set(imageFile.id, objectUrl);
      if (state.folderPath === folderPath && state.folderArtworkEntry?.id === imageFile.id) {
        els.tableBody.querySelectorAll(".track-artwork").forEach((image) => {
          if (image.dataset.folderPath === folderPath) image.src = objectUrl;
        });
      }
    }).catch(() => {}).finally(() => state.artworkLoading.delete(imageFile.id));
  }
  async function openFolderPicker() {
    state.navigationRequest += 1;
    els.audio.pause();
    els.audio.removeAttribute("src");
    els.audio.load();
    state.current = null;
    state.loadingTrack = false;
    els.nowTitle.textContent = "Nothing playing yet";
    els.nowAlbum.textContent = "";
    els.nowFavorite.disabled = true;
    updateFavoriteButton();
    updateTransport();
    state.folderPicker = true;
    state.folderHistory = [];
    els.search.disabled = true;
    state.folderPath = "";
    state.folderArtworkEntry = null;
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
    state.folderArtworkEntry = null;
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
    state.viewMode = "library";
    state.folderPicker = false;
    state.folderPath = path;
    state.folderName = name || (path === root ? state.libraryFolder.name : path.split("/").pop());
    state.displayLimit = 100;
    if (state.folderCache.has(path)) {
      state.entries = state.folderCache.get(path);
      state.folderArtworkEntry = chooseFolderArtwork(state.entries);
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
      state.entries = entries.filter((entry) => (isFolder(entry) || isAudio(entry) || isArtwork(entry)) && isInsideLibrary(entry));
      state.folderCache.set(path, state.entries);
      state.folderArtworkEntry = chooseFolderArtwork(state.entries);
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
    return state.tracks;
  }
  function renderTracks() {
    state.listObserver?.disconnect();
    els.tableBody.replaceChildren();
    els.emptyState.hidden = true;
    const query = els.search.value.trim().toLocaleLowerCase();
    const tracks = filteredTracks();
    let folders = state.entries.filter(isFolder).filter((folder) => !query || folder.name.toLocaleLowerCase().includes(query));
    if (state.viewMode === "favorites") folders = [];
    if (state.viewMode === "recent") folders = folders.sort((a, b) => new Date(b.server_modified || 0) - new Date(a.server_modified || 0)).slice(0, 20);
    els.trackCount.textContent = `· ${tracks.length} track${tracks.length === 1 ? "" : "s"} · ${folders.length} folder${folders.length === 1 ? "" : "s"}`;
    const rows = [
      ...folders.map((folder) => ({ kind: "folder", item: folder })),
      ...tracks.map((track) => ({ kind: "track", item: track }))
    ].sort((a, b) => state.viewMode === "recent"
      ? new Date(b.item.server_modified || 0) - new Date(a.item.server_modified || 0)
      : a.item.name.localeCompare(b.item.name, undefined, { numeric: true, sensitivity: "base" }));
    if (!rows.length) {
      els.emptyState.hidden = false;
      els.emptyState.querySelector("p").textContent = query ? "No results" : state.viewMode === "favorites" ? "No favorites" : "No tracks";
      els.emptyState.querySelector("span").textContent = "";
      return;
    }
    rows.slice(0, state.displayLimit).forEach(({ kind, item }, index) => {
      els.tableBody.append(kind === "folder" ? makeFolderRow(item, index) : makeTrackRow(item, index));
    });
    const remaining = rows.length - state.displayLimit;
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
    if (state.folderArtworkEntry) loadFolderArtwork(state.folderPath, state.folderArtworkEntry);
  }
  function renderFolderPicker() {
    state.listObserver?.disconnect();
    els.tableBody.replaceChildren();
    els.emptyState.hidden = true;
    els.trackCount.textContent = "· choose one folder";
    const folders = state.entries.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    folders.slice(0, state.displayLimit).forEach((folder, index) => els.tableBody.append(makeFolderRow(folder, index)));
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
  function makeFolderRow(folder, index = 0) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "library-row folder-row artist-row";
    row.setAttribute("aria-label", state.folderPicker ? `Select ${folder.name} as your library` : `Open ${folder.name}`);
    const leading = document.createElement("span");
    leading.className = "track-leading";
    leading.innerHTML = '<svg class="folder-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h5l2 2h8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>';
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
    row.className = `library-row track-row${state.current?.id === track.id ? " is-playing" : ""}`;
    const leading = document.createElement("span");
    leading.className = "track-leading";
    if (state.current?.id === track.id && !els.audio.paused) {
      leading.innerHTML = '<span class="mini-eq" aria-label="Playing"><i></i><i></i><i></i></span>';
    } else {
      const play = document.createElement("button");
      play.type = "button";
      play.className = "track-play";
      play.setAttribute("aria-label", `Play ${track.name}`);
      play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg>';
      play.addEventListener("click", () => playTrack(track));
      leading.append(play);
    }
    const copy = document.createElement("div");
    copy.className = "track-copy";
    if (state.folderArtworkEntry) {
      const artwork = document.createElement("img");
      artwork.className = "track-artwork";
      artwork.alt = "";
      artwork.loading = "lazy";
      artwork.dataset.folderPath = state.folderPath;
      const cachedArtwork = state.artworkLinks.get(state.folderArtworkEntry.id);
      if (cachedArtwork) artwork.src = cachedArtwork;
      row.append(leading, artwork);
    } else {
      row.append(leading);
    }
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
    favorite.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 8.7c0 4.2-8.8 10-8.8 10s-8.8-5.8-8.8-10A4.7 4.7 0 0 1 12 6.4a4.7 4.7 0 0 1 8.8 2.3Z"/></svg>';
    favorite.addEventListener("click", () => toggleFavorite(track));
    actions.append(favorite);
    row.append(copy, actions);
    row.addEventListener("dblclick", () => playTrack(track));
    return row;
  }
  async function playTrack(track) {
    if (!state.token) return toast("Open Dropbox setup first");
    if (!isInsideLibrary(track)) return showNotice("That track is outside the selected Flurb folder.", "error");
    const requestId = ++state.playRequest;
    els.audio.pause();
    state.loadingTrack = true;
    state.current = track;
    els.nowTitle.textContent = track.name.replace(/\.[^.]+$/, "");
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
  function updateTransport() {
    const hasTrack = Boolean(state.current);
    els.play.disabled = !hasTrack || state.loadingTrack;
    els.previous.disabled = !hasTrack;
    els.next.disabled = !hasTrack;
    els.progress.disabled = !hasTrack || !Number.isFinite(els.audio.duration);
    els.play.classList.toggle("playing", !els.audio.paused);
    els.play.setAttribute("aria-label", els.audio.paused ? "Play" : "Pause");
  }
  function updateFavoriteButton() {
    const active = Boolean(state.current && state.favorites.has(state.current.id));
    els.nowFavorite.classList.toggle("active", active);
    els.nowFavorite.setAttribute("aria-label", active ? "Remove current track from favorites" : "Favorite current track");
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
    updateTransport();
  }
  els.search.addEventListener("input", () => { state.displayLimit = 100; renderTracks(); });
  els.home.addEventListener("click", goHomeLibrary);
  els.recent.addEventListener("click", () => { state.viewMode = "recent"; updateQuickActions(); renderTracks(); });
  els.favoritesButton.addEventListener("click", () => { state.viewMode = "favorites"; updateQuickActions(); renderTracks(); });
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
    if (Number.isFinite(els.audio.duration)) els.audio.currentTime = (Number(els.progress.value) / 100) * els.audio.duration;
  });
  els.audio.addEventListener("timeupdate", renderProgress);
  els.audio.addEventListener("loadedmetadata", () => { renderProgress(); renderTracks(); });
  els.audio.addEventListener("play", () => { updateTransport(); renderTracks(); });
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
  updateConnection();
  updateTransport();
  handleOAuthReturn().then((handled) => { if (!handled && state.token) connectLibrary(); });
})();
