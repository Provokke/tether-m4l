export const PROTOCOL_VERSION = 1;
export const DEFAULT_MAX_BYTES = 64 * 1024;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isNonEmptyString = (x, max = 256) => typeof x === 'string' && x.length > 0 && x.length <= max;
const isOptionalDeviceId = (p) => p.deviceId === undefined || (typeof p.deviceId === 'string' && ID_RE.test(p.deviceId));

export const validators = Object.freeze(Object.assign(Object.create(null), {
  hello(p) {
    if (typeof p.deviceId !== 'string' || !ID_RE.test(p.deviceId)) return 'deviceId must match [A-Za-z0-9_-]{1,64}';
    if (p.name !== undefined && !isNonEmptyString(p.name, 64)) return 'name must be a string of 1-64 chars';
    if (!isNonEmptyString(p.version, 32)) return 'version is required';
    if (!Array.isArray(p.capabilities) || !p.capabilities.every((c) => isNonEmptyString(c, 64))) return 'capabilities must be an array of strings';
    return null;
  },
  welcome(p) {
    if (!isNonEmptyString(p.sessionId, 64)) return 'sessionId is required';
    if (!Number.isInteger(p.heartbeatMs) || p.heartbeatMs <= 0) return 'heartbeatMs must be a positive integer';
    return null;
  },
  state(p) {
    if (!isOptionalDeviceId(p)) return 'deviceId is invalid';
    return isObject(p.state) ? null : 'state must be an object';
  },
  patch(p) {
    if (!isOptionalDeviceId(p)) return 'deviceId is invalid';
    return isObject(p.changes) ? null : 'changes must be an object';
  },
  cmd(p) {
    if (!isOptionalDeviceId(p)) return 'deviceId is invalid';
    if (!isNonEmptyString(p.id, 64)) return 'id is required';
    if (!isNonEmptyString(p.name, 64)) return 'name is required';
    if (!isObject(p.args)) return 'args must be an object';
    return null;
  },
  ack(p) {
    if (!isOptionalDeviceId(p)) return 'deviceId is invalid';
    if (!isNonEmptyString(p.id, 64)) return 'id is required';
    if (typeof p.ok !== 'boolean') return 'ok must be a boolean';
    if (!p.ok && !(isObject(p.error) && isNonEmptyString(p.error.code, 64) && typeof p.error.message === 'string')) {
      return 'a failed ack must carry error { code, message }';
    }
    return null;
  },
  error(p) {
    if (!isNonEmptyString(p.code, 64)) return 'code is required';
    if (typeof p.message !== 'string') return 'message is required';
    return null;
  },
  snapshot(p) {
    return Array.isArray(p.devices) ? null : 'devices must be an array';
  },
  'device.up'(p) {
    if (typeof p.deviceId !== 'string' || !ID_RE.test(p.deviceId)) return 'deviceId is invalid';
    if (!isObject(p.state)) return 'state must be an object';
    return null;
  },
  'device.down'(p) {
    return typeof p.deviceId === 'string' && ID_RE.test(p.deviceId) ? null : 'deviceId is invalid';
  },
}));

export function encode(type, payload, seq) {
  const validate = validators[type];
  if (!validate) throw new Error(`unknown message type: ${type}`);
  const reason = isObject(payload) ? validate(payload) : 'payload must be an object';
  if (reason) throw new Error(`invalid ${type} payload: ${reason}`);
  return JSON.stringify({ v: PROTOCOL_VERSION, type, seq, ts: Date.now(), payload });
}

const fail = (code, message) => ({ ok: false, error: { code, message } });

export function decode(text, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const str = typeof text === 'string' ? text : String(text);
  if (str.length > maxBytes || (str.length * 3 > maxBytes && Buffer.byteLength(str) > maxBytes)) {
    return fail('too_large', `frame exceeds ${maxBytes} bytes`);
  }
  let msg;
  try {
    msg = JSON.parse(str);
  } catch {
    return fail('bad_json', 'frame is not valid JSON');
  }
  if (!isObject(msg)) return fail('bad_envelope', 'frame must be a JSON object');
  if (msg.v !== PROTOCOL_VERSION) return fail('bad_version', `unsupported protocol version ${msg.v}`);
  if (typeof msg.type !== 'string' || !validators[msg.type]) return fail('unknown_type', `unknown message type ${msg.type}`);
  if (!Number.isInteger(msg.seq) || msg.seq < 0) return fail('bad_envelope', 'seq must be a non-negative integer');
  if (!Number.isFinite(msg.ts)) return fail('bad_envelope', 'ts must be a number');
  if (!isObject(msg.payload)) return fail('bad_envelope', 'payload must be an object');
  const reason = validators[msg.type](msg.payload);
  if (reason) return fail('bad_payload', `${msg.type}: ${reason}`);
  return { ok: true, msg };
}
