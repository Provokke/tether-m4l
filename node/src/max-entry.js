import Max from 'max-api';
import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createBridge } from './bridge.js';
import { readCa } from './ca.js';

const version = typeof __TETHER_VERSION__ === 'string' ? __TETHER_VERSION__ : 'dev';

const caFile = path.join(__dirname, 'tether-ca.pem');
const caResult = readCa(caFile);

const bridge = createBridge({
  deviceId: `tether-${randomBytes(4).toString('hex')}`,
  version,
  WebSocket,
  ca: caResult.ok ? caResult.pem : null,
  host: {
    post: (message) => Max.post(message),
    outlet: (...atoms) => {
      Max.outlet(...atoms).catch(() => {});
    },
  },
});

for (const selector of ['live', 'config', 'connect']) {
  Max.addHandler(selector, (...atoms) => bridge.handle(selector, ...atoms));
}

const shutdown = () => {
  bridge.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

Max.post(`tether ${version} ready (node ${process.version}, ${process.platform}-${process.arch})`);
if (caResult.ok) Max.post(`tether: trusting private CA from ${caFile}`);
else if (caResult.missing) Max.post('tether: no tether-ca.pem beside the script; wss:// trusts the bundled public roots only');
else Max.post(`tether: ignoring ${caFile}: ${caResult.error}`);
Max.outlet('status', 'offline').catch(() => {});
