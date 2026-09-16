// observe.js — observation mode: sparse sampling, temporal jitter, assigning egress by "who holds the logs"
//
// Background (why this module is needed rather than just "add a Tor switch"):
// To judge the real state of an agency (team) you have to look at what several of its members are
// doing at the same time; but "sweeping the whole agency at one instant" is itself the most
// conspicuous trace -- and it does not depend on which IP you come from.
// Tor only swaps the network identity of "who is watching"; it cannot swap "what is being watched,
// when it is watched, how much is watched at once".
//
// So the four things below, the first two unrelated to Tor:
//   1. **Sampling**: each round takes only a random subset, and rotation fills in the coverage slowly
//      (locally it is an incremental archive, so the profile ends up complete after a few days, yet no
//      single observation reveals that "someone is watching the whole agency");
//   2. **Jitter**: the interval and the start instant are random, so the timing does not carry the
//      machine-like signature of a fixed rhythm;
//   3. **Egress by log ownership**: an agency self-hosted site (official-*) is **the only class where the logs are on their side**,
//      so it goes over Tor; for platform sources (Reddit / Fandom) the agency cannot see your IP,
//      so it goes direct or through a self-built proxy;
//   4. **No identity sent**: sources that need a login session do not run in this mode (binding a real
//      identity to observation behaviour is the strongest correlation signal, far worse than an IP).
//
// Measurement basis (2026-09-12):
//   - swapping egress: a different SOCKS user name -> a different exit IP (Tor's IsolateSOCKSAuth);
//   - agency self-hosted sites over Tor: hololivepro 200 / vspo 200 / cover-corp 200,
//     anycolor **403 (Cloudflare blocks Tor)**, brave-group timeout.
import fs from 'node:fs';
import path from 'node:path';
import { resolveDir } from './config.js';

/**
 * Domains where "the logs are on their side" — that is, entry points **the agency hosts itself**.
 * Only for this class does Tor really make sense: when you scrape a platform (Reddit/Fandom)
 * the agency cannot obtain that log; when you scrape its own site the log is sitting on its server.
 * This list is a whitelist: anything not listed is treated as a platform, which errs on the side of
 * using Tor too little rather than using it where it does not belong.
 */
export const AGENCY_HOSTS = [
  'hololivepro.com',
  'hololive.tv',
  'anycolor.co.jp',
  'nijisanji.jp',
  'brave-group.jp',
  'vspo.jp',
  'cover-corp.com',
  'a-soul.com',
  'yousa.cn',
];

export function urlHost(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Who holds the logs of this source: 'agency' (the agency itself) / 'platform' (a third-party platform) */
export function logOwnerOf(source) {
  const host = urlHost(source?.url);
  if (!host) return 'platform';
  return AGENCY_HOSTS.some((h) => host === h || host.endsWith('.' + h)) ? 'agency' : 'platform';
}

/** Does it need a login session (login: required)? This class does not run under observation mode */
export function isLoginRequired(source) {
  return String(source?.login ?? '').toLowerCase() === 'required';
}

/**
 * Which egress this source uses this round.
 * Returning null means "leave it alone" — follow the source's own setting (source.proxy) and the global proxy.
 */
export function resolveEgress(source, cfg, { observation } = {}) {
  const obs = observation ?? cfg?.observation ?? {};
  if (!obs.enabled) return null;
  if (isLoginRequired(source) && obs.skipLoginSources !== false) {
    return { skip: true, reason: 'login required: not run under observation mode (so a real identity is not bound to observation behaviour)' };
  }
  // Respect an egress the user explicitly pinned (that per-source column)
  if (source?.proxy === 'direct' || source?.proxy === 'proxy' || source?.proxy === 'tor') {
    return { mode: source.proxy, why: 'egress pinned by the source itself' };
  }
  if (obs.torForAgency !== false && logOwnerOf(source) === 'agency') {
    return { mode: 'tor', why: 'the logs are on their side (the agency hosts the site) -> go over Tor' };
  }
  return null;
}

// ───────────────────────────────────────────── sampling

/**
 * Take a subset each round.
 *
 * Purely random will not do: it lets some object go several rounds unseen (coverage fills in very slowly).
 * Purely LRU will not do either: the least recently seen batch is always the same batch, so the pattern
 * becomes predictable again.
 * So: **first rank a candidate pool by "least recently seen", then pick randomly from the pool** — this
 * keeps the rotation fair while making "who exactly was picked this round" unpredictable; the result is
 * shuffled again afterwards.
 */
export function pickSample(items, { ratio = 0.5, min = 2, history = {}, rng = Math.random, keyOf = (x) => x.id } = {}) {
  const list = Array.isArray(items) ? items.slice() : [];
  const n = list.length;
  if (!n) return { picked: [], skipped: [], k: 0, n: 0 };
  const want = Math.max(min, Math.round(n * Math.min(1, Math.max(0.05, ratio))));
  const k = Math.min(n, want);
  if (k >= n) return { picked: shuffle(list, rng), skipped: [], k: n, n };

  const ranked = list
    .map((x) => ({ x, at: Date.parse(history[keyOf(x)] ?? '') || 0 }))
    .sort((a, b) => a.at - b.at);
  // The candidate pool has to be a little larger than k, so that there is real randomness inside it
  const poolSize = Math.min(n, Math.max(k, Math.ceil(n * 0.6) + 1));
  const pool = ranked.slice(0, poolSize).map((r) => r.x);
  const picked = shuffle(pool, rng).slice(0, k);
  const pickedIds = new Set(picked.map(keyOf));
  return { picked: shuffle(picked, rng), skipped: list.filter((x) => !pickedIds.has(keyOf(x))), k, n };
}

function shuffle(arr, rng) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Interval jitter.
 *
 * When `base <= 0` it **returns 0 directly**: an explicit "do not wait" outranks jitter —
 * the diagnostic path (`diagnose.js`) skips the rate-limit wait precisely via `rateLimit.gapSeconds = 0`,
 * and jitter must not sneak that wait back in.
 */
export function gapWithJitter(baseSeconds, jitter, rng = Math.random) {
  const base = Math.max(0, Number(baseSeconds) || 0);
  if (base <= 0) return 0;
  if (Array.isArray(jitter) && jitter.length === 2) {
    const [lo, hi] = jitter.map((x) => Math.max(0, Number(x) || 0));
    if (hi > lo) return Math.max(base, lo) + rng() * Math.max(0, hi - Math.max(base, lo));
    return Math.max(base, lo);
  }
  if (jitter && typeof jitter === 'object') {
    const spread = Math.max(0, Number(jitter.spread) || 0);
    if (spread) return Math.max(0, base * (1 - spread + rng() * spread * 2));
  }
  return base;
}

// ───────────────────────────────────────────── rotation state (remembers "when it was last seen")

function statePath(cfg) {
  return path.join(resolveDir(cfg, 'logsDir'), 'observation.json');
}

export function loadObservationState(cfg) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(cfg), 'utf8'));
    if (raw && typeof raw === 'object') return { rounds: raw.rounds ?? 0, lastPicked: raw.lastPicked ?? {} };
  } catch {
    /* start empty when there is none */
  }
  return { rounds: 0, lastPicked: {} };
}

