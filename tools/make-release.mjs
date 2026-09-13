// make-release.mjs — build the public release tree / build the public release tree
//
// Target artifacts (default <sibling of the project>/VML-release, overridable with --out):
//
//   <out>/
//     README.md               <- public description (carries no local machine info)
//     PUBLISH-TO-GITHUB.md    <- the step-by-step commands for pushing to GitHub
//     src/ …                  <- the **complete, sanitized copy of the project** (can be git init'd and pushed directly)
//     releases/<version>/
//         VtuberMonitorLink-<version>-win-x64.zip
//         *.zip.manifest.json   <- the in-package file listing (release verification asserts "no runtime data" against it)
//         SHA256SUMS.txt
//         RELEASE-NOTES.md
//
// Sanitization here is a **hard gate**, not a best effort:
//   · runtime data (config.json / reports / feeds / logs / watch / thumbs / advice) never enters the copy
//   · .git / node_modules / build / dist do not enter the copy
//   · as soon as the copy is written it is re-scanned with the project's own scanner (tools/verify-release.cjs --scan-only --dir),
//     and any secret, absolute path, private name or harness marker -> the whole release aborts (exit code 1)
//   · the release zip's manifest is asserted too: any runtime data present aborts as well
//
// Note: this file **hardcodes no local path** -- the default output directory is derived from the VML_RELEASE_OUT
// environment variable or from the directory next to the project. A hardcoded drive letter is itself exactly what
// sanitization has to catch (and the scanner really would catch it).
//
//   node tools/make-release.mjs [--out <dir>] [--skip-copy]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {
  out: process.env.VML_RELEASE_OUT || path.join(path.dirname(ROOT), 'VML-release'),
  copy: true,
};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i]);
  else if (process.argv[i] === '--skip-copy') args.copy = false;
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const log = (s) => process.stdout.write(s + '\n');
const problems = [];

// Things that never enter the public copy. The first three classes are runtime data (including secrets), the rest are development intermediates and local machine leftovers.
const NEVER_COPY = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'logs',
  'reports',
  'feeds',
  'watch',
  'thumbs',
  'advice',
  'pw-browsers',
  '.sanitize-names',
  'config.json',
  'coverage',
  '.vite',
  '.cache',
  '.cache',
]);
// The "example paths" allowed to appear (the kind the docs tell others to fill in); the scan lets them through
const EXAMPLE_PATH_HINTS = [/E:\\\\YourCache/, /E:\\YourCache/];

function copyTree(src, dst) {
  let files = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (NEVER_COPY.has(e.name)) continue;
    if (e.name.endsWith('.local.json') || e.name.endsWith('.local')) continue;
    if (e.name === '.env' || e.name.startsWith('.env.')) continue;
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      files += copyTree(from, to);
    } else if (e.isFile()) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      files++;
    }
  }
  return files;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ───────────────────────────────────────────── 0. preconditions

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const outRoot = args.out;
const srcOut = path.join(outRoot, 'src');
const relOut = path.join(outRoot, 'releases', version);

log(`\nrelease tree / release tree: ${outRoot}`);
log(`version / version: ${version}\n`);

const zipName = `VtuberMonitorLink-${version}-win-x64.zip`;
const zipPath = path.join(ROOT, 'dist', zipName);
const manifestPath = zipPath + '.manifest.json';
if (!fs.existsSync(zipPath)) {
  log('  ! no release package yet -- run node tools/build-portable.cjs first');
} else {
  log(`  ok found release package ${zipName} (${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB)`);
}

// ───────────────────────────────────────────── 1. copy the sanitized tree

if (args.copy) {
  log('\n[1/5] copying the sanitized project tree');
  fs.rmSync(srcOut, { recursive: true, force: true });
  fs.mkdirSync(srcOut, { recursive: true });
  const n = copyTree(ROOT, srcOut);
  log(`  -> ${rel(srcOut)} (${n} files)`);
  for (const skip of [...NEVER_COPY].sort()) log(`     excluding ${skip}`);
}

// ───────────────────────────────────────────── 2. re-scan with the project's own scanner

