(() => {
  "use strict";

  function shuffled(tracks) {
    const order = [...new Set(tracks)];
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
  }

  function create(tracks, { start = null, shuffle = false } = {}) {
    const startIndex = start == null ? -1 : tracks.indexOf(start);
    const selected = startIndex < 0 ? null : start;
    const order = shuffle
      ? [...(selected ? [selected] : []), ...shuffled(tracks.filter((id) => id !== selected))]
      : tracks;
    const position = shuffle || !selected ? 0 : startIndex;
    return {
      tracks, order, position, shuffle, finished: false, nextCycle: null,
      visited: new Set(order.length ? [order[position]] : [])
    };
  }

  function current(queue) {
    return queue.order[queue.position];
  }

  function setShuffle(queue, enabled) {
    if (enabled === queue.shuffle) return;
    const active = current(queue);
    if (enabled) {
      const history = [...new Set(queue.order.slice(0, queue.position).filter((id) => queue.visited.has(id) && id !== active))];
      queue.order = [...history, active, ...shuffled(queue.tracks.filter((id) => !queue.visited.has(id)))];
      queue.position = history.length;
    } else {
      queue.order = queue.tracks.slice();
      queue.position = queue.order.indexOf(active);
    }
    queue.shuffle = enabled;
    queue.nextCycle = null;
  }

  function upcoming(queue, repeatAll) {
    const next = queue.order[queue.position + 1];
    if (next !== undefined || !repeatAll || !queue.order.length) return next;
    if (!queue.nextCycle) {
      queue.nextCycle = queue.shuffle ? shuffled(queue.tracks) : queue.tracks.slice();
      if (queue.shuffle && queue.nextCycle.length > 1 && queue.nextCycle[0] === current(queue)) {
        queue.nextCycle.push(queue.nextCycle.shift());
      }
    }
    return queue.nextCycle[0];
  }

  function step(queue, direction, repeatAll) {
    if (direction < 0) {
      if (queue.position < 1) return false;
      queue.position -= 1;
    } else if (queue.position + 1 < queue.order.length) {
      queue.position += 1;
    } else {
      if (upcoming(queue, repeatAll) === undefined) return false;
      queue.order = queue.nextCycle;
      queue.nextCycle = null;
      queue.position = 0;
      queue.visited.clear();
    }
    queue.finished = false;
    queue.visited.add(current(queue));
    return true;
  }

  window.FlurbPlayback = { create, current, setShuffle, upcoming, step };
})();
