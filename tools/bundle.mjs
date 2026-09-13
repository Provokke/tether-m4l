import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const BUNDLE_NAME = 'tether-bridge.js';

export async function bundle({ outdir = path.join(root, 'dist') } = {}) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const outfile = path.join(outdir, BUNDLE_NAME);
  const result = await build({
    entryPoints: [path.join(root, 'node', 'src', 'max-entry.js')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node16',
    external: ['max-api', 'bufferutil', 'utf-8-validate'],
    define: { __TETHER_VERSION__: JSON.stringify(pkg.version) },
    minify: true,
    legalComments: 'none',
    logLevel: 'silent',
    metafile: true,
  });
  await writeFile(path.join(outdir, 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);
  const bytes = Object.values(result.metafile.outputs)[0].bytes;
  return { outfile, bytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { outfile, bytes } = await bundle();
  console.log(`bundled ${path.relative(root, outfile)} (${(bytes / 1024).toFixed(1)} KiB)`);
}
