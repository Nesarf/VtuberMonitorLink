// size-report.mjs — where this checkout's bytes are, and whether the checkout is inside its size band.
//
// Why this exists: the tree was tidied once (253 MB -> 153 MB) by deleting things that looked unused, and the
// owner's rule afterwards was explicit - keep the whole thing **under 1 GB but not below ~400 MB**, because the
// floor is what stops "slimming" from quietly removing something the product still needs. A number nobody measures
// is not a rule, so this prints the breakdown and states the verdict.
//
// Two honest numbers, because they answer different questions:
//   * the **checkout** - every file physically inside this directory (junctions not followed, so a junction is
//     reported as a junction and its target's bytes are counted where they actually live);
//   * the **footprint of this product** - the checkout plus the engines it needs out of a shared cache. The
//     Chromium copies sitting in the same cache belong to whatever else shares it, so they are reported and *not*
//     counted, and certainly not deleted to make a number smaller.
//
// Usage: node tools/size-report.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FLOOR_MB = 400;
export const CEILING_MB = 1024;

// The engines this product actually needs, from the repository's own rule rather than from taste: integrity-check
// section 5j ("the bundled browser is Firefox, alone") fails the gate if the source reaches for Chromium again.
export const NEEDED_BROWSERS = ['firefox'];

const ENGINE_RE = /^(chromium|firefox|webkit|ffmpeg|winldd)[-_]?/i;

/** Every regular file under `dir`, with reparse points (junctions/symlinks) reported instead of walked. */
export function walk(dir) {
  const files = [];
  const links = [];
  const stack = [dir];
  while (stack.length) {
    const here = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(here, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(here, e.name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        let target = null;
        try {
          target = fs.realpathSync(full);
        } catch {
          target = null;
        }
        links.push({ path: full, target });
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else files.push({ path: full, bytes: st.size });
    }
  }
  return { files, links };
}

/** Bytes under a directory, junctions not followed (a target is measured where it lives). */
export function sizeOf(dir) {
  return walk(dir).files.reduce((n, f) => n + f.bytes, 0);
}

export function report(root = ROOT) {
  const { files, links: found } = walk(root);
  const checkout = files.reduce((n, f) => n + f.bytes, 0);
  const byTop = new Map();
  for (const f of files) {
    const rel = path.relative(root, f.path);
    const top = rel.includes(path.sep) ? rel.split(path.sep)[0] : '(root files)';
    byTop.set(top, (byTop.get(top) ?? 0) + f.bytes);
  }
  const top = [...byTop.entries()].sort((a, b) => b[1] - a[1]);
  const mb = (n) => Math.round((n / (1024 * 1024)) * 10) / 10;

  // A linked cache is split into "the engines this product needs" and "everything else sharing it".
  const links = [];
  let needed = 0;
  let shared = 0;
  for (const l of found) {
    // A junction that points back inside the checkout (the workspace links `node_modules/<pkg> -> server|web` are
    // exactly that) contributes nothing new: those bytes are already in the checkout total, and calling them
    // "shared with other projects" would read as if another project were holding them.
    const internal = l.target ? path.resolve(l.target).startsWith(path.resolve(root) + path.sep) : false;
    if (!l.target || internal) {
      links.push({ path: path.relative(root, l.path), target: l.target, internal, neededMB: 0, sharedMB: 0 });
      continue;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(l.target, { withFileTypes: true });
    } catch {
      entries = [];
    }
    let neededHere = 0;
    let sharedHere = 0;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const bytes = sizeOf(path.join(l.target, e.name));
      const engine = ENGINE_RE.exec(e.name)?.[1]?.toLowerCase();
      if (engine && NEEDED_BROWSERS.includes(engine)) neededHere += bytes;
      else sharedHere += bytes;
    }
    needed += neededHere;
    shared += sharedHere;
    links.push({
      path: path.relative(root, l.path),
      target: l.target,
      internal: false,
      neededMB: mb(neededHere),
      sharedMB: mb(sharedHere),
    });
  }

  return {
    root,
    files: files.length,
    checkoutMB: mb(checkout),
    attributedMB: mb(checkout + needed),
    sharedElsewhereMB: mb(shared),
    top: top.map(([name, bytes]) => ({ name, mb: mb(bytes) })),
    links,
    neededBrowsers: NEEDED_BROWSERS,
    floorMB: FLOOR_MB,
    ceilingMB: CEILING_MB,
    withinBand: mb(checkout + needed) >= FLOOR_MB && mb(checkout + needed) <= CEILING_MB,
  };
}

function main() {
  const r = report();
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  } else {
    process.stdout.write(`checkout: ${r.checkoutMB} MB in ${r.files} files (junctions not followed)\n`);
    for (const t of r.top.slice(0, 10)) process.stdout.write(`  ${String(t.mb).padStart(8)} MB  ${t.name}\n`);
    for (const l of r.links) {
      if (l.internal) {
        process.stdout.write(`  junction ${l.path} -> ${l.target} (points back inside the checkout, already counted)\n`);
        continue;
      }
      process.stdout.write(
        `  junction ${l.path} -> ${l.target}\n` +
          `    needed here (${r.neededBrowsers.join('/')}): ${l.neededMB} MB | shared with other projects: ${l.sharedMB} MB\n`
      );
    }
    process.stdout.write(`this product's footprint (checkout + the engines it needs): ${r.attributedMB} MB\n`);
    process.stdout.write(`elsewhere in the same caches, other projects' bytes: ${r.sharedElsewhereMB} MB (not counted, not deleted)\n`);
    process.stdout.write(`band: ${r.floorMB} MB .. ${r.ceilingMB} MB -> ${r.withinBand ? 'inside' : 'OUTSIDE'}\n`);
  }
  if (r.attributedMB > CEILING_MB) {
    process.stdout.write('over the ceiling: trim regenerable artifacts (old packages, build intermediates, caches), never source\n');
    process.exit(1);
  }
  if (r.attributedMB < FLOOR_MB) {
    process.stdout.write(
      'under the floor: on a machine that is set up to run this product that usually means something that belongs is missing.\n' +
        'A fresh clone without node_modules or a built package is legitimately small - check which of the two this is before adding anything.\n'
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
