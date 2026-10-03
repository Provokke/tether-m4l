import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, prepareCommand } from '../shared/commands.js';

const live = { trackCount: 4, sceneCount: 8 };
const ok = (name, args, state = live) => {
  const r = prepareCommand(name, args, state);
  assert.equal(r.ok, true, `${name} ${JSON.stringify(args)} → ${JSON.stringify(r.error)}`);
  return r;
};
const err = (name, args, state = live) => {
  const r = prepareCommand(name, args, state);
  assert.equal(r.ok, false, `${name} ${JSON.stringify(args)} should be rejected`);
  return r.error.code;
};

test('the whitelist is exactly the documented command set', () => {
  assert.deepEqual([...COMMANDS].sort(), [
    'clip.fire', 'tempo.set', 'track.select', 'track.volume', 'transport.play', 'transport.stop',
  ]);
});

test('transport commands take no arguments', () => {
  assert.deepEqual(ok('transport.play', {}).atoms, ['play']);
  assert.deepEqual(ok('transport.stop', {}).atoms, ['stop']);
  assert.equal(err('transport.play', { now: true }), 'bad_args');
});

test('tempo is clamped to the range Live accepts', () => {
  assert.deepEqual(ok('tempo.set', { bpm: 128 }).atoms, ['tempo', 128]);
  const low = ok('tempo.set', { bpm: 5 });
  assert.deepEqual(low.atoms, ['tempo', 20]);
  assert.equal(low.clamped, true);
  assert.deepEqual(ok('tempo.set', { bpm: 5000 }).atoms, ['tempo', 999]);
  assert.equal(ok('tempo.set', { bpm: 120 }).clamped, false);
  for (const bpm of [NaN, Infinity, '120', null, undefined]) assert.equal(err('tempo.set', { bpm }), 'bad_args');
});

test('volume is clamped to 0..1', () => {
  assert.deepEqual(ok('track.volume', { value: 0.85 }).atoms, ['volume', 0.85]);
  assert.deepEqual(ok('track.volume', { value: -1 }).atoms, ['volume', 0]);
  assert.deepEqual(ok('track.volume', { value: 3 }).atoms, ['volume', 1]);
  assert.equal(err('track.volume', { value: 'loud' }), 'bad_args');
});

test('indices are validated against the Set, never clamped', () => {
  assert.deepEqual(ok('track.select', { index: 3 }).atoms, ['select', 3]);
  assert.equal(err('track.select', { index: 4 }), 'out_of_range');
  assert.equal(err('track.select', { index: -1 }), 'out_of_range');
  assert.equal(err('track.select', { index: 1.5 }), 'bad_args');
  assert.deepEqual(ok('clip.fire', { track: 0, slot: 7 }).atoms, ['fire', 0, 7]);
  assert.equal(err('clip.fire', { track: 0, slot: 8 }), 'out_of_range');
  assert.equal(err('clip.fire', { track: 9, slot: 0 }), 'out_of_range');
  assert.equal(err('clip.fire', { track: 0 }), 'bad_args');
});

test('index commands are refused until the Set size is known', () => {
  assert.equal(err('track.select', { index: 0 }, {}), 'not_ready');
  assert.equal(err('clip.fire', { track: 0, slot: 0 }, { trackCount: 2 }), 'not_ready');
});

test('unknown and prototype-shaped command names are refused', () => {
  for (const name of ['launch', '__proto__', 'constructor', 'toString', '']) {
    assert.equal(err(name, {}), 'unknown_command');
  }
});

test('unexpected argument keys are refused', () => {
  assert.equal(err('tempo.set', { bpm: 120, path: 'live_set' }), 'bad_args');
});
