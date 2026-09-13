import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { buildPatcher } from '../device/patcher.mjs';
import { objectSpec } from '../device/objects.mjs';
import { BUNDLE_NAME, bundle } from './bundle.mjs';
import { packAmxd } from './amxd.mjs';
import { createTetherServer } from '../server/src/server.js';
import { encode, decode } from '../shared/protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'dist', 'smoke');
const keepOpen = process.argv.includes('--keep-open');
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 120_000);
const TOKEN = 'max-smoke';

const candidates = [
  process.env.MAX_EXE,
  process.platform === 'win32' && "C:/Program Files/Cycling '74/Max 9/Max.exe",
  process.platform === 'darwin' && '/Applications/Max.app/Contents/MacOS/Max',
].filter(Boolean);
const maxExe = candidates.find((p) => existsSync(p));
if (!maxExe) {
  console.error(`Max not found. Set MAX_EXE. Tried:\n  ${candidates.join('\n  ')}`);
  process.exit(2);
}

const server = await createTetherServer({ token: TOKEN, log: (l) => console.log(`  server: ${l}`) });
const deviceUrl = `ws://127.0.0.1:${server.port}/device`;

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const doc = buildPatcher({ version: pkg.version, bundleName: BUNDLE_NAME });
const p = doc.patcher;
p.openinpresentation = 0;
const find = (text) => {
  const box = p.boxes.map((b) => b.box).find((b) => b.text === text);
  if (!box) throw new Error(`harness: no box "${text}"`);
  return box.id;
};
let extra = 0;
const addObj = (text, x, y) => {
  const id = `smoke-${++extra}`;
  const s = objectSpec(text);
  p.boxes.push({ box: { id, maxclass: 'newobj', text, numinlets: s.inlets, numoutlets: s.outlets, outlettype: s.outlettype, patching_rect: [x, y, 200, 22], color: [1, 0.4, 0.2, 1] } });
  return id;
};
const addMsg = (text, x, y) => {
  const id = `smoke-${++extra}`;
  p.boxes.push({ box: { id, maxclass: 'message', text, numinlets: 2, numoutlets: 1, outlettype: [''], patching_rect: [x, y, 420, 22] } });
  return id;
};
const wire = (a, o, b, i = 0) => p.lines.push({ patchline: { source: [a, o], destination: [b, i] } });

const smokeDefer = addObj('deferlow', 1000, 560);
const smokeCfg = addMsg(`config token ${TOKEN}, config url ${deviceUrl}, connect 1`, 1000, 590);
wire(find('route loadend'), 0, smokeDefer);
wire(smokeDefer, 0, smokeCfg);
wire(smokeCfg, 0, find(`node.script ${BUNDLE_NAME} @autostart 1`));
const tap = addObj('prepend live tempo', 290, 810);
wire(find('route play stop tempo volume select fire'), 2, tap);
wire(tap, 0, find(`node.script ${BUNDLE_NAME} @autostart 1`));

await mkdir(outdir, { recursive: true });
await bundle({ outdir });
const asAmxd = process.argv.includes('--amxd');
const harness = path.join(outdir, asAmxd ? 'Tether-smoke.amxd' : 'Tether-smoke.maxpat');
await writeFile(harness, asAmxd ? packAmxd(doc, { type: 'audio' }) : `${JSON.stringify(doc, null, '\t')}\n`);
console.log(`harness: ${path.relative(root, harness)}`);

const results = { deviceUp: null, ack: null, tempoPatch: null };
const ui = new WebSocket(`ws://127.0.0.1:${server.port}/dashboard?token=${TOKEN}`);
let seq = 0;
const done = new Promise((resolve) => {
  ui.on('message', (data) => {
    const { msg } = decode(String(data));
    if (msg.type === 'device.up' && !results.deviceUp) {
      results.deviceUp = msg.payload;
      console.log(`✔ device connected from inside Max: ${msg.payload.deviceId} v${msg.payload.version}`);
      ui.send(encode('cmd', { deviceId: msg.payload.deviceId, id: 'smoke-tempo', name: 'tempo.set', args: { bpm: 128 } }, seq++));
    }
    if (msg.type === 'ack' && msg.payload.id === 'smoke-tempo') {
      results.ack = msg.payload;
      console.log(`${msg.payload.ok ? '✔' : '✖'} command ack: ${JSON.stringify(msg.payload)}`);
    }
    if (msg.type === 'patch' && msg.payload.changes.tempo === 128) {
      results.tempoPatch = msg.payload.changes;
      console.log('✔ tempo 128 came back through the patcher routing (gate → deferlow → route → tap)');
      resolve();
    }
  });
});

console.log(`launching ${maxExe}`);
const max = spawn(maxExe, [harness], { stdio: 'ignore', detached: false });
max.on('error', (err) => console.error(`✖ could not launch Max: ${err.message}`));

const timer = new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS, 'timeout'));
const outcome = await Promise.race([done.then(() => 'ok'), timer]);

if (outcome !== 'ok') {
  console.error(`✖ timed out after ${TIMEOUT_MS} ms: ${JSON.stringify(results)}`);
  console.error('  If Max opened an authorization or crash dialog, dismiss it and re-run.');
}
ui.close();
if (!keepOpen) max.kill();
await server.close();
process.exit(outcome === 'ok' && results.ack?.ok ? 0 : 1);
