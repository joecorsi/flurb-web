(() => {
  "use strict";

  const MAX_BYTES = 128 * 1024 * 1024;
  const MAX_ENTRIES = 3000;
  let database;

  function openDatabase() {
    database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open("flurb-artwork", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("covers").createIndex("savedAt", "savedAt");
        request.result.createObjectStore("usage");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return database;
  }

  async function get(key) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction("covers").objectStore("covers").get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function put(key, cover, revision) {
    const bytes = cover?.size || 0;
    if (bytes > MAX_BYTES) return;
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["covers", "usage"], "readwrite");
      const covers = tx.objectStore("covers");
      const usage = tx.objectStore("usage");
      const previous = covers.get(key);
      const totals = usage.get("totals");
      totals.onsuccess = () => {
        const old = previous.result;
        const total = totals.result || { bytes: 0, count: 0 };
        total.bytes += bytes - (old?.cover?.size || 0);
        if (!old) total.count += 1;
        covers.put({ cover, revision, savedAt: Date.now() }, key);
        if (total.bytes <= MAX_BYTES && total.count <= MAX_ENTRIES) {
          usage.put(total, "totals");
          return;
        }
        const cursor = covers.index("savedAt").openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry || (total.bytes <= MAX_BYTES && total.count <= MAX_ENTRIES)) {
            usage.put(total, "totals");
            return;
          }
          total.bytes -= entry.value.cover?.size || 0;
          total.count -= 1;
          entry.delete();
          entry.continue();
        };
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error("Could not save artwork."));
    });
  }

  window.FlurbArtworkCache = { get, put };
})();
