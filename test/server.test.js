import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createTetherServer } from '../server/src/server.js';
import { createTokenBucket } from '../server/src/rate-limit.js';
import { encode, decode } from '../shared/protocol.js';
import { COMMANDS } from '../shared/commands.js';

const TOKEN = 'test-token';

async function start(t, opts = {}) {
  const server = await createTetherServer({ token: TOKEN, ...opts });
  t.after(() => server.close());
  return server;
}

function client(t, port, role, { token = TOKEN, header = true } = {}) {
  const url = `ws://127.0.0.1:${port}/${role}${header ? '' : `?token=${encodeURIComponent(token)}`}`;
  const ws = new WebSocket(url, header ? { headers: { Authorization: `Bearer ${token}` } } : {});
  const frames = [];
  const waiters = [];
  let seq = 0;
  ws.on('message', (data) => {
    const r = decode(String(data));
    frames.push(r.msg);
    for (const w of [...waiters]) {
      if (w.pred(r.msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(r.msg);
      }
    }
  });
  t.after(() => ws.terminate());
  return {
    ws,
    frames,
    opened: new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once('error', reject);
    }),
    closed: new Promise((resolve) => ws.once('close', (code) => resolve(code))),
    send: (type, payload) => ws.send(encode(type, payload, seq++)),
    next(pred, ms = 2000) {
      const found = frames.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error('timed out waiting for frame')), ms).unref();
      });
    },
  };
}

const type = (t) => (m) => m.type === t;
const hello = (deviceId = 'dev-1') => ({ deviceId, name: 'Tether', version: '1.0.0', capabilities: [...COMMANDS] });

async function device(t, port, id = 'dev-1') {
  const d = client(t, port, 'device');
  await d.opened;
  d.send('hello', hello(id));
  await d.next(type('welcome'));
  return d;
}

test('token bucket allows a burst then refills over time', () => {
  let now = 0;
  const b = createTokenBucket({ capacity: 3, refillPerSec: 2, now: () => now });
  assert.deepEqual([b.take(), b.take(), b.take(), b.take()], [true, true, true, false]);
  now = 500;
  assert.deepEqual([b.take(), b.take()], [true, false]);
});

test('upgrades without the right token are refused with 401; unknown paths with 404', async (t) => {
  const { port } = await start(t);
  await assert.rejects(client(t, port, 'device', { token: 'wrong' }).opened, /HTTP 401/);
  await assert.rejects(client(t, port, 'dashboard', { token: '' , header: false }).opened, /HTTP 401/);
  await assert.rejects(client(t, port, 'admin').opened, /HTTP 404/);
  await client(t, port, 'dashboard', { header: false }).opened;
});

test('a device that does not say hello first is disconnected', async (t) => {
  const { port } = await start(t);
  const d = client(t, port, 'device');
  await d.opened;
  d.send('patch', { changes: { tempo: 1 } });
  assert.equal(await d.closed, 4001);
});

test('dashboards see devices come and go, with state, including late joiners', async (t) => {
  const { port } = await start(t);
  const early = client(t, port, 'dashboard');
  await early.next(type('snapshot'));
  const d = await device(t, port);
  const up = await early.next(type('device.up'));
  assert.equal(up.payload.deviceId, 'dev-1');

  d.send('state', { state: { tempo: 120, trackCount: 3 } });
  await early.next(type('state'));
  d.send('patch', { changes: { tempo: 124 } });
  const patch = await early.next(type('patch'));
  assert.deepEqual(patch.payload, { deviceId: 'dev-1', changes: { tempo: 124 } });

  const late = client(t, port, 'dashboard');
  const snap = await late.next(type('snapshot'));
  assert.equal(snap.payload.devices.length, 1);
  assert.deepEqual({ ...snap.payload.devices[0].state }, { tempo: 124, trackCount: 3 });

  d.ws.close();
  const down = await early.next(type('device.down'));
  assert.equal(down.payload.deviceId, 'dev-1');
});

