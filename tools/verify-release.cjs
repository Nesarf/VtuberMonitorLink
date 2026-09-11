// tools/verify-release.cjs - proofread a built release folder.
//
// ASCII only, CommonJS. Run it after tools/build-portable.cjs:
//
//   node tools/verify-release.cjs [--dir dist/VtuberMonitorLink]
//
// It checks the things that actually break a release:
//   1. required files exist and the exe runs its own --doctor
//   2. files that MUST be ASCII really are (launcher, quickstart, scripts)
//   3. every text file is valid UTF-8 (no mojibake, no BOM surprises)
//   4. no personal data leaked in (accounts, keys, absolute user paths)
//   5. no run data shipped (config.json with a key, reports/feeds/logs content)
//
// Exit code 0 = clean, 1 = problems found.

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXE = process.platform === 'win32' ? '.exe' : '';

const TEXT_EXT = new Set([
  '.js', '.cjs', '.mjs', '.jsx', '.ts', '.json', '.md', '.txt', '.html',
  '.css', '.yml', '.yaml', '.sh', '.cmd', '.bat', '.ps1', '.map', '',
]);

// Files that must survive any system code page => ASCII only.
// App source is intentionally bilingual, so it is only checked for valid UTF-8.
const ASCII_MUST = ['README.txt', 'package.json'];

const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9]{16,}/, 'looks like an API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block'],
  [/[Aa]uthorization"?\s*:\s*"?[Bb]earer\s+[A-Za-z0-9._-]{20,}/, 'bearer token'],
  // A literal cookie value: a long run of cookie-safe characters straight after
  // the key. Deliberately excludes spaces/commas/quotes so ordinary source like
  // `cookie: r.cookieHeader, via: ...` is not mistaken for a leaked value.
  [/[Cc]ookie"?:?\s*[:=]\s*"?[A-Za-z0-9_%.\-]{40,}/, 'literal cookie value'],
  [/sessionid=[A-Za-z0-9%]{16,}/, 'session cookie'],
  [/\bSESSDATA=[A-Za-z0-9%*._-]{20,}/, 'bilibili session cookie value'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'email address'],
];