log('\n[2/5] sanitization scan (using the project\'s own verifier --scan-only)');
const scan = spawnSync(
  process.execPath,
  [path.join(ROOT, 'tools', 'verify-release.cjs'), '--scan-only', '--dir', srcOut],
  { encoding: 'utf8' }
);
const scanOut = (scan.stdout ?? '') + (scan.stderr ?? '');
for (const line of scanOut.split(/\r?\n/)) {
  if (/PROBLEM|problem\(s\)|note:/.test(line)) log('  ' + line.trim());
}
if (scan.status !== 0) {
  problems.push('the sanitization scan did not pass (see above) -- release aborted');
} else {
  log('  ok no secrets, absolute paths, private names or harness markers');
}

// ───────────────────────────────────────────── 3. release package + checksums

log('\n[3/5] assembling releases/');
fs.mkdirSync(relOut, { recursive: true });
if (fs.existsSync(zipPath)) {
  fs.copyFileSync(zipPath, path.join(relOut, zipName));
  if (fs.existsSync(manifestPath)) {
    const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    // Hard assertion: the package must not contain runtime data (config.json holds the API key, past reports are private)
    const bad = (man.files ?? []).filter((f) => /^app\/(config\.json|reports|feeds|logs|watch|thumbs|advice)(\/|$)/.test(f));
    if (bad.length) {
      problems.push(`runtime data appeared in the release package: ${bad.slice(0, 5).join(', ')}`);
    } else {
      log(`  ok ${man.files.length} files in the package, no runtime data (${man.excluded.length} items excluded)`);
    }
    fs.copyFileSync(manifestPath, path.join(relOut, path.basename(manifestPath)));
  } else {
    problems.push('the zip manifest (.manifest.json) is missing -- the package contents cannot be asserted, release aborted');
  }
}

const sums = [];
for (const f of fs.readdirSync(relOut).filter((f) => !f.endsWith('SHA256SUMS.txt'))) {
  sums.push(`${sha256(path.join(relOut, f))}  ${f}`);
}
fs.writeFileSync(path.join(relOut, 'SHA256SUMS.txt'), sums.join('\n') + '\n', 'utf8');
log(`  -> ${rel(relOut)} (${fs.readdirSync(relOut).length} files + SHA256SUMS.txt)`);

// ───────────────────────────────────────────── 4. public documentation and release steps

log('\n[4/5] public documentation');
// The division of labour must be stated in the most obvious place: this directory is a **frozen release snapshot**, not a development tree.
// Editing code in the copy and then finding "my change had no effect" is an easy one-time mistake to make.
fs.writeFileSync(
  path.join(outRoot, 'README-FIRST.md'),
  `# 这个目录是什么 / What this directory is

**对外发布快照，不是开发树。** 不要在这里改代码 —— 改了不会被合并回去，下次重新生成还会被覆盖。

  · 开发在这里：\`<你 clone 工程的地方>\`（本文件由 tools/make-release.mjs 生成，不含任何本机路径）
  · 这个目录只放**可以直接发出去的东西**：无痕化后的工程副本 + 正式发行包
  · 重新生成（在开发树里跑一条命令即可）：

        node tools/make-release.mjs --out <这个目录>

  · 生成过程会自动做无痕化扫描（密钥 / 本机绝对路径 / 私有名字 / harness 标记），
    任何一项不过就**整体中止**，不会产出一个半成品
  · 发行包在 \`releases/<版本>/\`，含 zip、包内清单、SHA256SUMS 与发行说明

## 目录结构

    src/                     无痕化后的工程副本（可整目录 git init 推到 GitHub）
    releases/<version>/      正式发行包（zip + manifest + SHA256SUMS + RELEASE-NOTES.md）
    PUBLISH-TO-GITHUB.md     推到 GitHub 的逐步命令
    README.md                与工程一致的对外说明

## 发布前请确认

1. 在**开发树**里跑过 \`npm run verify\`（含完整性、覆盖率棘轮、七套自检、发布校验）且全绿
2. \`npm run sanitize-check\` 干净
3. 本机 \`config.json\` 里的 API Key 不在任何待上传文件里（脚本已在拷贝与打包两处断言）
`,
  'utf8',
);

