import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { getHeapSpaceStatistics } from 'node:v8';
import { createTetherServer } from '../server/src/server.js';

const port = Number(process.argv[2] ?? 0);
const token = process.argv[3];
const STATS_MS = 500;

process.on('disconnect', () => process.exit(0));

async function listen() {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return await createTetherServer({ port, host: '127.0.0.1', token });
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

const server = await listen();
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
let elu = performance.eventLoopUtilization();

process.send({ type: 'listening', port: server.port, at: Date.now() });

setInterval(() => {
  const now = performance.eventLoopUtilization();
  process.send({
    type: 'stats',
    at: Date.now(),
    mem: process.memoryUsage(),
    cpu: process.cpuUsage(),
    elu: performance.eventLoopUtilization(now, elu).utilization,
    loopDelayP99: loop.percentile(99) / 1e6,
    loopDelayMax: loop.max / 1e6,
  });
  elu = now;
  loop.reset();
}, STATS_MS);

if (globalThis.gc) {
  setInterval(() => {
    globalThis.gc();
    const m = process.memoryUsage();
    const spaces = getHeapSpaceStatistics().map((x) => ({
      name: x.space_name,
      sizeMB: Math.round((x.space_size / 1048576) * 10) / 10,
      usedMB: Math.round((x.space_used_size / 1048576) * 10) / 10,
    }));
    process.send({ type: 'gc', at: Date.now(), heapUsed: m.heapUsed, external: m.external, rss: m.rss, spaces });
  }, 10_000);
}
