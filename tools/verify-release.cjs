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

/**
 * 运行期状态（**不随发布包出去**，由 make-zip.mjs 排除）。
 * 构建会刻意保留它们；secret 扫描与「已发布数据」检查都要按这个名单区分。
 */
const RUNTIME_STATE_RELS = ['config.json', 'reports', 'feeds', 'logs', 'watch', 'thumbs', 'advice'];

/**
 * 找到 make-zip.mjs 生成的发布包清单（zip 同级或上级目录）。
 * 为什么要清单：纯 Node 没有 zip 读取器，而「包里到底有没有运行期数据」
 * 必须能断言 —— 让打包脚本自己写下文件列表，校验脚本读 JSON 即可。
 */
function findZipManifest(dir) {
  const dirs = [dir, path.dirname(dir)];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    const hit = fs
      .readdirSync(d)
      .filter((f) => f.endsWith('.zip.manifest.json'))
      .map((f) => path.join(d, f));
    if (hit.length) {
      hit.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      return hit[0];
    }
  }
  return null;
}

/**
 * 命中密钥时把密钥本身替换掉，只留下「哪里、多长」。
 * 自检的第一职责是不泄漏 —— 把 API Key 原文写进 stdout/日志等于自己制造事故。
 */
function redact(line, re) {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  return line
    .replace(new RegExp(re.source, flags), (m) => m.slice(0, 3) + '\u2026<' + m.length + ' chars redacted>')
    .trim()
    .slice(0, 120);
}

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
    // 本机的运行期状态（config.json / 历史 / 日志）不在发布zip里 —— make-zip 保证
    // 了这件事，清单检查（第 5 节）会盯着它。所以这里跳过，否则每次自检都会
    // 把「你自己的 Key 在你自己的 dist 里」当成发布事故（假警报会让人忽略真警报）。
    if (RUNTIME_STATE_RELS.some((r) => rel === 'app/' + r || rel.startsWith('app/' + r + '/'))) return true;
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
    const secretPatterns = SECRET_PATTERNS.map(([re, why]) => [re, why, true]);
    const personalPatterns = PERSONAL_PATTERNS.map(([re, why]) => [re, why, false]);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const [re, why, isSecret] of secretPatterns.concat(personalPatterns)) {
        if (!re.test(line)) continue;
        if (EXAMPLE_HINT.test(line) && !/sk-[A-Za-z0-9]{16,}/.test(line)) continue;
        // 命中密钥时只报「哪个文件、哪一行、多长」，**绝不回显密钥本身**：
        // 自检把 API Key 原样打进控制台/日志，本身就是一次泄漏（真的发生过）。
        problems.push(rel + ':' + (i + 1) + '  ' + why + ' -> ' + (isSecret ? redact(line, re) : line.trim().slice(0, 120)));
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
  //
  // 注意这里的分工：`dist/<name>/app/` 是**开发者本机自己的运行期数据**
  // （API Key、历史报告）。构建现在会刻意保留它（不然每次重新打包就把 Key 清空，
  // 那是真的踩过）。真正决定「发布出去的是什么」的是 zip，由 make-zip.mjs 的
  // 清单（.manifest.json）来断言 —— 所以这里的 dist/app 只提示，不再当问题。
  process.stdout.write('\n5. shipped run data\n');
  const RUNTIME_RELS = RUNTIME_STATE_RELS;

  const manifestPath = findZipManifest(args.dir);
  if (manifestPath) {
    const rel = path.relative(args.dir, manifestPath).replace(/\\/g, '/');
    try {
      const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const bad = (man.files ?? []).filter((f) => RUNTIME_RELS.some((r) => f === 'app/' + r || f.startsWith('app/' + r + '/')));
      if (bad.length) {
        problems.push('release zip includes runtime state: ' + bad.slice(0, 5).join(', ') + (bad.length > 5 ? ` (+${bad.length - 5})` : ''));
      } else {
        process.stdout.write(
          '   [ok]   release zip is clean (' + (man.files ?? []).length + ' files, ' + (man.excluded ?? []).length + ' runtime paths excluded)  -- ' + rel + '\n',
        );
      }
    } catch (e) {
      problems.push('zip manifest is not valid JSON: ' + rel);
    }
  } else {
    notes.push('no zip manifest found next to the build; build with npm run build:portable to get one');
  }

  const cfgPath = path.join(args.dir, 'app', 'config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      // 递归找 apiKey：它以前是 llm.apiKey，现在是 llm.providers[].apiKey ——
      // 只看旧路径会给出「没有 Key」的假阴性（踩过）。
      const hasKey = (function find(v) {
        if (!v || typeof v !== 'object') return false;
        for (const [k, val] of Object.entries(v)) {
          if (/^api_?key$/i.test(k) && typeof val === 'string' && val.trim()) return true;
          if (find(val)) return true;
        }
        return false;
      })(cfg);
      // 只说「有没有」，永远不打印 Key 本身
      notes.push('app/config.json = your local settings (' + (hasKey ? 'an API key is stored here' : 'no API key stored') + '); make-zip keeps it out of the release zip');
    } catch (e) {
      problems.push('app/config.json is not valid JSON');
    }
  } else {
    process.stdout.write('   [ok]   no app/config.json (created on first save)\n');
  }
  for (const d of ['reports', 'feeds', 'logs', 'watch', 'thumbs', 'advice']) {
    const dir = path.join(args.dir, 'app', d);
    const count = fs.existsSync(dir) ? walk(dir, []).length : 0;
    if (count) notes.push('app/' + d + '/ holds ' + count + ' file(s) of local run data (kept out of the release zip)');
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
