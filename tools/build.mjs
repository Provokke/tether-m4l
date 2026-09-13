import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle, BUNDLE_NAME } from './bundle.mjs';
import { lintPatcher } from './lint-patcher.mjs';
import { packAmxd } from './amxd.mjs';
import { buildPatcher } from '../device/patcher.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const release = path.join(root, 'Tether');
const committed = path.join(root, 'device', 'tether.maxpat');
const check = process.argv.includes('--check');

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await mkdir(dist, { recursive: true });

const { bytes } = await bundle({ outdir: dist });
console.log(`✔ bundled ${BUNDLE_NAME} (${(bytes / 1024).toFixed(1)} KiB)`);

const doc = buildPatcher({ version: pkg.version, bundleName: BUNDLE_NAME });
const json = `${JSON.stringify(doc, null, '\t')}\n`;

const problems = lintPatcher(doc, { fileExists: (f) => existsSync(path.join(dist, f)) });
if (problems.length) {
  for (const p of problems) console.error(`✖ ${p}`);
  process.exit(1);
}
console.log(`✔ patcher lint clean (${doc.patcher.boxes.length} boxes, ${doc.patcher.lines.length} lines)`);

const amxd = packAmxd(doc, { type: 'audio', meta: 1 });
const releaseFiles = {
  'Tether.amxd': amxd,
  [BUNDLE_NAME]: await readFile(path.join(dist, BUNDLE_NAME)),
  'package.json': Buffer.from(`${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`),
};

if (check) {
  const stale = [];
  const current = existsSync(committed) ? await readFile(committed, 'utf8') : '';
  if (current.replace(/\r\n/g, '\n') !== json) stale.push('device/tether.maxpat');
  for (const [name, content] of Object.entries(releaseFiles)) {
    const file = path.join(release, name);
    if (!existsSync(file) || !(await readFile(file)).equals(content)) stale.push(`Tether/${name}`);
  }
  if (stale.length) {
    console.error(`✖ out of date: ${stale.join(', ')} — run \`npm run build\` and commit`);
    process.exit(1);
  }
}

await writeFile(committed, json);
await writeFile(path.join(dist, 'Tether.maxpat'), json);
await writeFile(path.join(dist, 'Tether.amxd'), amxd);
await mkdir(release, { recursive: true });
for (const [name, content] of Object.entries(releaseFiles)) await writeFile(path.join(release, name), content);
console.log(`✔ wrote Tether/Tether.amxd (${(amxd.length / 1024).toFixed(1)} KiB) and Tether/${BUNDLE_NAME}`);
