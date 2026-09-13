import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createBridge } from '../node/src/bridge.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

function createFakeLive(port, token) {
  const set = { tempo: 120, playing: false, songTime: 0, tracks: 4, scenes: 8, sel: ['track', 0], volume: 0.85, fired: [] };
  let bridge = null;
  let gen = 0;
  const live = (...a) => setTimeout(() => bridge?.handle('live', ...a), 5);
  const ids = (n, base) => Array.from({ length: n }, (_, i) => ['id', base + i]).flat();

  const reportTrack = () => {
    const [kind, i] = set.sel;
    const p = kind === 'track' ? ['live_set', 'tracks', i] : kind === 'return' ? ['live_set', 'return_tracks', 0] : ['live_set', 'master_track'];
    live('track.path', 'path', ...p);
    live('track.name', kind === 'track' ? `Track ${i + 1}` : kind);
    live('track.volume', set.volume);
  };

  const verbs = {
    tempo: (v) => { set.tempo = v; live('tempo', v); },
    play: () => { set.playing = true; live('playing', 1); },
    stop: () => { set.playing = false; live('playing', 0); },
    volume: (v) => { set.volume = v; live('track.volume', v); },
    select: (i) => { set.sel = ['track', i]; reportTrack(); },
    fire: (t, s) => set.fired.push([t, s]),
  };

  const ticker = setInterval(() => {
    if (!bridge || !set.playing) return;
    set.songTime += 0.1;
    bridge.handle('live', 'songTime', Math.round(set.songTime * 100) / 100);
    bridge.handle('live', 'track.meter', 0.5);
  }, 50);

  return {
    set,
    actions: {
      '1. Device loads': () => {
        gen++;
        bridge = createBridge({
          deviceId: `fake-live-${gen}`, version: '1.0.0', WebSocket,
          host: { post: () => {}, outlet: (kind, verb, ...a) => kind === 'cmd' && verbs[verb]?.(...a) },
        });
        bridge.handle('live', 'tempo', set.tempo);
        bridge.handle('live', 'playing', set.playing ? 1 : 0);
        bridge.handle('live', 'songTime', set.songTime);
        bridge.handle('live', 'tracks', ...ids(set.tracks, 1));
        bridge.handle('live', 'scenes', ...ids(set.scenes, 100));
        reportTrack();
        bridge.handle('config', 'url', 'text', `ws://127.0.0.1:${port}/device`);
        bridge.handle('config', 'token', 'text', token);
        bridge.handle('connect', 1);
      },
      '3. Tempo change': () => verbs.tempo(97),
      '4. Transport': () => verbs.play(),
      '5. Selection follows': () => { set.sel = ['track', 2]; reportTrack(); },
      '5.1. Return': () => { set.sel = ['return', 0]; reportTrack(); },
      '5.2. Master': () => { set.sel = ['master', 0]; reportTrack(); },
      '5.3. Back': () => { set.sel = ['track', 0]; reportTrack(); },
      '11. Track list': () => { set.tracks++; live('tracks', ...ids(set.tracks, 1)); },
      '14. Settings persist': function reopen() {
        bridge.stop();
        setTimeout(() => this['1. Device loads'](), 1000);
      },
    },
    stop() {
      clearInterval(ticker);
      bridge?.stop();
    },
  };
}

test('the guided Live verifier passes against a scripted fake Live', { timeout: 120_000 }, async (t) => {
  const port = await freePort();
  const token = 'verifier-self-test';
  const dir = await mkdtemp(path.join(tmpdir(), 'tether-lv-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const report = path.join(dir, 'report.md');
  const fake = createFakeLive(port, token);
  t.after(() => fake.stop());

  const child = spawn(process.execPath, ['tools/live-verify.mjs', '--port', String(port), '--token', token, '--report', report], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());

  const answers = [
    ['Live version', 'self-test'],
    ['Max version', 'self-test'],
    ['1.1. Max console', 'y'],
    ['Press Enter when ready', ''],
    ['Did that clip launch', 'y'],
    ['12. No notification', 'y'],
    ['15. Stored-only', 'y'],
    ['16. Frozen', 's'],
  ];
  let out = '';
  const fired = new Set();
  child.stdout.on('data', (d) => {
    out += String(d);
    for (const [key, action] of Object.entries(fake.actions)) {
      if (!fired.has(key) && out.includes(key)) {
        fired.add(key);
        setTimeout(() => action.call(fake.actions), 300);
      }
    }
    for (const [prompt, reply] of answers) {
      if (!fired.has(prompt) && out.includes(prompt)) {
        fired.add(prompt);
        setTimeout(() => child.stdin.write(`${reply}\n`), 150);
      }
    }
  });
  let errOut = '';
  child.stderr.on('data', (d) => (errOut += String(d)));

  const code = await new Promise((resolve) => child.on('exit', resolve));
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(code, 0, `verifier exited ${code}\n${plain.slice(-2000)}\n${errOut}`);
  assert.match(plain, /(\d+) passed, 0 failed, 1 skipped/);
  assert.equal(fake.set.fired.length, 1, 'clip.fire reached the fake Live exactly once');
  const [firedTrack, firedSlot] = fake.set.fired[0];
  assert.equal(firedSlot, 0);
  assert.match(plain, new RegExp(`Put a clip in track ${firedTrack + 1}, scene 1`), 'the instruction named the track that was fired');

  const md = await readFile(report, 'utf8');
  assert.match(md, /Live: self-test/);
  assert.doesNotMatch(md, /\*\*FAIL\*\*/);
  for (const check of ['Reconnects by itself after a server restart', 'Settings persist in the Set', 'Selection follows']) {
    assert.match(md, new RegExp(`${check}[^\\n]*\\| pass \\|`));
  }
});
