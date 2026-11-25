(() => {
  "use strict";
  const API = "https://api.dropboxapi.com/2";
  const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "aif", "aifc", "aiff", "au", "alac", "wma", "wm", "m4b", "m4p", "m4r", "mid"]);
  const $ = (selector) => document.querySelector(selector);
  const els = {
    audio: $("#audio"), appKey: $("#app-key"), setupCard: $("#setup-card"), setupConnect: $("#setup-connect"), connectButton: $("#connect-button"),
    connectionState: $("#connection-state"), connectionLabel: $("#connection-label"), search: $("#search"), breadcrumbs: $("#breadcrumbs"),
    trackList: $("#track-list"), emptyState: $("#empty-state"), trackCount: $("#track-count"), notice: $("#notice"), noticeMessage: $("#notice-message"),
    refresh: $("#refresh-button"), help: $("#show-help"), helpPanel: $("#help-panel"), player: $("#player"), play: $("#play-button"),
    previous: $("#previous-button"), next: $("#next-button"), shuffle: $("#shuffle-button"), repeat: $("#repeat-button"), progress: $("#progress"),
    elapsed: $("#elapsed-time"), duration: $("#duration-time"), nowTitle: $("#now-title"), nowAlbum: $("#now-album"), nowFavorite: $("#now-favorite"),
    volume: $("#volume"), toast: $("#toast")
  };
  const state = {
    appKey: localStorage.getItem("flurb.dropbox.appKey") || "",
    token: sessionStorage.getItem("flurb.dropbox.accessToken") || "",
    folderPath: "",
    folderName: "All files",
    entries: [],
    tracks: [],
    current: null,
    loadingTrack: false,
    shuffle: false,
    repeat: "off",
    favorites: new Set(JSON.parse(localStorage.getItem("flurb.dropbox.favorites") || "[]")),
    playRequest: 0,
    toastTimer: null
  };
  els.appKey.value = state.appKey;
  els.audio.volume = Number(els.volume.value);

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
    if (/expired_access_token|invalid_access_token|401/i.test(text)) return "Your Dropbox session expired. Connect again to keep listening.";
    if (/missing_scope|insufficient_scope/i.test(text)) return "This Dropbox app needs files.metadata.read and files.content.read permissions. Save the permissions, then reconnect.";
    if (/path/not_found/i.test(text)) return "That folder is no longer available. Go back to your Dropbox files.";
    return text;
  }
  async function dropbox(path, body = {}) {
    const args = new URLSearchParams({
      authorization: `Bearer ${state.token}`,
      arg: JSON.stringify(body),
      reject_cors_preflight: "true"
    });
    const response = await fetch(`${API}${path}?${args.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=dropbox-cors-hack" }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        state.token = "";
        sessionStorage.removeItem("flurb.dropbox.accessToken");
        updateConnection();
      }
      throw new Error(payload.error_summary || payload.error?.[".tag"] || `Dropbox request failed (${response.status}).`);
    }
    return payload;
  }
  function randomString(bytes = 32) {
    const values = crypto.getRandomValues(new Uint8Array(bytes));
    return Array.from(values, (v) => v.toString(16).padStart(2, "0")).join("");
  }
  function base64Url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  async function startOAuth() {
    const appKey = els.appKey.value.trim();
    if (!appKey) {
      els.appKey.focus();
      showNotice("Add your Dropbox app key first.", "error");
      return;
    }
    if (!window.isSecureContext && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
      showNotice("Dropbox sign-in needs HTTPS, or localhost for local development.", "error");
      return;
    }
    state.appKey = appKey;
    localStorage.setItem("flurb.dropbox.appKey", appKey);
    const verifier = randomString(48);
    const challenge = base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const csrf = randomString(24);
    sessionStorage.setItem("flurb.dropbox.pkce", JSON.stringify({ verifier, csrf, redirectUri: location.href.split("?")[0].split("#")[0] }));
    const params = new URLSearchParams({
      client_id: appKey,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      redirect_uri: location.href.split("?")[0].split("#")[0],
      state: csrf,
      scope: "files.metadata.read files.content.read"
    });
    location.assign(`https://www.dropbox.com/oauth2/authorize?${params.toString()}`);
  }
  async function handleOAuthReturn() {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const error = params.get("error_description") || params.get("error");
    if (!code && !error) return;
    history.replaceState({}, document.title, location.pathname + location.hash);
    if (error) {
      sessionStorage.removeItem("flurb.dropbox.pkce");
      showNotice(`Dropbox sign-in was not completed: ${error}`, "error");
      return;
    }
    let pending;
    try { pending = JSON.parse(sessionStorage.getItem("flurb.dropbox.pkce") || "null"); } catch (_) {}
    sessionStorage.removeItem("flurb.dropbox.pkce");
    if (!pending || params.get("state") !== pending.csrf) {
      showNotice("Dropbox sign-in could not be verified. Please connect again.", "error");
      return;
    }
    try {
      const form = new URLSearchParams({
        code,
        grant_type: "authorization_code",
        client_id: state.appKey,
        code_verifier: pending.verifier,
        redirect_uri: pending.redirectUri
      });
      const response = await fetch("https://api.dropboxapi.com/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error_description || result.error || "Dropbox could not complete sign-in.");
      state.token = result.access_token;
      sessionStorage.setItem("flurb.dropbox.accessToken", state.token);
      toast("Dropbox connected");
      await connectLibrary();
    } catch (err) {
      showNotice(friendlyError(err), "error");
    }
  }
  function updateConnection() {
    const connected = Boolean(state.token);
    els.connectionState.classList.toggle("connected", connected);
    els.connectionLabel.textContent = connected ? "Dropbox connected" : "Not connected";
    els.connectButton.textContent = connected ? "Reconnect" : "Connect Dropbox";
    els.search.disabled = !connected;
    els.refresh.disabled = !connected;
    els.setupCard.classList.toggle("connected", connected);
  }
  async function connectLibrary() {
    updateConnection();
    showNotice("Looking for your music…");
    try {
      await loadFolder("");
    } catch (error) {
      showNotice(friendlyError(error), "error");
    }
  }
  async function listFolder(path) {
    let response = await dropbox("/files/list_folder", { path, recursive: false, include_deleted: false, include_media_info: true });
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
  async function loadFolder(path, name) {
    showNotice("Opening folder…");
    els.refresh.classList.add("is-spinning");
    try {
      state.folderPath = path;
      state.folderName = name || (path ? path.split("/").pop() : "All files");
      const allEntries = await listFolder(path);
      state.entries = allEntries.filter((entry) => isFolder(entry) || isAudio(entry));
      state.tracks = state.entries.filter(isAudio).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
      renderBreadcrumbs();
      renderTracks();
      hideNotice();
      if (state.entries.length === 0) showNotice("This folder is empty. Try another Dropbox folder.");
    } finally {
      els.refresh.classList.remove("is-spinning");
    }
  }
  function renderBreadcrumbs() {
    els.breadcrumbs.replaceChildren();
    const parts = state.folderPath.split("/").filter(Boolean);
    const root = document.createElement("button");
    root.type = "button";
    root.className = `crumb${parts.length === 0 ? " current" : ""}`;
    root.textContent = "All files";
    root.addEventListener("click", () => loadFolder("", "All files").catch((e) => showNotice(friendlyError(e), "error")));
    els.breadcrumbs.append(root);
    let current = "";
    parts.forEach((part, index) => {
      const separator = document.createElement("span");
      separator.className = "crumb-separator";
      separator.textContent = "/";
      els.breadcrumbs.append(separator);
      current += `/${part}`;
      const path = current;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `crumb${index === parts.length - 1 ? " current" : ""}`;
      button.textContent = part;
      button.addEventListener("click", () => loadFolder(path, part).catch((e) => showNotice(friendlyError(e), "error")));
      els.breadcrumbs.append(button);
    });
  }
  function filteredTracks() {
    const query = els.search.value.trim().toLocaleLowerCase();
    return state.tracks.filter((track) => !query || track.name.toLocaleLowerCase().includes(query) || track.path_lower.toLocaleLowerCase().includes(query));
  }
  function renderTracks() {
    els.trackList.replaceChildren();
    const query = els.search.value.trim().toLocaleLowerCase();
    const folders = state.entries.filter(isFolder).filter((folder) => !query || folder.name.toLocaleLowerCase().includes(query));
    const tracks = filteredTracks();
    els.trackCount.textContent = `· ${tracks.length} track${tracks.length === 1 ? "" : "s"}`;
    if (!folders.length && !tracks.length) {
      els.trackList.append(els.emptyState);
      els.emptyState.querySelector("p").textContent = query ? "No tracks found." : "No music in this folder yet.";
      els.emptyState.querySelector("span").textContent = query ? "Try another search." : "Choose a different folder or add some music to Dropbox.";
      return;
    }
    folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    folders.forEach((folder) => els.trackList.append(makeFolderRow(folder)));
    tracks.forEach((track, index) => els.trackList.append(makeTrackRow(track, index)));
  }
  function makeFolderRow(folder) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "track-row folder-row";
    row.setAttribute("aria-label", `Open folder ${folder.name}`);
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
    meta.textContent = "FOLDER";
    copy.append(title, meta);
    const chevron = document.createElement("span");
    chevron.className = "track-duration";
    chevron.textContent = "OPEN  ›";
    row.append(leading, copy, chevron);
    row.addEventListener("click", () => loadFolder(folder.path_lower, folder.name).catch((e) => showNotice(friendlyError(e), "error")));
    return row;
  }
  function makeTrackRow(track, index) {
    const row = document.createElement("div");
    row.className = `track-row${state.current?.id === track.id ? " is-playing" : ""}`;
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
    const title = document.createElement("span");
    title.className = "track-name";
    title.textContent = track.name.replace(/\.[^.]+$/, "");
    const meta = document.createElement("span");
    meta.className = "track-meta";
    meta.textContent = `${state.folderName.toUpperCase()} · ${formatBytes(track.size)}`;
    copy.append(title, meta);
    const duration = document.createElement("span");
    duration.className = "track-duration";
    duration.textContent = state.current?.id === track.id && Number.isFinite(els.audio.duration) ? formatTime(els.audio.duration) : "AUDIO";
    const actions = document.createElement("div");
    actions.className = "track-actions";
    const favorite = document.createElement("button");
    favorite.type = "button";
    favorite.className = `icon-button track-favorite${state.favorites.has(track.id) ? " active" : ""}`;
    favorite.setAttribute("aria-label", state.favorites.has(track.id) ? `Remove ${track.name} from favorites` : `Favorite ${track.name}`);
    favorite.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 8.7c0 4.2-8.8 10-8.8 10s-8.8-5.8-8.8-10A4.7 4.7 0 0 1 12 6.4a4.7 4.7 0 0 1 8.8 2.3Z"/></svg>';
    favorite.addEventListener("click", () => toggleFavorite(track));
    actions.append(favorite);
    row.append(leading, copy, duration, actions);
    row.addEventListener("dblclick", () => playTrack(track));
    return row;
  }
  async function playTrack(track) {
    if (!state.token) return toast("Connect Dropbox first");
    const requestId = ++state.playRequest;
    els.audio.pause();
    state.loadingTrack = true;
    state.current = track;
    els.nowTitle.textContent = track.name.replace(/\.[^.]+$/, "");
    els.nowAlbum.textContent = track.path_display || track.name;
    els.nowFavorite.disabled = false;
    updateFavoriteButton();
    updateTransport();
    renderTracks();
    showNotice(`Loading ${track.name}…`);
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
        updateTransport();
      }
    }
  }
  function playNext(direction = 1) {
    if (!state.tracks.length) return;
    const currentIndex = state.tracks.findIndex((track) => track.id === state.current?.id);
    let nextIndex;
    if (state.shuffle && direction > 0 && state.tracks.length > 1) {
      do { nextIndex = Math.floor(Math.random() * state.tracks.length); } while (nextIndex === currentIndex);
    } else if (currentIndex < 0) {
      nextIndex = direction > 0 ? 0 : state.tracks.length - 1;
    } else {
      nextIndex = (currentIndex + direction + state.tracks.length) % state.tracks.length;
    }
    playTrack(state.tracks[nextIndex]);
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
    if (state.favorites.has(track.id)) state.favorites.delete(track.id);
    else state.favorites.add(track.id);
    localStorage.setItem("flurb.dropbox.favorites", JSON.stringify([...state.favorites]));
    updateFavoriteButton();
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
  els.setupConnect.addEventListener("click", startOAuth);
  els.connectButton.addEventListener("click", () => {
    if (state.token) return startOAuth();
    els.setupCard.scrollIntoView({ behavior: "smooth", block: "center" });
    els.appKey.focus({ preventScroll: true });
  });
  els.help.addEventListener("click", () => {
    const expanded = els.help.getAttribute("aria-expanded") === "true";
    els.help.setAttribute("aria-expanded", String(!expanded));
    els.helpPanel.hidden = expanded;
  });
  els.search.addEventListener("input", renderTracks);
  els.refresh.addEventListener("click", () => loadFolder(state.folderPath, state.folderName).catch((e) => showNotice(friendlyError(e), "error")));
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
  els.volume.addEventListener("input", () => { els.audio.volume = Number(els.volume.value); });
  els.audio.addEventListener("timeupdate", renderProgress);
  els.audio.addEventListener("loadedmetadata", () => { renderProgress(); renderTracks(); });
  els.audio.addEventListener("play", () => { updateTransport(); renderTracks(); });
  els.audio.addEventListener("pause", () => { updateTransport(); renderTracks(); });
  els.audio.addEventListener("ended", () => {
    if (state.repeat === "one") { els.audio.currentTime = 0; els.audio.play(); }
    else if (state.repeat === "all" || state.shuffle || state.tracks.findIndex((t) => t.id === state.current?.id) < state.tracks.length - 1) playNext(1);
    else updateTransport();
  });
  els.audio.addEventListener("error", () => {
    if (state.current && !els.audio.paused) showNotice("The audio stream was interrupted. Try playing the track again.", "error");
  });

  updateConnection();
  updateTransport();
  if (state.token) connectLibrary();
  handleOAuthReturn();
})();
