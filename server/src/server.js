import http from 'node:http';
import https from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { decode, encode, DEFAULT_MAX_BYTES } from '../../shared/protocol.js';
import { COMMANDS } from '../../shared/commands.js';
import { createTokenBucket } from './rate-limit.js';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function tokenMatches(expected, given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function tokenFrom(req, url) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return url.searchParams.get('token');
}

function reject(socket, status, text) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export async function createTetherServer({
  port = 0,
  host = '127.0.0.1',
  token,
  publicDir,
  tls,
  maxBytes = DEFAULT_MAX_BYTES,
  rate = { capacity: 60, refillPerSec: 30 },
  heartbeatMs = 15_000,
  helloTimeoutMs = 5_000,
  commandTimeoutMs = 10_000,
  log = () => {},
}) {
  if (!token) throw new Error('a token is required');
  if (tls && !(tls.cert && tls.key)) throw new Error('tls needs both cert and key');

  const devices = new Map();
  const dashboards = new Set();
  const pending = new Map();
  let cmdCounter = 0;
  let seq = 0;

  const send = (socket, type, payload) => {
    if (socket.readyState === socket.OPEN) socket.send(encode(type, payload, seq++));
  };
  const broadcast = (type, payload) => {
    for (const d of dashboards) send(d, type, payload);
  };
  const deviceSummary = (id, d) => ({ deviceId: id, ...d.info, state: d.state });

  const handleRequest = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, devices: devices.size, dashboards: dashboards.size }));
      return;
    }
    if (!publicDir || req.method !== 'GET') {
      res.writeHead(404).end();
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(publicDir, rel);
    if (!file.startsWith(path.resolve(publicDir) + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
        'content-security-policy': "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self'; img-src 'self' data:",
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-cache',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  };
  const httpServer = tls ? https.createServer({ ...tls }, handleRequest) : http.createServer(handleRequest);

  const wss = new WebSocketServer({ noServer: true, maxPayload: maxBytes });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const role = { '/device': 'device', '/dashboard': 'dashboard' }[url.pathname];
    if (!role) return reject(socket, 404, 'Not Found');
    if (!tokenMatches(token, tokenFrom(req, url))) {
      log(`rejected ${role} from ${req.socket.remoteAddress}: bad token`);
      return reject(socket, 401, 'Unauthorized');
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', (err) => log(`${role} socket error: ${err.message}`));
      ws.isAlive = true;
      ws.on('pong', () => (ws.isAlive = true));
      const bucket = createTokenBucket(rate);
      const guard = (handler) => (data, isBinary) => {
        if (!bucket.take()) return send(ws, 'error', { code: 'rate_limited', message: 'slow down' });
        if (isBinary) return send(ws, 'error', { code: 'bad_json', message: 'binary frames are not supported' });
        const r = decode(String(data), { maxBytes });
        if (!r.ok) return send(ws, 'error', r.error);
        handler(r.msg);
      };
      if (role === 'device') acceptDevice(ws, guard);
      else acceptDashboard(ws, guard);
    });
  });

  function failPending(match, code, message) {
    for (const [id, p] of pending) {
      if (!match(p)) continue;
      clearTimeout(p.timer);
      pending.delete(id);
      if (p.dashboard) send(p.dashboard, 'ack', { deviceId: p.deviceId, id: p.clientId, ok: false, error: { code, message } });
    }
  }

  function acceptDevice(ws, guard) {
    let deviceId = null;
    const helloTimer = setTimeout(() => ws.close(4001, 'hello expected'), helloTimeoutMs);

    ws.on('message', guard((msg) => {
      const { type, payload } = msg;
      if (deviceId === null) {
        if (type !== 'hello') return ws.close(4001, 'hello expected');
        clearTimeout(helloTimer);
        deviceId = payload.deviceId;
        const existing = devices.get(deviceId);
        if (existing) existing.socket.close(4000, 'replaced by a new connection');
        devices.set(deviceId, {
          socket: ws,
          info: { name: payload.name ?? deviceId, version: payload.version, capabilities: payload.capabilities, connectedAt: Date.now() },
          state: Object.create(null),
        });
        send(ws, 'welcome', { sessionId: randomBytes(8).toString('hex'), heartbeatMs });
        log(`device up: ${deviceId} (${payload.name ?? ''} ${payload.version})`);
        broadcast('device.up', deviceSummary(deviceId, devices.get(deviceId)));
        return;
      }
      const device = devices.get(deviceId);
      if (!device || device.socket !== ws) return;
      switch (type) {
        case 'state':
          device.state = Object.assign(Object.create(null), payload.state);
          broadcast('state', { deviceId, state: device.state });
          return;
        case 'patch':
          for (const [k, v] of Object.entries(payload.changes)) device.state[k] = v;
          broadcast('patch', { deviceId, changes: payload.changes });
          return;
        case 'ack': {
          const p = pending.get(payload.id);
          if (!p || p.deviceId !== deviceId) return;
          clearTimeout(p.timer);
          pending.delete(payload.id);
          if (p.dashboard) send(p.dashboard, 'ack', { ...payload, deviceId, id: p.clientId });
          return;
        }
        default:
          send(ws, 'error', { code: 'unexpected_type', message: `devices may not send ${type}` });
      }
    }));

    ws.on('close', () => {
      clearTimeout(helloTimer);
      const device = deviceId && devices.get(deviceId);
      if (!device || device.socket !== ws) return;
      devices.delete(deviceId);
      failPending((p) => p.deviceId === deviceId, 'device_gone', 'the device disconnected');
      log(`device down: ${deviceId}`);
      broadcast('device.down', { deviceId });
    });
  }

  function acceptDashboard(ws, guard) {
    dashboards.add(ws);
    send(ws, 'snapshot', { devices: [...devices].map(([id, d]) => deviceSummary(id, d)) });

    ws.on('message', guard((msg) => {
      if (msg.type !== 'cmd') {
        return send(ws, 'error', { code: 'unexpected_type', message: `dashboards may not send ${msg.type}` });
      }
      const { deviceId, id: clientId, name, args } = msg.payload;
      const nack = (code, message) => send(ws, 'ack', { deviceId, id: clientId, ok: false, error: { code, message } });
      const device = deviceId && devices.get(deviceId);
      if (!device) return nack('unknown_device', `no device ${deviceId}`);
      if (!COMMANDS.includes(name) || !device.info.capabilities.includes(name)) {
        return nack('unknown_command', `${deviceId} does not support ${name}`);
      }
      const serverId = `s${++cmdCounter}`;
      const timer = setTimeout(() => {
        failPending((p) => p === entry, 'timeout', `no ack within ${commandTimeoutMs} ms`);
      }, commandTimeoutMs);
      const entry = { dashboard: ws, clientId, deviceId, timer };
      pending.set(serverId, entry);
      send(device.socket, 'cmd', { id: serverId, name, args });
    }));

    ws.on('close', () => {
      dashboards.delete(ws);
      for (const p of pending.values()) if (p.dashboard === ws) p.dashboard = null;
    });
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  await new Promise((resolve, rejectListen) => {
    httpServer.once('error', rejectListen);
    httpServer.listen(port, host, resolve);
  });
  const actualPort = httpServer.address().port;

  return {
    port: actualPort,
    secure: Boolean(tls),
    close() {
      clearInterval(heartbeat);
      failPending(() => true, 'server_closing', 'server is shutting down');
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => wss.close(() => httpServer.close(() => resolve())));
    },
  };
}
