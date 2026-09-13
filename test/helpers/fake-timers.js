export function createFakeTimers(start = 0) {
  let now = start;
  let nextId = 1;
  const pending = new Map();

  const timers = {
    setTimeout(fn, ms = 0) {
      const id = nextId++;
      pending.set(id, { at: now + Math.max(0, ms), fn, every: 0 });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    setInterval(fn, ms) {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn, every: ms });
      return id;
    },
    clearInterval(id) {
      pending.delete(id);
    },
  };

  function advance(ms) {
    const until = now + ms;
    for (;;) {
      let dueId = null;
      let due = null;
      for (const [id, t] of pending) {
        if (t.at <= until && (due === null || t.at < due.at)) {
          dueId = id;
          due = t;
        }
      }
      if (!due) break;
      now = due.at;
      if (due.every) due.at += due.every;
      else pending.delete(dueId);
      due.fn();
    }
    now = until;
  }

  return { timers, now: () => now, advance, pendingCount: () => pending.size };
}
