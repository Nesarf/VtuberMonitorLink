// fetchers/rss.js — RSS / Atom fetching (with proactive spacing and retries)
// Experience: sites like Reddit rate-limit by IP, and spacing requests out proactively works far better than "hammer + retry".
//
// The request goes through netFetch, and that is a correction rather than a preference. This fetcher used a
// bare `fetch` while every other fetch path in the project used net.js, so an RSS source **ignored the
// configured egress entirely** (a Reddit feed a user has pinned to the proxy went out direct) and followed
// redirects inside undici, where no hop could be checked. net.js is now the only place a hop is decided
// (server/src/remote-url.js is the policy), so an RSS source is checked and routed like everything else.
// The policy carries this source's own allowance: a fixture feed on loopback is allowed only when the source
// says so, and the default refuses it.
import { setTimeout as sleep } from 'node:timers/promises';
import { netFetch } from '../net.js';
import { sourcePolicy } from '../sources.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export async function fetchRss(source, { log, cfg }) {
  const rl = source.rateLimit ?? {};
  const gap = (rl.gapSeconds ?? 2) * 1000;
  const retries = rl.retries ?? 1;
  let lastErr = null;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const r = await netFetch(
        source.url,
        {
          headers: { 'user-agent': UA, accept: 'application/atom+xml,application/rss+xml,application/xml,text/xml,*/*' },
          signal: AbortSignal.timeout(25000),
        },
        { cfg, subject: source, policy: sourcePolicy(source) },
      );
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
