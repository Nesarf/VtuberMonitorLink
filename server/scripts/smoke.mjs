// scripts/smoke.mjs — smoke test for the fetch layer (never calls an LLM)
// usage:
//   node server/scripts/smoke.mjs                     # by default tests two non-browser sources
//   node server/scripts/smoke.mjs reddit-Hololive ... # explicit source ids
//   node server/scripts/smoke.mjs --all-rss           # every rss source
import { loadConfig } from '../src/config.js';
import { effectiveSources } from '../src/sources.js';
import { fetchAll } from '../src/fetchers/index.js';
import { createLogger } from '../src/logger.js';
import { applyProxy } from '../src/net.js';

const cfg = loadConfig();
const log = createLogger();
const argv = process.argv.slice(2);
const px = await applyProxy(cfg);
console.log(`proxy: ${px.applied ?? '(direct)'}\n`);

let picked;
if (argv.includes('--all-rss')) picked = effectiveSources(cfg).filter((s) => s.fetch === 'rss');
else if (argv.length) picked = effectiveSources(cfg).filter((s) => argv.includes(s.id));
else picked = effectiveSources(cfg).filter((s) => ['reddit-Hololive', 'fandom-vtuber-wiki'].includes(s.id));

if (picked.length === 0) {
  console.error('no matching sources');
  process.exit(2);
}

console.log(`smoke-testing ${picked.length} sources\n`);
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
console.log(`\nresult: ${ok}/${results.length} ok`);
process.exit(ok === results.length ? 0 : 1);
