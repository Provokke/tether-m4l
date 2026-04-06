import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createSimDevice } from '../server/sim-device.js';
import { encode, decode } from '../shared/protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const quick = has('quick');
const params = {
  label: opt('label', quick ? 'quick' : 'default'),
  devices: Number(opt('devices', quick ? 10 : 50)),
  dashboards: Number(opt('dashboards', quick ? 2 : 10)),
  durationS: Number(opt('duration', quick ? 15 : 90)),
  kills: Number(opt('kills', quick ? 1 : 3)),
  cmdRate: Number(opt('cmd-rate', 5)),
};
const record = has('record');
if (has('docs-only')) {
  await writeDocs();
  console.log('regenerated docs/soak-results.md');
  process.exit(0);
}
const profile = has('profile');
const leakCheck = has('leak-check');
params.leakCheck = leakCheck;
params.serverNodeFlags = opt('server-node-flags', '');
if (profile) params.kills = 0;
const THRESHOLDS = { recoveryMs: 35_000 };
const KILL_GRACE_MS = 2000;
const APPLY_TIMEOUT_MS = 3000;
const token = randomBytes(9).toString('base64url');

class Reservoir {
  constructor(cap = 50_000) {
    this.cap = cap;
    this.n = 0;
    this.max = 0;
    this.values = [];
  }
  add(v) {
    this.n++;
    if (v > this.max) this.max = v;
    if (this.values.length < this.cap) this.values.push(v);
    else {
      const j = Math.floor(Math.random() * this.n);
      if (j < this.cap) this.values[j] = v;
    }
  }
  stats() {
    const s = [...this.values].sort((a, b) => a - b);
    const q = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null);
    const r = (x) => (x === null ? null : Math.round(x * 10) / 10);
    return { count: this.n, p50: r(q(0.5)), p95: r(q(0.95)), p99: r(q(0.99)), max: r(this.n ? this.max : null) };
  }
}

const lat = { ackRtt: new Reservoir(), applied: new Reservoir(), deliveryLag: new Reservoir() };
const latKill = { ackRtt: new Reservoir(), applied: new Reservoir(), deliveryLag: new Reservoir() };
const latFor = (t) => (inKillWindow(t) ? latKill : lat);
const frames = { dashboardRx: 0, dashboardTx: 0, deviceRx: 0, deviceTx: 0 };
const counts = {
  commandsSent: 0,
  acksOk: 0,
  ackErrorsKill: {},
  ackErrorsOutside: {},
  applied: 0,
  unconfirmedKill: 0,
  unconfirmedOutside: 0,
  lostKill: 0,
  lostOutside: 0,
  unackedAtEnd: 0,
  rateLimitedKill: 0,
  rateLimitedOutside: 0,
  protocolErrors: 0,
  closesKill: 0,
  unexpectedCloses: 0,
  deviceDownsKill: 0,
  unexpectedDeviceDowns: 0,
  heartbeatLost: 0,
  serverCrashes: 0,
};
const unexpected = [];
let measuring = false;
let t0 = 0;
const kills = [];
let recovery = null;

const inKillWindow = (t) => kills.some((k) => t >= k.killAt - 50 && t <= (k.windowEnd ?? Infinity));
function note(kind, detail) {
  if (unexpected.length < 50) unexpected.push({ atS: Math.round((Date.now() - t0) / 100) / 10, kind, detail });
}
const bump = (obj, key) => (obj[key] = (obj[key] ?? 0) + 1);

let child = null;
let port = 0;
let stopping = false;
const incarnations = [];

function startServer() {
  return new Promise((resolve, reject) => {
    const inc = { startedAt: Date.now(), listeningAt: null, killedAt: null, samples: [], gcSamples: [] };
    const execArgv = [
      ...(profile ? ['--cpu-prof', `--cpu-prof-dir=${path.join(root, 'dist', 'prof')}`] : []),
      ...(leakCheck ? ['--expose-gc'] : []),
      ...(params.serverNodeFlags ? params.serverNodeFlags.split(/\s+/) : []),
    ];
    const c = fork(path.join(root, 'tools', 'soak-server.mjs'), [String(port), token], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv });
    let last = null;
    c.on('message', (m) => {
      if (m.type === 'listening') {
        port = m.port;
        inc.listeningAt = m.at;
        incarnations.push(inc);
        resolve(inc);
      } else if (m.type === 'gc') {
        inc.gcSamples.push({ at: m.at, heap: m.heapUsed, external: m.external, rss: m.rss, spaces: m.spaces });
      } else if (m.type === 'stats') {
        const cpuMs = (m.cpu.user + m.cpu.system) / 1000;
        const cpuPct = last ? Math.round(((cpuMs - last.cpuMs) / (m.at - last.at)) * 1000) / 10 : null;
        last = { cpuMs, at: m.at };
        inc.samples.push({ at: m.at, rss: m.mem.rss, heap: m.mem.heapUsed, heapTotal: m.mem.heapTotal, external: m.mem.external, cpuPct, elu: m.elu, loopP99: m.loopDelayP99 });
      }
    });
    c.on('exit', (code, signal) => {
      if (!stopping && child === c && !inc.killedAt) {
        counts.serverCrashes++;
        note('server-crash', `exit ${code} ${signal}`);
      }
      if (!inc.listeningAt) reject(new Error(`server exited before listening (${code})`));
    });
    child = c;
  });
}

