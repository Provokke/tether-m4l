import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../node/src/bridge.js';
import { decode, encode } from '../shared/protocol.js';
import { createFakeTimers } from './helpers/fake-timers.js';
import { createFakeWebSocketClass } from './helpers/fake-websocket.js';

function setup() {
  const clock = createFakeTimers(0);
  const fake = createFakeWebSocketClass();
  const posts = [];
  const outlets = [];
  const bridge = createBridge({
    host: { post: (m) => posts.push(m), outlet: (...a) => outlets.push(a) },
    WebSocket: fake.FakeWebSocket,
    deviceId: 'dev-1',
    version: '1.0.0',
    timers: clock.timers,
    now: clock.now,
    backoff: { random: () => 1 },
  });
  const frames = () => fake.last().sent.map((t) => decode(t).msg);
  const online = () => {
    bridge.handle('config', 'url', 'ws://example.test/device');
    bridge.handle('connect', 1);
    fake.last().serverOpen();
  };
  return { clock, fake, posts, outlets, bridge, frames, online };
}

test('on connect the device says hello, then sends a full snapshot', () => {
  const { bridge, frames, online } = setup();
  bridge.handle('live', 'tempo', 120);
  bridge.handle('live', 'tracks', 'id', 1, 'id', 2);
  online();
  const [hello, state] = frames();
  assert.equal(hello.type, 'hello');
  assert.equal(hello.payload.deviceId, 'dev-1');
  assert.ok(hello.payload.capabilities.includes('clip.fire'));
  assert.equal(state.type, 'state');
  assert.deepEqual(state.payload.state, { tempo: 120, trackCount: 2 });
  assert.deepEqual(frames().map((f) => f.seq), [0, 1]);
});

test('observer updates arrive as coalesced patches, not one frame each', () => {
  const { clock, bridge, frames, online } = setup();
  online();
  for (let i = 1; i <= 50; i++) bridge.handle('live', 'songTime', i);
  bridge.handle('live', 'tempo', 128);
  clock.advance(40);
  const patches = frames().filter((f) => f.type === 'patch');
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].payload.changes, { songTime: 50, tempo: 128 });
});

test('the snapshot is not repeated as a patch', () => {
  const { clock, bridge, frames, online } = setup();
  bridge.handle('live', 'tempo', 120);
  online();
  clock.advance(100);
  assert.equal(frames().filter((f) => f.type === 'patch').length, 0);
});

test('a valid command reaches Max as a short message and is acked', () => {
  const { fake, outlets, bridge, frames, online } = setup();
  bridge.handle('live', 'tracks', 'id', 1, 'id', 2);
  bridge.handle('live', 'scenes', 'id', 5);
  online();
  fake.last().serverSend(encode('cmd', { id: 'c1', name: 'tempo.set', args: { bpm: 128 } }, 0));
  fake.last().serverSend(encode('cmd', { id: 'c2', name: 'clip.fire', args: { track: 1, slot: 0 } }, 1));
  assert.deepEqual(outlets.filter((o) => o[0] === 'cmd'), [['cmd', 'tempo', 128], ['cmd', 'fire', 1, 0]]);
  const acks = frames().filter((f) => f.type === 'ack').map((f) => f.payload);
  assert.deepEqual(acks, [{ id: 'c1', ok: true }, { id: 'c2', ok: true }]);
});

test('an invalid command is refused with a reason and never reaches Max', () => {
  const { fake, outlets, frames, online } = setup();
  online();
  fake.last().serverSend(encode('cmd', { id: 'c1', name: 'track.select', args: { index: 0 } }, 0));
  fake.last().serverSend(encode('cmd', { id: 'c2', name: 'song.delete', args: {} }, 1));
  assert.equal(outlets.filter((o) => o[0] === 'cmd').length, 0);
  const acks = frames().filter((f) => f.type === 'ack').map((f) => [f.payload.id, f.payload.ok, f.payload.error.code]);
  assert.deepEqual(acks, [['c1', false, 'not_ready'], ['c2', false, 'unknown_command']]);
});

test('garbage from the server is posted, not executed', () => {
  const { fake, posts, outlets, online } = setup();
  online();
  fake.last().serverSend('{"v":1,"type":"cmd"}');
  assert.match(posts.join('\n'), /dropped frame/);
  assert.equal(outlets.filter((o) => o[0] === 'cmd').length, 0);
});

test('connecting without a URL explains itself and stays offline', () => {
  const { fake, posts, outlets, bridge } = setup();
  bridge.handle('connect', 1);
  assert.equal(fake.instances.length, 0);
  assert.match(posts.join('\n'), /set a server URL/);
  assert.deepEqual(outlets.at(-1), ['status', 'offline']);
});

test('changing the URL while connected reconnects to the new server', () => {
  const { fake, bridge, online } = setup();
  online();
  bridge.handle('config', 'url', 'ws://other.test/device');
  assert.equal(fake.instances.length, 2);
  assert.equal(fake.last().url, 'ws://other.test/device');
  assert.equal(fake.instances[0].closed.code, 1000);
});

test('textedit output with or without the "text" selector sets the URL', () => {
  const { fake, bridge } = setup();
  bridge.handle('config', 'url', 'text', 'ws://a.test/device');
  bridge.handle('connect', 1);
  assert.equal(fake.last().url, 'ws://a.test/device');
  bridge.handle('config', 'url', 'ws://b.test/device');
  assert.equal(fake.last().url, 'ws://b.test/device');
});

test('status and rtt are forwarded to Max', () => {
  const { clock, fake, outlets, online } = setup();
  online();
  clock.advance(10_000);
  clock.advance(12);
  fake.last().serverPong();
  assert.deepEqual(outlets.filter((o) => o[0] === 'status').map((o) => o[1]), ['connecting', 'online']);
  assert.deepEqual(outlets.filter((o) => o[0] === 'rtt'), [['rtt', 12]]);
});

test('under backpressure a patch is retried with fresher values', () => {
  const { clock, fake, bridge, frames, online } = setup();
  online();
  fake.last().bufferedAmount = 10 << 20;
  bridge.handle('live', 'tempo', 121);
  clock.advance(40);
  bridge.handle('live', 'tempo', 122);
  fake.last().bufferedAmount = 0;
  clock.advance(40);
  const patches = frames().filter((f) => f.type === 'patch').map((f) => f.payload.changes);
  assert.deepEqual(patches, [{ tempo: 122 }]);
});

test('unknown selectors, including prototype names, are ignored', () => {
  const { bridge } = setup();
  bridge.handle('__proto__', 1);
  bridge.handle('constructor');
  bridge.handle('hasOwnProperty');
});
