// observe.js — 观测模式：稀疏取样、时序抖动、按「日志在谁手上」分配出口
//
// 背景（为什么需要这个模块，而不只是「加个 Tor 开关」）：
// 想判断一个箱（团队）的真实状态，就得同时看箱内多人的行动；但「把整箱在同一时刻
// 扫一遍」这件事本身就是最显眼的痕迹 —— 它不依赖你是从哪个 IP 来的。
// Tor 只能换掉「谁在看」的网络身份，换不掉「在看什么、什么时候看、一次看多少」这个模式。
//
// 所以这里的四件事，前两件与 Tor 无关：
//   1. **取样**：每轮只随机取一部分对象，轮转让覆盖慢慢补齐（本地是增量归档，
//      几天下来画像照样完整，但任何单次观察都不指向「有人在盯整箱」）；
//   2. **抖动**：间隔与起始时刻随机，避免固定节奏这种机器特征；
//   3. **按日志归属分配出口**：箱自托管的站点（official-*）是**唯一日志在对方手上**的一类，
//      走 Tor；平台源（bilibili / Reddit / Fandom）那边箱看不到你的 IP，走直连或自建代理
//      —— 而且实测 B 站经 Tor 慢 8 倍、还有接口直接 -799 限流；
//   4. **不发身份**：需要登录态的来源在这个模式下不跑（把实名身份和观测行为绑在一起
//      是最强的关联信号，比 IP 严重得多）。
//
// 实测依据（2026-09-12，见 docs/LIVE.md）：
//   · B 站动态：direct 321ms / tor 2521ms，都是 20 条（用本项目带签名的 fetcher 测的）；
//   · 换出口：SOCKS 用户名不同 → 出口 IP 不同（Tor 的 IsolateSOCKSAuth）；
//   · 箱自托管站点经 Tor：hololivepro 200 / vspo 200 / cover-corp 200、
//     anycolor **403（Cloudflare 拦 Tor）**、brave-group 超时。
import fs from 'node:fs';
import path from 'node:path';
import { resolveDir } from './config.js';

/**
 * 「日志在对方手上」的域名 —— 也就是**箱自己托管**的入口。
 * 只有这一类，Tor 才是真正有意义的：你抓平台（B 站/Reddit/Fandom），
 * 箱拿不到那份日志；你抓它自己的站点，日志就躺在它的服务器上。
 * 这份清单是白名单式的：没列进来的按平台处理（宁可少用 Tor，也不乱套）。
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

/** 这个来源的日志在谁手上：'agency'（箱自己） / 'platform'（第三方平台） */
export function logOwnerOf(source) {
  const host = urlHost(source?.url);
  if (!host) return 'platform';
  return AGENCY_HOSTS.some((h) => host === h || host.endsWith('.' + h)) ? 'agency' : 'platform';
}

/** 需要登录态吗（login: required）—— 观测模式下这类不跑 */
export function isLoginRequired(source) {
  return String(source?.login ?? '').toLowerCase() === 'required';
}

/**
 * 该来源这一轮用什么出口。
 * 返回 null 表示「不动它」——沿用来源自己的设置（source.proxy）与全局代理。
 */
export function resolveEgress(source, cfg, { observation } = {}) {
  const obs = observation ?? cfg?.observation ?? {};
  if (!obs.enabled) return null;
  if (isLoginRequired(source) && obs.skipLoginSources !== false) {
    return { skip: true, reason: '需要登录态：观测模式下不跑（避免把实名身份和观测行为绑在一起）' };
  }
  // 使用者显式钉过出口就尊重它（per-source 那一列）
  if (source?.proxy === 'direct' || source?.proxy === 'proxy' || source?.proxy === 'tor') {
    return { mode: source.proxy, why: '来源自己钉的出口' };
  }
  if (obs.torForAgency !== false && logOwnerOf(source) === 'agency') {
    return { mode: 'tor', why: '日志在对方（箱）手上 → 走 Tor' };
  }
  return null;
}

// ───────────────────────────────────────────── 取样