function killServer() {
  return new Promise((resolve) => {
    const c = child;
    incarnations.at(-1).killedAt = Date.now();
    c.once('exit', resolve);
    c.kill('SIGKILL');
  });
}

let serverDevices = null;
const healthTimer = setInterval(async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
    serverDevices = (await r.json()).devices;
  } catch {
    serverDevices = null;
  }
}, 250);

function countingWebSocket(counter) {
  return class extends WebSocket {
    constructor(...args) {
      super(...args);
      this.on('message', () => measuring && counter.rx());
    }
    send(data, ...rest) {
      if (measuring) counter.tx();
      return super.send(data, ...rest);
    }
  };
}
const DeviceWS = countingWebSocket({ rx: () => frames.deviceRx++, tx: () => frames.deviceTx++ });

function deviceLog(line) {
  const now = Date.now();
  const kill = inKillWindow(now);
  if (/dropped frame/.test(line)) {
    counts.protocolErrors++;
    note('device-protocol', line);
  } else if (/server error rate_limited/.test(line)) {
    if (kill) counts.rateLimitedKill++;
    else {
      counts.rateLimitedOutside++;
      note('device-rate-limited', line);
    }
  } else if (/server error/.test(line)) {
    counts.protocolErrors++;
    note('device-server-error', line);
  } else if (/heartbeat lost/.test(line)) {
    counts.heartbeatLost++;
    if (!kill) note('heartbeat-lost', line);
  } else if (measuring && /connection closed/.test(line)) {
    if (kill) counts.closesKill++;
    else {
      counts.unexpectedCloses++;
      note('device-close', line);
    }
  }
}

const sims = [];

let valueCounter = 0;

class Dashboard {
  constructor(i) {
    this.i = i;
    this.view = new Set();
    this.snapshotAt = 0;
    this.pendingAcks = new Map();
    this.pendingApplied = new Map();
    this.seq = 0;
    this.cmd = 0;
    this.connect();
    const every = 1000 / params.cmdRate;
    setTimeout(() => {
      this.timer = setInterval(() => this.sendCommand(), every);
    }, Math.random() * every);
  }

