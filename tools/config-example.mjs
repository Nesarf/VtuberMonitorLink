// config-example.mjs — keep config.example.json equal to the real defaults, and never carrying a value
//
// Why this exists: `config.example.json` is the file a user copies to `config.json`, and the packager copies it
// into the packaged app, so a stale example teaches a shape the product no longer has. It had drifted exactly
// that way once - the legacy flat `llm` block (no activeId, no providers, no budget), a `proxy` block missing
// everything the Tor work added, and 8 of the 24 sections the product actually has. The v1.0.6 notes recorded
// that it is "generated from the real defaults"; what that round did was generate the file **once**, by hand,
// and nothing kept it true afterwards - so the claim was ahead of the tree until this tool existed.
//
//   node tools/config-example.mjs            rewrite config.example.json from DEFAULT_CONFIG
//   node tools/config-example.mjs --check    fail if the committed file is not what the defaults say
//
// `--check` is what the fast gate runs: it is the difference between "the file was generated once" and "the
// file cannot drift", which is the same distinction this repository keeps making everywhere else.
//
// The guard: the defaults are empty wherever a secret lives, and this refuses to write a file in which any
// secret-shaped key holds a non-empty value (the name list is the config module's own, so a new secret field
// needs no declaration here). An example config that carries a real value is worse than a stale one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, secretNameRes } from '../server/src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'config.example.json');
const check = process.argv.includes('--check');

/** Every leaf whose key name is secret-shaped and whose value is a non-empty scalar. */
function secretValues(value, prefix = '', out = []) {
  if (!value || typeof value !== 'object') return out;
  const names = secretNameRes();
  for (const [k, v] of Object.entries(value)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') secretValues(v, p, out);
    else if (names.some((re) => re.test(k)) && v !== '' && v !== null && v !== undefined) out.push(p);
  }
  return out;
}

/** Leaf paths whose values differ, so a failed check can name the drift instead of printing two files. */
function differingPaths(a, b, prefix = '', out = []) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    const p = prefix ? `${prefix}.${k}` : k;
    const av = a?.[k];
    const bv = b?.[k];
    const aObj = av && typeof av === 'object';
    const bObj = bv && typeof bv === 'object';
    if (aObj && bObj) differingPaths(av, bv, p, out);
    else if (JSON.stringify(av) !== JSON.stringify(bv)) out.push(`${p} (example: ${JSON.stringify(bv)}, defaults: ${JSON.stringify(av)})`);
    if (out.length > 5) return out;
  }
  return out;
}

const leaks = secretValues(DEFAULT_CONFIG);
if (leaks.length) {
  process.stderr.write(
    `refusing to write an example config: the defaults carry a value in a secret-shaped key (${leaks.join(', ')}).\n` +
      'The defaults are supposed to be empty there; an example that ships a value is worse than a stale one.\n'
  );
  process.exit(1);
}

const text = JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n';

if (check) {
  if (!fs.existsSync(TARGET)) {
    process.stderr.write('config.example.json is missing (regenerate it with: node tools/config-example.mjs)\n');
    process.exit(1);
  }
  const onDisk = fs.readFileSync(TARGET, 'utf8');
  if (onDisk === text) {
    const sections = Object.keys(DEFAULT_CONFIG).length;
    process.stderr.write(`config.example.json matches the defaults exactly (${sections} sections, ${text.split('\n').length} lines)\n`);
    process.exit(0);
  }
  let reported = [];
  try {
    reported = differingPaths(DEFAULT_CONFIG, JSON.parse(onDisk));
  } catch (e) {
    process.stderr.write(`config.example.json is not valid JSON: ${e.message}\n`);
    process.exit(1);
  }
  process.stderr.write(
    'config.example.json is not what DEFAULT_CONFIG says' +
      (reported.length ? ': ' + reported.slice(0, 5).join('; ') : ' (the bytes differ, the parsed values do not)') +
      '\nregenerate it with: node tools/config-example.mjs\n'
  );
  process.exit(1);
}

fs.writeFileSync(TARGET, text, 'utf8');
process.stdout.write(
  `config.example.json written from DEFAULT_CONFIG (${Object.keys(DEFAULT_CONFIG).length} sections, ${text.split('\n').length} lines)\n`
);
