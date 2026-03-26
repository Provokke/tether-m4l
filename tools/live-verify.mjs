import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createTetherServer } from '../server/src/server.js';
import { encode, decode } from '../shared/protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const PORT = Number(arg('port', 8787));
const TOKEN = arg('token', randomBytes(9).toString('base64url'));
const HUMAN_TIMEOUT_MS = Number(arg('human-timeout', 90)) * 1000;
const SKIP = new Set(String(arg('skip', '')).split(',').map((x) => x.trim()).filter(Boolean));
const rl = createInterface({ input: process.stdin, output: process.stdout });

const logFile = arg('log', null);
if (logFile) {
  const { appendFileSync, writeFileSync: resetLog } = await import('node:fs');
  resetLog(logFile, '');
  const original = console.log;
  console.log = (...parts) => {
    original(...parts);
    appendFileSync(logFile, `${parts.join(' ').replace(/\x1b\[[0-9;]*m/g, '')}\n`);
  };
  const logCrash = (kind) => (err) => {
    appendFileSync(logFile, `\n[${kind}] ${err?.stack ?? err}\n`);
    process.exit(1);
  };
  process.on('uncaughtException', logCrash('uncaughtException'));
  process.on('unhandledRejection', logCrash('unhandledRejection'));
  process.on('exit', (code) => appendFileSync(logFile, `\n[exit ${code}]\n`));
}
const results = [];
const c = { ok: '\x1b[32m', bad: '\x1b[31m', dim: '\x1b[2m', b: '\x1b[1m', end: '\x1b[0m' };

let server;
let ui;
let device = null;
let seq = 0;
let cmdCounter = 0;
const acks = new Map();

async function startServer() {
  server = await createTetherServer({ port: PORT, host: '0.0.0.0', token: TOKEN, publicDir: path.join(root, 'server', 'public') });
}

function connectObserver() {
  return new Promise((resolve) => {
    ui = new WebSocket(`ws://127.0.0.1:${PORT}/dashboard?token=${encodeURIComponent(TOKEN)}`);
    ui.on('open', resolve);
    ui.on('message', (data) => {
      const { ok, msg } = decode(String(data));
      if (!ok) return;
      const p = msg.payload;
      if (msg.type === 'snapshot' && p.devices.length) device = { deviceId: p.devices.at(-1).deviceId, state: { ...p.devices.at(-1).state }, ups: 1 };
      if (msg.type === 'device.up') device = { deviceId: p.deviceId, state: { ...p.state }, ups: (device?.ups ?? 0) + 1 };
      if (msg.type === 'device.down' && device?.deviceId === p.deviceId) device = { ...device, down: true };
      if (msg.type === 'state' && device?.deviceId === p.deviceId) device.state = { ...p.state };
      if (msg.type === 'patch' && device?.deviceId === p.deviceId) Object.assign(device.state, p.changes);
      if (msg.type === 'ack') acks.get(p.id)?.(p);
    });
    ui.on('close', () => setTimeout(() => connectObserver().catch(() => {}), 500));
  });
}

const S = () => device?.state ?? {};

async function waitFor(pred, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (pred()) return Date.now() - start;
    } catch { }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

