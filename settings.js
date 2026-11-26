(() => {
  "use strict";
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
  let token = localStorage.getItem("flurb.dropbox.accessToken") || sessionStorage.getItem("flurb.dropbox.accessToken") || "";
  let refreshToken = localStorage.getItem("flurb.dropbox.refreshToken") || "";
  let tokenExpiresAt = Number(localStorage.getItem("flurb.dropbox.tokenExpiresAt") || 0);
  let refreshPromise = null;
  let foldersLoaded = false;

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
    els.connect.textContent = "Reconnect Dropbox";
    els.connect.classList.remove("is-select-folder");
  }
  async function ensureAccessToken(force = false) {
    if (!force && token && (!tokenExpiresAt || Date.now() < tokenExpiresAt - 60_000)) return token;
    if (!refreshToken) {
      if (token && !force) return token;
      throw new Error("Reconnect Dropbox once to enable a lasting session.");
    }
    if (!refreshPromise) {
      refreshPromise = (async () => {
        const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: APP_KEY });
        const response = await fetch("https://api.dropbox.com/oauth2/token", {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form
        });
        const result = await response.json().catch(() => ({}));
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
      status(error.message || "Could not load Dropbox folders.", true);
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
      els.accountEmail.textContent = account.email || "—";
      els.accountName.textContent = account.name?.display_name || "—";
    } catch (error) {
      els.accountEmail.textContent = /missing_scope|insufficient_scope/i.test(error.message) ? "Reconnect to allow account details" : "Unavailable";
      if (/missing_scope|insufficient_scope/i.test(error.message)) els.reconnect.hidden = false;
      else status(error.message || "Could not load Dropbox account details.", true);
    }
  }

  els.connect.addEventListener("click", () => {
    if (token) listRootFolders();
    else connectDropbox().catch((error) => status(error.message, true));
  });
  els.libraryToggle.addEventListener("click", () => {
    if (!els.folders.hidden) setFolderListOpen(false);
    else if (foldersLoaded) setFolderListOpen(true);
    else listRootFolders();
  });
  els.reconnect.addEventListener("click", () => connectDropbox().catch((error) => status(error.message, true)));
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.data?.type !== "flurb-dropbox-connected") return;
    token = localStorage.getItem("flurb.dropbox.accessToken") || "";
    refreshToken = localStorage.getItem("flurb.dropbox.refreshToken") || "";
    tokenExpiresAt = Number(localStorage.getItem("flurb.dropbox.tokenExpiresAt") || 0);
    if (!token) return;
    updateSelectedFolder();
    els.connect.textContent = "Select music folder";
    els.connect.classList.add("is-select-folder");
    loadAccountDetails();
    listRootFolders();
  });
  token = localStorage.getItem("flurb.dropbox.accessToken") || sessionStorage.getItem("flurb.dropbox.accessToken") || "";
  if (token) {
    const selected = updateSelectedFolder();
    els.library.hidden = false;
    setFolderListOpen(false);
    els.connect.textContent = "Select music folder";
    els.connect.classList.add("is-select-folder");
    loadAccountDetails();
    if (selected?.name) status(`${selected.name} selected`);
    const justConnected = new URLSearchParams(location.search).get("connected") === "1";
    if (justConnected || !selected?.name) {
      history.replaceState({}, document.title, location.pathname);
      listRootFolders();
    }
  } else {
    els.connect.textContent = "Connect Dropbox";
    els.account.hidden = true;
    els.reconnect.hidden = true;
  }
})();
