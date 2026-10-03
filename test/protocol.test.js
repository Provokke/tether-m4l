import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION, encode, decode, validators } from '../shared/protocol.js';

const samples = {
  hello: { deviceId: 'dev-1', name: 'Tether', version: '1.0.0', capabilities: ['tempo.set'] },
  welcome: { sessionId: 'abc', heartbeatMs: 10000 },
  state: { state: { tempo: 120 } },
  patch: { changes: { tempo: 121 } },
  cmd: { id: 'c1', name: 'tempo.set', args: { bpm: 128 } },
  ack: { id: 'c1', ok: true },
  error: { code: 'bad_payload', message: 'nope' },
  snapshot: { devices: [] },
  'device.up': { deviceId: 'dev-1', name: 'Tether', state: {} },
  'device.down': { deviceId: 'dev-1' },
};

test('every message type round-trips', () => {
  for (const [type, payload] of Object.entries(samples)) {
    const r = decode(encode(type, payload, 7));
    assert.equal(r.ok, true, `${type}: ${JSON.stringify(r.error)}`);
    assert.equal(r.msg.v, PROTOCOL_VERSION);
    assert.equal(r.msg.type, type);
    assert.equal(r.msg.seq, 7);
    assert.equal(typeof r.msg.ts, 'number');
    assert.deepEqual(r.msg.payload, payload);
  }
});

test('the sample table covers every validator', () => {
  assert.deepEqual(Object.keys(samples).sort(), Object.keys(validators).sort());
});

test('encode refuses a type it cannot validate', () => {
  assert.throws(() => encode('nope', {}, 0), /unknown message type/);
  assert.throws(() => encode('cmd', { id: 'x' }, 0), /invalid cmd payload/);
});

const code = (text, opts) => {
  const r = decode(text, opts);
  assert.equal(r.ok, false, `expected rejection of ${text}`);
  return r.error.code;
};
const frame = (over) => JSON.stringify({ v: 1, type: 'ack', seq: 0, ts: 1, payload: { id: 'a', ok: true }, ...over });

test('decode rejects malformed frames with a specific code', () => {
  assert.equal(code('{not json'), 'bad_json');
  assert.equal(code(frame({}), { maxBytes: 10 }), 'too_large');
  assert.equal(code('[]'), 'bad_envelope');
  assert.equal(code('null'), 'bad_envelope');
  assert.equal(code(frame({ v: 2 })), 'bad_version');
  assert.equal(code(frame({ type: 'launch_missiles' })), 'unknown_type');
  assert.equal(code(frame({ type: '__proto__' })), 'unknown_type');
  assert.equal(code(frame({ seq: -1 })), 'bad_envelope');
  assert.equal(code(frame({ seq: 1.5 })), 'bad_envelope');
  assert.equal(code(frame({ ts: 'now' })), 'bad_envelope');
  assert.equal(code(frame({ payload: [] })), 'bad_envelope');
  assert.equal(code(frame({ payload: { id: 'a' } })), 'bad_payload');
});

test('too_large measures bytes, not characters', () => {
  const payload = { code: 'x', message: 'é'.repeat(40) };
  const text = encode('error', payload, 0);
  assert.ok(text.length < 130 && Buffer.byteLength(text) > 130);
  assert.equal(code(text, { maxBytes: 130 }), 'too_large');
});

test('payload validators reject the wrong shapes', () => {
  const bad = {
    hello: [{ ...samples.hello, deviceId: '' }, { ...samples.hello, deviceId: 'a b' },
      { ...samples.hello, deviceId: 'x'.repeat(65) }, { ...samples.hello, capabilities: 'all' }],
    welcome: [{ sessionId: 'a', heartbeatMs: 0 }, { heartbeatMs: 10 }],
    state: [{ state: null }, { state: [] }],
    patch: [{ changes: 5 }, {}],
    cmd: [{ id: '', name: 'x', args: {} }, { id: 'a', name: 'x', args: [] }, { id: 'a', args: {} }],
    ack: [{ id: 'a', ok: 'yes' }, { id: 'a', ok: false }, { id: 'a', ok: false, error: { code: 1 } }],
    error: [{ code: '', message: 'x' }, { code: 'x' }],
    snapshot: [{ devices: {} }],
    'device.up': [{ name: 'x', state: {} }],
    'device.down': [{}],
  };
  for (const [type, payloads] of Object.entries(bad)) {
    for (const p of payloads) {
      assert.notEqual(validators[type](p), null, `${type} accepted ${JSON.stringify(p)}`);
    }
  }
});

test('a failed ack must carry an error', () => {
  assert.equal(validators.ack({ id: 'a', ok: false, error: { code: 'out_of_range', message: 'm' } }), null);
});

test('dashboard-bound frames may carry a deviceId', () => {
  assert.equal(validators.patch({ deviceId: 'd', changes: {} }), null);
  assert.equal(validators.cmd({ deviceId: 'd', id: 'a', name: 'n', args: {} }), null);
  assert.notEqual(validators.patch({ deviceId: 3, changes: {} }), null);
});
