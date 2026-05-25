const ECHO = Object.freeze(Object.assign(Object.create(null), {
  tempo: 'tempo',
  playing: 'is_playing',
  songTime: 'current_song_time',
  sigNum: 'signature_numerator',
  sigDen: 'signature_denominator',
  tracks: 'tracks',
  scenes: 'scenes',
  'track.name': 'name',
  'track.color': 'color',
  'track.volume': 'value',
  'track.meter': 'output_meter_level',
  'track.path': 'path',
}));

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const int = (x) => (Number.isInteger(x) ? x : null);

function countIds(atoms) {
  let n = 0;
  for (let i = 0; i < atoms.length - 1; i++) {
    if (atoms[i] === 'id' && typeof atoms[i + 1] === 'number' && atoms[i + 1] !== 0) n++;
  }
  return n;
}

function parsePath(atoms) {
  const parts = atoms.flatMap((a) => String(a).split(/\s+/)).filter(Boolean);
  if (parts[0] !== 'live_set') return null;
  if (parts[1] === 'tracks' && /^\d+$/.test(parts[2] ?? '')) {
    return [{ key: 'track.index', value: Number(parts[2]) }, { key: 'track.kind', value: 'track' }];
  }
  if (parts[1] === 'return_tracks') return [{ key: 'track.index', value: null }, { key: 'track.kind', value: 'return' }];
  if (parts[1] === 'master_track') return [{ key: 'track.index', value: null }, { key: 'track.kind', value: 'master' }];
  return null;
}

const scalar = (key, convert) => (v) => {
  const value = convert(v[0]);
  return value === null || v.length !== 1 ? null : [{ key, value }];
};

const parsers = Object.freeze(Object.assign(Object.create(null), {
  tempo: scalar('tempo', num),
  songTime: scalar('songTime', num),
  sigNum: scalar('sigNum', int),
  sigDen: scalar('sigDen', int),
  playing: scalar('playing', (x) => (x === 0 || x === 1 ? x === 1 : null)),
  'track.volume': scalar('track.volume', num),
  'track.meter': scalar('track.meter', num),
  'track.color': scalar('track.color', int),
  'track.name': (v) => (v.length ? [{ key: 'track.name', value: v.map(String).join(' ') }] : null),
  tracks: (v) => [{ key: 'trackCount', value: countIds(v) }],
  scenes: (v) => [{ key: 'sceneCount', value: countIds(v) }],
  'track.path': (v) => parsePath(v),
}));

export const LIVE_KEYS = Object.freeze(Object.keys(parsers));

export function parseLive(atoms) {
  if (!Array.isArray(atoms) || typeof atoms[0] !== 'string') return null;
  const [key, ...rest] = atoms;
  const parse = parsers[key];
  if (!parse) return null;
  const values = rest[0] === ECHO[key] ? rest.slice(1) : rest;
  return parse(values);
}
