"use strict";

const CACHE = "flurb-shell-v33";
const FILES = [
  "./index.html", "./settings.html", "./app.js", "./settings.js", "./turso-sync.js",
  "./artwork-cache.js", "./offline-audio.js", "./playback-queue.js", "./styles.css",
  "./favicon.png", "./apple-touch-icon.png"
];
const scope = new URL(self.registration.scope);
const shell = new Map(FILES.map((file) => {
  const url = new URL(file, scope);
  return [url.pathname, url.href];
}));
const index = new URL("./index.html", scope).href;
const oauthParameters = ["code", "state", "error", "error_description"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll([...shell.values()].map((url) => new Request(url, { cache: "reload" })));
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("flurb-shell-") && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin || oauthParameters.some((parameter) => url.searchParams.has(parameter))) return;
  const key = url.pathname === scope.pathname && request.mode === "navigate" ? index : shell.get(url.pathname);
  if (!key) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE).catch(() => null);
    const saved = await cache?.match(key).catch(() => null);
    if (saved) return saved;

    // Repair a missing shell entry when the network is available.
    const response = await fetch(key);
    if (response.ok && cache) await cache.put(key, response.clone()).catch(() => {});
    return response;
  })());
});
