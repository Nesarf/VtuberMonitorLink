// make-zip.mjs - build the release zip (pure Node, reusing the zip writer written in office.js)
//
// Why the whole directory cannot simply be zipped: app/config.json holds an **API Key**, and
// app/reports and friends are your history. The build now keeps runtime data (see the staging
// logic in build-portable.cjs), so "zip up all of dist/VtuberMonitorLink" means shipping the key
// inside the release package. This picks files by allow/deny list and prints exactly what was
// excluded at the end.
//
// usage: node tools/make-zip.mjs [dist/VtuberMonitorLink] [out.zip]
import fs from 'node:fs';
import path from 'node:path';
import { makeZip } from '../server/src/office.js';

const dir = path.resolve(process.argv[2] ?? 'dist/VtuberMonitorLink');
const out = process.argv[3] ? path.resolve(process.argv[3]) : path.join(path.dirname(dir), path.basename(dir) + '.zip');

// Runtime data that never enters the package (relative to the package root)
// app/vdb is the local cache of the VDB roster (third-party data under CC BY-NC-SA 4.0): its
// license should not be redistributed with the package, and there is no size reason either -
// one request on the user's side pulls it again.
const RUNTIME = ['app/config.json', 'app/reports', 'app/feeds', 'app/logs', 'app/watch', 'app/thumbs', 'app/advice', 'app/tmp', 'app/vdb'];
// Assorted development junk
const JUNK = ['__pycache__', '.DS_Store', 'Thumbs.db', '.vite', '.cache'];

const excluded = [];
const files = [];

function isExcluded(rel) {
  const p = rel.replace(/\\/g, '/');
  for (const r of RUNTIME) {
    if (p === r || p.startsWith(r + '/')) {
      excluded.push(p);
      return true;
    }
  }
  if (JUNK.some((j) => p.split('/').includes(j))) {
    excluded.push(p);
    return true;
  }
  return false;
}

function walk(base, rel = '') {
  for (const ent of fs.readdirSync(path.join(base, rel), { withFileTypes: true })) {
    const r = rel ? rel + '/' + ent.name : ent.name;
    if (isExcluded(r)) continue;
    if (ent.isDirectory()) walk(base, r);
    else if (ent.isFile()) files.push({ name: r, data: fs.readFileSync(path.join(base, r)) });
  }
}

if (!fs.existsSync(dir)) {
  process.stderr.write('make-zip: directory does not exist ' + dir + '\n');
  process.exit(1);
}
walk(dir);

// Hard safety net: any config.json in the package is either the template or a leak
const leaky = files.filter((f) => /(^|\/)config\.json$/.test(f.name) && !f.name.endsWith('config.example.json'));
if (leaky.length) {
  process.stderr.write('make-zip: refusing to package - config.json showed up in the zip (it may hold an API Key): ' + leaky.map((f) => f.name).join(', ') + '\n');
  process.exit(2);
}

const buf = makeZip(files);
fs.writeFileSync(out, buf);

// Manifest: verify-release reads it directly, so it can assert "no runtime data in the package"
// without unpacking. (Pure Node has no zip reader, and a manifest is far more reliable than
// making the verification script parse the zip.)
fs.writeFileSync(
  out + '.manifest.json',
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      from: dir,
      zip: path.basename(out),
      bytes: buf.length,
      files: files.map((f) => f.name).sort(),
      excluded: [...new Set(excluded)].sort(),
    },
    null,
    2,
  ) + '\n',
  'utf8',
);

const mb = (buf.length / 1024 / 1024).toFixed(1);
process.stdout.write(`zip: ${out} (${files.length} files, ${mb} MB)\n`);
if (excluded.length) {
  const tops = [...new Set(excluded.map((e) => e.split('/').slice(0, 2).join('/')))];
  process.stdout.write('excluded runtime state: ' + tops.join(', ') + '\n');
}
if (fs.existsSync(path.join(dir, 'app', 'config.json'))) {
  process.stdout.write('note: app/config.json exists (your settings) and was deliberately kept OUT of the zip\n');
}