/**
 * 每轮取一部分。
 *
 * 不能纯随机：纯随机会让某个对象连着好几轮都没被看过（覆盖补齐得很慢）。
 * 也不能纯 LRU：最久没看的一批总是同一批，模式又变得可预测。
 * 所以：**先按「最久没看过」排出候选池，再从池里随机取** —— 既保证公平轮转，
 * 又让「这一轮到底取了谁」不可预测；取完再打乱顺序。
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
  // 候选池要比 k 大一点，池内才有真正的随机空间
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
 * 间隔抖动。
 *
 * `base <= 0` 时**直接返回 0**：显式的「不要等」优先于抖动 ——
 * 诊断路径（`diagnose.js`）就是靠 `rateLimit.gapSeconds = 0` 跳过限流等待的，
 * 抖动不该把那段等待偷偷塞回去。
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

// ───────────────────────────────────────────── 轮转状态（记住「上次看它是什么时候」）

function statePath(cfg) {
  return path.join(resolveDir(cfg, 'logsDir'), 'observation.json');
}

export function loadObservationState(cfg) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(cfg), 'utf8'));
    if (raw && typeof raw === 'object') return { rounds: raw.rounds ?? 0, lastPicked: raw.lastPicked ?? {} };
  } catch {
    /* 没有就从空开始 */
  }
  return { rounds: 0, lastPicked: {} };
}

export function saveObservationState(cfg, state) {
  const p = statePath(cfg);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch {
    /* 记不上不影响这一轮 */
  }
}

// ───────────────────────────────────────────── 一轮的计划

/**
 * 把「这一轮抓谁、用什么出口、间隔多少」一次算清。
 * 纯函数（除了读不到状态时的兜底）：给测试留了 rng 与 history 两个注入口。
 *
 * @returns {{
 *   enabled:boolean, ratio:number,
 *   sources:object[], skippedLogin:object[], egress:Record<string,string>,
 *   watchTargets:object[], sampling:object
 * }}
 */
export function observationPlan({ cfg, sources = [], watchTargets = [], history = { lastPicked: {} }, rng = Math.random, now = new Date() } = {}) {
  const obs = cfg?.observation ?? {};
  const plan = {
    enabled: !!obs.enabled,
    ratio: Number(obs.sampleRatio ?? 0.5),
    sources: sources.slice(),
    watchTargets: watchTargets.slice(),
    skippedLogin: [],
    egress: {},
    sampling: { enabled: !!obs.enabled, ratio: Number(obs.sampleRatio ?? 0.5), sources: null, watch: null },
  };
  if (!plan.enabled) return plan;

  // 1) 按日志归属决定出口 + 需要登录态的直接不跑
  const kept = [];
  for (const s of plan.sources) {
    const e = resolveEgress(s, cfg, { observation: obs });
    if (e?.skip) {
      plan.skippedLogin.push({ id: s.id, reason: e.reason });
      continue;
    }
    if (e?.mode) {
      plan.egress[s.id] = e.mode;
      kept.push({ ...s, proxy: e.mode, egressWhy: e.why });
    } else {
      kept.push(s);
    }
  }

  // 2) 取样（来源与监视对象各取一份）
  const sSample = pickSample(kept, { ratio: plan.ratio, min: obs.minSources ?? 2, history: history.lastPicked, rng });
  const wSample = pickSample(plan.watchTargets, { ratio: plan.ratio, min: obs.minWatch ?? 1, history: history.lastPicked, rng, keyOf: (t) => t.id ?? t.url });

  plan.sources = sSample.picked;
  plan.watchTargets = wSample.picked;
  plan.sampling.sources = { picked: sSample.picked.map((x) => x.id), skipped: sSample.skipped.map((x) => x.id), k: sSample.k, n: sSample.n };
  plan.sampling.watch = { picked: wSample.picked.map((x) => x.id ?? x.url), skipped: wSample.skipped.map((x) => x.id ?? x.url), k: wSample.k, n: wSample.n };
  // 只报**本轮真的会走 Tor 的**那几条（egress 里那些没被取样取到的，这一轮根本不会请求）
  plan.sampling.tor = sSample.picked.filter((s) => s.proxy === 'tor').map((s) => s.id);
  plan.sampling.skippedLogin = plan.skippedLogin.map((x) => x.id);
  plan.at = now.toISOString();
  return plan;
}

/** 这一轮取过的对象记上时间，下一轮优先取「最久没看过」的 */
export function recordPicked(state, ids, at = new Date()) {
  const next = { rounds: (state?.rounds ?? 0) + 1, lastPicked: { ...(state?.lastPicked ?? {}) } };
  for (const id of ids) next.lastPicked[id] = at.toISOString();
  return next;
}
