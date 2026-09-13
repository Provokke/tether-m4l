import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createTetherServer } from '../server/src/server.js';
import { createBridge } from '../node/src/bridge.js';
import { bundle } from '../tools/bundle.mjs';
import { decode } from '../shared/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const certFile = path.join(here, 'fixtures', 'tls', 'localhost.crt');
const cert = readFileSync(certFile, 'utf8');
const key = readFileSync(path.join(here, 'fixtures', 'tls', 'localhost.key'), 'utf8');
const TOKEN = 'tls-token';

const secureServer = () => createTetherServer({
  token: TOKEN,
  tls: { cert, key },
  publicDir: path.join(here, '..', 'server', 'public'),
});

async function until(cond, what, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function fakeHost() {
  const posts = [];
  const outlets = [];
  return { posts, outlets, host: { post: (m) => posts.push(m), outlet: (...a) => outlets.push(a) } };
}
const isOnline = (outlets) => outlets.some((o) => o[0] === 'status' && o[1] === 'online');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { ca: cert }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('tls without a key is refused at startup', async () => {
  await assert.rejects(createTetherServer({ token: TOKEN, tls: { cert } }), /both cert and key/);
});

test('a device that trusts the CA connects over wss and goes online', async (t) => {
  const server = await secureServer();
  const { posts, outlets, host } = fakeHost();
  const bridge = createBridge({ host, WebSocket, deviceId: 'tls-dev', version: 'test', ca: cert });
  t.after(async () => {
    bridge.stop();
    await server.close();
  });
  assert.equal(server.secure, true);

  bridge.handle('config', 'token', TOKEN);
  bridge.handle('config', 'url', `wss://127.0.0.1:${server.port}/device`);
  bridge.handle('connect', 1);
  await until(() => isOnline(outlets), 'status online');
  await until(() => posts.some((p) => /connected, session/.test(p)), 'welcome from the server');
  const health = JSON.parse((await httpsGet(`https://127.0.0.1:${server.port}/healthz`)).body);
  assert.equal(health.devices, 1);
});

test('without the CA the certificate is refused, the token is never sent, and it keeps retrying', async (t) => {
  const server = await secureServer();
  const { posts, outlets, host } = fakeHost();
  const bridge = createBridge({ host, WebSocket, deviceId: 'tls-noca', version: 'test' });
  t.after(async () => {
    bridge.stop();
    await server.close();
  });

  bridge.handle('config', 'token', TOKEN);
  bridge.handle('config', 'url', `wss://127.0.0.1:${server.port}/device`);
  bridge.handle('connect', 1);
  await until(() => posts.some((p) => /certificate/i.test(p)), 'a certificate error in the log');
  await until(() => posts.filter((p) => /reconnecting in/.test(p)).length >= 2, 'at least two retries');
  assert.equal(isOnline(outlets), false);
  const health = JSON.parse((await httpsGet(`https://127.0.0.1:${server.port}/healthz`)).body);
  assert.equal(health.devices, 0);
});

test('dashboards and the static page work over https/wss; a bad token is still 401', async (t) => {
  const server = await secureServer();
  t.after(() => server.close());

  const page = await httpsGet(`https://127.0.0.1:${server.port}/`);
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>Tether<\/title>/);

  const ui = new WebSocket(`wss://127.0.0.1:${server.port}/dashboard?token=${TOKEN}`, { ca: cert });
  t.after(() => ui.terminate());
  const first = await new Promise((resolve, reject) => {
    ui.once('message', (d) => resolve(decode(String(d)).msg));
    ui.once('error', reject);
  });
  assert.equal(first.type, 'snapshot');

  const bad = new WebSocket(`wss://127.0.0.1:${server.port}/dashboard?token=nope`, { ca: cert });
  const status = await new Promise((resolve) => {
    bad.once('unexpected-response', (_req, res) => resolve(res.statusCode));
    bad.once('error', () => {});
  });
  assert.equal(status, 401);
  bad.terminate();
});

test('config ca loads a PEM from a path with spaces and reports unusable files', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tether ca dir '));
  const pemPath = path.join(dir, 'my private ca.pem');
  await copyFile(certFile, pemPath);
  const server = await secureServer();
  const { posts, outlets, host } = fakeHost();
  const bridge = createBridge({ host, WebSocket, deviceId: 'tls-cfg', version: 'test' });
  t.after(async () => {
    bridge.stop();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  bridge.handle('config', 'ca', ...path.join(dir, 'missing.pem').split(' '));
  assert.match(posts.at(-1), /cannot use CA file .*missing\.pem/);

  bridge.handle('config', 'ca', ...fileURLToPath(new URL('../package.json', import.meta.url)).split(' '));
  assert.match(posts.at(-1), /no PEM certificate/);

  bridge.handle('config', 'ca', ...pemPath.split(' '));
  assert.equal(posts.at(-1), `tether: trusting private CA from ${pemPath}`);

  bridge.handle('config', 'token', TOKEN);
  bridge.handle('config', 'url', `wss://127.0.0.1:${server.port}/device`);
  bridge.handle('connect', 1);
  await until(() => isOnline(outlets), 'status online with the configured CA');

  bridge.handle('config', 'ca');
  assert.match(posts.join('\n'), /custom CA cleared/);
});

test('the real bundle trusts tether-ca.pem placed beside it', async (t) => {
  const outdir = await mkdtemp(path.join(tmpdir(), 'tether-tls-bundle-'));
  const { outfile } = await bundle({ outdir });
  await copyFile(certFile, path.join(outdir, 'tether-ca.pem'));
  const server = await createTetherServer({ token: TOKEN, tls: { cert, key } });

  const child = fork(outfile, [], {
    execPath: process.env.TETHER_NODE_BIN || process.execPath,
    execArgv: [],
    env: { ...process.env, NODE_PATH: path.join(here, 'helpers', 'node_path') },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const posts = [];
  const outlets = [];
  child.on('message', (m) => (m.kind === 'outlet' ? outlets.push(m.atoms) : posts.push(m.args.join(' '))));
  t.after(async () => {
    if (child.exitCode === null) await new Promise((r) => { child.once('exit', r); child.kill(); });
    await server.close();
    await rm(outdir, { recursive: true, force: true }).catch(() => {});
  });

  await until(() => posts.some((p) => /trusting private CA from .*tether-ca\.pem$/.test(p)), 'the CA post');
  assert.ok(posts.some((p) => p.startsWith('tether 1.0.0 ready')));

  child.send({ selector: 'config', atoms: ['token', TOKEN] });
  child.send({ selector: 'config', atoms: ['url', `wss://127.0.0.1:${server.port}/device`] });
  child.send({ selector: 'connect', atoms: [1] });
  await until(() => isOnline(outlets), 'bundle online over wss', 8000);
});
