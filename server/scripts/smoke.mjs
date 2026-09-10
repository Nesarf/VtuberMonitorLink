// scripts/smoke.mjs — 抓取层冒烟测试（不调用 LLM）
// 用法 / usage:
//   node server/scripts/smoke.mjs                     # 默认测两条非浏览器来源
//   node server/scripts/smoke.mjs reddit-Hololive ... # 指定来源 id
//   node server/scripts/smoke.mjs --all-rss           # 测全部 rss 来源
import { loadConfig } from '../src/config.js';
import { effectiveSources } from '../src/sources.js';
import { fetchAll } from '../src/fetchers/index.js';
import { createLogger } from '../src/logger.js';
import { applyProxy } from '../src/net.js';

const cfg = loadConfig();
const log = createLogger();
const argv = process.argv.slice(2);
const px = await applyProxy(cfg);
console.log(`代理 / proxy: ${px.applied ?? '（直连 / direct）'}\n`);

let picked;
if (argv.includes('--all-rss')) picked = effectiveSources(cfg).filter((s) => s.fetch === 'rss');
else if (argv.length) picked = effectiveSources(cfg).filter((s) => argv.includes(s.id));
else picked = effectiveSources(cfg).filter((s) => ['reddit-Hololive', 'fandom-vtuber-wiki'].includes(s.id));

if (picked.length === 0) {
  console.error('没有匹配的来源 / no matching sources');
  process.exit(2);
}

console.log(`冒烟测试 ${picked.length} 条来源 / smoke-testing ${picked.length} sources\n`);
const results = await fetchAll(picked, { cfg, log });

let ok = 0;
for (const r of results) {
  if (r.ok) {
    ok++;
    console.log(`✅ ${r.source.id.padEnd(28)} ${String(r.content?.length ?? 0).padStart(8)} B`);
  } else {
    console.log(`❌ ${r.source.id.padEnd(28)} ${r.error}`);
  }
}
console.log(`\n结果 / result: ${ok}/${results.length} 成功`);
process.exit(ok === results.length ? 0 : 1);
