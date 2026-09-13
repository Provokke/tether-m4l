import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextDelay } from '../node/src/backoff.js';
import { createConnection } from '../node/src/connection.js';
import { createFakeTimers } from './helpers/fake-timers.js';
import { createFakeWebSocketClass } from './helpers/fake-websocket.js';

test('backoff ceiling doubles from the base and stops at the cap', () => {
  for (let attempt = 0; attempt <= 40; attempt++) {
    const ceiling = Math.min(30_000, 500 * 2 ** attempt);
    assert.equal(nextDelay(attempt, { random: () => 1 }), ceiling, `attempt ${attempt}`);
    assert.equal(nextDelay(attempt, { random: () => 0 }), 100, 'floor');
    const mid = nextDelay(attempt, { random: () => 0.5 });
    assert.ok(mid >= 100 && mid <= ceiling);
  }
});

function setup(overrides = {}) {
  const clock = createFakeTimers(0);
  const fake = createFakeWebSocketClass();
  const events = { status: [], messages: [], rtt: [], opens: 0 };
  const conn = createConnection({
    url: 'ws://example.test/device',
    token: 'secret',
    WebSocket: fake.FakeWebSocket,
    timers: clock.timers,
    now: clock.now,
    heartbeatMs: 1000,
    backoff: { random: () => 1 },
    onOpen: () => events.opens++,
    onMessage: (m) => events.messages.push(m),
    onStatus: (s) => events.status.push(s),
    onRtt: (ms) => events.rtt.push(ms),
    ...overrides,
  });
  return { clock, fake, events, conn };
}

test('connects with a bearer token and reports status transitions', () => {
  const { fake, events, conn } = setup();
  conn.start();
  assert.equal(fake.instances.length, 1);
  assert.deepEqual(fake.last().options.headers, { Authorization: 'Bearer secret' });
  fake.last().serverOpen();
  assert.deepEqual(events.status, ['connecting', 'online']);
  assert.equal(events.opens, 1);
  assert.equal(conn.status, 'online');
});

test('reconnects with growing delays and resets after a successful open', () => {
  const { clock, fake, conn } = setup();
  conn.start();
  fake.last().serverClose();
  clock.advance(499);
  assert.equal(fake.instances.length, 1, 'first retry waits 500 ms');
  clock.advance(1);
  assert.equal(fake.instances.length, 2);
  fake.last().serverClose();
  clock.advance(999);
  assert.equal(fake.instances.length, 2, 'second retry waits 1000 ms');
  clock.advance(1);
  assert.equal(fake.instances.length, 3);
  fake.last().serverOpen();
  fake.last().serverClose();
  clock.advance(500);
  assert.equal(fake.instances.length, 4, 'attempt counter reset by the open');
});

test('stop cancels a pending reconnect and closes cleanly', () => {
  const { clock, fake, events, conn } = setup();
  conn.start();
  fake.last().serverOpen();
  fake.last().serverClose();
  conn.stop();
  clock.advance(60_000);
  assert.equal(fake.instances.length, 1);
  assert.equal(events.status.at(-1), 'offline');

  conn.start();
  fake.last().serverOpen();
  conn.stop();
  assert.deepEqual(fake.last().closed, { code: 1000, reason: 'client stopping' });
  clock.advance(60_000);
  assert.equal(fake.instances.length, 2, 'a deliberate close does not reconnect');
});

test('a late close from a replaced socket does not start a second loop', () => {
  const { clock, fake, conn } = setup();
  conn.start();
  const first = fake.last();
  first.serverOpen();
  conn.stop();
  conn.start();
  first.emit('close', 1006);
  clock.advance(60_000);
  assert.equal(fake.instances.length, 2);
});

test('send writes only when open and below the high-water mark', () => {
  const { fake, conn } = setup({ highWaterBytes: 100 });
  assert.equal(conn.send('x'), false, 'not started');
  conn.start();
  assert.equal(conn.send('x'), false, 'still connecting');
  fake.last().serverOpen();
  assert.equal(conn.send('a'), true);
  fake.last().bufferedAmount = 101;
  assert.equal(conn.send('b'), false, 'backpressure');
  fake.last().bufferedAmount = 0;
  assert.equal(conn.send('c'), true);
  assert.deepEqual(fake.last().sent, ['a', 'c']);
});

test('heartbeat measures RTT and terminates after two missed pongs', () => {
  const { clock, fake, events, conn } = setup();
  conn.start();
  const ws = fake.last();
  ws.serverOpen();
  clock.advance(1000);
  assert.equal(ws.pings, 1);
  clock.advance(42);
  ws.serverPong();
  assert.deepEqual(events.rtt, [42]);
  clock.advance(958);
  clock.advance(1000);
  assert.equal(ws.terminated, false);
  clock.advance(1000);
  assert.equal(ws.terminated, true);
  clock.advance(500);
  assert.equal(fake.instances.length, 2, 'reconnects after the heartbeat loss');
});

test('binary frames are ignored; text frames are delivered', () => {
  const { fake, events, conn } = setup();
  conn.start();
  fake.last().serverOpen();
  fake.last().emit('message', Buffer.from([1, 2]), true);
  fake.last().serverSend('{"hi":1}');
  assert.deepEqual(events.messages, ['{"hi":1}']);
});

test('an invalid URL stops instead of retrying forever', () => {
  const logs = [];
  const { clock, fake, events, conn } = setup({ url: 'http://nope', log: (l) => logs.push(l) });
  conn.start();
  clock.advance(60_000);
  assert.equal(fake.instances.length, 0);
  assert.equal(events.status.at(-1), 'offline');
  assert.match(logs.join('\n'), /cannot connect/);
});
