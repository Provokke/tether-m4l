import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPatcher, DEVICE_WIDTH } from '../device/patcher.mjs';
import { lintPatcher } from '../tools/lint-patcher.mjs';
import { packAmxd, unpackAmxd } from '../tools/amxd.mjs';
import { BUNDLE_NAME } from '../tools/bundle.mjs';
import { LIVE_KEYS } from '../node/src/live-input.js';
import { COMMANDS, VERBS, prepareCommand } from '../shared/commands.js';

const doc = buildPatcher({ version: '1.0.0', bundleName: BUNDLE_NAME });
const boxes = doc.patcher.boxes.map((b) => b.box);
const lines = doc.patcher.lines.map((l) => l.patchline);
const byText = (re) => boxes.filter((b) => re.test(b.text ?? ''));
const into = (id, inlet) => lines.filter((l) => l.destination[0] === id && l.destination[1] === inlet);
const byId = (id) => boxes.find((b) => b.id === id);

test('the generated patcher passes the lint', () => {
  assert.deepEqual(lintPatcher(doc, { fileExists: (f) => f === BUNDLE_NAME }), []);
});

test('every "live <key>" the patcher sends is parsed by the bridge, and every parser is fed', () => {
  const sent = byText(/^prepend live /).map((b) => b.text.split(' ')[2]);
  for (const key of sent) assert.ok(LIVE_KEYS.includes(key), `bridge does not parse "${key}"`);
  assert.deepEqual([...new Set(sent)].sort(), [...LIVE_KEYS].sort());
});

test('every command verb the bridge can emit is routed to Live, in order', () => {
  const samples = {
    'transport.play': {}, 'transport.stop': {}, 'tempo.set': { bpm: 120 },
    'track.volume': { value: 0.5 }, 'track.select': { index: 0 }, 'clip.fire': { track: 0, slot: 0 },
  };
  const emitted = COMMANDS.map((c) => prepareCommand(c, samples[c], { trackCount: 1, sceneCount: 1 }).atoms[0]);
  assert.deepEqual([...emitted].sort(), [...VERBS].sort());
  const [route] = byText(/^route play /);
  assert.deepEqual(route.text.split(' ').slice(1), VERBS);
});

test('commands cannot reach Live before the Live API is ready', () => {
  const [routeOut] = byText(/^route cmd status rtt$/);
  const gate = byText(/^gate$/).find((g) => into(g.id, 1).some((l) => l.source[0] === routeOut.id && l.source[1] === 0));
  assert.ok(gate, 'cmd output enters a gate');
  const opener = into(gate.id, 0).map((l) => byId(l.source[0]));
  assert.deepEqual(opener.map((b) => b.text), ['1']);
});

test('nothing reaches node.script before it reports loadend, and loadend opens the gate first', () => {
  const [node] = byText(/^node\.script /);
  const sources = into(node.id, 0).map((l) => byId(l.source[0]));
  assert.deepEqual(sources.map((b) => b.text), ['gate'], 'node.script has exactly one input: its gate');
  const inGate = sources[0];
  const [loadT] = byText(/^t b b b b$/);
  const opener = into(inGate.id, 0).map((l) => byId(l.source[0]));
  assert.deepEqual(opener.map((b) => b.text), ['1']);
  const openedBy = into(opener[0].id, 0)[0].source;
  assert.deepEqual(openedBy, [loadT.id, 3], 'the rightmost trigger outlet fires first');
  assert.ok(into(loadT.id, 0).some((l) => byId(l.source[0]).text === 'route loadend'));
});

test('every observer is bound to an object id', () => {
  for (const obs of byText(/^live\.observer /)) {
    assert.equal(into(obs.id, 1).length, 1, `${obs.text} has no id source`);
  }
});

test('node.script loads the bundle automatically', () => {
  const [node] = byText(/^node\.script /);
  assert.equal(node.text, `node.script ${BUNDLE_NAME} @autostart 1`);
  assert.equal(node.saved_object_attributes.autostart, 1);
});

test('stored-only parameters are declared and listed', () => {
  const params = boxes.filter((b) => b.parameter_enable === 1);
  assert.deepEqual(params.map((b) => b.saved_attribute_attributes.valueof.parameter_longname).sort(), ['Connect', 'Server Token', 'Server URL']);
  for (const b of params) {
    assert.equal(b.saved_attribute_attributes.valueof.parameter_invisible, 1, `${b.varname} must not be automatable`);
    assert.ok(doc.patcher.parameters[b.id], `${b.id} missing from patcher.parameters`);
  }
});

test('the device UI fits the device strip', () => {
  for (const b of boxes.filter((x) => x.presentation === 1)) {
    const [x, y, w, h] = b.presentation_rect;
    assert.ok(x >= 0 && x + w <= DEVICE_WIDTH, `${b.id} overflows width`);
    assert.ok(y >= 0 && y + h <= 169, `${b.id} overflows Live's 169 px device height`);
  }
});

test('the committed device/tether.maxpat matches the generator', () => {
  const committed = readFileSync(new URL('../device/tether.maxpat', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const expected = `${JSON.stringify(buildPatcher({ version: pkg.version, bundleName: BUNDLE_NAME }), null, '\t')}\n`;
  assert.equal(committed, expected, 'run `npm run build` and commit device/tether.maxpat');
});

test('the device packs as an audio effect and round-trips', () => {
  const r = unpackAmxd(packAmxd(doc, { type: 'audio' }));
  assert.equal(r.type, 'audio');
  assert.equal(r.patcher.patcher.project.amxdtype, Buffer.from('aaaa').readUInt32BE(0));
  assert.deepEqual(r.patcher, doc);
});