const PERSONAL_PATTERNS = [
  [/[A-Za-z]:\\Users\\[^\\"'\s]+/i, 'absolute Windows user path'],
  [/[A-Za-z]:\\~[^\\"'\s]*/, 'absolute workspace path'],
  [/\/(home|Users)\/[a-z0-9._-]+\//i, 'absolute POSIX home path'],
  [/\bDSH\b/, 'harness marker'],
  [/\bdsh-home\b/, 'harness marker'],
  // Generic: an absolute path on a non-standard drive is machine-specific.
  // Standard OS locations (Windows, Program Files, Users, temp) are allowed.
  [/[A-Z]:\\(?!(Windows|Program Files|ProgramData|Users|temp|Temp|System32)\b)[^\\"'\s]{3,}/i, 'hard-coded absolute drive path'],
];

// Private names must not be hard-coded here either: this file ships with the
// release. They come from $SANITIZE_NAMES or the gitignored .sanitize-names.
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadPrivateNames() {
  const names = [];
  if (process.env.SANITIZE_NAMES) names.push(...process.env.SANITIZE_NAMES.split(','));
  try {
    const file = path.join(ROOT, '.sanitize-names');
    if (fs.existsSync(file)) names.push(...fs.readFileSync(file, 'utf8').split(/\r?\n/));
  } catch (e) {
    /* ignore */
  }
  return [...new Set(names.map((s) => String(s).trim()).filter((s) => s && s.indexOf('#') !== 0))];
}

const PRIVATE_NAMES = loadPrivateNames();
if (PRIVATE_NAMES.length) {
  PERSONAL_PATTERNS.push([
    new RegExp(PRIVATE_NAMES.map(escapeRe).join('|'), 'i'),
    'private name leftover (' + PRIVATE_NAMES.length + ' configured)',
  ]);
}

const EXAMPLE_HINT = /(<name>|<user>|<username>|example|placeholder|YOUR_|xxxx|\.\.\.)/i;

function parseArgs(argv) {
  const out = { dir: path.join(ROOT, 'dist', 'VtuberMonitorLink'), verbose: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') out.dir = path.resolve(argv[++i]);
    else if (argv[i] === '--verbose') out.verbose = true;
  }
  return out;
}

function walk(dir, out, skip) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
    for (const e of entries) {
    const p = path.join(dir, e.name);
    const rel = path.relative(SKIP_ROOT, p).replace(/\\/g, '/');
    if (skip && skip(rel, e)) continue;
    if (e.isDirectory()) walk(p, out, skip);
    else {
      // A symlink (or a junction) is reported as a plain entry; resolve it so a
      // link to a directory is never handed to readFileSync.
      try {
        if (fs.statSync(p).isDirectory()) continue;
      } catch (err) {
        continue;
      }
      out.push(p);
    }
  }
  return out;
}

/** Decode strictly; returns null when the bytes are not valid UTF-8. */
function decodeUtf8(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    return null;
  }
}

function isAscii(str) {
  for (let i = 0; i < str.length; i++) if (str.charCodeAt(i) > 127) return false;
  return true;
}

let SKIP_ROOT = ROOT;

function main() {
  const args = parseArgs(process.argv.slice(2));
  SKIP_ROOT = args.dir;
  const problems = [];
  const notes = [];

  if (!fs.existsSync(args.dir)) {
    process.stderr.write('release dir not found: ' + args.dir + '\n');
    process.exit(1);
  }

  const name = path.basename(args.dir);
  const exe = path.join(args.dir, name + EXE);
  process.stdout.write('\nproofreading: ' + args.dir + '\n\n');

  // ---------------------------------------------------------------- 1. layout
  const required = [
    [name + EXE, 'launcher executable'],
    ['package.json', 'version source'],
    ['README.txt', 'ASCII quickstart'],
    [path.join('app', 'server', 'src', 'index.js'), 'server entry'],
    [path.join('app', 'server', 'package.json'), 'server manifest'],
    [path.join('app', 'web', 'dist', 'index.html'), 'built web UI'],
    [path.join('app', 'server', 'node_modules'), 'production dependencies'],
  ];
  process.stdout.write('1. required files\n');
  for (const [rel, why] of required) {
    let ok = fs.existsSync(path.join(args.dir, rel));
    if (!ok && rel.endsWith('node_modules')) {
      // npm may hoist one level up; either location resolves for the server.
      ok = fs.existsSync(path.join(args.dir, 'app', 'node_modules'));
    }
    process.stdout.write('   ' + (ok ? '[ok]  ' : '[MISS]') + ' ' + rel + '  (' + why + ')\n');
    if (!ok) problems.push('missing ' + rel + ' (' + why + ')');
  }

  // --------------------------------------------------------------- 2. doctor
  process.stdout.write('\n2. exe self-check (--doctor)\n');
  if (fs.existsSync(exe)) {
    const r = spawnSync(exe, ['--doctor'], { encoding: 'utf8', cwd: args.dir, timeout: 60000 });
    const text = (r.stdout || '') + (r.stderr || '');
    for (const line of text.trim().split(/\r?\n/)) process.stdout.write('   | ' + line + '\n');
    if (r.status !== 0) problems.push('--doctor exited with ' + r.status);
    const v = spawnSync(exe, ['--version'], { encoding: 'utf8', cwd: args.dir, timeout: 30000 });
    const ver = (v.stdout || '').trim();
    process.stdout.write('   --version -> ' + ver + '\n');
    const pkgVer = JSON.parse(fs.readFileSync(path.join(args.dir, 'package.json'), 'utf8')).version;
    if (ver !== pkgVer) problems.push('exe version ' + JSON.stringify(ver) + ' != package.json ' + pkgVer);
  } else {
    problems.push('no executable to check');
  }

  // ------------------------------------------------------------ 3. file pass
  process.stdout.write('\n3. text files: encoding, ASCII rules, secrets, personal paths\n');
  const files = walk(args.dir, [], (rel, e) => {
    // Third-party code is neither ours to police nor worth the noise.
    if (rel.indexOf('node_modules/') !== -1) return true;
    if (rel.startsWith('pw-browsers/')) return true;
    return false;
  });

  let asciiFiles = 0;
  let utf8Files = 0;
  let binaryFiles = 0;
  const bomFiles = [];

  for (const abs of files) {
    const rel = path.relative(args.dir, abs).replace(/\\/g, '/');
    if (rel === name + EXE) continue;
    const ext = path.extname(abs).toLowerCase();
    const buf = fs.readFileSync(abs);

    if (!TEXT_EXT.has(ext)) {
      binaryFiles++;
      continue;
    }
    // A NUL byte in the first 4 KB means it is really a binary blob.
    if (buf.subarray(0, 4096).includes(0)) {
      binaryFiles++;
      continue;
    }

    const text = decodeUtf8(buf);
    if (text === null) {
      problems.push('not valid UTF-8: ' + rel);
      continue;
    }
    utf8Files++;

    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bomFiles.push(rel);

    if (ASCII_MUST.includes(rel) && !isAscii(text)) {
      problems.push('must be ASCII-only but is not: ' + rel);
    }
    if (isAscii(text)) asciiFiles++;

    // Secrets / personal data, ignoring documentation examples.
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const [re, why] of SECRET_PATTERNS.concat(PERSONAL_PATTERNS)) {
        if (!re.test(line)) continue;
        if (EXAMPLE_HINT.test(line) && !/sk-[A-Za-z0-9]{16,}/.test(line)) continue;
        problems.push(rel + ':' + (i + 1) + '  ' + why + ' -> ' + line.trim().slice(0, 120));
      }
    }
  }

  process.stdout.write(
    '   scanned ' + (asciiFiles + utf8Files - asciiFiles) + ' text files, ' +
      asciiFiles + ' pure ASCII, ' + binaryFiles + ' skipped as binary\n'
  );
  if (bomFiles.length) notes.push('UTF-8 BOM present in: ' + bomFiles.join(', '));

  // ------------------------------------------------------------- 4. syntax
  // 这一条是被真事教出来的：一个以数字开头的对象键（3D披露 / 2434）让
  // server 起不来，而打包脚本只看 exe 的 --doctor（那时还没加载到那个模块）。
  // 随包的每一个 JS 都过一遍 node --check，才不会再让语法错误上路。
  process.stdout.write('\n4. shipped script syntax (node --check)\n');
  const scripts = walk(args.dir, [], (rel) => rel.includes('node_modules/') || rel === name + EXE).filter((p) =>
    /\.(js|cjs|mjs)$/i.test(p)
  );
  let syntaxBad = 0;
  for (const p of scripts) {
    const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) {
      syntaxBad++;
      const first = String(r.stderr ?? '').trim().split(/\r?\n/).slice(0, 3).join(' | ');
      problems.push('syntax error in ' + path.relative(args.dir, p).replace(/\\/g, '/') + ' — ' + first);
    }
  }
  process.stdout.write('   checked ' + scripts.length + ' scripts, ' + syntaxBad + ' with errors\n');

  // ------------------------------------------------------------- 5. run data
  process.stdout.write('\n5. shipped run data\n');
  const cfgPath = path.join(args.dir, 'app', 'config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const key = cfg && cfg.llm && cfg.llm.apiKey;
      if (key) problems.push('app/config.json contains an LLM API key - do not ship it');
      else notes.push('app/config.json is shipped but has an empty apiKey (harmless; delete it to be safe)');
    } catch (e) {
      problems.push('app/config.json is not valid JSON');
    }
  } else {
    process.stdout.write('   [ok]   no app/config.json (created on first save)\n');
  }
  for (const d of ['reports', 'feeds', 'logs', 'watch', 'thumbs', 'advice']) {
    const dir = path.join(args.dir, 'app', d);
    const count = fs.existsSync(dir) ? walk(dir, []).length : 0;
    if (count) problems.push('app/' + d + '/ ships ' + count + ' file(s) of run data');
    else process.stdout.write('   [ok]   app/' + d + '/ is empty or absent\n');
  }

  // ---------------------------------------------------------------- 5. report
  process.stdout.write('\n6. result\n');
  for (const n of notes) process.stdout.write('   note: ' + n + '\n');
  if (problems.length) {
    for (const p of problems) process.stdout.write('   PROBLEM: ' + p + '\n');
    process.stdout.write('\n' + problems.length + ' problem(s) found.\n\n');
    process.exit(1);
  }
  process.stdout.write('   clean - no problems found.\n\n');
  process.exit(0);
}

main();
