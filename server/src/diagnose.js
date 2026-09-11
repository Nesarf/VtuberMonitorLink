// diagnose.js — 自定义站点的连通性自检 / self-check for a user-added source
//
// 设计原则（按需求）：
//   • 现有抓取方式**能正常连通就不折腾** —— 直接返回 healthy，不写文件、不建议改配置；
//   • 只有出现**明显异常**时，才生成一份人可读的诊断文件（markdown），
//     里面写清：结论、实测数据、原始错误、以及**推荐研究项**（具体去哪看什么）。
//   文件通过网页按钮直接打开（服务端渲染成可读 HTML）。
import fs from 'node:fs';
import path from 'node:path';
import { resolveDir, DEFAULT_CONFIG } from './config.js';
import { probeUrl } from './probe.js';
import { fetchAll } from './fetchers/index.js';
import { markdownToHtml } from './reports.js';

export function adviceDir(cfg) {
  const dir = path.join(resolveDir(cfg, 'logsDir'), '..', 'advice');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 推荐研究项：按现象给出「去查什么」，不是泛泛而谈 */
const PLAYBOOK = [
  {
    id: 'both-dead',
    when: (d) => d.probe.direct && !d.probe.direct.ok && d.probe.proxy && !d.probe.proxy.skipped && !d.probe.proxy.ok,
    zh: [
      '两个出口都不通：先确认地址本身是否正确（浏览器里人工打开一次对照）。',
      '直连不通时，用 `ping` / `curl -v <url>` 看是 DNS 解析失败、连接被重置，还是超时。',
      '如果只有带代理才通，把该来源的「出口」设成「强制走代理」；反之设成「强制直连」（B 站就是这类）。',
      '若目标站在海外而本机代理在境内（或反之），节点所在地本身可能就被目标站拒绝。',
    ],
  },
  {
    id: 'direct-only',
    when: (d) => d.probe.direct?.ok && d.probe.proxy && !d.probe.proxy.skipped && !d.probe.proxy.ok,
    zh: [
      '直连可用、代理不通 —— 这类站要**强制直连**（来源设置里的「出口」选直连）。',
      '常见于国内站点经海外节点访问被风控（B 站会直接返回 412 / -352）。',
      '可用「代理节点」面板看该节点到本站的延迟，或换一个落地在目标地区的节点。',
    ],
  },
  {
    id: 'proxy-only',
    when: (d) => d.probe.direct && !d.probe.direct.ok && d.probe.proxy?.ok,
    zh: [
      '只有走代理才通 —— 把该来源的「出口」设成「强制走代理」。',
      '若延迟很高（>3000ms），考虑换节点：见「设置 → 网络代理 → 节点」。',
    ],
  },
  {
    id: 'lossy',
    when: (d) => (d.probe.direct?.loss > 0 || d.probe.proxy?.loss > 0) && (d.probe.direct?.ok || d.probe.proxy?.ok),
    zh: [
      '存在丢包/失败：多为被限流。把该来源的 `rateLimit.gapSeconds` 调大（例如 30~60 秒）。',
      'Reddit 这类站点按 IP 限流，连击重试只会更糟，主动拉开间隔更有效。',
    ],
  },
  {
    id: 'cloudflare',
    when: (d) => /403|429|503|cloudflare|cf-|just a moment|verify you are human|安全验证/i.test(d.fetch.error + (d.fetch.head ?? '')),
    zh: [
      '像是 Cloudflare / 风控拦截。先试该站自己的 **API 端点**（MediaWiki 的 `api.php`、RSS 等），通常比网页好抓。',
      '拿不到就用 fetch 方式「浏览器渲染」并配置已登录 profile；必要时把浏览器设成非无头（headless=false）人工过一次验证。',
      '注意：Fandom 的 `Special:` 页面与 dic.pixiv.net 在无头下会稳定被拦，这是已知限制。',
    ],
  },
  {
    id: 'login',
    when: (d) => /401|403|login|sign in|未登录|需要登录/i.test(d.fetch.error + (d.fetch.head ?? '')),
    zh: [
      '像是需要登录。在「设置 → 浏览器」里指定一个已登录该站的 profile，然后用「检查登录态」确认能读到 cookie。',
      '若该浏览器启用了 App-Bound Encryption（Chrome 127+ 默认），只能关掉浏览器让 Playwright 复用 profile。',
    ],
  },
  {
    id: 'not-json',
    when: (d) => d.fetch.contentType && !/json/i.test(d.fetch.contentType) && /json/i.test(d.source.url ?? ''),
    zh: [
      '地址看起来是 API 但返回的不是 JSON（常见是被重定向到首页或验证页）。对照浏览器 Network 面板确认真正的接口地址。',
      '如果接口需要签名参数（例如 B 站的 wbi），用「浏览器渲染」方式更省事。',
    ],
  },
  {
    id: 'empty',
    when: (d) => d.fetch.ok && d.fetch.items === 0,
    zh: [
      '连上了但没解析出条目：确认抓取方式选对了（RSS / MediaWiki API / 浏览器渲染）。',
      'RSS：浏览器里打开该地址，看根节点是 `<rss>` 还是 `<feed>`（Atom），两者都支持，但空 feed 不会产条目。',
      'MediaWiki：确认 `api.php` 能返回 `recentchanges`（带 `action=query&list=recentchanges`）。',
    ],
  },
  {
    id: 'slow',
    when: (d) => (d.probe.direct?.avg ?? 0) > 5000 || (d.probe.proxy?.avg ?? 0) > 5000,
    zh: ['延迟偏高：把 `browser.hardTimeoutMs` 与 `waitMs` 调大，或给该来源单独降低抓取频率。'],
  },
];

function pickPlaybook(diag) {
  return PLAYBOOK.filter((p) => {
    try {
      return p.when(diag);
    } catch {
      return false;
    }
  });
}

function fmtProbe(label, p) {
  if (!p) return `| ${label} | — | — | — | — | — | — |`;
  if (p.skipped) return `| ${label} | 跳过 | — | — | — | — | ${p.error ?? ''} |`;
  return `| ${label} | ${p.ok ? '✅ 通' : '❌ 不通'} | ${p.received}/${p.sent} | ${p.avg ?? '—'} | ${p.min ?? '—'} | ${p.max ?? '—'} | ${Math.round((p.loss ?? 0) * 100)}% |`;
}

/**
 * 诊断一个来源。
 * @returns {{healthy:boolean, verdict:string, advice?:object, probe:object, fetch:object}}
 */
export async function diagnoseSource(source, cfg, log) {
  const samples = Math.max(2, Math.min(6, cfg?.ui?.probeSamples ?? 3));
  const modes = cfg?.proxy?.enabled && cfg?.proxy?.url ? ['direct', 'proxy'] : ['direct'];

  let probe = { modes: {} };
  if (source.url) {
    try {
      probe = await probeUrl(source.url, { cfg, samples, modes });
    } catch (e) {
      probe = { modes: {}, error: e.message };
    }
  }

  const started = Date.now();
  let raw = null;
  try {
    const results = await fetchAll([{ ...source, rateLimit: { gapSeconds: 0 } }], { cfg, log });
    raw = results[0] ?? null;
  } catch (e) {
    raw = { ok: false, error: e.message };
  }
  const elapsedMs = Date.now() - started;

  const content = raw?.content ?? '';
  const fetchInfo = {
    ok: !!raw?.ok,
    error: String(raw?.error ?? ''),
    bytes: content.length,
    items: Array.isArray(raw?.items) ? raw.items.length : null,
    egress: raw?.egress ?? null,
    failover: raw?.failover ?? null,
    elapsedMs,
    contentType: null,
    head: content.slice(0, 400),
  };
  // 从原始内容猜 content-type 特征（JSON / HTML / XML）
  if (/^\s*[{[]/.test(content)) fetchInfo.contentType = 'application/json (inferred)';
  else if (/^\s*</.test(content)) fetchInfo.contentType = /<\?xml|<rss|<feed/i.test(content.slice(0, 200)) ? 'xml (inferred)' : 'text/html (inferred)';

  const diag = { source: { id: source.id, url: source.url, fetch: source.fetch, login: source.login, proxy: source.proxy ?? null }, probe, fetch: fetchInfo };
  const hits = pickPlaybook(diag);

  // 结论：连通且抓到了东西 → 不折腾
  const connected = (probe.modes?.direct?.ok || probe.modes?.proxy?.ok) && fetchInfo.ok;
  const healthy = connected && hits.length === 0;
  if (healthy) {
    log?.info(`${source.id}: 连通正常，无需优化 / healthy`);
    return { healthy: true, verdict: 'healthy', probe, fetch: fetchInfo, advice: null };
  }

  const verdict = !connected
    ? 'unreachable'
    : fetchInfo.ok
      ? 'degraded'
      : 'fetch-failed';

  // 只有明显异常才落文件
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `${String(source.id).replace(/[^A-Za-z0-9._-]/g, '_')}-${stamp}.md`;
  const md = renderAdvice({ source, probe, fetch: fetchInfo, hits, verdict, cfg });
  fs.writeFileSync(path.join(adviceDir(cfg), file), md, 'utf8');
  log?.warn(`${source.id}: 自检异常（${verdict}），已生成诊断文件 ${file}`);

  return { healthy: false, verdict, probe, fetch: fetchInfo, advice: { file, url: `/api/advice/${encodeURIComponent(file)}` } };
}

/** 生成人可读的诊断 markdown */
export function renderAdvice({ source, probe, fetch: f, hits, verdict, cfg }) {
  const verdictText = {
    unreachable: '两个出口都连不上，现有抓取方式无法工作。',
    'fetch-failed': '网络层能通，但抓取本身失败。',
    degraded: '能抓到内容，但存在明显隐患（见下）。',
  }[verdict] ?? verdict;

  const lines = [];
  lines.push(`# 站点自检报告：${source.name?.zh ?? source.id}`);
  lines.push('');
  lines.push(`- 生成时间：${new Date().toLocaleString()}（本机时间）`);
  lines.push(`- 来源标识：\`${source.id}\``);
  lines.push(`- 抓取方式：\`${source.fetch}\`　登录要求：\`${source.login ?? 'none'}\`　出口设置：\`${source.proxy ?? '跟随全局'}\``);
  lines.push(`- 地址：${source.url ?? '(无)'}`);
  lines.push(`- 本机代理：${cfg?.proxy?.enabled ? cfg.proxy.url : '未启用'}`);
  lines.push('');
  lines.push(`## 结论`);
  lines.push('');
  lines.push(`**${verdictText}**`);
  if (probe.hint) lines.push('');
  if (probe.hint) lines.push(`> ${probe.hint}`);
  lines.push('');
  lines.push('## 实测数据');
  lines.push('');
  lines.push('| 出口 | 结果 | 成功/发送 | 平均(ms) | 最小 | 最大 | 失败率 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  lines.push(fmtProbe('直连（TCP 握手）', probe.modes?.direct));
  lines.push(fmtProbe('代理（HTTP 首字节）', probe.modes?.proxy));
  lines.push('');
  lines.push(`> 说明：直连测的是 TCP 握手时间（最接近 ping），代理测的是经代理发一次请求的首字节时间。`);
  lines.push(`> 「失败率」= 失败次数 ÷ 尝试次数，不是 ICMP 丢包。`);
  lines.push('');
  lines.push('## 抓取结果');
  lines.push('');
  lines.push(`- 是否成功：${f.ok ? '✅' : '❌'}`);
  lines.push(`- 耗时：${f.elapsedMs} ms`);
  lines.push(`- 内容大小：${f.bytes} 字节`);
  if (f.items !== null) lines.push(`- 解析出条目：${f.items} 条`);
  if (f.egress) lines.push(`- 实际使用出口：\`${f.egress}\``);
  if (f.failover) lines.push(`- 自动换出口：\`${f.failover.from}\` → \`${f.failover.to}\`（首次错误：${f.failover.firstError ?? '-'}）`);
  if (f.contentType) lines.push(`- 内容类型（推断）：${f.contentType}`);
  if (f.error) lines.push(`- 错误：\`${f.error}\``);
  if (f.head) {
    lines.push('');
    lines.push('响应开头 400 字符：');
    lines.push('');
    lines.push('```');
    lines.push(f.head.replace(/```/g, '``'));
    lines.push('```');
  }
  lines.push('');
  lines.push('## 推荐研究项');
  lines.push('');
  if (!hits.length) {
    lines.push('- 未命中已知模式，建议人工在浏览器里对照一次，并记录真实接口地址。');
  } else {
    for (const h of hits) {
      lines.push(`### ${h.id}`);
      lines.push('');
      for (const l of h.zh) lines.push(`- ${l}`);
      lines.push('');
    }
  }
  lines.push('## 怎么复核');
  lines.push('');
  lines.push('在网页「来源」页点该来源的「自检」可以重跑一遍；也可以在本机直接跑：');
  lines.push('');
  lines.push('```');
  lines.push(`node server/src/index.js            # 起服务后打开 http://127.0.0.1:43110`);
  lines.push(`# 或直接看这一份已经抓下来的原始内容：feed/`);
  lines.push('```');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('_本文件由 Vtuber\'s Monitor Link 自动生成。里面不含任何 cookie、密钥或账号信息。_');
  return lines.join('\n');
}

/** 读一份诊断文件，并渲染成可读 HTML（点按钮直接在浏览器里打开） */
export function readAdvice(cfg, file, asHtml = true) {
  const safe = path.basename(file);
  const p = path.join(adviceDir(cfg), safe);
  if (!fs.existsSync(p)) return null;
  const md = fs.readFileSync(p, 'utf8');
  if (!asHtml) return { markdown: md, mime: 'text/markdown; charset=utf-8' };
  const body = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${safe}</title>
<style>
:root{color-scheme:light dark}
body{max-width:880px;margin:36px auto;padding:0 20px;font:15px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
h1,h2,h3{line-height:1.3;border-bottom:1px solid #8883;padding-bottom:.2em}
code{background:#8881;padding:.1em .35em;border-radius:4px}
pre{background:#8881;padding:12px;border-radius:8px;overflow:auto}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #8884;padding:6px 10px;text-align:left}
blockquote{border-left:3px solid #8886;margin:0;padding-left:12px;color:#8888}
a{color:#3b82f6}
</style></head><body>
${markdownToHtml(md)}
</body></html>`;
  return { html: body, mime: 'text/html; charset=utf-8' };
}

export function listAdvice(cfg) {
  const dir = adviceDir(cfg);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { file: f, bytes: st.size, mtime: st.mtime.toISOString(), url: `/api/advice/${encodeURIComponent(f)}` };
    })
    .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

void DEFAULT_CONFIG;
