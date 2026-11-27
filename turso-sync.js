(() => {
  "use strict";

  const CONFIG_KEY = "flurb.turso.connection";
  const PULL_SQL = "SELECT seq,id,body FROM (SELECT seq,id,body,sum(length(body)) OVER(ORDER BY seq) AS bytes,row_number() OVER(ORDER BY seq) AS n FROM (SELECT seq,id,body FROM flurb_cloud_changes WHERE seq>? ORDER BY seq LIMIT 64)) WHERE bytes<=750000 OR n=1 ORDER BY seq";
  const TRACK_FIELDS = ["title", "artist", "album", "genre", "path", "duration", "favorite"];
  const MODIFIED_PREFIX = "playlist_modified_v1:";
  const PULL_PAGES_PER_SAVE = 8;
  let database;

  function openDatabase() {
    database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open("flurb-cloud", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("records");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return database;
  }

  async function record(key, update) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("records", update ? "readwrite" : "readonly");
      const store = tx.objectStore("records");
      const request = store.get(key);
      let value;
      let failure;
      request.onsuccess = () => {
        try {
          value = update ? update(request.result) : request.result;
          if (update) {
            if (value === undefined) store.delete(key);
            else store.put(value, key);
          }
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(failure || tx.error || new Error("Could not save the local Turso cache."));
    });
  }

  function readConfig() {
    try { return JSON.parse(localStorage.getItem(CONFIG_KEY)); } catch (_) { return null; }
  }

  function databaseOrigin(input) {
    const url = new URL(input.trim().replace(/^(libsql|turso):\/\//i, "https://"));
    if (url.protocol !== "https:" || !url.hostname.endsWith(".turso.io") || url.port ||
        url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("Enter the Turso database URL ending in .turso.io.");
    }
    return url.origin;
  }

  async function execute(origin, token, sql, values = []) {
    const args = values.map((value) => typeof value === "number"
      ? { type: "integer", value: String(value) } : { type: "text", value });
    const response = await fetch(`${databaseOrigin(origin)}/v2/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql, args } }, { type: "close" }] }),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error("Turso refused the token. Reconnect in Settings.");
      throw new Error(`Turso returned HTTP ${response.status}.`);
    }
    const { results } = await response.json();
    const result = results?.[0];
    const rows = result?.response?.result?.rows;
    if (result?.type !== "ok" || !Array.isArray(rows)) {
      throw new Error(result?.error?.message || "Invalid Turso response.");
    }
    return rows.map((row) => row.map((cell) => cell.type === "integer" ? Number(cell.value) : cell.value ?? null));
  }

  async function identity(origin, token) {
    let rows;
    try {
      rows = await execute(origin, token, "SELECT version,library_id,ready FROM flurb_cloud_library WHERE id=1");
    } catch (error) {
      if (/no such table/i.test(error.message)) throw new Error("Publish this library from Flurb Rust first.");
      throw error;
    }
    const [version, id, ready] = rows[0] || [];
    if (version !== 1 || typeof id !== "string" || !id || ready !== 1) {
      throw new Error("Publish this library from Flurb Rust before connecting the web player.");
    }
    return id;
  }

  const cacheKey = (config) => `library:${JSON.stringify([config.origin, config.id])}`;
  const tokenKey = (config) => `token:${cacheKey(config)}`;
  const emptyCache = () => ({ cursor: 0, tracks: new Map(), playlists: new Map(), members: new Map(), modified: new Map(), pending: [], generation: 0 });
  function activeConfig(config) {
    const active = readConfig();
    return active?.origin === config.origin && active.id === config.id;
  }

  async function connect(input, token) {
    const origin = databaseOrigin(input);
    token = token.trim();
    if (!token) throw new Error("Enter a database-scoped Turso token.");
    const id = await identity(origin, token);
    await execute(origin, token, "INSERT INTO flurb_cloud_changes(id,body) SELECT '','' WHERE 0");
    const config = { origin, id };
    await record(tokenKey(config), () => token);
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    return config;
  }

  async function disconnect() {
    const config = readConfig();
    localStorage.removeItem(CONFIG_KEY);
    if (config) await record(tokenKey(config), () => undefined);
  }

  function safePath(path) {
    return typeof path === "string" && path.split("/").every((part) =>
      part && part !== "." && part !== ".." && !part.includes("\u0000"));
  }

  function applyPatch(cache, { kind, key, patch }) {
    if (kind === "metadata") {
      if (key.startsWith(MODIFIED_PREFIX)) {
        const id = key.slice(MODIFIED_PREFIX.length);
        if (patch === null) cache.modified.delete(id);
        else if (Object.hasOwn(patch, "value")) cache.modified.set(id, patch.value);
      }
      return;
    }
    if (kind === "members") {
      if (!cache.playlists.has(key)) return;
      if (patch === null) cache.members.delete(key);
      else if (Array.isArray(patch.tracks) && patch.tracks.every((id) => typeof id === "string")) {
        cache.members.set(key, patch.tracks);
      }
      return;
    }
    const table = kind === "track" ? cache.tracks : kind === "playlist" ? cache.playlists : null;
    if (!table) return;
    if (patch === null) {
      table.delete(key);
      if (kind === "playlist") cache.members.delete(key);
      else for (const [id, members] of cache.members) {
        if (members.includes(key)) cache.members.set(id, members.filter((member) => member !== key));
      }
      return;
    }
    if (Object.hasOwn(patch, "id") && patch.id !== key) throw new Error("Invalid Turso entity identity.");
    if (kind === "track" && Object.hasOwn(patch, "path") && !safePath(patch.path)) throw new Error("Invalid shared audio path.");
    const current = table.get(key);
    const required = kind === "track" ? TRACK_FIELDS : ["name"];
    if (!current && !required.every((field) => Object.hasOwn(patch, field))) return;
    table.set(key, { ...current, ...patch, id: key });
  }

  function applyPage(cache, rows) {
    for (const [seq, id, body] of rows) {
      if (!Number.isSafeInteger(seq) || typeof id !== "string") throw new Error("Invalid Turso change header.");
      if (seq <= cache.cursor) continue;
      const events = JSON.parse(body);
      if (!Array.isArray(events)) throw new Error("Invalid Turso change record.");
      cache.pending = cache.pending.filter((entry) => entry.id !== id);
      // Like Rust, keep fields with unacknowledged local edits protected.
      const pending = new Map();
      for (const entry of cache.pending) for (const event of entry.events) {
        const key = JSON.stringify([event.kind, event.key]);
        if (!pending.has(key)) pending.set(key, []);
        pending.get(key).push(event.patch);
      }
      for (const event of events) {
        if (typeof event.kind !== "string" || typeof event.key !== "string" ||
            (event.patch !== null && (!event.patch || typeof event.patch !== "object" || Array.isArray(event.patch)))) {
          throw new Error("Invalid Turso change event.");
        }
        let patch = event.patch;
        const protectedPatches = pending.get(JSON.stringify([event.kind, event.key]));
        if (patch !== null && protectedPatches) {
          if (protectedPatches.includes(null)) continue;
          patch = { ...patch };
          for (const local of protectedPatches) for (const field of Object.keys(local)) delete patch[field];
          if (!Object.keys(patch).length) continue;
        }
        applyPatch(cache, { ...event, patch });
      }
      cache.cursor = seq;
    }
    cache.generation += 1;
    return cache;
  }

  async function load(config) {
    return await record(cacheKey(config)) || emptyCache();
  }

  async function edit(config, buildEvents) {
    if (!activeConfig(config)) throw new Error("Connect to Turso in Settings first.");
    return record(cacheKey(config), (saved) => {
      const cache = saved || emptyCache();
      const events = buildEvents(cache);
      if (!events.length) return cache;
      for (const event of events) applyPatch(cache, event);
      cache.pending.push({ id: crypto.randomUUID().replaceAll("-", ""), events });
      cache.generation += 1;
      return cache;
    });
  }

  async function sync(config, onUpdate) {
    const run = async () => {
      const token = await record(tokenKey(config));
      if (!token || !activeConfig(config)) return;
      const id = await identity(config.origin, token);
      if (id !== config.id) throw new Error("The Turso library changed. Reconnect in Settings.");
      while (activeConfig(config)) {
        const local = await load(config);
        const outgoing = local.pending.slice(0, 4);
        if (outgoing.length) {
          const placeholders = outgoing.map(() => "(?,?)").join(",");
          await execute(config.origin, token,
            `INSERT INTO flurb_cloud_changes(id,body) VALUES ${placeholders} ON CONFLICT(id) DO NOTHING`,
            outgoing.flatMap((entry) => [entry.id, JSON.stringify(entry.events)]));
        }
        const batch = [];
        let cursor = local.cursor;
        for (let page = 0; page < PULL_PAGES_PER_SAVE && activeConfig(config); page += 1) {
          const rows = await execute(config.origin, token, PULL_SQL, [cursor]);
          if (!rows.length) break;
          const last = rows.at(-1)[0];
          if (!Number.isSafeInteger(last) || last <= cursor) throw new Error("Invalid Turso cursor.");
          cursor = last;
          batch.push(...rows);
        }
        if (!activeConfig(config)) return;
        if (!batch.length) {
          onUpdate(await load(config));
          return;
        }
        const next = await record(cacheKey(config), (saved) => applyPage(saved || emptyCache(), batch));
        if (activeConfig(config)) onUpdate(next);
      }
    };
    if (navigator.locks) return navigator.locks.request(cacheKey(config), run);
    return run();
  }

  window.FlurbCloud = { readConfig, connect, disconnect, load, edit, sync, safePath, applyPage, emptyCache };
})();
