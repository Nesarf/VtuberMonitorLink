// diagnose.js — connectivity self-check for a user-added source
//
// Design principles (as required):
//   * If the existing fetch method **can connect just fine, leave it alone** — return healthy
//     directly, write no file and suggest no config change;
//   * only when something is **clearly wrong** generate a human-readable diagnostic file
//     (markdown) stating: the verdict, the measurements, the raw error, and the
//     **recommended things to investigate** (specifically where to look and at what).
// The file is opened straight from a button in the UI (the server renders it into readable HTML).
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

/** Recommended things to investigate: state "what to check" for each symptom, not vague advice */
const PLAYBOOK = [
  {
    id: 'both-dead',
    when: (d) => d.probe.direct && !d.probe.direct.ok && d.probe.proxy && !d.probe.proxy.skipped && !d.probe.proxy.ok,
    zh: [
      'Neither egress works: first confirm the address itself is correct (open it by hand in a browser to compare).',
      'When direct fails, use `ping` / `curl -v <url>` to see whether it is a DNS failure, a reset connection, or a timeout.',
      'If only the proxy works, set that source\'s "egress" to "force proxy"; if the opposite, set it to "force direct" (a site that risk-controls a proxy is this kind).',
      'If the target site is overseas while the local proxy is domestic (or the reverse), the node\'s own location may be what the target site rejects.',
    ],
  },
  {
    id: 'direct-only',
    when: (d) => d.probe.direct?.ok && d.probe.proxy && !d.probe.proxy.skipped && !d.probe.proxy.ok,
    zh: [
      'Direct works but the proxy does not — this kind of site needs **force direct** (pick direct for "egress" in the source settings).',
      'Common for domestic sites being risk-controlled when reached through an overseas node (such a site answers a bare 4xx instead of the page).',
      'Use the "proxy nodes" panel to see that node\'s latency to this site, or switch to a node landing in the target region.',
    ],
  },
  {
    id: 'proxy-only',
    when: (d) => d.probe.direct && !d.probe.direct.ok && d.probe.proxy?.ok,
    zh: [
      'Only the proxy works — set that source\'s "egress" to "force proxy".',
      'If the latency is very high (>3000ms), consider another node: see "Settings -> Network proxy -> Nodes".',
    ],
  },
  {
    id: 'lossy',
    when: (d) => (d.probe.direct?.loss > 0 || d.probe.proxy?.loss > 0) && (d.probe.direct?.ok || d.probe.proxy?.ok),
    zh: [
      'There is packet loss / failure: usually rate limiting. Raise that source\'s `rateLimit.gapSeconds` (for example 30~60 seconds).',
      'Sites like Reddit rate-limit by IP, so hammering with retries only makes it worse; spacing the requests out deliberately works better.',
    ],
  },
  {
    id: 'cloudflare',
    when: (d) => /403|429|503|cloudflare|cf-|just a moment|verify you are human|安全验证/i.test(d.fetch.error + (d.fetch.head ?? '')),
    zh: [
      'Looks like Cloudflare / a risk-control block. First try the site\'s own **API endpoint** (MediaWiki\'s `api.php`, RSS, and so on); it is usually easier to fetch than the web page.',
      'If that is not available, use the "browser render" fetch method with a profile that is already logged in; if necessary set the browser to non-headless (headless=false) and pass the check by hand once.',
      'Note: Fandom\'s `Special:` pages and dic.pixiv.net are reliably blocked in headless mode; that is a known limitation.',
    ],
  },
  {
    id: 'login',
    when: (d) => /401|403|login|sign in|未登录|需要登录/i.test(d.fetch.error + (d.fetch.head ?? '')),
    zh: [
      'Looks like a login is required. In "Settings -> Browser" point at a profile already logged into that site, then use "check login state" to confirm the cookies can be read.',
      'If that browser has App-Bound Encryption enabled (the default in Chrome 127+), the browser can only be closed so Playwright can reuse the profile.',
    ],
  },
  {
    id: 'not-json',
    when: (d) => d.fetch.contentType && !/json/i.test(d.fetch.contentType) && /json/i.test(d.source.url ?? ''),
    zh: [
      'The address looks like an API but what came back is not JSON (commonly a redirect to the home page or a verification page). Compare with the browser Network panel to confirm the real endpoint address.',
      'If the endpoint needs signed parameters (a signature its own page computes), the "browser render" method is less trouble.',
    ],
  },
  {
    id: 'empty',
    when: (d) => d.fetch.ok && d.fetch.items === 0,
    zh: [
      'It connected but parsed no items: confirm the right fetch method was picked (RSS / MediaWiki API / browser render).',
      'RSS: open that address in a browser and see whether the root node is `<rss>` or `<feed>` (Atom); both are supported, but an empty feed produces no items.',
      'MediaWiki: confirm `api.php` can return `recentchanges` (with `action=query&list=recentchanges`).',
    ],
  },
  {
    id: 'slow',
    when: (d) => (d.probe.direct?.avg ?? 0) > 5000 || (d.probe.proxy?.avg ?? 0) > 5000,
    zh: ['Latency is on the high side: raise `browser.hardTimeoutMs` and `waitMs`, or lower the fetch frequency for this source on its own.'],
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
  if (p.skipped) return `| ${label} | skipped | — | — | — | — | ${p.error ?? ''} |`;
  return `| ${label} | ${p.ok ? '✅ up' : '❌ down'} | ${p.received}/${p.sent} | ${p.avg ?? '—'} | ${p.min ?? '—'} | ${p.max ?? '—'} | ${Math.round((p.loss ?? 0) * 100)}% |`;
}

/**
 * Diagnose one source.
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
  // Guess the content-type flavour from the raw content (JSON / HTML / XML)
  if (/^\s*[{[]/.test(content)) fetchInfo.contentType = 'application/json (inferred)';
  else if (/^\s*</.test(content)) fetchInfo.contentType = /<\?xml|<rss|<feed/i.test(content.slice(0, 200)) ? 'xml (inferred)' : 'text/html (inferred)';

  const diag = { source: { id: source.id, url: source.url, fetch: source.fetch, login: source.login, proxy: source.proxy ?? null }, probe, fetch: fetchInfo };
  const hits = pickPlaybook(diag);

  // Verdict: connected and it fetched something -> leave it alone
  const connected = (probe.modes?.direct?.ok || probe.modes?.proxy?.ok) && fetchInfo.ok;
  const healthy = connected && hits.length === 0;
  if (healthy) {
    log?.info(`${source.id}: healthy, nothing to optimise`);
    return { healthy: true, verdict: 'healthy', probe, fetch: fetchInfo, advice: null };
  }

  const verdict = !connected
    ? 'unreachable'
    : fetchInfo.ok
      ? 'degraded'
      : 'fetch-failed';

  // Only a clearly abnormal result lands in a file
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `${String(source.id).replace(/[^A-Za-z0-9._-]/g, '_')}-${stamp}.md`;
  const md = renderAdvice({ source, probe, fetch: fetchInfo, hits, verdict, cfg });
  fs.writeFileSync(path.join(adviceDir(cfg), file), md, 'utf8');
  log?.warn(`${source.id}: self-check abnormal (${verdict}), diagnostic file written: ${file}`);

  return { healthy: false, verdict, probe, fetch: fetchInfo, advice: { file, url: `/api/advice/${encodeURIComponent(file)}` } };
}

/** Generate the human-readable diagnostic markdown */
export function renderAdvice({ source, probe, fetch: f, hits, verdict, cfg }) {
  const verdictText = {
    unreachable: 'Neither egress can connect; the existing fetch method cannot work.',
    'fetch-failed': 'The network layer is reachable, but the fetch itself failed.',
    degraded: 'Content can be fetched, but there is an obvious risk (see below).',
  }[verdict] ?? verdict;

  const lines = [];
  lines.push(`# Site self-check report: ${source.name?.zh ?? source.id}`);
  lines.push('');
  lines.push(`- Generated at: ${new Date().toLocaleString()} (local time)`);
  lines.push(`- Source id: \`${source.id}\``);
  lines.push(`- Fetch method: \`${source.fetch}\`  Login requirement: \`${source.login ?? 'none'}\`  Egress setting: \`${source.proxy ?? 'follow global'}\``);
  lines.push(`- Address: ${source.url ?? '(none)'}`);
  lines.push(`- Local proxy: ${cfg?.proxy?.enabled ? cfg.proxy.url : 'not enabled'}`);
  lines.push('');
  lines.push(`## Verdict`);
  lines.push('');
  lines.push(`**${verdictText}**`);
  if (probe.hint) lines.push('');
  if (probe.hint) lines.push(`> ${probe.hint}`);
  lines.push('');
  lines.push('## Measurements');
  lines.push('');
  lines.push('| Egress | Result | OK/Sent | Avg(ms) | Min | Max | Failure rate |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  lines.push(fmtProbe('direct (TCP handshake)', probe.modes?.direct));
  lines.push(fmtProbe('proxy (HTTP first byte)', probe.modes?.proxy));
  lines.push('');
  lines.push(`> Note: the direct figure is the TCP handshake time (closest to ping); the proxy figure is the time to first byte of one request sent through the proxy.`);
  lines.push(`> "Failure rate" = failures ÷ attempts, not ICMP packet loss.`);
  lines.push('');
  lines.push('## Fetch result');
  lines.push('');
  lines.push(`- Succeeded: ${f.ok ? '✅' : '❌'}`);
  lines.push(`- Elapsed: ${f.elapsedMs} ms`);
  lines.push(`- Content size: ${f.bytes} bytes`);
  if (f.items !== null) lines.push(`- Items parsed: ${f.items}`);
  if (f.egress) lines.push(`- Egress actually used: \`${f.egress}\``);
  if (f.failover) lines.push(`- Egress switched automatically: \`${f.failover.from}\` -> \`${f.failover.to}\` (first error: ${f.failover.firstError ?? '-'})`);
  if (f.contentType) lines.push(`- Content type (inferred): ${f.contentType}`);
  if (f.error) lines.push(`- Error: \`${f.error}\``);
  if (f.head) {
    lines.push('');
    lines.push('First 400 characters of the response:');
    lines.push('');
    lines.push('```');
    lines.push(f.head.replace(/```/g, '``'));
    lines.push('```');
  }
  lines.push('');
  lines.push('## Recommended things to investigate');
  lines.push('');
  if (!hits.length) {
    lines.push('- No known pattern matched; check it by hand in a browser and note the real endpoint address.');
  } else {
    for (const h of hits) {
      lines.push(`### ${h.id}`);
      lines.push('');
      for (const l of h.zh) lines.push(`- ${l}`);
      lines.push('');
    }
  }
  lines.push('## How to re-check');
  lines.push('');
  lines.push('Clicking "self-check" on that source in the "Sources" page reruns it; you can also run it locally:');
  lines.push('');
  lines.push('```');
  lines.push(`node server/src/index.js            # start the server, then open http://127.0.0.1:43110`);
  lines.push(`# or read the raw content this check already fetched: feed/`);
  lines.push('```');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('_This file was generated automatically by Vtuber\'s Monitor Link. It contains no cookies, keys or account information._');
  return lines.join('\n');
}

/** Read one diagnostic file and render it into readable HTML (open it in the browser straight from the button) */
export function readAdvice(cfg, file, asHtml = true) {
  const safe = path.basename(file);
  const p = path.join(adviceDir(cfg), safe);
  if (!fs.existsSync(p)) return null;
  const md = fs.readFileSync(p, 'utf8');
  if (!asHtml) return { markdown: md, mime: 'text/markdown; charset=utf-8' };
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
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
