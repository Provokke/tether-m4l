import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPE_TO_CODE = { audio: 'aaaa', midi: 'mmmm', instrument: 'iiii' };
const CODE_TO_TYPE = Object.fromEntries(Object.entries(TYPE_TO_CODE).map(([k, v]) => [v, k]));
const HEADER_BYTES = 32;

export function packAmxdBody(body, { type = 'audio', meta = 1 } = {}) {
  const code = TYPE_TO_CODE[type];
  if (!code) throw new Error(`unknown device type "${type}" (audio, midi, instrument)`);
  const header = Buffer.alloc(HEADER_BYTES);
  header.write('ampf', 0, 'latin1');
  header.writeUInt32LE(4, 4);
  header.write(code, 8, 'latin1');
  header.write('meta', 12, 'latin1');
  header.writeUInt32LE(4, 16);
  header.writeUInt32LE(meta >>> 0, 20);
  header.write('ptch', 24, 'latin1');
  header.writeUInt32LE(body.length, 28);
  return Buffer.concat([header, body]);
}

export function packAmxd(patcher, options) {
  if (!patcher || typeof patcher.patcher !== 'object') throw new Error('expected a patcher document: { "patcher": { … } }');
  const body = Buffer.from(`${JSON.stringify(patcher, null, '\t')}\n\0`, 'utf8');
  return packAmxdBody(body, options);
}

export function unpackAmxd(buf) {
  if (buf.length < HEADER_BYTES) throw new Error(`not an .amxd: ${buf.length} bytes is shorter than the header`);
  const tag = (at) => buf.toString('latin1', at, at + 4);
  if (tag(0) !== 'ampf') throw new Error(`not an .amxd: bad magic "${tag(0)}"`);
  const type = CODE_TO_TYPE[tag(8)];
  if (!type) throw new Error(`unknown device type code "${tag(8)}"`);
  if (tag(12) !== 'meta' || tag(24) !== 'ptch') throw new Error('not an .amxd: missing meta/ptch chunk');
  const meta = buf.readUInt32LE(20);
  const length = buf.readUInt32LE(28);
  if (HEADER_BYTES + length > buf.length) throw new Error(`truncated: ptch declares ${length} bytes, file has ${buf.length - HEADER_BYTES}`);
  if (HEADER_BYTES + length < buf.length) throw new Error(`${buf.length - HEADER_BYTES - length} unexpected bytes after the ptch chunk`);
  const body = buf.subarray(HEADER_BYTES);
  if (body.toString('latin1', 0, 4) === 'mx@c') return { type, meta, frozen: true, body, patcher: null };
  const text = body.toString('utf8').replace(/\0+$/, '');
  let patcher;
  try {
    patcher = JSON.parse(text);
  } catch (err) {
    throw new Error(`ptch chunk is not valid JSON: ${err.message}`);
  }
  return { type, meta, frozen: false, body, patcher };
}

async function main([cmd, input, output, ...flags]) {
  const flag = (name, fallback) => {
    const i = flags.indexOf(`--${name}`);
    return i === -1 ? fallback : flags[i + 1];
  };
  if (cmd === 'pack' && input && output) {
    const doc = JSON.parse(await readFile(input, 'utf8'));
    await writeFile(output, packAmxd(doc, { type: flag('type', 'audio'), meta: Number(flag('meta', 1)) }));
    console.log(`packed ${output}`);
  } else if (cmd === 'unpack' && input && output) {
    const r = unpackAmxd(await readFile(input));
    if (r.frozen) throw new Error('frozen device: the patcher is inside an mx@c container; unfreeze it in Max first');
    await writeFile(output, `${JSON.stringify(r.patcher, null, '\t')}\n`);
    console.log(`unpacked ${r.type} device to ${output}`);
  } else if (cmd === 'inspect' && input) {
    const r = unpackAmxd(await readFile(input));
    const p = r.patcher?.patcher;
    console.log(JSON.stringify({
      type: r.type,
      meta: r.meta,
      frozen: r.frozen,
      bytes: r.body.length + HEADER_BYTES,
      appversion: p?.appversion,
      boxes: p?.boxes?.length,
      lines: p?.lines?.length,
      devicewidth: p?.devicewidth,
    }, null, 2));
  } else {
    console.error('usage: amxd.mjs pack <patcher.json> <out.amxd> [--type audio|midi|instrument] [--meta n]\n'
      + '       amxd.mjs unpack <device.amxd> <out.maxpat>\n'
      + '       amxd.mjs inspect <device.amxd>');
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
