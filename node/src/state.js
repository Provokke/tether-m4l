export function createState({ timers = globalThis, now = Date.now, intervalMs = 33, onFlush }) {
  const values = Object.create(null);
  const sent = Object.create(null);
  const dirty = new Set();
  let timer = null;
  let lastFlush = -Infinity;

  function flush() {
    timer = null;
    const changes = {};
    for (const key of dirty) {
      if (!Object.is(values[key], sent[key]) || !(key in sent)) {
        changes[key] = values[key];
        sent[key] = values[key];
      }
    }
    dirty.clear();
    if (Object.keys(changes).length === 0) return;
    lastFlush = now();
    onFlush(changes);
  }

  function schedule() {
    if (timer !== null) return;
    const wait = Math.max(0, lastFlush + intervalMs - now());
    timer = timers.setTimeout(flush, wait);
  }

  return {
    set(key, value) {
      if (Object.is(values[key], value) && key in values) return;
      values[key] = value;
      dirty.add(key);
      schedule();
    },
    get: (key) => values[key],
    snapshot: () => ({ ...values }),
    markAllSent() {
      for (const key of Object.keys(values)) sent[key] = values[key];
      dirty.clear();
    },
    markDirty(keys) {
      for (const key of keys) {
        if (!(key in values)) continue;
        delete sent[key];
        dirty.add(key);
      }
      if (dirty.size) schedule();
    },
    flushNow() {
      if (timer !== null) timers.clearTimeout(timer);
      flush();
    },
  };
}
