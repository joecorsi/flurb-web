(() => {
  "use strict";
  const APP_KEY = "b7db4q3upd3kspx";
  const API = "https://api.dropboxapi.com/2";
  const els = {
    connect: document.querySelector("#settings-connect"),
    library: document.querySelector("#settings-library"),
    folders: document.querySelector("#settings-folders"),
    status: document.querySelector("#settings-status")
  };
  let token = localStorage.getItem("flurb.dropbox.accessToken") || sessionStorage.getItem("flurb.dropbox.accessToken") || "";

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
    const verifier = randomString(48);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const redirectUri = new URL("./", location.href).href;
    const csrf = randomString(24);
    sessionStorage.setItem("flurb.dropbox.pkce", JSON.stringify({ verifier, csrf, redirectUri }));
    const params = new URLSearchParams({
      client_id: APP_KEY,
      response_type: "code",
      code_challenge: base64Url(digest),
      code_challenge_method: "S256",
      redirect_uri: redirectUri,
      state: csrf,
      scope: "files.metadata.read files.content.read"
    });
    location.assign(`https://www.dropbox.com/oauth2/authorize?${params}`);
  }
  async function dropbox(path, body = {}) {
    const response = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        token = "";
        localStorage.removeItem("flurb.dropbox.accessToken");
        sessionStorage.removeItem("flurb.dropbox.accessToken");
      }
      throw new Error(result.error_summary || result.error?.[".tag"] || `Dropbox request failed (${response.status}).`);
    }
    return result;
  }
  async function listRootFolders() {
    els.library.hidden = false;
    els.folders.replaceChildren();
    status("Loading folders…");
    try {
      let response = await dropbox("/files/list_folder", { path: "", recursive: false, include_deleted: false });
      const folders = (response.entries || []).filter((entry) => entry[".tag"] === "folder");
      while (response.has_more) {
        response = await dropbox("/files/list_folder/continue", { cursor: response.cursor });
        folders.push(...(response.entries || []).filter((entry) => entry[".tag"] === "folder"));
      }
      folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
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
          location.assign(new URL("./", location.href).href);
        });
        els.folders.append(button);
      });
    } catch (error) {
      status(error.message || "Could not load Dropbox folders.", true);
    }
  }

  els.connect.addEventListener("click", () => {
    if (token) listRootFolders();
    else connectDropbox().catch((error) => status(error.message, true));
  });
  token = localStorage.getItem("flurb.dropbox.accessToken") || sessionStorage.getItem("flurb.dropbox.accessToken") || "";
  if (token) {
    let selected = null;
    try { selected = JSON.parse(localStorage.getItem("flurb.dropbox.libraryFolder") || "null"); } catch (_) {}
    els.connect.textContent = selected?.name ? "Change music folder" : "Choose music folder";
    if (selected?.name) status(`${selected.name} selected`);
    const justConnected = new URLSearchParams(location.search).get("connected") === "1";
    if (justConnected || !selected?.name) {
      history.replaceState({}, document.title, location.pathname);
      listRootFolders();
    }
  } else {
    els.connect.textContent = "Connect Dropbox";
  }
})();