function command(name, args) {
  const id = `lv${++cmdCounter}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: { code: 'no_ack' } }), 12_000);
    acks.set(id, (ack) => {
      clearTimeout(timer);
      resolve(ack);
    });
    ui.send(encode('cmd', { deviceId: device.deviceId, id, name, args }, seq++));
  });
}

function record(n, title, pass, detail = '') {
  results.push({ n, title, pass, detail });
  const mark = pass === null ? `${c.dim}–${c.end}` : pass ? `${c.ok}✔${c.end}` : `${c.bad}✖${c.end}`;
  console.log(`  ${mark} ${title}${detail ? ` ${c.dim}(${detail})${c.end}` : ''}`);
}

async function human(n, title, instruction, pred, timeoutMs = HUMAN_TIMEOUT_MS) {
  if (SKIP.has(String(n))) return record(n, title, null, 'skipped (--skip)');
  console.log(`\n${c.b}${n}. ${title}${c.end}\n   → ${instruction}`);
  const ms = await waitFor(pred, timeoutMs);
  record(n, title, ms !== null, ms !== null ? `observed after ${(ms / 1000).toFixed(1)} s` : `not observed within ${timeoutMs / 1000} s`);
}

async function remote(n, title, name, args, pred, timeoutMs = 5000) {
  console.log(`\n${c.b}${n}. ${title}${c.end}\n   → sending ${name} ${JSON.stringify(args)}`);
  const sent = Date.now();
  const ack = await command(name, args);
  if (!ack.ok) return record(n, title, false, `ack failed: ${ack.error?.code}`);
  const ms = await waitFor(pred, timeoutMs);
  record(n, title, ms !== null, ms !== null ? `ack ${Date.now() - sent - ms} ms, applied +${ms} ms` : 'acked but state never changed');
}

async function ask(n, title, question) {
  if (SKIP.has(String(n))) return record(n, title, null, 'skipped (--skip)');
  const a = (await rl.question(`\n${c.b}${n}. ${title}${c.end}\n   ${question} [y/n/s=skip] `)).trim().toLowerCase();
  record(n, title, a === 's' ? null : a.startsWith('y'), a === 's' ? 'skipped' : 'reported by tester');
}

await startServer();
await connectObserver();
const lan = Object.values(os.networkInterfaces()).flat().find((i) => i?.family === 'IPv4' && !i.internal)?.address;
console.log(`${c.b}Tether — guided Live verification${c.end}`);
console.log(`  Server URL : ws://127.0.0.1:${PORT}/device${lan ? `   (or ws://${lan}:${PORT}/device)` : ''}`);
console.log(`  Token      : ${TOKEN}`);
console.log(`  Dashboard  : http://127.0.0.1:${PORT}/#token=${encodeURIComponent(TOKEN)}\n`);

const liveVersion = (await rl.question('Live version (Help → About Live), e.g. 12.2.5 Suite: ')).trim();
const maxVersion = (await rl.question('Max version (Preferences → Library, or the Max window title): ')).trim();

await human(1, 'Device loads and connects',
  'Drag dist/Tether.amxd (with tether-bridge.js beside it) onto a track. Enter the Server URL and Token above, press Enter in each, click Connect.',
  () => device && !device.down, 20 * 60_000);
if (!device) {
  console.log(`${c.bad}No device connected; stopping.${c.end}`);
  process.exit(1);
}
await ask(1.1, 'Max console clean on load', 'Open the device in Max → Window → Max Console. Is there "tether 1.0.0 ready" and no red error?');

await human(2, 'Initial state arrived', 'Nothing to do.', () => typeof S().tempo === 'number' && Number.isInteger(S().trackCount) && Number.isInteger(S().sceneCount) && typeof S()['track.name'] === 'string', 10_000);
console.log(`   ${c.dim}${JSON.stringify(S())}${c.end}`);

const baseTempo = S().tempo;
await human(3, 'Tempo change in Live reaches the server', 'Change the tempo in Live (any value).', () => Math.abs(S().tempo - baseTempo) > 0.001);

await human(4, 'Transport and song position', 'Press Play in Live.', () => S().playing === true && S().songTime > 0);
const t0 = S().songTime;
await human(4.1, 'Song position keeps advancing', 'Leave it playing for a moment.', () => S().songTime > t0 + 0.5, 10_000);
await human(4.2, 'Meter reports signal on a playing track', 'Select a track that is making sound.', () => S()['track.meter'] > 0);

const baseIndex = S()['track.index'];
await human(5, 'Selection follows (live.path middle outlet)', 'Click a different regular track in Live.', () => S()['track.index'] !== baseIndex && S()['track.kind'] === 'track');
await human(5.1, 'Return track selection', 'Click a return track.', () => S()['track.kind'] === 'return');
await human(5.2, 'Master track selection', 'Click the Master track.', () => S()['track.kind'] === 'master');
await human(5.3, 'Back to a regular track', 'Click the first regular track.', () => S()['track.kind'] === 'track');

await remote(6, 'Remote tempo.set', 'tempo.set', { bpm: 128 }, () => Math.abs(S().tempo - 128) < 0.01);
await remote(7, 'Remote transport.stop', 'transport.stop', {}, () => S().playing === false);
await remote(7.1, 'Remote transport.play', 'transport.play', {}, () => S().playing === true);
const vol = S()['track.volume'];
await remote(8, 'Remote track.volume', 'track.volume', { value: 0.5 }, () => Math.abs(S()['track.volume'] - 0.5) < 0.005);
if (typeof vol === 'number') await command('track.volume', { value: vol });
const target = S().trackCount > 1 ? (S()['track.index'] === 0 ? 1 : 0) : 0;
await remote(9, 'Remote track.select', 'track.select', { index: target }, () => S()['track.index'] === target && S()['track.kind'] === 'track');
const oob = await command('track.select', { index: S().trackCount });
record(9.1, 'Out-of-range index refused by the device', !oob.ok && oob.error?.code === 'out_of_range', oob.error?.code ?? 'was accepted');

console.log(`\n${c.b}10. Remote clip.fire${c.end}\n   → Put a clip in track ${target + 1}, scene 1 (slot 0). Press Enter when ready, or type s to skip.`);
if ((await rl.question('   ')).trim().toLowerCase() !== 's') {
  const ack = await command('clip.fire', { track: target, slot: 0 });
  if (!ack.ok) record(10, 'Remote clip.fire', false, ack.error?.code);
  else await ask(10, 'Remote clip.fire', 'Did that clip launch?');
} else record(10, 'Remote clip.fire', null, 'skipped');

const tracks = S().trackCount;
await human(11, 'Track list observer', 'Add a new track in Live (Ctrl/Cmd+T).', () => S().trackCount === tracks + 1);

await ask(12, 'No notification errors', 'In the Max Console: any "Changes cannot be triggered by notifications"? Answer y if there are NONE.');

if (!process.argv.includes('--skip-restart')) {
  console.log(`\n${c.b}13. Server restart → automatic reconnect${c.end}\n   → stopping the server for 5 s…`);
  const before = device.ups;
  ui.removeAllListeners('close');
  ui.terminate();
  await server.close();
  await new Promise((r) => setTimeout(r, 5000));
  await startServer();
  const restarted = Date.now();
  await connectObserver();
  const ms = await waitFor(() => device.ups > before && !device.down && typeof S().tempo === 'number', 60_000);
  record(13, 'Reconnects by itself after a server restart', ms !== null, ms !== null ? `back online ${((Date.now() - restarted) / 1000).toFixed(1)} s after restart` : 'did not reconnect in 60 s');
}

const ups = device.ups;
await human(14, 'Settings persist in the Set',
  'Save the Set, close it (File → New Live Set), then reopen it. Do not touch the device.',
  () => device.ups > ups && !device.down && typeof S().tempo === 'number', 300_000);

await ask(15, 'Stored-only parameters', 'In an automation lane chooser for the device, are URL, Token and Connect ABSENT?');
await ask(16, 'Frozen device (optional)', 'Freeze the device in Max, copy only the .amxd elsewhere, load it. Does it reach "online"? (s to skip)');

const passed = results.filter((r) => r.pass === true).length;
const failed = results.filter((r) => r.pass === false).length;
const skipped = results.filter((r) => r.pass === null).length;
const platform = `${os.platform()}-${os.arch()}`;
const lines = [
  `# Live verification — ${platform}`,
  '',
  `- Date: ${new Date().toISOString()}`,
  `- Live: ${liveVersion || 'not given'}`,
  `- Max: ${maxVersion || 'not given'}`,
  `- OS: ${os.type()} ${os.release()} (${platform}), CPU: ${os.cpus()[0]?.model ?? 'unknown'}`,
  `- Result: **${passed} passed, ${failed} failed, ${skipped} skipped**`,
  '',
  '| # | Check | Result | Detail |',
  '|---|-------|--------|--------|',
  ...results.map((r) => `| ${r.n} | ${r.title} | ${r.pass === null ? 'skipped' : r.pass ? 'pass' : '**FAIL**'} | ${r.detail} |`),
  '',
];
const file = arg('report', path.join(root, 'dist', `live-verify-${platform}-${new Date().toISOString().slice(0, 10)}.md`));
await mkdir(path.dirname(file), { recursive: true });
await writeFile(file, lines.join('\n'));
console.log(`\n${failed ? c.bad : c.ok}${passed} passed, ${failed} failed, ${skipped} skipped${c.end}\nReport: ${path.relative(root, file)}`);
rl.close();
ui.removeAllListeners('close');
ui.terminate();
await server.close();
process.exit(failed ? 1 : 0);
