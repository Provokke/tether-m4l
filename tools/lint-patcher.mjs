import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const className = (box) => (box.maxclass === 'newobj' ? String(box.text ?? '').split(/\s+/)[0] : box.maxclass);

export function lintPatcher(doc, { fileExists = () => true } = {}) {
  const problems = [];
  const p = doc?.patcher;
  if (!p || !Array.isArray(p.boxes) || !Array.isArray(p.lines)) return ['document has no patcher.boxes / patcher.lines'];

  const boxes = new Map();
  for (const { box } of p.boxes) {
    if (!box?.id) {
      problems.push('a box has no id');
      continue;
    }
    if (boxes.has(box.id)) problems.push(`duplicate box id ${box.id}`);
    boxes.set(box.id, box);
    if (box.maxclass === 'newobj' && !String(box.text ?? '').trim()) problems.push(`${box.id}: empty object box`);
    if (className(box) === 'node.script') {
      const file = String(box.text).split(/\s+/)[1];
      if (!file) problems.push(`${box.id}: node.script without a script file`);
      else if (!fileExists(file)) problems.push(`${box.id}: node.script file not found: ${file}`);
    }
  }

  const edges = new Map();
  for (const { patchline: l } of p.lines) {
    const [from, outlet] = l?.source ?? [];
    const [to, inlet] = l?.destination ?? [];
    const a = boxes.get(from);
    const b = boxes.get(to);
    if (!a || !b) {
      problems.push(`line ${from}:${outlet} → ${to}:${inlet} references a missing box`);
      continue;
    }
    if (!(Number.isInteger(outlet) && outlet >= 0 && outlet < (a.numoutlets ?? 0))) {
      problems.push(`line from ${from} (${className(a)}) uses outlet ${outlet}, box has ${a.numoutlets ?? 0}`);
    }
    if (!(Number.isInteger(inlet) && inlet >= 0 && inlet < (b.numinlets ?? 0))) {
      problems.push(`line to ${to} (${className(b)}) uses inlet ${inlet}, box has ${b.numinlets ?? 0}`);
    }
    if (!edges.has(from)) edges.set(from, []);
    edges.get(from).push({ outlet, to, inlet });
  }

  const ready = new Set();
  const queue = [...boxes.values()].filter((b) => className(b) === 'live.thisdevice').map((b) => b.id);
  while (queue.length) {
    const id = queue.shift();
    if (ready.has(id)) continue;
    ready.add(id);
    for (const e of edges.get(id) ?? []) queue.push(e.to);
  }
  for (const box of boxes.values()) {
    if (className(box) === 'live.path' && !ready.has(box.id)) {
      problems.push(`live-api-before-ready: ${box.id} (${box.text}) is not triggered from live.thisdevice`);
    }
  }

  const reachesObjectUndeferred = (startId, startOutlet) => {
    const seen = new Set();
    const stack = (edges.get(startId) ?? []).filter((e) => e.outlet === startOutlet);
    while (stack.length) {
      const e = stack.pop();
      const key = `${e.to}:${e.inlet}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const box = boxes.get(e.to);
      const cls = className(box);
      if (cls === 'deferlow') continue;
      if (cls === 'live.object' && e.inlet === 0) return box.id;
      if (cls === 'live.observer' || cls === 'live.path') continue;
      stack.push(...(edges.get(e.to) ?? []));
    }
    return null;
  };
  for (const box of boxes.values()) {
    const cls = className(box);
    const sources = cls === 'live.observer' ? [0] : cls === 'live.path' ? [1] : [];
    for (const outlet of sources) {
      const hit = reachesObjectUndeferred(box.id, outlet);
      if (hit) problems.push(`change-from-notification: ${box.id} (${box.text}) outlet ${outlet} reaches ${hit} without deferlow`);
    }
  }

  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  const doc = JSON.parse(await readFile(file, 'utf8'));
  const dir = path.dirname(file);
  const problems = lintPatcher(doc, { fileExists: (f) => existsSync(path.join(dir, f)) || existsSync(path.join(dir, '..', 'dist', f)) });
  for (const line of problems) console.error(`✖ ${line}`);
  console.log(problems.length ? `${problems.length} problem(s)` : `✔ ${path.basename(file)} is clean`);
  process.exitCode = problems.length ? 1 : 0;
}