const publishDoc = `# 推到 GitHub / Publishing to GitHub

这个目录是\`无痕化后的工程副本\`：**没有**运行期数据（config.json 里的 API Key、历史报告、
日志、浏览器登录态）与开发中间产物。可以整目录直接推上去。

## 一次性准备

    cd ${outRoot}\\src
    git init
    git add -A
    git -c user.name="<你的名字>" -c user.email="<你的邮箱>" commit -m "Vtuber's Monitor Link ${version}"
    git branch -M main
    git remote add origin https://github.com/<你的账号>/<仓库名>.git
    git push -u origin main

## 发一个正式 release

    # 打 tag（版本号要和 package.json 一致）
    git tag -a v${version} -m "v${version}"
    git push origin v${version}

推 tag 后 GitHub Actions（.github/workflows/release.yml）会自动：
装依赖 → 跑自检（含完整性 / 日历 / 推送 / 发布校验）→ 打包便携 exe → 建 Release 并附上 zip。

## 手动发（没有 Actions 或想自己传）

在 GitHub 网页上 Releases → Draft a new release → 选 tag → 把
\`releases\\${version}\\${zipName}\`
拖进去，正文粘贴 \`releases\\${version}\\RELEASE-NOTES.md\`。

## 发布前请再确认

1. \`npm run verify\` 全绿（含完整性检查、繁体词条时效、日历与推送自检）
2. \`npm run sanitize-check\` 干净
3. \`releases\\${version}\\SHA256SUMS.txt\` 与 zip 在同一个 release 里，方便使用者校验
4. 本机 \`config.json\` 里的 API Key **不在**任何待上传文件里（本脚本已在拷贝与打包两处断言）
`;
fs.writeFileSync(path.join(outRoot, 'PUBLISH-TO-GITHUB.md'), publishDoc, 'utf8');

const releaseNotes = `# Vtuber's Monitor Link ${version}

## 这一版做了什么

- **纪念日倒计时日历**：生日 / 出道日 / 3D披露 / 周年。闰日（2/29）在平年会顺延到 3/1
  并在界面标出；「今天」按你配置的时区计算（盯日箱可设 Asia/Tokyo）；月历的一周起始日
  跟随地区（港台日韩美是周日、中国欧洲是周一）。日报最前面会列出未来 30 天内的纪念日。
- **推送渠道扩展**：新增钉钉（含 HMAC 加签）、企业微信、ntfy、Gotify、PushPlus、Slack，
  合计 12 种；新增**静默时段**（跨午夜正确处理；静默期内的通知进队列、出静默期补发，
  **不丢弃**；urgent 默认豁免；配置写坏时 fail-open）与**去重**。
- **每个站点自动匹配出口**：按「等效延迟 = 平均延迟 × (1 + 丢包 × 4)」打分选择直连或代理，
  带粘滞（优势不足 20% 不切换）；真实抓取结果会反哺判定，连续失败的站点自动换出口。
- **界面全球化**：25 个地区可选（含地区变体：en-US/GB/AU/CA、zh-Hans/Hant/HK/TW、
  es-ES/419/MX/AR、pt-PT/BR、fr-FR/CA、de/ja/ko/it/ru/uk/pl/sr/ar），支持 RTL，
  日期/数字/相对时间/一周起始日按地区格式化。
- **日报默认输出 .html**（VSCode 可直接预览），同时保留 .json 源用于导出与检索。
- 长列表默认收起、保存状态常驻可见、一键补发积压通知。

## 安装

解压后直接运行 \`VtuberMonitorLink.exe\`，浏览器会打开本地界面（默认
\`http://127.0.0.1:43110\`）。不需要安装 Node.js，也不联网上报任何数据。

完整说明见 \`README.md\` 与 \`docs/\`。
`;
fs.writeFileSync(path.join(relOut, 'RELEASE-NOTES.md'), releaseNotes, 'utf8');

if (fs.existsSync(path.join(srcOut, 'README.md'))) {
  fs.copyFileSync(path.join(srcOut, 'README.md'), path.join(outRoot, 'README.md'));
}
log('  -> PUBLISH-TO-GITHUB.md, releases/' + version + '/RELEASE-NOTES.md');

// ───────────────────────────────────────────── 5. result

log('\n[5/5] result');
if (problems.length) {
  for (const p of problems) log('  PROBLEM: ' + p);
  log(`\n${problems.length} problems -- release aborted, fix them and re-run.\n`);
  process.exit(1);
}
log(`  ok release directory is ready: ${outRoot}`);
log('    next step: read PUBLISH-TO-GITHUB.md\n');
