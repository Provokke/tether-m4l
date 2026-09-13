import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { builtinModules } from 'node:module';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { bundle } from '../tools/bundle.mjs';
import { decode, encode } from '../shared/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let outdir;
let outfile;

before(async () => {
  outdir = await mkdtemp(path.join(tmpdir(), 'tether-bundle-'));
  ({ outfile } = await bundle({ outdir }));
});
after(() => rm(outdir, { recursive: true, force: true }));

test('the bundle has no runtime requires except max-api and optional ws accelerators', async () => {
  const code = await readFile(outfile, 'utf8');
  const requires = new Set([...code.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]));
  const allowed = new Set(['max-api', 'bufferutil', 'utf-8-validate']);
  for (const r of requires) {
    assert.ok(allowed.has(r) || builtinModules.includes(r.replace(/^node:/, '')), `unexpected require("${r}")`);
  }
  assert.ok(requires.has('max-api'));
});

test('the bundle connects, says hello, and routes a command to an outlet', async (t) => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  const { port } = wss.address();

  const authHeaders = [];
  const frames = [];
  wss.on('connection', (socket, req) => {
    authHeaders.push(req.headers.authorization);
    socket.on('message', (data) => {
      const r = decode(String(data));
      frames.push(r.msg);
      if (r.msg.type === 'hello') {
        socket.send(encode('cmd', { id: 'k1', name: 'tempo.set', args: { bpm: 5000 } }, 0));
      }
    });
  });

  const child = fork(outfile, [], {
    execPath: process.env.TETHER_NODE_BIN || process.execPath,
    execArgv: [],
    env: { ...process.env, NODE_PATH: path.join(here, 'helpers', 'node_path') },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  t.after(async () => {
    child.kill();
    for (const client of wss.clients) client.terminate();
    await new Promise((r) => wss.close(r));
  });
  const outlets = [];
  const posts = [];
  child.on('message', (m) => (m.kind === 'outlet' ? outlets.push(m.atoms) : posts.push(m.args.join(' '))));

  const until = async (cond, what) => {
    const deadline = Date.now() + 5000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; posts: ${posts.join(' | ')}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  await until(() => posts.some((p) => p.startsWith('tether 1.0.0 ready')), 'ready post');
  child.send({ selector: 'live', atoms: ['tempo', 120] });
  child.send({ selector: 'config', atoms: ['token', 's3cret'] });
  child.send({ selector: 'config', atoms: ['url', `ws://127.0.0.1:${port}/device`] });
  child.send({ selector: 'connect', atoms: [1] });

  await until(() => outlets.some((o) => o[0] === 'cmd'), 'cmd outlet');
  await until(() => frames.some((f) => f.type === 'ack'), 'ack frame');

  assert.deepEqual(authHeaders, ['Bearer s3cret']);
  assert.deepEqual(frames.slice(0, 2).map((f) => f.type), ['hello', 'state']);
  assert.equal(frames[0].payload.version, '1.0.0');
  assert.deepEqual(frames[1].payload.state, { tempo: 120 });
  assert.deepEqual(outlets.find((o) => o[0] === 'cmd'), ['cmd', 'tempo', 999]);
  assert.deepEqual(frames.find((f) => f.type === 'ack').payload, { id: 'k1', ok: true });
  assert.ok(outlets.some((o) => o[0] === 'status' && o[1] === 'online'));
});