export function saveObservationState(cfg, state) {
  const p = statePath(cfg);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch {
    /* failing to record does not affect this round */
  }
}

// ───────────────────────────────────────────── the plan for one round

/**
 * Work out "whom to fetch this round, over which egress, and with what interval" in one go.
 * Pure function (apart from the fallback when the state cannot be read): rng and history are the two
 * injection points left for tests.
 *
 * @returns {{
 *   enabled:boolean, ratio:number,
 *   sources:object[], skippedLogin:object[], egress:Record<string,string>,
 *   watchTargets:object[], sampling:object
 * }}
 */
export function observationPlan({ cfg, sources = [], watchTargets = [], history = { lastPicked: {} }, rng = Math.random, now = new Date(), torReachable = null } = {}) {
  const obs = cfg?.observation ?? {};
  const plan = {
    enabled: !!obs.enabled,
    ratio: Number(obs.sampleRatio ?? 0.5),
    sources: sources.slice(),
    watchTargets: watchTargets.slice(),
    skippedLogin: [],
    skippedTor: [],
    egress: {},
    sampling: { enabled: !!obs.enabled, ratio: Number(obs.sampleRatio ?? 0.5), sources: null, watch: null },
  };
  if (!plan.enabled) return plan;

  // 0) Report the Tor outage first: sources that would not go through Tor this round are skipped
  //    outright rather than being left to fail individually.
  //    Such a failure would be recorded as "this source is broken" and trigger the self-check — a false
  //    fault, because the snowflake bridge drops connections momentarily.
  const torDown = torReachable === false && obs.torForAgency !== false;

  // 1) Decide the egress by log ownership + skip outright whatever needs a login session
  const kept = [];
  for (const s of plan.sources) {
    const e = resolveEgress(s, cfg, { observation: obs });
    if (e?.skip) {
      plan.skippedLogin.push({ id: s.id, reason: e.reason });
      continue;
    }
    if (e?.mode === 'tor') {
      if (torDown) {
        plan.skippedTor.push({ id: s.id, reason: 'the local Tor port is unreachable, skipped this round (not counted as a source failure, retry next time)' });
        continue;
      }
      plan.egress[s.id] = e.mode;
      kept.push({ ...s, proxy: e.mode, egressWhy: e.why });
    } else if (e?.mode) {
      plan.egress[s.id] = e.mode;
      kept.push({ ...s, proxy: e.mode, egressWhy: e.why });
    } else {
      kept.push(s);
    }
  }

  // 2) Sampling (one draw for sources and one for watch targets)
  const sSample = pickSample(kept, { ratio: plan.ratio, min: obs.minSources ?? 2, history: history.lastPicked, rng });
  const wSample = pickSample(plan.watchTargets, { ratio: plan.ratio, min: obs.minWatch ?? 1, history: history.lastPicked, rng, keyOf: (t) => t.id ?? t.url });

  plan.sources = sSample.picked;
  plan.watchTargets = wSample.picked;
  plan.sampling.sources = { picked: sSample.picked.map((x) => x.id), skipped: sSample.skipped.map((x) => x.id), k: sSample.k, n: sSample.n };
  plan.sampling.watch = { picked: wSample.picked.map((x) => x.id ?? x.url), skipped: wSample.skipped.map((x) => x.id ?? x.url), k: wSample.k, n: wSample.n };
  // Report only **the ones that really go through Tor this round** (anything in egress that the sampling
  // did not pick is not requested at all this round)
  plan.sampling.tor = sSample.picked.filter((s) => s.proxy === 'tor').map((s) => s.id);
  plan.sampling.skippedLogin = plan.skippedLogin.map((x) => x.id);
  plan.sampling.skippedTor = plan.skippedTor.map((x) => x.id);
  plan.at = now.toISOString();
  return plan;
}

/** Timestamp the objects picked this round so that the next round prefers "least recently seen" */
export function recordPicked(state, ids, at = new Date()) {
  const next = { rounds: (state?.rounds ?? 0) + 1, lastPicked: { ...(state?.lastPicked ?? {}) } };
  for (const id of ids) next.lastPicked[id] = at.toISOString();
  return next;
}
