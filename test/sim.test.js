import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createTetherServer } from '../server/src/server.js';
import { createSimDevice } from '../server/sim-device.js';
import { encode, decode } from '../shared/protocol.js';

test('a dashboard command changes the simulated Set and the change comes back as state', async (t) => {
  const server = await createTetherServer({ token: 'tok' });
  t.after(() => server.close());
  const sim = createSimDevice({ url: `ws://127.0.0.1:${server.port}/device`, token: 'tok', deviceId: 'sim-1' });
  t.after(() => sim.stop());

  const ui = new WebSocket(`ws://127.0.0.1:${server.port}/dashboard?token=tok`);
  t.after(() => ui.terminate());
  const state = {};
  const acks = [];
  let seq = 0;
  let deviceUp;
  const up = new Promise((r) => (deviceUp = r));
  ui.on('message', (data) => {
    const { msg } = decode(String(data));
    if (msg.type === 'snapshot') msg.payload.devices.forEach((d) => { Object.assign(state, d.state); deviceUp(); });
    if (msg.type === 'device.up') deviceUp();
    if (msg.type === 'state') Object.assign(state, msg.payload.state);
    if (msg.type === 'patch') Object.assign(state, msg.payload.changes);
    if (msg.type === 'ack') acks.push(msg.payload);
  });
  const until = async (cond, what) => {
    const deadline = Date.now() + 3000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${what} (state ${JSON.stringify(state)})`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  await up;
  await until(() => state.trackCount === 6, 'initial state');
  const cmd = (id, name, args) => ui.send(encode('cmd', { deviceId: 'sim-1', id, name, args }, seq++));

  cmd('t', 'tempo.set', { bpm: 140 });
  await until(() => state.tempo === 140, 'tempo applied');

  cmd('s', 'track.select', { index: 2 });
  await until(() => state['track.index'] === 2 && state['track.name'] === 'Keys', 'track selected');

  cmd('p', 'transport.play', {});
  await until(() => state.playing === true && state.songTime > 0, 'transport running');

  cmd('bad', 'clip.fire', { track: 99, slot: 0 });
  await until(() => acks.length === 4, 'acks');
  assert.deepEqual(acks.map((a) => [a.id, a.ok]), [['t', true], ['s', true], ['p', true], ['bad', false]]);
  assert.equal(acks[3].error.code, 'out_of_range');
});
