import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createBridge } from '../node/src/bridge.js';

const TRACKS = [
  { name: 'Drums', color: 0xff5b5b },
  { name: 'Bass', color: 0xffa94d },
  { name: 'Keys', color: 0xffd43b },
  { name: 'Lead', color: 0x69db7c },
  { name: 'Pad', color: 0x4dabf7 },
  { name: 'Vox', color: 0xb197fc },
];
const SCENES = 8;
const TICK_MS = 50;

export function createSimDevice({
  url,
  token,
  name = 'Simulated Set',
  deviceId = 'sim-device',
  log = () => {},
  tickMs = TICK_MS,
  playing = false,
  WebSocket: WebSocketClass = WebSocket,
}) {
  const set = {
    tempo: 120,
    playing: Boolean(playing),
    songTime: 0,
    selected: 0,
    volumes: TRACKS.map(() => 0.85),
  };

  const observe = (...atoms) => setTimeout(() => bridge.handle('live', ...atoms), 0);

  function reportTrack() {
    const t = TRACKS[set.selected];
    observe('track.path', 'live_set', 'tracks', set.selected);
    observe('track.name', t.name);
    observe('track.color', t.color);
    observe('track.volume', set.volumes[set.selected]);
  }

  const verbs = {
    play() { set.playing = true; observe('playing', 1); },
    stop() { set.playing = false; set.songTime = 0; observe('playing', 0); observe('songTime', 0); },
    tempo(bpm) { set.tempo = bpm; observe('tempo', bpm); },
    volume(v) { set.volumes[set.selected] = v; observe('track.volume', v); },
    select(i) { set.selected = i; reportTrack(); },
    fire(track, slot) {
      log(`fired clip ${track}:${slot}`);
      if (!set.playing) verbs.play();
    },
  };

  const bridge = createBridge({
    deviceId,
    name,
    version: 'sim',
    WebSocket: WebSocketClass,
    host: {
      post: (m) => log(m),
      outlet: (kind, ...atoms) => {
        if (kind === 'cmd' && Object.prototype.hasOwnProperty.call(verbs, atoms[0])) verbs[atoms[0]](...atoms.slice(1));
        else if (kind === 'status') log(`status ${atoms[0]}`);
      },
    },
  });

  bridge.handle('live', 'tempo', set.tempo);
  bridge.handle('live', 'playing', set.playing ? 1 : 0);
  bridge.handle('live', 'songTime', 0);
  bridge.handle('live', 'sigNum', 4);
  bridge.handle('live', 'sigDen', 4);
  bridge.handle('live', 'tracks', ...TRACKS.flatMap((_, i) => ['id', i + 1]));
  bridge.handle('live', 'scenes', ...Array.from({ length: SCENES }, (_, i) => ['id', 100 + i]).flat());
  reportTrack();

  const ticker = setInterval(() => {
    if (!set.playing) {
      bridge.handle('live', 'track.meter', 0);
      return;
    }
    set.songTime += (set.tempo / 60) * (tickMs / 1000);
    bridge.handle('live', 'songTime', Math.round(set.songTime * 1000) / 1000);
    const beatPhase = set.songTime % 1;
    const level = set.volumes[set.selected] * (0.35 + 0.6 * Math.exp(-6 * beatPhase)) * (0.9 + Math.random() * 0.1);
    bridge.handle('live', 'track.meter', Math.round(level * 1000) / 1000);
  }, tickMs);
  ticker.unref?.();

  bridge.handle('config', 'token', token ?? '');
  bridge.handle('config', 'url', url);
  bridge.handle('connect', 1);

  return {
    bridge,
    stop() {
      clearInterval(ticker);
      bridge.stop();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.TETHER_URL ?? 'ws://127.0.0.1:8787/device';
  const sim = createSimDevice({ url, token: process.env.TETHER_TOKEN, log: (l) => console.log(l) });
  console.log(`simulated device connecting to ${url}`);
  process.on('SIGINT', () => {
    sim.stop();
    process.exit(0);
  });
}
