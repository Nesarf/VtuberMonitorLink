// make-release.mjs — 生成对外发布目录（无痕化）/ build the public release tree
//
// 目标产物（默认 <工程同级>/VML-release，可用 --out 指定）：
//
//   <out>/
//     README.md               ← 对外说明（不带本机信息）
//     PUBLISH-TO-GITHUB.md    ← 推到 GitHub 的逐步命令
//     src/ …                  ← 无痕化后的**完整工程副本**（可直接 git init 推上去）
//     releases/<version>/
//         VtuberMonitorLink-<版本>-win-x64.zip
//         *.zip.manifest.json   ← 包内文件清单（发布校验据此断言「没有运行期数据」）
//         SHA256SUMS.txt
//         RELEASE-NOTES.md
//
// 「无痕化」在这里是**硬闸门**，不是尽力而为：
//   · 运行期数据（config.json / reports / feeds / logs / watch / thumbs / advice）绝不进副本
//   · .git / node_modules / build / dist 不进副本
//   · 副本写完立刻用工程自己的扫描器复扫（tools/verify-release.cjs --scan-only --dir），
//     一旦发现密钥、绝对路径、私有名字、harness 标记 → 整个发布中止（退出码 1）
//   · 发行 zip 的清单也会被断言：出现任何运行期数据同样中止
//
// 注意：本文件里**不写死任何本机路径** —— 默认输出目录由 VML_RELEASE_OUT 环境变量
// 或工程同级目录推导。写死盘符本身就是无痕化要抓的东西（而且扫描器真的会抓到它）。
//
//   node tools/make-release.mjs [--out <目录>] [--skip-copy]
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

// 绝不进对外副本的东西。前三类是运行期数据（含密钥），后面是开发中间产物与本机私货。
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
]);
// 允许出现的「示例路径」（文档里教别人填的那种），扫描时会放行
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

// ───────────────────────────────────────────── 0. 前置条件

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const outRoot = args.out;
const srcOut = path.join(outRoot, 'src');
const relOut = path.join(outRoot, 'releases', version);

log(`\n发布目录 / release tree: ${outRoot}`);
log(`版本 / version: ${version}\n`);

const zipName = `VtuberMonitorLink-${version}-win-x64.zip`;
const zipPath = path.join(ROOT, 'dist', zipName);
const manifestPath = zipPath + '.manifest.json';
if (!fs.existsSync(zipPath)) {
  log('  ⚠ 还没有发行包 —— 先跑 node tools/build-portable.cjs');
} else {
  log(`  ✓ 找到发行包 ${zipName}（${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB）`);
}

// ───────────────────────────────────────────── 1. 拷贝无痕化副本

if (args.copy) {
  log('\n[1/5] 拷贝无痕化工程副本');
  fs.rmSync(srcOut, { recursive: true, force: true });
  fs.mkdirSync(srcOut, { recursive: true });
  const n = copyTree(ROOT, srcOut);
  log(`  -> ${rel(srcOut)}（${n} 个文件）`);
  for (const skip of [...NEVER_COPY].sort()) log(`     排除 ${skip}`);
}

// ───────────────────────────────────────────── 2. 用工程自己的扫描器复扫

log('\n[2/5] 无痕化扫描（用工程自己的校验器 --scan-only）');
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
  problems.push('无痕化扫描未通过（见上）—— 发布中止');
} else {
  log('  ✓ 没有密钥、绝对路径、私有名字、harness 标记');
}

// ───────────────────────────────────────────── 3. 发行包 + 校验和

log('\n[3/5] 组装 releases/');
fs.mkdirSync(relOut, { recursive: true });
if (fs.existsSync(zipPath)) {
  fs.copyFileSync(zipPath, path.join(relOut, zipName));
  if (fs.existsSync(manifestPath)) {
    const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    // 硬断言：包里不能有运行期数据（config.json 里有 API Key，历史报告是隐私）
    const bad = (man.files ?? []).filter((f) => /^app\/(config\.json|reports|feeds|logs|watch|thumbs|advice)(\/|$)/.test(f));
    if (bad.length) {
      problems.push(`发行包里出现运行期数据: ${bad.slice(0, 5).join(', ')}`);
    } else {
      log(`  ✓ 包内 ${man.files.length} 个文件，无运行期数据（已排除 ${man.excluded.length} 项）`);
    }
    fs.copyFileSync(manifestPath, path.join(relOut, path.basename(manifestPath)));
  } else {
    problems.push('缺少 zip 清单（.manifest.json）—— 无法断言包内容，发布中止');
  }
}

const sums = [];
for (const f of fs.readdirSync(relOut).filter((f) => !f.endsWith('SHA256SUMS.txt'))) {
  sums.push(`${sha256(path.join(relOut, f))}  ${f}`);
}
fs.writeFileSync(path.join(relOut, 'SHA256SUMS.txt'), sums.join('\n') + '\n', 'utf8');
log(`  -> ${rel(relOut)}（${fs.readdirSync(relOut).length} 个文件 + SHA256SUMS.txt）`);

// ───────────────────────────────────────────── 4. 对外说明与发布步骤

log('\n[4/5] 对外文档');
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

// ───────────────────────────────────────────── 5. 结果

log('\n[5/5] 结果');
if (problems.length) {
  for (const p of problems) log('  PROBLEM: ' + p);
  log(`\n${problems.length} 处问题 —— 发布中止，先修掉再重跑。\n`);
  process.exit(1);
}
log(`  ✓ 发布目录已就绪: ${outRoot}`);
log('    下一步：看 PUBLISH-TO-GITHUB.md\n');
