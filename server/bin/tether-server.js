import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTetherServer } from '../src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
let token = process.env.TETHER_TOKEN;
if (!token) {
  token = randomBytes(12).toString('base64url');
  console.log('TETHER_TOKEN not set; generated a token for this run.');
}

const { TETHER_TLS_CERT: certFile, TETHER_TLS_KEY: keyFile } = process.env;
if (Boolean(certFile) !== Boolean(keyFile)) {
  console.error('Set both TETHER_TLS_CERT and TETHER_TLS_KEY, or neither.');
  process.exit(1);
}
const tls = certFile ? { cert: readFileSync(certFile), key: readFileSync(keyFile) } : undefined;

const server = await createTetherServer({
  port,
  host,
  token,
  tls,
  publicDir: path.join(here, '..', 'public'),
  log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
});

const shown = host === '0.0.0.0' ? 'localhost' : host;
console.log(`Tether server listening on ${host}:${server.port}`);
console.log(`  device URL : ${tls ? 'wss' : 'ws'}://${shown}:${server.port}/device   (token: ${token})`);
console.log(`  dashboard  : ${tls ? 'https' : 'http'}://${shown}:${server.port}/#token=${encodeURIComponent(token)}`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
