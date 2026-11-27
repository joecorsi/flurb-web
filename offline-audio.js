(() => {
  "use strict";

  const preference = "flurb.offlineRecentAudio";
  let database;
  function openDatabase() {
    database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open("flurb-offline-audio", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("tracks");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((error) => {
      database = null;
      throw error;
    });
    return database;
  }

  async function transaction(mode, run) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("tracks", mode);
      const request = run(tx.objectStore("tracks"));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(request.error || tx.error);
    });
  }

  const get = (key) => transaction("readonly", (tracks) => tracks.get(key));
  const put = (key, blob) => transaction("readwrite", (tracks) => tracks.put(blob, key));

  async function keep(allowed) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const saved = new Set();
      const tx = db.transaction("tracks", "readwrite");
      const tracks = tx.objectStore("tracks");
      const request = tracks.openKeyCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (allowed.has(cursor.key)) saved.add(cursor.key);
        else tracks.delete(cursor.primaryKey);
        cursor.continue();
      };
      tx.oncomplete = () => resolve(saved);
      tx.onabort = () => reject(tx.error);
    });
  }

  window.FlurbOfflineAudio = { preference, get, put, keep };
})();
