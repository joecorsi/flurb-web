import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const window = {};
runInNewContext(readFileSync(new URL("../playback-queue.js", import.meta.url), "utf8"), { window });
const { create, current, setShuffle, upcoming, step } = window.FlurbPlayback;

test("sequential playback starts at the selected row and walks the list in order", () => {
  const queue = create(["a", "b", "c"], { start: "b" });
  assert.equal(current(queue), "b");
  assert.equal(upcoming(queue, false), "c");
  assert.ok(step(queue, 1, false));
  assert.equal(current(queue), "c");
  assert.equal(step(queue, 1, false), false);
  assert.ok(step(queue, -1, false));
  assert.equal(current(queue), "b");
});

test("shuffle visits each track once and repeat-all prepares the next cycle without an immediate repeat", () => {
  const tracks = ["a", "b", "c", "d"];
  const queue = create(tracks, { shuffle: true });
  const played = [current(queue)];
  while (step(queue, 1, false)) played.push(current(queue));
  assert.deepEqual(played.slice().sort(), tracks);
  const next = upcoming(queue, true);
  assert.notEqual(next, played.at(-1));
  assert.equal(upcoming(queue, true), next);
  assert.ok(step(queue, 1, true));
  assert.equal(current(queue), next);
  const replayed = [next];
  while (step(queue, 1, false)) replayed.push(current(queue));
  assert.deepEqual(replayed.sort(), tracks);
});

test("enabling shuffle during playback keeps the current track and excludes played tracks", () => {
  const queue = create(["a", "b", "c", "d"]);
  assert.ok(step(queue, 1, false));
  setShuffle(queue, true);
  assert.equal(current(queue), "b");
  const unplayed = [];
  while (step(queue, 1, false)) unplayed.push(current(queue));
  assert.deepEqual(unplayed.sort(), ["c", "d"]);
});
