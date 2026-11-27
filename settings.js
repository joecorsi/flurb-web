(() => {
  "use strict";
  const DROPBOX_SIGNED_OUT = "flurb.dropbox.signedOutAt";
  const APP_KEY = "b7db4q3upd3kspx";
  if (new URLSearchParams(location.search).get("embedded") === "1") document.body.classList.add("is-embedded");
  const API = "https://api.dropboxapi.com/2";
  const els = {
    connect: document.querySelector("#settings-connect"),
    library: document.querySelector("#settings-library"),
    libraryToggle: document.querySelector("#settings-library-toggle"),
    currentFolder: document.querySelector("#settings-current-folder"),
    folders: document.querySelector("#settings-folders"),
    status: document.querySelector("#settings-status"),
    account: document.querySelector("#dropbox-account"),
    accountEmail: document.querySelector("#dropbox-account-email"),
    accountName: document.querySelector("#dropbox-account-name"),
    loginDate: document.querySelector("#dropbox-login-date"),
    reconnect: document.querySelector("#settings-reconnect")
  };
  let token = "";
  let refreshToken = "";
  let tokenExpiresAt = 0;
  let refreshPromise = null;
  let foldersLoaded = false;

  function readDropboxSession() {
    const signedOut = localStorage.getItem(DROPBOX_SIGNED_OUT);
    token = signedOut ? "" : localStorage.getItem("flurb.dropbox.accessToken") || sessionStorage.getItem("flurb.dropbox.accessToken") || "";
    refreshToken = signedOut ? "" : localStorage.getItem("flurb.dropbox.refreshToken") || "";
    tokenExpiresAt = Number(localStorage.getItem("flurb.dropbox.tokenExpiresAt") || 0);
  }
  function updateDropboxPanel() {
    els.connect.textContent = token ? "Sign out" : "Connect Dropbox";
    els.connect.classList.toggle("is-connected", Boolean(token));
    els.library.hidden = !token;
    els.account.hidden = !token;
    if (!token) {
      els.reconnect.hidden = true;
      setFolderListOpen(false);
      els.folders.replaceChildren();
      foldersLoaded = false;
    }
  }

  function setFolderListOpen(open) {
    els.folders.hidden = !open;
    els.libraryToggle.setAttribute("aria-expanded", String(open));
    els.libraryToggle.classList.toggle("is-open", open);
  }
  function updateSelectedFolder() {
    let selected = null;
    try { selected = JSON.parse(localStorage.getItem("flurb.dropbox.libraryFolder") || "null"); } catch (_) {}
    els.currentFolder.textContent = selected?.name || "No folder selected";
    return selected;
  }

  function status(message, error = false) {
    els.status.textContent = message;
    els.status.classList.toggle("is-error", error);
  }
  function randomString(size) {
    const bytes = crypto.getRandomValues(new Uint8Array(size));
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  }
  function base64Url(buffer) {
    let binary = "";
    new Uint8Array(buffer).forEach((value) => { binary += String.fromCharCode(value); });
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  async function connectDropbox() {
    const popup = window.open("about:blank", "flurb-dropbox-auth", "popup,width=520,height=680");
    const verifier = randomString(48);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const redirectUri = new URL("./", location.href).href;
    const csrf = randomString(24);
    localStorage.setItem("flurb.dropbox.pkce", JSON.stringify({ verifier, csrf, redirectUri }));
    const params = new URLSearchParams({
      client_id: APP_KEY,
      response_type: "code",
      code_challenge: base64Url(digest),
      code_challenge_method: "S256",
      redirect_uri: redirectUri,
      state: csrf,
      scope: "files.metadata.read files.content.read account_info.read",
      include_granted_scopes: "user",
      token_access_type: "offline"
    });
    const authorizationUrl = `https://www.dropbox.com/oauth2/authorize?${params}`;
    if (popup) popup.location.assign(authorizationUrl);
    else location.assign(authorizationUrl);
  }
  function clearDropboxTokens() {
    token = "";
    refreshToken = "";
    tokenExpiresAt = 0;
    ["flurb.dropbox.accessToken", "flurb.dropbox.refreshToken", "flurb.dropbox.tokenExpiresAt", "flurb.dropbox.loginAt"].forEach((key) => {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    });
    updateDropboxPanel();
  }
  async function ensureAccessToken(force = false) {
    if (localStorage.getItem(DROPBOX_SIGNED_OUT)) throw new Error("Connect Dropbox in Settings.");
    if (!force && token && (!tokenExpiresAt || Date.now() < tokenExpiresAt - 60_000)) return token;
    if (!refreshToken) {
      if (token && !force) return token;
      throw new Error("Reconnect Dropbox once to enable a lasting session.");
    }
    if (!refreshPromise) {
      const credential = refreshToken;
      refreshPromise = (async () => {
        const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: credential, client_id: APP_KEY });
        const response = await fetch("https://api.dropbox.com/oauth2/token", {
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
        token = result.access_token;
        tokenExpiresAt = Date.now() + (Number(result.expires_in) || 14_400) * 1000;
        localStorage.setItem("flurb.dropbox.accessToken", token);
        localStorage.setItem("flurb.dropbox.tokenExpiresAt", String(tokenExpiresAt));
        sessionStorage.setItem("flurb.dropbox.accessToken", token);
        sessionStorage.setItem("flurb.dropbox.tokenExpiresAt", String(tokenExpiresAt));
        return token;
      })().finally(() => { refreshPromise = null; });
    }
    return refreshPromise;
  }
  async function dropbox(path, body = {}, retried = false) {
    const accessToken = await ensureAccessToken();
    const response = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && refreshToken && !retried) {
        await ensureAccessToken(true);
        return dropbox(path, body, true);
      }
      if (response.status === 401) {
        clearDropboxTokens();
      }
      throw new Error(result.error_summary || result.error?.[".tag"] || `Dropbox request failed (${response.status}).`);
    }
    return result;
  }
  async function listRootFolders() {
    els.library.hidden = false;
    setFolderListOpen(true);
    els.folders.replaceChildren();
    foldersLoaded = false;
    status("Loading folders…");
    try {
      let response = await dropbox("/files/list_folder", { path: "", recursive: false, include_deleted: false });
      const folders = (response.entries || []).filter((entry) => entry[".tag"] === "folder");
      while (response.has_more) {
        response = await dropbox("/files/list_folder/continue", { cursor: response.cursor });
        folders.push(...(response.entries || []).filter((entry) => entry[".tag"] === "folder"));
      }
      if (!token || localStorage.getItem(DROPBOX_SIGNED_OUT)) return;
      folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      foldersLoaded = true;
      if (!folders.length) {
        status("No folders found.");
        return;
      }
      status("");
      folders.forEach((folder) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "settings-folder";
        button.textContent = folder.name;
        button.addEventListener("click", () => {
          localStorage.setItem("flurb.dropbox.libraryFolder", JSON.stringify({ id: folder.id, path_lower: folder.path_lower, name: folder.name }));
          updateSelectedFolder();
          setFolderListOpen(false);
          if (window.parent !== window) window.parent.postMessage({ type: "flurb-library-selected" }, location.origin);
          else location.replace(new URL("./", location.href).href);
        });
        els.folders.append(button);
      });
    } catch (error) {
      if (token) status(error.message || "Could not load Dropbox folders.", true);
    }
  }

  function formatLoginDate(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return "Not recorded";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
  }
  async function loadAccountDetails() {
    if (!token) { els.account.hidden = true; els.reconnect.hidden = true; return; }
    els.account.hidden = false;
    els.accountEmail.textContent = "Loading…";
    els.accountName.textContent = "—";
    const loginAt = localStorage.getItem("flurb.dropbox.loginAt");
    els.loginDate.textContent = formatLoginDate(loginAt);
    els.reconnect.hidden = Boolean(loginAt);
    try {
      const account = await dropbox("/users/get_current_account");
      if (!token || localStorage.getItem(DROPBOX_SIGNED_OUT)) return;
      els.accountEmail.textContent = account.email || "—";
      els.accountName.textContent = account.name?.display_name || "—";
    } catch (error) {
      if (!token) return;
      els.accountEmail.textContent = /missing_scope|insufficient_scope/i.test(error.message) ? "Reconnect to allow account details" : "Unavailable";
      if (/missing_scope|insufficient_scope/i.test(error.message)) els.reconnect.hidden = false;
      else status(error.message || "Could not load Dropbox account details.", true);
    }
  }

  els.connect.addEventListener("click", () => {
    if (!token) {
      connectDropbox().catch((error) => status(error.message, true));
      return;
    }
    localStorage.setItem(DROPBOX_SIGNED_OUT, String(Date.now()));
    localStorage.removeItem("flurb.dropbox.pkce");
    sessionStorage.removeItem("flurb.dropbox.pkce");
    clearDropboxTokens();
    status("Signed out of Dropbox.");
    notifyPlayer("flurb-dropbox-session-changed");
  });
  els.libraryToggle.addEventListener("click", () => {
    if (!els.folders.hidden) setFolderListOpen(false);
    else if (foldersLoaded) setFolderListOpen(true);
    else listRootFolders();
  });
  els.reconnect.addEventListener("click", () => connectDropbox().catch((error) => status(error.message, true)));
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.data?.type !== "flurb-dropbox-connected") return;
    readDropboxSession();
    updateDropboxPanel();
    if (!token) return;
    const selected = updateSelectedFolder();
    loadAccountDetails();
    if (!selected) listRootFolders();
    else status(`${selected.name} selected`);
    notifyPlayer("flurb-dropbox-session-changed");
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== DROPBOX_SIGNED_OUT) return;
    readDropboxSession();
    updateDropboxPanel();
    if (token) {
      updateSelectedFolder();
      loadAccountDetails();
    } else status("Signed out of Dropbox.");
  });
  const cloud = window.FlurbCloud;
  const tursoForm = document.querySelector("#turso-form");
  const tursoUrl = document.querySelector("#turso-url");
  const tursoToken = document.querySelector("#turso-token");
  const tursoConnect = document.querySelector("#turso-connect");
  const tursoDisconnect = document.querySelector("#turso-disconnect");
  const tursoStatus = document.querySelector("#turso-status");
  const tursoSyncDetails = document.querySelector("#turso-sync-details");
  const tursoSyncPhase = document.querySelector("#turso-sync-phase");
  const tursoLastSync = document.querySelector("#turso-last-sync");
  const tursoQueuedEdits = document.querySelector("#turso-queued-edits");
  const tursoPhaseLabels = {
    connecting: "Connecting…", syncing: "Syncing…", synced: "Up to date",
    offline: "Offline", paused: "Paused", pending: "Waiting to sync", connected: "Connected"
  };
  let tursoDetailsRequest = 0;
  function renderTursoDetails({ phase, lastSyncAt, queued }) {
    tursoSyncPhase.textContent = tursoPhaseLabels[phase] || "Connected";
    tursoLastSync.textContent = Number.isFinite(lastSyncAt) ? formatLoginDate(lastSyncAt) : "Not yet";
    tursoQueuedEdits.textContent = Number.isInteger(queued) ? String(queued) : "—";
  }
  async function loadTursoDetails(config) {
    const request = ++tursoDetailsRequest;
    tursoSyncDetails.hidden = !config;
    if (!config) return;
    const phase = navigator.onLine ? "connected" : "offline";
    renderTursoDetails({ phase });
    try {
      const [snapshot, lastSyncAt] = await Promise.all([cloud.load(config), cloud.lastSyncAt(config)]);
      if (request === tursoDetailsRequest) renderTursoDetails({ phase, lastSyncAt, queued: snapshot.pending.length });
    } catch (_) {}
  }
  const setTursoStatus = (text, error = false) => {
    tursoStatus.textContent = text;
    tursoStatus.classList.toggle("is-error", error);
  };
  const notifyPlayer = (type) => {
    if (window.parent !== window) window.parent.postMessage({ type }, location.origin);
  };
  const offlinePreference = window.FlurbOfflineAudio.preference;
  const offlineToggle = document.querySelector("#offline-audio-toggle");
  const offlineProgress = document.querySelector("#offline-audio-progress");
  const offlineCount = document.querySelector("#offline-audio-count");
  const offlineBar = document.querySelector("#offline-audio-bar");
  const offlineStatus = document.querySelector("#offline-audio-status");
  function renderOfflineAudio({ phase, saved, total, title } = {}) {
    const enabled = localStorage.getItem(offlinePreference) === "on";
    offlineToggle.textContent = enabled ? "On" : "Off";
    offlineToggle.setAttribute("aria-checked", String(enabled));
    offlineToggle.classList.toggle("is-connected", enabled);
    offlineProgress.hidden = !enabled || !(total > 0);
    offlineBar.max = total || 1;
    offlineBar.value = saved || 0;
    offlineCount.textContent = `${saved || 0} of ${total || 0} tracks saved`;
    const messages = {
      waiting: "Loading Recently Added…",
      connect: "Connect Turso and select a Dropbox music folder to download tracks.",
      downloading: `Downloading ${title || "track"}…`,
      ready: total ? "Available offline on this device." : "No tracks in Recently Added.",
      offline: "Waiting for an internet connection.",
      retry: "Some downloads failed. Flurb will retry.",
      storage: "Device storage is full. Tracks already saved are available offline.",
      error: "Flurb couldn’t access this device’s offline storage."
    };
    offlineStatus.textContent = enabled ? messages[phase] || (window.parent === window ? "Open the player to download tracks." : "Checking downloads…") : "";
    offlineStatus.classList.toggle("is-error", enabled && (phase === "storage" || phase === "error"));
  }
  offlineToggle.addEventListener("click", () => {
    const enabled = localStorage.getItem(offlinePreference) !== "on";
    localStorage.setItem(offlinePreference, enabled ? "on" : "off");
    renderOfflineAudio();
    if (!enabled && window.parent === window) {
      window.FlurbOfflineAudio.keep(new Set()).catch(() => {
        offlineStatus.textContent = "Flurb couldn’t remove the saved files.";
        offlineStatus.classList.add("is-error");
      });
    }
    notifyPlayer("flurb-offline-audio-changed");
  });
  window.addEventListener("message", (event) => {
    if (event.origin === location.origin && event.source === window.parent && event.data?.type === "flurb-offline-audio-status") {
      renderOfflineAudio(event.data);
    }
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== offlinePreference) return;
    renderOfflineAudio();
    notifyPlayer("flurb-offline-audio-request");
  });
  renderOfflineAudio();
  notifyPlayer("flurb-offline-audio-request");

  function updateTursoForm() {
    const config = cloud.readConfig();
    tursoUrl.value = config?.origin || "";
    tursoDisconnect.hidden = !config;
    tursoConnect.textContent = config ? "Reconnect Turso" : "Connect Turso";
    tursoConnect.classList.toggle("is-connected", Boolean(config));
    loadTursoDetails(config);
  }
  tursoForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    tursoConnect.disabled = tursoDisconnect.disabled = true;
    setTursoStatus("Connecting to Turso…");
    try {
      await cloud.connect(tursoUrl.value, tursoToken.value);
      tursoToken.value = "";
      updateTursoForm();
      setTursoStatus("");
      notifyPlayer("flurb-turso-changed");
    } catch (error) {
      setTursoStatus(error.message || "Could not connect to Turso.", true);
    } finally {
      tursoConnect.disabled = tursoDisconnect.disabled = false;
    }
  });
  tursoDisconnect.addEventListener("click", async () => {
    tursoConnect.disabled = tursoDisconnect.disabled = true;
    try {
      await cloud.disconnect();
      tursoToken.value = "";
      updateTursoForm();
      setTursoStatus("Disconnected. Local changes will resume syncing when you reconnect to this library.");
      notifyPlayer("flurb-turso-changed");
    } catch (error) {
      setTursoStatus(error.message || "Could not disconnect Turso.", true);
    } finally {
      tursoConnect.disabled = tursoDisconnect.disabled = false;
    }
  });
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== "flurb-turso-status") return;
    const config = cloud.readConfig();
    if (!config || event.data.config?.id !== config.id || event.data.config?.origin !== config.origin) return;
    tursoDetailsRequest += 1;
    tursoSyncDetails.hidden = false;
    renderTursoDetails(event.data);
    if (!tursoConnect.disabled) setTursoStatus(event.data.message, event.data.phase === "paused");
  });
  updateTursoForm();
  if (cloud.readConfig()) notifyPlayer("flurb-turso-status-request");
  window.addEventListener("storage", (event) => {
    if (event.key === "flurb.turso.connection" && !tursoConnect.disabled) {
      updateTursoForm();
      notifyPlayer("flurb-turso-status-request");
    }
  });

  readDropboxSession();
  updateDropboxPanel();
  if (token) {
    const selected = updateSelectedFolder();
    loadAccountDetails();
    if (selected?.name) status(`${selected.name} selected`);
    const justConnected = new URLSearchParams(location.search).get("connected") === "1";
    if (justConnected) history.replaceState({}, document.title, location.pathname);
    if (!selected) listRootFolders();
  }
})();
