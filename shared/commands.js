const TEMPO_MIN = 20;
const TEMPO_MAX = 999;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const fail = (code, message) => ({ ok: false, error: { code, message } });

function hasOnlyKeys(args, keys) {
  return Object.keys(args).every((k) => keys.includes(k));
}

function index(value, count, label) {
  if (!Number.isInteger(value)) return fail('bad_args', `${label} must be an integer`);
  if (!Number.isInteger(count)) return fail('not_ready', `${label} count is not known yet`);
  if (value < 0 || value >= count) return fail('out_of_range', `${label} ${value} is outside 0..${count - 1}`);
  return null;
}

const table = Object.freeze(Object.assign(Object.create(null), {
  'transport.play': { keys: [], run: () => ({ atoms: ['play'] }) },
  'transport.stop': { keys: [], run: () => ({ atoms: ['stop'] }) },

  'tempo.set': {
    keys: ['bpm'],
    run({ bpm }) {
      if (!isNum(bpm)) return fail('bad_args', 'bpm must be a finite number');
      const v = clamp(bpm, TEMPO_MIN, TEMPO_MAX);
      return { atoms: ['tempo', v], clamped: v !== bpm };
    },
  },

  'track.volume': {
    keys: ['value'],
    run({ value }) {
      if (!isNum(value)) return fail('bad_args', 'value must be a finite number');
      const v = clamp(value, 0, 1);
      return { atoms: ['volume', v], clamped: v !== value };
    },
  },

  'track.select': {
    keys: ['index'],
    run({ index: i }, live) {
      return index(i, live.trackCount, 'track') ?? { atoms: ['select', i] };
    },
  },

  'clip.fire': {
    keys: ['track', 'slot'],
    run({ track, slot }, live) {
      return index(track, live.trackCount, 'track')
        ?? index(slot, live.sceneCount, 'slot')
        ?? { atoms: ['fire', track, slot] };
    },
  },
}));

export const COMMANDS = Object.freeze(Object.keys(table));

export const VERBS = Object.freeze(['play', 'stop', 'tempo', 'volume', 'select', 'fire']);

export function prepareCommand(name, args, live = {}) {
  const def = typeof name === 'string' ? table[name] : undefined;
  if (!def) return fail('unknown_command', `unknown command ${name}`);
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return fail('bad_args', 'args must be an object');
  if (!hasOnlyKeys(args, def.keys)) return fail('bad_args', `${name} accepts only: ${def.keys.join(', ') || 'no arguments'}`);
  const r = def.run(args, live);
  if (r.ok === false) return r;
  return { ok: true, atoms: r.atoms, clamped: Boolean(r.clamped) };
}
