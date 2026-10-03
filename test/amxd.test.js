import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packAmxd, packAmxdBody, unpackAmxd } from '../tools/amxd.mjs';
import { lintPatcher } from '../tools/lint-patcher.mjs';

const doc = { patcher: { fileversion: 1, boxes: [], lines: [], devicewidth: 300 } };

test('header layout matches the Max for Live format byte for byte', () => {
  const buf = packAmxd(doc, { type: 'audio', meta: 1 });
  assert.equal(buf.toString('latin1', 0, 4), 'ampf');
  assert.equal(buf.readUInt32LE(4), 4);
  assert.equal(buf.toString('latin1', 8, 12), 'aaaa');
  assert.equal(buf.toString('latin1', 12, 16), 'meta');
  assert.equal(buf.readUInt32LE(16), 4);
  assert.equal(buf.readUInt32LE(20), 1);
  assert.equal(buf.toString('latin1', 24, 28), 'ptch');
  assert.equal(buf.readUInt32LE(28), buf.length - 32);
  assert.deepEqual([...buf.subarray(-2)], [0x0a, 0x00], 'body ends with "\\n\\0"');
  assert.equal(buf[32], '{'.charCodeAt(0));
});

test('device type codes', () => {
  assert.equal(packAmxd(doc, { type: 'midi' }).toString('latin1', 8, 12), 'mmmm');
  assert.equal(packAmxd(doc, { type: 'instrument' }).toString('latin1', 8, 12), 'iiii');
  assert.throws(() => packAmxd(doc, { type: 'video' }), /unknown device type/);
  assert.throws(() => packAmxd({ boxes: [] }), /expected a patcher document/);
});

test('pack → unpack round-trips, including non-ASCII text', () => {
  const rich = { patcher: { ...doc.patcher, description: 'Tether — Live ⇄ réseau' } };
  const r = unpackAmxd(packAmxd(rich, { type: 'instrument', meta: 0 }));
  assert.equal(r.type, 'instrument');
  assert.equal(r.meta, 0);
  assert.equal(r.frozen, false);
  assert.deepEqual(r.patcher, rich);
});

test('the ptch length counts bytes, not characters', () => {
  const buf = packAmxd({ patcher: { ...doc.patcher, description: 'ééé' } });
  assert.equal(buf.readUInt32LE(28), buf.length - 32);
});

test('frozen devices are recognised instead of misparsed', () => {
  const body = Buffer.concat([Buffer.from('mx@c'), Buffer.alloc(12), Buffer.from('{"patcher":{}}')]);
  const r = unpackAmxd(packAmxdBody(body, { meta: 7 }));
  assert.equal(r.frozen, true);
  assert.equal(r.patcher, null);
  assert.equal(r.meta, 7);
});

test('corrupt files fail with a reason', () => {
  const good = packAmxd(doc);
  assert.throws(() => unpackAmxd(good.subarray(0, 20)), /shorter than the header/);
  assert.throws(() => unpackAmxd(Buffer.concat([Buffer.from('RIFF'), good.subarray(4)])), /bad magic/);
  assert.throws(() => unpackAmxd(good.subarray(0, good.length - 5)), /truncated/);
  assert.throws(() => unpackAmxd(Buffer.concat([good, Buffer.from('xx')])), /unexpected bytes/);
  const badType = Buffer.from(good);
  badType.write('zzzz', 8, 'latin1');
  assert.throws(() => unpackAmxd(badType), /unknown device type code/);
  assert.throws(() => unpackAmxd(packAmxdBody(Buffer.from('{nope\n\0'))), /not valid JSON/);
});

let n = 0;
const box = (text, numinlets, numoutlets, extra = {}) => ({
  box: { id: `obj-${++n}`, maxclass: 'newobj', text, numinlets, numoutlets, ...extra },
});
const line = (a, outlet, b, inlet) => ({ patchline: { source: [a.box.id, outlet], destination: [b.box.id, inlet] } });
const patch = (boxes, lines) => ({ patcher: { boxes, lines } });

test('lint passes a correct Live API chain', () => {
  const dev = box('live.thisdevice', 1, 3);
  const msg = { box: { id: 'm1', maxclass: 'message', text: 'path live_set', numinlets: 2, numoutlets: 1 } };
  const lp = box('live.path', 1, 3);
  const obs = box('live.observer tempo', 2, 2);
  const defer = box('deferlow', 1, 1);
  const obj = box('live.object', 2, 1);
  const lines = [line(dev, 0, msg, 0), line(msg, 0, lp, 0), line(lp, 1, obs, 1), line(lp, 1, obj, 1), line(obs, 0, defer, 0), line(defer, 0, obj, 0)];
  assert.deepEqual(lintPatcher(patch([dev, msg, lp, obs, defer, obj], lines)), []);
});

test('lint catches structural mistakes', () => {
  const a = box('route a b', 2, 3);
  const b = box('prepend x', 1, 1);
  const dup = { box: { ...b.box } };
  const problems = lintPatcher(patch([a, b, dup, box('', 1, 1), box('node.script missing.js', 1, 2)], [
    line(a, 3, b, 0),
    line(a, 0, b, 1),
    { patchline: { source: ['obj-999', 0], destination: [b.box.id, 0] } },
  ]), { fileExists: (f) => f !== 'missing.js' });
  const text = problems.join('\n');
  assert.match(text, /duplicate box id/);
  assert.match(text, /uses outlet 3, box has 3/);
  assert.match(text, /uses inlet 1, box has 1/);
  assert.match(text, /missing box/);
  assert.match(text, /empty object box/);
  assert.match(text, /node\.script file not found: missing\.js/);
});

test('lint flags a live.path that runs before the Live API is ready', () => {
  const lb = box('loadbang', 1, 1);
  const lp = box('live.path live_set', 1, 3);
  const problems = lintPatcher(patch([lb, lp], [line(lb, 0, lp, 0)]));
  assert.match(problems.join('\n'), /live-api-before-ready/);
});

test('lint flags an observer that changes the Set without deferlow', () => {
  const dev = box('live.thisdevice', 1, 3);
  const lp = box('live.path live_set', 1, 3);
  const obs = box('live.observer is_playing', 2, 2);
  const sel = box('sel 1', 2, 2);
  const obj = box('live.object', 2, 1);
  const problems = lintPatcher(patch([dev, lp, obs, sel, obj], [
    line(dev, 0, lp, 0), line(lp, 1, obs, 1), line(obs, 0, sel, 0), line(sel, 0, obj, 0),
  ]));
  assert.match(problems.join('\n'), /change-from-notification: .* reaches .* without deferlow/);
});

test('lint allows notifications to re-bind observers and objects by id', () => {
  const dev = box('live.thisdevice', 1, 3);
  const lp = box('live.path live_set view selected_track', 1, 3);
  const obs = box('live.observer name', 2, 2);
  const obj = box('live.object', 2, 1);
  assert.deepEqual(lintPatcher(patch([dev, lp, obs, obj], [
    line(dev, 0, lp, 0), line(lp, 1, obs, 1), line(lp, 1, obj, 1),
  ])), []);
});
