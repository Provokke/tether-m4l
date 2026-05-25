import { readFileSync } from 'node:fs';

export function readCa(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, missing: err.code === 'ENOENT', error: err.message };
  }
  if (!text.includes('-----BEGIN CERTIFICATE-----')) {
    return { ok: false, missing: false, error: 'file contains no PEM certificate' };
  }
  return { ok: true, pem: text };
}
