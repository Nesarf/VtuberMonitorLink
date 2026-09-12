// fetchers/rss.js — RSS / Atom fetching (with proactive spacing and retries)
// Experience: sites like Reddit rate limit per IP, and spacing requests out proactively works far better than "hammer + retry".
import { setTimeout as sleep } from 'node:timers/promises';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export async function fetchRss(source, { log }) {
  const rl = source.rateLimit ?? {};
  const gap = (rl.gapSeconds ?? 2) * 1000;
  const retries = rl.retries ?? 1;
  let lastErr = null;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const r = await fetch(source.url, {
        headers: { 'user-agent': UA, accept: 'application/atom+xml,application/rss+xml,application/xml,text/xml,*/*' },
        signal: AbortSignal.timeout(25000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}${r.status === 429 ? ' (rate limited)' : ''}`);
      const content = await r.text();
      log?.info(`${source.id}: ok ${content.length}B (try ${attempt})`);
      return { ok: true, content, ext: 'xml' };
    } catch (err) {
      lastErr = err;
      log?.warn(`${source.id}: try ${attempt} failed — ${err.message}`);
      if (attempt <= retries) await sleep(gap);
    }
  }
  return { ok: false, error: lastErr?.message ?? 'unknown error' };
}
