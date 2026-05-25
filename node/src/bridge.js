import { encode, decode } from '../../shared/protocol.js';
import { COMMANDS, prepareCommand } from '../../shared/commands.js';
import { parseLive } from './live-input.js';
import { createState } from './state.js';
import { createConnection } from './connection.js';
import { readCa } from './ca.js';

export function createBridge({
  host,
  WebSocket,
  deviceId,
  version,
  name = 'Tether',
  timers = globalThis,
  now = Date.now,
  heartbeatMs = 10_000,
  flushIntervalMs = 33,
  backoff,
  ca = null,
}) {
  const config = { url: '', token: '', name, ca };
  let wantConnected = false;
  let conn = null;
  let seq = 0;

  const send = (type, payload) => conn !== null && conn.send(encode(type, payload, seq++));

  const state = createState({
    timers,
    now,
    intervalMs: flushIntervalMs,
    onFlush(changes) {
      if (send('patch', { changes })) return;
      if (conn?.status === 'online') state.markDirty(Object.keys(changes));
    },
  });

  function onOpen() {
    send('hello', { deviceId, name: config.name, version, capabilities: [...COMMANDS] });
    send('state', { state: state.snapshot() });
    state.markAllSent();
  }

  function onMessage(text) {
    const r = decode(text);
    if (!r.ok) {
      host.post(`tether: dropped frame from server (${r.error.code}: ${r.error.message})`);
      return;
    }
    const { type, payload } = r.msg;
    if (type === 'cmd') return runCommand(payload);
    if (type === 'welcome') return host.post(`tether: connected, session ${payload.sessionId}`);
    if (type === 'error') return host.post(`tether: server error ${payload.code}: ${payload.message}`);
  }

  function runCommand({ id, name: cmdName, args }) {
    const prepared = prepareCommand(cmdName, args, {
      trackCount: state.get('trackCount'),
      sceneCount: state.get('sceneCount'),
    });
    if (!prepared.ok) {
      send('ack', { id, ok: false, error: prepared.error });
      return;
    }
    host.outlet('cmd', ...prepared.atoms);
    send('ack', { id, ok: true });
  }

  function reconnect() {
    if (conn) conn.stop();
    conn = null;
    if (!wantConnected) {
      host.outlet('status', 'offline');
      return;
    }
    if (!config.url) {
      host.post('tether: set a server URL before connecting');
      host.outlet('status', 'offline');
      return;
    }
    conn = createConnection({
      url: config.url,
      token: config.token,
      ca: config.ca ?? undefined,
      WebSocket,
      timers,
      now,
      heartbeatMs,
      backoff,
      onOpen,
      onMessage,
      onStatus: (s) => host.outlet('status', s),
      onRtt: (ms) => host.outlet('rtt', Math.round(ms)),
      log: (line) => host.post(`tether: ${line}`),
    });
    conn.start();
  }

  const handlers = {
    live(...atoms) {
      const updates = parseLive(atoms);
      if (!updates) return;
      for (const { key, value } of updates) state.set(key, value);
    },
    config(field, ...rest) {
      const atoms = rest[0] === 'text' ? rest.slice(1) : rest;
      const value = atoms.map(String).join(' ').trim();
      if (field === 'url' || field === 'token') {
        if (config[field] === value) return;
        config[field] = value;
        if (wantConnected) reconnect();
      } else if (field === 'ca') {
        if (!value) {
          config.ca = null;
          host.post('tether: custom CA cleared; trusting only the bundled roots');
        } else {
          const r = readCa(value);
          if (!r.ok) {
            host.post(`tether: cannot use CA file ${value}: ${r.error}`);
            return;
          }
          config.ca = r.pem;
          host.post(`tether: trusting private CA from ${value}`);
        }
        if (wantConnected) reconnect();
      } else if (field === 'name' && value) {
        config.name = value.slice(0, 64);
      }
    },
    connect(flag) {
      const next = Number(flag) === 1;
      if (next === wantConnected) return;
      wantConnected = next;
      reconnect();
    },
  };

  return {
    handle(selector, ...atoms) {
      const fn = Object.prototype.hasOwnProperty.call(handlers, selector) ? handlers[selector] : null;
      if (fn) fn(...atoms);
    },
    stop() {
      wantConnected = false;
      reconnect();
    },
    get state() {
      return state.snapshot();
    },
  };
}
