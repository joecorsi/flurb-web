"use strict";

const CACHE = "flurb-shell-v5";
const FILES = ["./index.html", "./settings.html", "./app.js", "./settings.js", "./turso-sync.js", "./styles.css", "./favicon.png", "./apple-touch-icon.png"];
const ICONS = "https://unpkg.com/lucide@0.468.0/dist/umd/lucide.min.js";
const scope = new URL(self.registration.scope);
const paths = new Set(FILES.map((file) => new URL(file, scope).pathname));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then(async (cache) => {
    await cache.addAll(FILES);
    try { await cache.add(new Request(ICONS, { mode: "cors" })); } catch (_) {}
  }));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((key) => key.startsWith("flurb-shell-") && key !== CACHE).map((key) => caches.delete(key)))));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.href !== ICONS && (url.origin !== scope.origin || (!paths.has(url.pathname) && url.pathname !== scope.pathname))) return;
  const fallback = url.pathname === scope.pathname ? new URL("./index.html", scope) : url;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (response.ok) {
        // Store the shell route without query parameters, including OAuth callbacks.
        const key = new URL(fallback);
        key.search = "";
        await cache.put(key, response.clone()).catch(() => {});
      }
      return response;
    } catch (error) {
      const saved = await cache.match(fallback, { ignoreSearch: true });
      if (saved) return saved;
      throw error;
    }
  })());
});