test('a command is forwarded with a server id and its ack returns only to the sender', async (t) => {
  const { port } = await start(t);
  const d = await device(t, port);
  const sender = client(t, port, 'dashboard');
  const bystander = client(t, port, 'dashboard');
  await sender.next(type('snapshot'));
  await bystander.next(type('snapshot'));

  sender.send('cmd', { deviceId: 'dev-1', id: 'ui-7', name: 'tempo.set', args: { bpm: 130 } });
  const cmd = await d.next(type('cmd'));
  assert.match(cmd.payload.id, /^s\d+$/);
  assert.equal(cmd.payload.deviceId, undefined, 'the device is not told its own id');
  assert.deepEqual(cmd.payload.args, { bpm: 130 });

  d.send('ack', { id: cmd.payload.id, ok: true });
  const ack = await sender.next(type('ack'));
  assert.deepEqual(ack.payload, { id: 'ui-7', ok: true, deviceId: 'dev-1' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(bystander.frames.filter(type('ack')).length, 0);
});

test('commands to unknown devices or outside the whitelist are refused by the server', async (t) => {
  const { port } = await start(t);
  const d = await device(t, port);
  const ui = client(t, port, 'dashboard');
  await ui.opened;
  ui.send('cmd', { deviceId: 'ghost', id: 'a', name: 'tempo.set', args: {} });
  ui.send('cmd', { deviceId: 'dev-1', id: 'b', name: 'song.delete', args: {} });
  const a = await ui.next((m) => m.type === 'ack' && m.payload.id === 'a');
  const b = await ui.next((m) => m.type === 'ack' && m.payload.id === 'b');
  assert.equal(a.payload.error.code, 'unknown_device');
  assert.equal(b.payload.error.code, 'unknown_command');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(d.frames.filter(type('cmd')).length, 0);
});

test('pending commands fail when the device disconnects or never answers', async (t) => {
  const { port } = await start(t, { commandTimeoutMs: 100 });
  const d = await device(t, port);
  const ui = client(t, port, 'dashboard');
  await ui.opened;

  ui.send('cmd', { deviceId: 'dev-1', id: 'slow', name: 'transport.play', args: {} });
  const timeout = await ui.next((m) => m.type === 'ack' && m.payload.id === 'slow');
  assert.equal(timeout.payload.error.code, 'timeout');

  ui.send('cmd', { deviceId: 'dev-1', id: 'gone', name: 'transport.stop', args: {} });
  await d.next((m) => m.type === 'cmd' && m.payload.name === 'transport.stop');
  d.ws.close();
  const gone = await ui.next((m) => m.type === 'ack' && m.payload.id === 'gone');
  assert.equal(gone.payload.error.code, 'device_gone');
});

test('a reconnecting device replaces its previous socket', async (t) => {
  const { port } = await start(t);
  const first = await device(t, port);
  const second = await device(t, port);
  assert.equal(await first.closed, 4000);
  const ui = client(t, port, 'dashboard');
  const snap = await ui.next(type('snapshot'));
  assert.equal(snap.payload.devices.length, 1);
  assert.equal(second.ws.readyState, WebSocket.OPEN);
});

test('invalid frames get a specific error; floods get rate limited', async (t) => {
  const { port } = await start(t, { rate: { capacity: 5, refillPerSec: 0.001 } });
  const ui = client(t, port, 'dashboard');
  await ui.opened;
  ui.ws.send('{"v":1,"type":"cmd","seq":0,"ts":1,"payload":{}}');
  const bad = await ui.next(type('error'));
  assert.equal(bad.payload.code, 'bad_payload');
  for (let i = 0; i < 10; i++) ui.ws.send('{}');
  const limited = await ui.next((m) => m.type === 'error' && m.payload.code === 'rate_limited');
  assert.ok(limited);
});

test('frames above the size limit close the socket', async (t) => {
  const { port } = await start(t, { maxBytes: 1024 });
  const ui = client(t, port, 'dashboard');
  await ui.opened;
  ui.ws.send('x'.repeat(4096));
  assert.equal(await ui.closed, 1009);
});

test('the static dashboard is served, and path traversal is not', async (t) => {
  const { port } = await start(t, { publicDir: fileURLToPath(new URL('../server/public', import.meta.url)) });
  const index = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
  const traversal = await fetch(`http://127.0.0.1:${port}/..%2f..%2fpackage.json`);
  assert.ok([403, 404].includes(traversal.status), `got ${traversal.status}`);
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.deepEqual(health, { ok: true, devices: 0, dashboards: 0 });
});
