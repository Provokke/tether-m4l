import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLive } from '../node/src/live-input.js';
import { createState } from '../node/src/state.js';
import { createFakeTimers } from './helpers/fake-timers.js';

const one = (atoms) => {
  const r = parseLive(atoms);
  assert.ok(Array.isArray(r) && r.length === 1, `expected one update for ${atoms.join(' ')}, got ${JSON.stringify(r)}`);
  return r[0];
};

test('scalar observers parse with or without the property name echoed', () => {
  assert.deepEqual(one(['tempo', 120.5]), { key: 'tempo', value: 120.5 });
  assert.deepEqual(one(['tempo', 'tempo', 99]), { key: 'tempo', value: 99 });
  assert.deepEqual(one(['playing', 1]), { key: 'playing', value: true });
  assert.deepEqual(one(['playing', 'is_playing', 0]), { key: 'playing', value: false });
  assert.deepEqual(one(['songTime', 'current_song_time', 16.25]), { key: 'songTime', value: 16.25 });
  assert.deepEqual(one(['sigNum', 7]), { key: 'sigNum', value: 7 });
  assert.deepEqual(one(['sigDen', 'signature_denominator', 8]), { key: 'sigDen', value: 8 });
  assert.deepEqual(one(['track.volume', 'value', 0.85]), { key: 'track.volume', value: 0.85 });
  assert.deepEqual(one(['track.meter', 'output_meter_level', 0.3]), { key: 'track.meter', value: 0.3 });
  assert.deepEqual(one(['track.color', 'color', 16711680]), { key: 'track.color', value: 16711680 });
});

test('names keep their spaces whether Max split them or not', () => {
  assert.deepEqual(one(['track.name', 'name', 'Bass Line']), { key: 'track.name', value: 'Bass Line' });
  assert.deepEqual(one(['track.name', 'Bass', 'Line']), { key: 'track.name', value: 'Bass Line' });
  assert.deepEqual(one(['track.name', 42]), { key: 'track.name', value: '42' });
});

test('list children become counts, ignoring id 0', () => {
  assert.deepEqual(one(['tracks', 'tracks', 'id', 3, 'id', 4, 'id', 9]), { key: 'trackCount', value: 3 });
  assert.deepEqual(one(['scenes', 'id', 11]), { key: 'sceneCount', value: 1 });
  assert.deepEqual(one(['tracks', 'id', 0]), { key: 'trackCount', value: 0 });
  assert.deepEqual(one(['tracks']), { key: 'trackCount', value: 0 });
});

test('a canonical path yields the selected track index and kind', () => {
  assert.deepEqual(parseLive(['track.path', 'path', 'live_set', 'tracks', 2]), [
    { key: 'track.index', value: 2 }, { key: 'track.kind', value: 'track' },
  ]);
  assert.deepEqual(parseLive(['track.path', 'live_set tracks 5']), [
    { key: 'track.index', value: 5 }, { key: 'track.kind', value: 'track' },
  ]);
  assert.deepEqual(parseLive(['track.path', 'path', 'live_set', 'return_tracks', 1]), [
    { key: 'track.index', value: null }, { key: 'track.kind', value: 'return' },
  ]);
  assert.deepEqual(parseLive(['track.path', 'live_set', 'master_track']), [
    { key: 'track.index', value: null }, { key: 'track.kind', value: 'master' },
  ]);
});

test('malformed or unknown input is ignored, not thrown', () => {
  for (const atoms of [[], ['nope', 1], ['tempo'], ['tempo', 'fast'], ['playing', 'yes'], ['sigNum', 2.5],
    ['track.path', 'somewhere'], ['__proto__', 1], ['toString', 1]]) {
    assert.equal(parseLive(atoms), null, JSON.stringify(atoms));
  }
});

function setup(intervalMs = 33) {
  const clock = createFakeTimers(1000);
  const flushes = [];
  const state = createState({ timers: clock.timers, now: clock.now, intervalMs, onFlush: (c) => flushes.push(c) });
  return { clock, flushes, state };
}

test('a burst inside one interval produces one flush with the latest values', () => {
  const { clock, flushes, state } = setup();
  for (let i = 0; i < 100; i++) state.set('songTime', i / 4);
  state.set('tempo', 120);
  assert.equal(flushes.length, 0, 'the first flush waits for the timer, not the caller');
  clock.advance(0);
  assert.deepEqual(flushes, [{ songTime: 99 / 4, tempo: 120 }]);
});

test('flushes are spaced at least intervalMs apart', () => {
  const { clock, flushes, state } = setup(33);
  state.set('songTime', 1);
  clock.advance(0);
  state.set('songTime', 2);
  clock.advance(10);
  assert.equal(flushes.length, 1);
  clock.advance(23);
  assert.deepEqual(flushes, [{ songTime: 1 }, { songTime: 2 }]);
});

test('setting an unchanged value schedules nothing', () => {
  const { clock, flushes, state } = setup();
  state.set('tempo', 120);
  clock.advance(100);
  state.set('tempo', 120);
  clock.advance(100);
  assert.equal(flushes.length, 1);
  assert.equal(clock.pendingCount(), 0);
});

test('a value that changes and changes back inside an interval is not sent', () => {
  const { clock, flushes, state } = setup();
  state.set('tempo', 120);
  clock.advance(100);
  state.set('tempo', 121);
  state.set('tempo', 120);
  clock.advance(100);
  assert.equal(flushes.length, 1);
});

test('snapshot returns every known key; flushNow sends pending changes immediately', () => {
  const { flushes, state } = setup();
  state.set('tempo', 120);
  state.set('track.name', 'Drums');
  assert.deepEqual(state.snapshot(), { tempo: 120, 'track.name': 'Drums' });
  state.flushNow();
  assert.deepEqual(flushes, [{ tempo: 120, 'track.name': 'Drums' }]);
  state.flushNow();
  assert.equal(flushes.length, 1, 'nothing pending, nothing sent');
});

test('markDirty resends keys with their latest values on the next flush', () => {
  const { clock, flushes, state } = setup();
  state.set('tempo', 120);
  state.set('songTime', 1);
  clock.advance(0);
  state.set('songTime', 2);
  state.markDirty(['tempo', 'songTime', 'unknownKey']);
  clock.advance(33);
  assert.deepEqual(flushes, [{ tempo: 120, songTime: 1 }, { tempo: 120, songTime: 2 }]);
});

test('markAllSent suppresses a patch for values already in a snapshot', () => {
  const { clock, flushes, state } = setup();
  state.set('tempo', 120);
  state.markAllSent();
  clock.advance(100);
  assert.equal(flushes.length, 0);
});

test('snapshot is a copy', () => {
  const { state } = setup();
  state.set('tempo', 120);
  state.snapshot().tempo = 1;
  assert.equal(state.get('tempo'), 120);
});