  connect() {
    if (stopping) return;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/dashboard?token=${encodeURIComponent(token)}`);
    this.ws = ws;
    ws.on('message', (data) => this.onFrame(data));
    ws.on('error', () => {});
    ws.on('close', () => {
      if (ws !== this.ws) return;
      const now = Date.now();
      const kill = inKillWindow(now);
      if (measuring && this.snapshotAt) {
        if (kill) counts.closesKill++;
        else {
          counts.unexpectedCloses++;
          note('dashboard-close', `dashboard ${this.i}`);
        }
      }
      for (const [id, p] of this.pendingAcks) {
        if (!measuring) break;
        if (kill) counts.lostKill++;
        else {
          counts.lostOutside++;
          note('command-lost', `${p.name} ${id}`);
        }
      }
      this.pendingAcks.clear();
      this.view.clear();
      this.snapshotAt = 0;
      setTimeout(() => this.connect(), 250 + Math.random() * 500);
    });
  }

  onFrame(data) {
    const now = Date.now();
    const tick = performance.now();
    if (measuring) frames.dashboardRx++;
    const r = decode(String(data), { maxBytes: 1 << 20 });
    if (!r.ok) {
      counts.protocolErrors++;
      note('dashboard-decode', r.error.code);
      return;
    }
    const { type, payload, ts } = r.msg;
    if (measuring && type !== 'ack') latFor(now).deliveryLag.add(now - ts);
    switch (type) {
      case 'snapshot':
        this.view = new Set(payload.devices.map((d) => d.deviceId));
        this.snapshotAt = now;
        if (recovery) for (const id of this.view) if (!recovery.seen.has(id)) recovery.seen.set(id, now);
        break;
      case 'device.up':
        this.view.add(payload.deviceId);
        if (recovery && !recovery.seen.has(payload.deviceId)) recovery.seen.set(payload.deviceId, now);
        break;
      case 'device.down':
        this.view.delete(payload.deviceId);
        if (measuring) {
          if (inKillWindow(now)) counts.deviceDownsKill++;
          else {
            counts.unexpectedDeviceDowns++;
            note('device-down', payload.deviceId);
          }
        }
        break;
      case 'patch':
        for (const key of ['tempo', 'track.volume']) {
          if (!(key in payload.changes)) continue;
          const k = `${payload.deviceId}|${key}|${payload.changes[key]}`;
          const sentAt = this.pendingApplied.get(k);
          if (sentAt === undefined) continue;
          this.pendingApplied.delete(k);
          if (measuring) {
            latFor(now).applied.add(tick - sentAt);
            counts.applied++;
          }
        }
        break;
      case 'ack': {
        const p = this.pendingAcks.get(payload.id);
        if (!p) break;
        this.pendingAcks.delete(payload.id);
        if (!measuring) break;
        latFor(now).ackRtt.add(tick - p.sentAt);
        if (payload.ok) counts.acksOk++;
        else if (inKillWindow(now) || ['device_gone', 'server_closing'].includes(payload.error.code)) bump(counts.ackErrorsKill, payload.error.code);
        else {
          bump(counts.ackErrorsOutside, payload.error.code);
          note('ack-error', `${p.name}: ${payload.error.code}`);
        }
        break;
      }
      case 'error':
        if (payload.code === 'rate_limited') {
          if (inKillWindow(now)) counts.rateLimitedKill++;
          else {
            counts.rateLimitedOutside++;
            note('dashboard-rate-limited', `dashboard ${this.i}`);
          }
        } else {
          counts.protocolErrors++;
          note('dashboard-error-frame', payload.code);
        }
        break;
      default:
    }
    this.expireApplied(tick, now);
  }

  expireApplied(tick, now) {
    for (const [k, sentAt] of this.pendingApplied) {
      if (tick - sentAt < APPLY_TIMEOUT_MS) break;
      this.pendingApplied.delete(k);
      if (!measuring) continue;
      if (inKillWindow(now - (tick - sentAt)) || inKillWindow(now)) counts.unconfirmedKill++;
      else counts.unconfirmedOutside++;
    }
  }

  sendCommand() {
    if (!measuring || this.ws?.readyState !== WebSocket.OPEN || !this.snapshotAt || this.view.size === 0) return;
    const ids = [...this.view];
    const deviceId = ids[Math.floor(Math.random() * ids.length)];
    const roll = Math.random();
    const n = ++valueCounter;
    let name;
    let args;
    let applied = null;
    if (roll < 0.4) {
      name = 'tempo.set';
      args = { bpm: 60 + (n % 90_000) / 1000 };
      applied = ['tempo', args.bpm];
    } else if (roll < 0.8) {
      name = 'track.volume';
      args = { value: ((n % 997) + 1) / 1000 };
      applied = ['track.volume', args.value];
    } else {
      name = 'track.select';
      args = { index: Math.floor(Math.random() * 6) };
    }
    const id = `d${this.i}c${++this.cmd}`;
    const tick = performance.now();
    this.pendingAcks.set(id, { sentAt: tick, name });
    if (applied) this.pendingApplied.set(`${deviceId}|${applied[0]}|${applied[1]}`, tick);
    this.ws.send(encode('cmd', { deviceId, id, name, args }, this.seq++));
    frames.dashboardTx++;
    counts.commandsSent++;
  }

  close() {
    clearInterval(this.timer);
    this.ws?.terminate();
  }
}

const dashboards = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return Date.now();
    await sleep(25);
  }
  return null;
}
const allDevicesOnServer = () => serverDevices === params.devices;
const allDashboardsSeeAll = (after) => dashboards.every((d) => d.snapshotAt > after && d.view.size === params.devices);

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  stopping = true;
  measuring = false;
  clearInterval(healthTimer);
  for (const s of sims) s.stop();
  for (const d of dashboards) d.close();
  if (child && child.exitCode === null) child.kill('SIGKILL');
}
process.on('SIGINT', () => {
  console.log('\ninterrupted, cleaning up');
  cleanup();
  process.exit(130);
});
process.on('exit', cleanup);

const mb = (b) => Math.round((b / 1024 / 1024) * 10) / 10;
const machine = {
  os: `${os.type()} ${os.release()}`,
  platform: `${process.platform}-${process.arch}`,
  cpu: os.cpus()[0]?.model?.trim() ?? 'unknown',
  cores: os.cpus().length,
  memoryGB: Math.round(os.totalmem() / 1024 ** 3),
  node: process.version,
};

console.log(`soak ${params.label}: ${params.devices} devices, ${params.dashboards} dashboards, ${params.durationS} s, ${params.kills} kills, ${params.cmdRate} cmd/s per dashboard`);

await startServer();
const url = `ws://127.0.0.1:${port}/device`;
const warmStart = Date.now();
for (let i = 0; i < params.devices; i++) {
  sims.push(createSimDevice({ url, token, deviceId: `soak-${i}`, name: `Soak ${i}`, playing: true, WebSocket: DeviceWS, log: deviceLog }));
}
for (let i = 0; i < params.dashboards; i++) dashboards.push(new Dashboard(i));

const warmedAt = await waitUntil(() => allDevicesOnServer() && allDashboardsSeeAll(0), 120_000);
if (!warmedAt) {
  console.error(`✖ warm-up failed: server sees ${serverDevices} of ${params.devices} devices`);
  cleanup();
  process.exit(1);
}
const initialConnectMs = warmedAt - warmStart;
console.log(`  warm: all connected in ${initialConnectMs} ms`);

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
const cpuStart = process.cpuUsage();
t0 = Date.now();
measuring = true;
const end = t0 + params.durationS * 1000;

for (let k = 0; k < params.kills; k++) {
  const at = t0 + (params.durationS * 1000 * (k + 1)) / (params.kills + 1);
  if (Date.now() < at) await sleep(at - Date.now());
  const kill = { n: k + 1, killAt: Date.now(), windowEnd: null };
  kills.push(kill);
  await killServer();
  kill.downMs = Math.round(500 + Math.random() * 2500);
  await sleep(kill.downMs);
  recovery = { seen: new Map() };
  const inc = await startServer();
  kill.restartAt = inc.listeningAt;
  const devicesAt = await waitUntil(allDevicesOnServer, 60_000);
  const dashboardsAt = await waitUntil(() => allDashboardsSeeAll(kill.restartAt), 60_000);
  kill.devicesBackMs = devicesAt ? devicesAt - kill.restartAt : null;
  kill.dashboardsBackMs = dashboardsAt ? dashboardsAt - kill.restartAt : null;
  kill.windowEnd = Math.max(devicesAt ?? Date.now(), dashboardsAt ?? Date.now()) + KILL_GRACE_MS;
  const back = [...recovery.seen.values()].map((t) => Math.max(0, t - kill.restartAt)).sort((a, b) => a - b);
  recovery = null;
  kill.firstDeviceMs = back[0] ?? null;
  kill.medianDeviceMs = back.length ? back[Math.floor(back.length / 2)] : null;
  kill.p90DeviceMs = back.length ? back[Math.min(back.length - 1, Math.floor(back.length * 0.9))] : null;
  console.log(`  kill ${k + 1}: down ${kill.downMs} ms; devices first ${kill.firstDeviceMs} / median ${kill.medianDeviceMs} / all ${kill.devicesBackMs} ms, dashboards resynced ${kill.dashboardsBackMs} ms after restart`);
}

if (Date.now() < end) await sleep(end - Date.now());
measuring = false;
const measuredMs = Date.now() - t0;
const cpu = process.cpuUsage(cpuStart);
await sleep(3000);
counts.unackedAtEnd = dashboards.reduce((n, d) => n + d.pendingAcks.size, 0);
const finalSample = incarnations.at(-1).samples.at(-1);

const measuredSamples = incarnations.flatMap((inc) => inc.samples.filter((s) => s.at >= t0 && s.at <= t0 + measuredMs));
function slopeMBPerMin(s, pick, minSamples = 10) {
  if (s.length < minSamples) return null;
  const xs = s.map((x) => (x.at - s[0].at) / 60_000);
  const ys = s.map((x) => pick(x) / 1024 / 1024);
  const mx = xs.reduce((a, b) => a + b) / xs.length;
  const my = ys.reduce((a, b) => a + b) / ys.length;
  const num = xs.reduce((a, x, j) => a + (x - mx) * (ys[j] - my), 0);
  const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  return den ? Math.round((num / den) * 100) / 100 : null;
}
const steady = incarnations.map((inc, i) => {
  const from = i === 0 ? t0 + 5000 : (kills[i - 1]?.windowEnd ?? inc.listeningAt) + 5000;
  const to = inc.killedAt ?? t0 + measuredMs;
  const s = inc.samples.filter((x) => x.at >= from && x.at <= to);
  const g = inc.gcSamples.filter((x) => x.at >= from && x.at <= to);
  const sorted = s.map((x) => x.rss).sort((a, b) => a - b);
  return {
    incarnation: i,
    seconds: Math.round((to - from) / 1000),
    rssMedianMB: sorted.length ? mb(sorted[Math.floor(sorted.length / 2)]) : null,
    heapSlopeMBPerMin: slopeMBPerMin(s, (x) => x.heap),
    rssSlopeMBPerMin: slopeMBPerMin(s, (x) => x.rss),
    externalSlopeMBPerMin: slopeMBPerMin(s, (x) => x.external),
    postGcHeapSlopeMBPerMin: slopeMBPerMin(g, (x) => x.heap, 4),
    postGcHeapFirstMB: g.length ? mb(g[0].heap) : null,
    postGcHeapLastMB: g.length ? mb(g.at(-1).heap) : null,
  };
});
const timeline = [];
for (const x of measuredSamples) if (!timeline.length || x.at - timeline.at(-1).at >= 5000) timeline.push(x);
const cpuPcts = measuredSamples.map((s) => s.cpuPct).filter((x) => x !== null);
const server = {
  rssStartMB: mb(measuredSamples[0]?.rss ?? 0),
  rssPeakMB: mb(Math.max(...measuredSamples.map((s) => s.rss))),
  rssEndMB: mb(finalSample.rss),
  heapEndMB: mb(finalSample.heap),
  steadyByIncarnation: steady,
  timeline: timeline.map((x) => ({ tS: Math.round((x.at - t0) / 1000), rssMB: mb(x.rss), heapUsedMB: mb(x.heap), heapTotalMB: mb(x.heapTotal), externalMB: mb(x.external) })),
  heapSpacesAtEnd: incarnations.at(-1).gcSamples.at(-1)?.spaces ?? null,
  postGc: incarnations.flatMap((inc) => inc.gcSamples).filter((x) => x.at >= t0 && x.at <= t0 + measuredMs)
    .map((x) => ({ tS: Math.round((x.at - t0) / 1000), heapUsedMB: mb(x.heap), externalMB: mb(x.external), rssMB: mb(x.rss) })),
  rssGrowthAcrossKillsMB: steady.length > 1 && steady[0].rssMedianMB !== null && steady.at(-1).rssMedianMB !== null
    ? Math.round((steady.at(-1).rssMedianMB - steady[0].rssMedianMB) * 10) / 10 : null,
  cpuPctAvg: cpuPcts.length ? Math.round((cpuPcts.reduce((a, b) => a + b) / cpuPcts.length) * 10) / 10 : null,
  cpuPctPeak: cpuPcts.length ? Math.max(...cpuPcts) : null,
  eventLoopUtilizationAvg: Math.round((measuredSamples.reduce((a, s) => a + s.elu, 0) / measuredSamples.length) * 100) / 100,
  loopDelayP99MaxMs: Math.round(Math.max(...measuredSamples.map((s) => s.loopP99)) * 10) / 10,
};

const secs = measuredMs / 1000;
const throughput = Object.fromEntries(Object.entries(frames).map(([k, v]) => [k, Math.round(v / secs)]));
throughput.total = Object.values(throughput).reduce((a, b) => a + b, 0);

const loadGenerator = {
  loopDelayP50Ms: Math.round((loop.percentile(50) / 1e6) * 10) / 10,
  loopDelayP99Ms: Math.round((loop.percentile(99) / 1e6) * 10) / 10,
  loopDelayMaxMs: Math.round((loop.max / 1e6) * 10) / 10,
  cpuPctOfOneCore: Math.round(((cpu.user + cpu.system) / 1000 / measuredMs) * 1000) / 10,
};

const failures = [];
for (const k of kills) {
  if (k.devicesBackMs === null || k.devicesBackMs > THRESHOLDS.recoveryMs) failures.push(`kill ${k.n}: devices not all back within ${THRESHOLDS.recoveryMs} ms (${k.devicesBackMs})`);
  if (k.dashboardsBackMs === null || k.dashboardsBackMs > THRESHOLDS.recoveryMs) failures.push(`kill ${k.n}: dashboards not all resynced within ${THRESHOLDS.recoveryMs} ms (${k.dashboardsBackMs})`);
}
if (counts.protocolErrors) failures.push(`${counts.protocolErrors} protocol errors`);
const outside = {
  unexpectedCloses: counts.unexpectedCloses,
  unexpectedDeviceDowns: counts.unexpectedDeviceDowns,
  commandsLostOutsideKills: counts.lostOutside,
  ackErrorsOutsideKills: Object.values(counts.ackErrorsOutside).reduce((a, b) => a + b, 0),
  rateLimitedOutsideKills: counts.rateLimitedOutside,
  serverCrashes: counts.serverCrashes,
};
for (const [k, v] of Object.entries(outside)) if (v) failures.push(`${v} × ${k}`);
const pass = failures.length === 0;

const result = {
  label: params.label,
  date: new Date().toISOString(),
  machine,
  params,
  thresholds: { ...THRESHOLDS, protocolErrors: 0, unexpectedOutsideKillWindows: 0 },
  pass,
  failures,
  initialConnectMs,
  measuredSeconds: Math.round(secs),
  kills: kills.map(({ n, killAt, downMs, firstDeviceMs, medianDeviceMs, p90DeviceMs, devicesBackMs, dashboardsBackMs }) => ({
    n, atS: Math.round((killAt - t0) / 100) / 10, downMs, firstDeviceMs, medianDeviceMs, p90DeviceMs, devicesBackMs, dashboardsBackMs,
  })),
  latencyMs: Object.fromEntries(Object.entries(lat).map(([k, r]) => [k, r.stats()])),
  latencyKillWindowMs: Object.fromEntries(Object.entries(latKill).map(([k, r]) => [k, r.stats()])),
  throughputPerSecond: throughput,
  server,
  loadGenerator,
  counts,
  unexpected,
};

const pct = (s) => `p50 ${s.p50} · p95 ${s.p95} · p99 ${s.p99} · max ${s.max} ms (n=${s.count})`;
console.log(`
  ack round trip      ${pct(result.latencyMs.ackRtt)}
  command → applied   ${pct(result.latencyMs.applied)}
  delivery lag        ${pct(result.latencyMs.deliveryLag)}
  throughput          ${throughput.total} frames/s (dashboards rx ${throughput.dashboardRx}, devices tx ${throughput.deviceTx})
  server              RSS ${server.rssStartMB} → peak ${server.rssPeakMB} → end ${server.rssEndMB} MB; CPU avg ${server.cpuPctAvg}% peak ${server.cpuPctPeak}%; loop p99 max ${server.loopDelayP99MaxMs} ms
  load generator      loop p99 ${loadGenerator.loopDelayP99Ms} ms, CPU ${loadGenerator.cpuPctOfOneCore}% of a core
  commands            ${counts.commandsSent} sent, ${counts.acksOk} ok, ${counts.applied} applied confirmed; lost around kills ${counts.lostKill}; unconfirmed ${counts.unconfirmedKill} (kill) / ${counts.unconfirmedOutside} (outside)
  errors              protocol ${counts.protocolErrors}; outside kill windows: ${JSON.stringify(outside)}
${pass ? '✔ PASS' : `✖ FAIL\n    ${failures.join('\n    ')}`}`);
if (unexpected.length) console.log(`  first unexpected events: ${JSON.stringify(unexpected.slice(0, 5))}`);

await mkdir(path.join(root, 'dist'), { recursive: true });
await writeFile(path.join(root, 'dist', 'soak.json'), `${JSON.stringify(result, null, 2)}\n`);
if (record) {
  await mkdir(path.join(root, 'docs', 'soak'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'soak', `${params.label}.json`), `${JSON.stringify(result, null, 2)}\n`);
  await writeDocs();
  console.log('  recorded docs/soak/' + params.label + '.json and regenerated docs/soak-results.md');
}

if (profile) {
  const c = child;
  await new Promise((r) => { c.once('exit', r); c.disconnect(); });
  console.log('  cpu profile written to dist/prof/');
}
cleanup();
process.exit(pass ? 0 : 1);

async function writeDocs() {
  const dir = path.join(root, 'docs', 'soak');
  const runs = [];
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.json'))) runs.push(JSON.parse(await readFile(path.join(dir, f), 'utf8')));
  runs.sort((a, b) => b.params.devices - a.params.devices || a.label.localeCompare(b.label));
  const n = (x) => (x === null || x === undefined ? '—' : x);
  const worst = (r, key) => Math.max(...r.kills.map((k) => k[key] ?? Infinity));
  const out = [
    '# Soak and chaos test results',
    '',
    'Generated by `node tools/soak.mjs --record`. Do not edit by hand.',
    '',
    'Each run starts the relay server in a child process, connects N simulated devices',
    '(the real device bridge, transport playing, so state patches flow continuously) and',
    'M dashboard clients that each send commands at a fixed rate. K times during the run',
    'the server process is killed with SIGKILL and restarted 0.5–3 s later on the same port.',
    '',
    '- **Ack round trip**: a dashboard sends a command; the server forwards it; the device',
    '  validates it and acks; the ack reaches the dashboard.',
    '- **Command → applied**: from sending `tempo.set` / `track.volume` (unique values) until the',
    '  sending dashboard receives the state patch carrying that value.',
    '- **Delivery lag**: server envelope `ts` to dashboard receive, for every non-ack frame. Both ends',
    '  use millisecond wall clocks in different processes, so ±1 ms (including -1) is clock-read resolution.',
    '- **Recovery**: from the restarted server listening until the server sees all N devices, and',
    '  until every dashboard has a fresh snapshot plus `device.up`s covering all N.',
    '- **Kill window**: from the kill until full recovery + 2 s. Closes, lost commands and',
    '  errors inside it are expected and counted separately; outside it they fail the run.',
    '  Latency rows exclude kill windows; samples inside them are listed on their own rows.',
    '- **Applied value never seen**: a newer command for the same device and key (or a',
    '  `track.select`, which reports the new track\x27s volume) landed in the same 33 ms state flush,',
    '  so the older value was coalesced away. That is the designed behaviour, not a loss.',
    '- **Event-loop delay** is sampled at 10 ms resolution; on Windows the timer granularity is',
    '  about 15.6 ms, so values near 16–20 ms are the floor, not load.',
    '',
    'Server, devices and dashboards share one machine, and devices and dashboards share one',
    'Node process. Its event-loop delay is reported because latency is only as good as the',
    'client measuring it.',
    '',
    '## Summary',
    '',
    '| Run | Devices | Dashboards | Duration | Kills | Result | Ack p99 | Applied p99 | Worst recovery (devices / dashboards) | Server RSS peak | Frames/s |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...runs.map((r) => `| ${r.label} | ${r.params.devices} | ${r.params.dashboards} | ${r.params.durationS} s | ${r.params.kills} | ${r.pass ? 'pass' : '**FAIL**'} | ${n(r.latencyMs.ackRtt.p99)} ms | ${n(r.latencyMs.applied.p99)} ms | ${r.kills.length ? `${worst(r, 'devicesBackMs')} / ${worst(r, 'dashboardsBackMs')} ms` : '—'} | ${r.server.rssPeakMB} MB | ${r.throughputPerSecond.total} |`),
    '',
  ];
  try {
    out.push((await readFile(path.join(dir, 'FINDINGS.md'), 'utf8')).trim(), '');
  } catch {
  }
  for (const r of runs) {
    const L = r.latencyMs;
    out.push(
      `## Run: ${r.label}`,
      '',
      `${r.date.slice(0, 10)} · ${r.machine.os} (${r.machine.platform}) · ${r.machine.cpu}, ${r.machine.cores} threads, ${r.machine.memoryGB} GB · Node ${r.machine.node}`,
      '',
      `**${r.pass ? 'PASS' : 'FAIL'}**${r.failures.length ? `: ${r.failures.join('; ')}` : ''}`,
      '',
      '| Parameter | Value |',
      '|---|---|',
      `| Devices / dashboards | ${r.params.devices} / ${r.params.dashboards} |`,
      `| Measured duration | ${r.measuredSeconds} s (after warm-up; all connected in ${r.initialConnectMs} ms) |`,
      `| Commands | ${r.params.cmdRate}/s per dashboard (40% tempo.set, 40% track.volume, 20% track.select) |`,
      `| Kills | ${r.params.kills ? `${r.params.kills} × SIGKILL, restart after 0.5–3 s` : 'none (steady state)'} |`,
      ...(r.params.leakCheck ? ['| Leak check | server runs with --expose-gc; full GC, then a heap sample, every 10 s |'] : []),
      ...(r.params.serverNodeFlags ? [`| Server Node flags | \`${r.params.serverNodeFlags}\` |`] : []),
      '',
      '| Latency (ms) | p50 | p95 | p99 | max | samples |',
      '|---|---|---|---|---|---|',
      ...[['Ack round trip', L.ackRtt], ['Command → applied', L.applied], ['Delivery lag', L.deliveryLag]]
        .map(([name, s]) => `| ${name} | ${n(s.p50)} | ${n(s.p95)} | ${n(s.p99)} | ${n(s.max)} | ${s.count} |`),
      ...(r.latencyKillWindowMs
        ? [['Ack round trip', r.latencyKillWindowMs.ackRtt], ['Command → applied', r.latencyKillWindowMs.applied], ['Delivery lag', r.latencyKillWindowMs.deliveryLag]]
          .filter(([, s]) => s.count)
          .map(([name, s]) => `| ${name}, *inside kill windows* | ${n(s.p50)} | ${n(s.p95)} | ${n(s.p99)} | ${n(s.max)} | ${s.count} |`)
        : []),
      '',
      '| Kill | At | Down for | First device back | Median device | p90 device | All devices back | All dashboards resynced |',
      '|---|---|---|---|---|---|---|---|',
      ...r.kills.map((k) => `| ${k.n} | ${k.atS} s | ${k.downMs} ms | ${n(k.firstDeviceMs)} ms | ${n(k.medianDeviceMs)} ms | ${n(k.p90DeviceMs)} ms | ${n(k.devicesBackMs)} ms | ${n(k.dashboardsBackMs)} ms |`),
      '',
      'Times are measured from the restarted server listening.',
      '',
      '| Server process | Value |',
      '|---|---|',
      `| RSS start → peak → end | ${r.server.rssStartMB} → ${r.server.rssPeakMB} → ${r.server.rssEndMB} MB |`,
      `| Steady RSS per server incarnation (median) | ${r.server.steadyByIncarnation.filter((s) => s.seconds > 0 && s.rssMedianMB !== null).map((s) => `${s.rssMedianMB} MB`).join(' · ')} |`,
      ...(r.params.kills === 0
        ? [
          `| Heap slope (between GCs, sawtooth) | ${n(r.server.steadyByIncarnation[0]?.heapSlopeMBPerMin)} MB/min over ${r.server.steadyByIncarnation[0]?.seconds} s |`,
          `| RSS slope | ${n(r.server.steadyByIncarnation[0]?.rssSlopeMBPerMin)} MB/min |`,
        ]
        : []),
      ...(r.params.leakCheck ? [`| Live heap after forced GC (first → last, slope) | ${r.server.steadyByIncarnation.filter((s) => s.seconds > 0).map((s) => `${n(s.postGcHeapFirstMB)} → ${n(s.postGcHeapLastMB)} MB, ${n(s.postGcHeapSlopeMBPerMin)} MB/min`).join(' · ')} |`] : []),
      `| CPU (one core = 100%) | avg ${r.server.cpuPctAvg}% · peak ${r.server.cpuPctPeak}% |`,
      `| Event loop | utilisation avg ${r.server.eventLoopUtilizationAvg} · delay p99 worst ${r.server.loopDelayP99MaxMs} ms |`,
      '',
      ...(r.params.kills === 0 && r.server.timeline?.length
        ? [
          '| t | RSS | heapUsed | heapTotal | external |' + (r.server.postGc?.length ? ' live heap after GC |' : ''),
          '|---|---|---|---|---|' + (r.server.postGc?.length ? '---|' : ''),
          ...r.server.timeline.filter((_, j) => j % 6 === 0 || j === r.server.timeline.length - 1).map((x) => {
            const gc = r.server.postGc?.length ? r.server.postGc.reduce((best, g) => (Math.abs(g.tS - x.tS) < Math.abs(best.tS - x.tS) ? g : best)) : null;
            return `| ${x.tS} s | ${x.rssMB} MB | ${x.heapUsedMB} MB | ${x.heapTotalMB} MB | ${x.externalMB} MB |` + (gc ? ` ${gc.heapUsedMB} MB (t=${gc.tS} s) |` : '');
          }),
          '',
        ]
        : []),
      ...(r.server.heapSpacesAtEnd
        ? [
          '| V8 heap space, at the last forced GC | Reserved | Used |',
          '|---|---|---|',
          ...r.server.heapSpacesAtEnd.filter((x) => x.sizeMB >= 0.5).map((x) => `| ${x.name} | ${x.sizeMB} MB | ${x.usedMB} MB |`),
          '',
        ]
        : []),
      '| Throughput (frames/s) | Value |',
      '|---|---|',
      `| Devices → server / server → devices | ${r.throughputPerSecond.deviceTx} / ${r.throughputPerSecond.deviceRx} |`,
      `| Dashboards → server / server → dashboards | ${r.throughputPerSecond.dashboardTx} / ${r.throughputPerSecond.dashboardRx} |`,
      `| Total | ${r.throughputPerSecond.total} |`,
      '',
      '| Counts | Around kills (expected) | Outside kill windows |',
      '|---|---|---|',
      `| Socket closes | ${r.counts.closesKill} | ${r.counts.unexpectedCloses} |`,
      `| device.down seen by dashboards | ${r.counts.deviceDownsKill} | ${r.counts.unexpectedDeviceDowns} |`,
      `| Commands lost (no ack before the socket died) | ${r.counts.lostKill} | ${r.counts.lostOutside} |`,
      `| Ack errors | ${JSON.stringify(r.counts.ackErrorsKill)} | ${JSON.stringify(r.counts.ackErrorsOutside)} |`,
      `| Applied value never seen within 3 s | ${r.counts.unconfirmedKill} | ${r.counts.unconfirmedOutside} |`,
      `| rate_limited | ${r.counts.rateLimitedKill} | ${r.counts.rateLimitedOutside} |`,
      '',
      `Commands sent ${r.counts.commandsSent}, acked ok ${r.counts.acksOk}, applied confirmed ${r.counts.applied}. Protocol errors ${r.counts.protocolErrors}. Server crashes ${r.counts.serverCrashes}. Load generator: event-loop delay p99 ${r.loadGenerator.loopDelayP99Ms} ms, CPU ${r.loadGenerator.cpuPctOfOneCore}% of one core.`,
      '',
    );
  }
  await writeFile(path.join(root, 'docs', 'soak-results.md'), out.join('\n'));
}
