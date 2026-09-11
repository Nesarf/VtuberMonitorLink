// make-zip.mjs — 生成发布用的 zip（纯 Node，复用 office.js 里自己写的 zip 写入器）
//
// 为什么不能直接整目录压缩：app/config.json 里有 **API Key**，app/reports 等是你的历史。
// 现在构建会保留运行期数据（见 build-portable.cjs 的暂存逻辑），所以
// 「把 dist/VtuberMonitorLink 整个压进去」就等于把 Key 打进发行包。
// 这里按白/黑名单挑文件，并在结尾把排除了什么明确打出来。
//
// 用法：node tools/make-zip.mjs [dist/VtuberMonitorLink] [输出.zip]
import fs from 'node:fs';
import path from 'node:path';
import { makeZip } from '../server/src/office.js';

const dir = path.resolve(process.argv[2] ?? 'dist/VtuberMonitorLink');
const out = process.argv[3] ? path.resolve(process.argv[3]) : path.join(path.dirname(dir), path.basename(dir) + '.zip');

// 永远不进包的运行期数据（相对包根目录）
const RUNTIME = ['app/config.json', 'app/reports', 'app/feeds', 'app/logs', 'app/watch', 'app/thumbs', 'app/advice', 'app/tmp'];
// 各类开发垃圾
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
  process.stderr.write('make-zip: 目录不存在 ' + dir + '\n');
  process.exit(1);
}
walk(dir);

// 硬保险：包里出现任何 config.json 都要么是模板，要么是泄漏
const leaky = files.filter((f) => /(^|\/)config\.json$/.test(f.name) && !f.name.endsWith('config.example.json'));
if (leaky.length) {
  process.stderr.write('make-zip: 拒绝打包 —— zip 里出现了 config.json（可能含 API Key）：' + leaky.map((f) => f.name).join(', ') + '\n');
  process.exit(2);
}

const buf = makeZip(files);
fs.writeFileSync(out, buf);

// 清单：verify-release 直接读它，不用解压就能断言「包里没有运行期数据」。
// （纯 Node 没有 zip 读取器，清单比让校验脚本去解析 zip 可靠得多。）
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
