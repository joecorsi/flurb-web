import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const context = { window: {}, Map, Object, JSON };
runInNewContext(readFileSync(new URL("../turso-sync.js", import.meta.url), "utf8"), context);
const { applyPage, emptyCache } = context.window.FlurbCloud;
const change = (kind, key, patch) => ({ kind, key, patch });
const row = (seq, id, events) => [seq, id, JSON.stringify(events)];
const track = { title: "Seed", artist: "Artist", album: "Album", genre: "", path: "Artist/Album/file.wav", duration: 42, favorite: 0 };
const seed = () => applyPage(emptyCache(), [row(1, "rust-seed", [
  change("track", "song", track),
  change("playlist", "mix", { name: "Mix", smart_rule: null }),
  change("members", "mix", { tracks: ["song"] })
])]);

test("pending local fields survive independent incoming edits and are acknowledged by change ID", () => {
  const cache = seed();
  cache.tracks.get("song").favorite = 1;
  cache.pending.push({ id: "local-favorite", events: [change("track", "song", { favorite: 1 })] });

  applyPage(cache, [row(2, "rust-edit", [change("track", "song", { title: "Renamed", favorite: 0 })])]);
  assert.equal(cache.tracks.get("song").title, "Renamed");
  assert.equal(cache.tracks.get("song").favorite, 1);

  const acknowledged = row(3, "local-favorite", cache.pending[0].events);
  applyPage(cache, [acknowledged, acknowledged]);
  assert.equal(cache.pending.length, 0);
  assert.equal(cache.tracks.get("song").favorite, 1);
  assert.equal(cache.cursor, 3);

  applyPage(cache, [row(4, "rust-favorite", [change("track", "song", { favorite: 0 })])]);
  assert.equal(cache.tracks.get("song").favorite, 0);
});

test("deletion beats stale partial edits and drops deleted tracks from membership", () => {
  const cache = seed();
  cache.pending.push({ id: "offline", events: [change("track", "song", { favorite: 1 })] });
  applyPage(cache, [
    row(2, "rust-delete", [change("track", "song", null)]),
    row(3, "offline", [change("track", "song", { favorite: 1 })])
  ]);
  assert.equal(cache.tracks.has("song"), false);
  assert.equal(cache.members.get("mix").length, 0);
  assert.equal(cache.pending.length, 0);
});

test("playlist membership is an ordered document and unrelated Rust metadata advances the cursor", () => {
  const cache = seed();
  cache.pending.push({ id: "web-order", events: [change("members", "mix", { tracks: ["song", "two"] })] });
  cache.members.set("mix", ["song", "two"]);
  applyPage(cache, [
    row(2, "rust-order", [change("members", "mix", { tracks: ["two", "song"] })]),
    row(3, "editor-inventory", [change("metadata", "editor_scan_fixture", { value: "ignored" })])
  ]);
  assert.deepEqual(Array.from(cache.members.get("mix")), ["song", "two"]);
  assert.equal(cache.cursor, 3);
  applyPage(cache, [row(4, "web-order", cache.pending[0].events),
    row(5, "rust-latest", [change("members", "mix", { tracks: ["two", "song"] })])]);
  assert.deepEqual(Array.from(cache.members.get("mix")), ["two", "song"]);
});

test("catalog paths are relative to the receiver's Dropbox root", () => {
  assert.equal(context.window.FlurbCloud.safePath("Artist/Album/Tune.wav"), true);
  assert.equal(context.window.FlurbCloud.safePath("/absolute.wav"), false);
  assert.equal(context.window.FlurbCloud.safePath("Artist/../outside.wav"), false);
  assert.throws(() => applyPage(emptyCache(), [
    row(1, "invalid", [change("track", "song", { ...track, path: "../outside.wav" })])
  ]), /Invalid shared audio path/);
});

test("the editor inventory head signals artwork refresh without retaining its chunks", () => {
  const cache = seed();
  applyPage(cache, [
    row(2, "rust-inventory-chunk", [change("metadata", "library_editor_scan_v1:chunk:one", { value: "inventory bytes" })]),
    row(3, "rust-inventory-head", [change("metadata", "library_editor_scan_v1:head", { value: "inventory version" })])
  ]);
  assert.equal(cache.artworkInventory, "inventory version");
  assert.equal(cache.modified.size, 0);
  assert.equal(cache.cursor, 3);
});
