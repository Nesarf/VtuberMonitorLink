// notify.js — 告警推送 / outbound alert delivery
//
// 目标：让「提前预警」真的落到手机上。
//
// 这一版补的是三件真正缺的事：
//
//  1) **静默时段**。凌晨三点推一条「嘉然今天直播」没有意义 —— 但**丢弃**更糟，
//     因为使用者根本不知道发生过。所以静默期内的通知进**队列**，出静默期补发。
//     跨午夜的时段（23:00→08:00）是最常见的形态，也是最容易写错的地方：
//     不能写成 `start <= t && t < end`（那样 23:00→08:00 永远不成立）。
//     另外「守时」必须按配置的时区算 —— 盯日箱时你的 23:00 不是对方的 23:00。
//
//  2) **去重**。同一条标题在几小时内重复推是纯粹的骚扰（报告标题往往就是同一个）。
//
//  3) **更多渠道**：钉钉（要 HMAC 签名）、企业微信、ntfy、Gotify、PushPlus、Slack。
//     钉钉的加签不能用 `+` 直接拼 URL（base64 里有 `+`/`/`），必须 encodeURIComponent。
//
// 仍然全部走 netFetch，因此遵循（且可按目标覆盖）代理配置。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { netFetch } from './net.js';
import { resolveDir } from './config.js';

export const NOTIFY_KINDS = [
  {
    id: 'bark',
    name: 'Bark（iOS）',
    fields: ['key', 'server'],
    hint: { zh: '填 Bark 的 key；服务器默认 https://api.day.app', en: 'Bark key; server defaults to https://api.day.app' },
  },
  {
    id: 'serverchan',
    name: 'Server酱（微信）',
    fields: ['key'],
    hint: { zh: '填 sctapi.ftqq.com 的 SendKey', en: 'The SendKey from sctapi.ftqq.com' },
  },
  {
    id: 'telegram',
    name: 'Telegram',
    fields: ['token', 'chatId'],
    hint: { zh: 'Bot Token 与 chat_id', en: 'Bot token and chat_id' },
  },
  {
    id: 'dingtalk',
    name: '钉钉群机器人',
    fields: ['webhookUrl', 'secret'],
    hint: {
      zh: 'Webhook 地址 + 加签密钥（安全设置里选「加签」时填；不填就是不签名模式）',
      en: 'Webhook URL plus the signing secret (leave empty if the bot has no signature)',
    },
  },
  {
    id: 'wecom',
    name: '企业微信群机器人',
    fields: ['webhookUrl'],
    hint: { zh: '群机器人的 Webhook 地址（key 在 URL 里）', en: 'Group bot webhook URL (the key is in the URL)' },
  },
  {
    id: 'ntfy',
    name: 'ntfy（可自建）',
    fields: ['server', 'topic', 'token'],
    hint: { zh: '服务器默认 https://ntfy.sh，topic 必填；自建或需要认证时填 token', en: 'Server defaults to https://ntfy.sh; topic required' },
  },
  {
    id: 'gotify',
    name: 'Gotify（可自建）',
    fields: ['server', 'token'],
    hint: { zh: '服务器地址 + 应用 Token', en: 'Server URL plus app token' },
  },
  {
    id: 'pushplus',
    name: 'PushPlus（微信）',
    fields: ['token'],
    hint: { zh: 'pushplus.plus 的 token', en: 'Token from pushplus.plus' },
  },
  {
    id: 'slack',
    name: 'Slack',
    fields: ['webhookUrl'],
    hint: { zh: 'Incoming Webhook 地址', en: 'Incoming webhook URL' },
  },
  {
    id: 'discord',
    name: 'Discord',
    fields: ['webhookUrl'],
    hint: { zh: '频道 Webhook 地址', en: 'Channel webhook URL' },
  },
  {
    id: 'feishu',
    name: '飞书 / Lark',
    fields: ['webhookUrl'],
    hint: { zh: '自定义机器人 Webhook 地址', en: 'Custom bot webhook URL' },
  },
  {
    id: 'custom',
    name: '自定义 Webhook',
    fields: ['webhookUrl'],
    hint: {
      zh: '会 POST 一份 JSON：{ title, body, level, url, at }',
      en: 'POSTs JSON: { title, body, level, url, at }',
    },
  },
];

export const LEVELS = ['info', 'alert', 'urgent', 'error'];

export function newTarget(kind = 'bark', overrides = {}) {
  const k = NOTIFY_KINDS.find((x) => x.id === kind) ?? NOTIFY_KINDS[0];
  return {
    id: `${kind}-${Date.now().toString(36)}`,
    kind: k.id,
    name: k.name,
    enabled: true,
    // always: 每次运行都推 | alerts: 只在有告警时 | failures: 只在失败时
    on: 'alerts',
    // inherit: 遵守静默时段（延后补发）| bypass: 无视静默时段，立刻推
    quiet: 'inherit',
    key: '',
    server: '',
    token: '',
    topic: '',
    secret: '',
    chatId: '',
    webhookUrl: '',
    ...overrides,
  };
}

export function sanitizeTarget(t = {}, i = 0) {
  const fields = [
    'id', 'kind', 'name', 'enabled', 'on', 'quiet', 'key', 'server', 'topic',
    'token', 'secret', 'chatId', 'webhookUrl', 'proxy', 'priority',
  ];
  const out = {};
  for (const f of fields) if (t[f] !== undefined) out[f] = t[f];
  out.kind = NOTIFY_KINDS.some((k) => k.id === out.kind) ? out.kind : 'custom';
  out.id = String(out.id ?? `notify-${i + 1}`).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60);
  out.name = String(out.name ?? out.kind).slice(0, 80);
  out.enabled = out.enabled !== false;
  out.on = ['always', 'alerts', 'failures'].includes(out.on) ? out.on : 'alerts';
  out.quiet = ['inherit', 'bypass'].includes(out.quiet) ? out.quiet : 'inherit';
  return out;
}

/** 这个目标该不该为本次事件触发 / should this target fire for this event */
function shouldFire(target, { level }) {
  if (!target.enabled) return false;
  if (target.on === 'always') return true;
  if (target.on === 'failures') return level === 'error';
  return level === 'alert' || level === 'urgent' || level === 'error';
}

function truncate(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// ───────────────────────────────────────────── 静默时段 / quiet hours

/** 'HH:MM' → 分钟数 */
export function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 某个时刻在指定时区下的「当天分钟数」与星期几 */
export function localClock(at, timeZone) {
  const d = at instanceof Date ? at : new Date(at ?? Date.now());
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || undefined,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = {};
  for (const p of fmt.formatToParts(d)) parts[p.type] = p.value;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { minutes, weekday: map[parts.weekday] ?? 1, hhmm: `${parts.hour}:${parts.minute}` };
}

/**
 * 现在是否处于静默时段。
 *
 * 跨午夜是最容易写错的地方：23:00 → 08:00 这种情况不能用 `start <= t < end` 判断
 * （这个区间在单日内永远为空）。正确做法是判断「在不在禁区里」：
 *   start > end  → t >= start || t < end      （跨午夜）
 *   start <= end → t >= start && t < end      （同一天内）
 * start === end 视为「全天静默」（这是使用者明确表达「别推」的方式）。
 */
export function inQuietHours(cfg, { at = new Date(), kind = null, level = 'info' } = {}) {
  const q = cfg?.notify?.quietHours ?? {};
  if (!q.enabled) return { quiet: false };
  const start = toMinutes(q.start ?? '23:00');
  const end = toMinutes(q.end ?? '08:00');
  if (start === null || end === null) return { quiet: false, error: 'invalid quiet hours' };
  if (start === end) return { quiet: true, until: null, reason: '全天静默' };

  const { minutes, weekday, hhmm } = localClock(at, q.timeZone || cfg?.calendar?.timeZone);
  const days = q.days ?? 'all';
  const dayOk = days === 'all' || (days === 'weekdays' ? weekday >= 1 && weekday <= 5 : weekday === 0 || weekday === 6);
  if (!dayOk) return { quiet: false, clock: hhmm };

  const quiet = start > end ? minutes >= start || minutes < end : minutes >= start && minutes < end;
  if (!quiet) return { quiet: false, clock: hhmm };

  // 免静默的级别（urgent 默认豁免：开播这类时间敏感的通知等不起）
  const bypass = q.bypassLevels ?? ['urgent'];
  if (Array.isArray(bypass) && bypass.includes(level)) return { quiet: false, clock: hhmm, bypassed: true };

  return { quiet: true, clock: hhmm, start: q.start, end: q.end, reason: `静默时段 ${q.start}–${q.end}` };
}

// ───────────────────────────────────────────── 队列与去重

function jfile(cfg, name) {
  return path.join(resolveDir(cfg, 'logsDir'), name);
}

function readJson(cfg, name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(jfile(cfg, name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(cfg, name, data) {
  try {
    fs.mkdirSync(resolveDir(cfg, 'logsDir'), { recursive: true });
    fs.writeFileSync(jfile(cfg, name), JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // 落盘失败不该让通知流程崩掉
  }
}

function fingerprint(payload) {
  return crypto
    .createHash('sha256')
    .update(`${payload.title ?? ''}|${String(payload.body ?? '').slice(0, 300)}`)
    .digest('hex')
    .slice(0, 16);
}

/** 同一条内容在 N 分钟内只推一次 */
export function isDuplicate(cfg, payload, at = Date.now()) {
  const mins = Number(cfg?.notify?.dedupeMinutes ?? 0);
  if (!(mins > 0)) return false;
  const seen = readJson(cfg, 'notify-seen.json', {});
  const fp = fingerprint(payload);
  const last = seen[fp];
  return !!last && at - Date.parse(last) < mins * 60000;
}

export function rememberSent(cfg, payload, at = new Date()) {
  const mins = Number(cfg?.notify?.dedupeMinutes ?? 0);
  if (!(mins > 0)) return;
  const seen = readJson(cfg, 'notify-seen.json', {});
  seen[fingerprint(payload)] = at.toISOString();
  // 顺手清掉过期项，避免无限增长
  const cutoff = at.getTime() - Math.max(mins, 1440) * 60000;
  for (const [k, v] of Object.entries(seen)) if (Date.parse(v) < cutoff) delete seen[k];
  writeJson(cfg, 'notify-seen.json', seen);
}

export function queuePath(cfg) {
  return jfile(cfg, 'notify-queue.json');
}

export function readQueue(cfg) {
  return readJson(cfg, 'notify-queue.json', []);
}

/** 静默期内积压的通知 */
export function enqueue(cfg, log, payload, { reason, targetIds = null } = {}) {
  const q = readQueue(cfg);
  const item = {
    id: `q-${Date.now().toString(36)}-${q.length}`,
    queuedAt: new Date().toISOString(),
    reason: reason ?? '静默时段',
    level: payload.level ?? 'info',
    title: payload.title ?? '',
    body: payload.body ?? '',
    url: payload.url ?? null,
    targetIds, // null = 发给当时该发的所有目标
  };
  q.push(item);
  // 上限保护：积压太多没意义，留最近的 200 条
  const capped = q.slice(-200);
  writeJson(cfg, 'notify-queue.json', capped);
  log?.info(`通知已进入队列（${item.reason}）/ queued: ${item.title}`);
  return item;
}

/**
 * 把队列里该发的补发出去。
 * @param {object} o
 * @param {boolean} o.force 忽略静默时段（手动点「立即补发」时用）
 */
export async function flushQueue(cfg, log, { force = false, limit = 20 } = {}) {
  const q = readQueue(cfg);
  if (!q.length) return { flushed: 0, remaining: 0 };
  const now = inQuietHours(cfg, { at: new Date(), level: 'info' });
  if (now.quiet && !force) return { flushed: 0, remaining: q.length, quiet: true };

  const batch = q.slice(0, limit);
  const sentIds = new Set();
  for (const item of batch) {
    const res = await deliver(cfg, log, {
      title: item.title,
      body: item.body,
      level: item.level,
      url: item.url,
      // 补发时不再走静默判断（已经出静默期了），但仍走目标过滤
      _skipQuiet: true,
      _targetIds: item.targetIds,
    });
    if (res.sent > 0 || res.results.length === 0) sentIds.add(item.id);
    else if (res.results.every((r) => r.ok === false && r.error)) sentIds.add(item.id); // 全失败也别永远卡在队列里
  }
  const remaining = q.filter((x) => !sentIds.has(x.id));
  writeJson(cfg, 'notify-queue.json', remaining);
  if (sentIds.size) log?.info(`补发了 ${sentIds.size} 条积压通知 / flushed ${sentIds.size} queued notifications`);
  return { flushed: sentIds.size, remaining: remaining.length };
}

// ───────────────────────────────────────────── 渠道请求构造

/** 钉钉加签：HMAC-SHA256(timestamp + "\n" + secret) 再 base64，最后必须 URL 编码 */
export function dingtalkSign(secret, timestamp) {
  const stringToSign = `${timestamp}\n${secret}`;
  const hmac = crypto.createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64');
  return { sign: hmac, query: `timestamp=${timestamp}&sign=${encodeURIComponent(hmac)}` };
}

/** 把一条通知变成具体请求 / turn one notification into a concrete request */
export function buildRequest(target, payload) {
  const title = truncate(payload.title ?? "Vtuber's Monitor Link", 80);
  const body = truncate(payload.body ?? '', 1500);
  const base = { url: '', method: 'POST', headers: { 'content-type': 'application/json' }, body: null };

  switch (target.kind) {
    case 'bark': {
      const server = (target.server || 'https://api.day.app').replace(/\/+$/, '');
      return {
        ...base,
        method: 'GET',
        headers: {},
        url: `${server}/${encodeURIComponent(target.key ?? '')}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=VML&isArchive=1`,
      };
    }
    case 'serverchan':
      return {
        ...base,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        url: `https://sctapi.ftqq.com/${encodeURIComponent(target.key ?? '')}.send`,
        body: new URLSearchParams({ title, desp: body }).toString(),
      };
    case 'telegram':
      return {
        ...base,
        url: `https://api.telegram.org/bot${target.token ?? ''}/sendMessage`,
        body: JSON.stringify({ chat_id: target.chatId ?? '', text: `${title}\n\n${body}`, disable_web_page_preview: true }),
      };
    case 'dingtalk': {
      let url = String(target.webhookUrl ?? '');
      if (target.secret) {
        const ts = Date.now();
        const { query } = dingtalkSign(target.secret, ts);
        url += (url.includes('?') ? '&' : '?') + query;
      }
      return { ...base, url, body: JSON.stringify({ msgtype: 'text', text: { content: `${title}\n\n${body}` } }) };
    }
    case 'wecom':
      return { ...base, url: target.webhookUrl ?? '', body: JSON.stringify({ msgtype: 'text', text: { content: `${title}\n${body}` } }) };
    case 'ntfy': {
      const server = (target.server || 'https://ntfy.sh').replace(/\/+$/, '');
      return {
        ...base,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          Title: encodeHeader(title),
          Priority: target.priority ?? (payload.level === 'urgent' ? '5' : payload.level === 'error' ? '4' : '3'),
          ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}),
        },
        url: `${server}/${encodeURIComponent(target.topic ?? '')}`,
        body: `${title}\n\n${body}`,
      };
    }
    case 'gotify': {
      const server = (target.server || '').replace(/\/+$/, '');
      return {
        ...base,
        headers: { 'content-type': 'application/json', 'X-Gotify-Key': target.token ?? '' },
        url: `${server}/message`,
        body: JSON.stringify({ title, message: body, priority: payload.level === 'urgent' ? 8 : payload.level === 'error' ? 6 : 3 }),
      };
    }
    case 'pushplus':
      return {
        ...base,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        url: 'https://www.pushplus.plus/send',
        body: new URLSearchParams({ token: target.token ?? '', title, content: body }).toString(),
      };
    case 'slack':
      return { ...base, url: target.webhookUrl ?? '', body: JSON.stringify({ text: `*${title}*\n${body}`.slice(0, 3000) }) };
    case 'discord':
      return { ...base, url: target.webhookUrl ?? '', body: JSON.stringify({ content: `${title}\n${body}`.slice(0, 1900) }) };
    case 'feishu':
      return {
        ...base,
        url: target.webhookUrl ?? '',
        body: JSON.stringify({ msg_type: 'text', content: { text: `${title}\n\n${body}` } }),
      };
    default:
      return {
        ...base,
        url: target.webhookUrl ?? '',
        body: JSON.stringify({ title, body, level: payload.level ?? 'info', url: payload.url ?? null, at: new Date().toISOString() }),
      };
  }
}

/** HTTP 头不能含中文/换行 —— ntfy 的 Title 走头部，必须编码 */
function encodeHeader(s) {
  const ascii = /^[\x20-\x7E]*$/.test(s);
  if (ascii) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

// ───────────────────────────────────────────── 投递

async function deliver(cfg, log, payload) {
  const targets = (cfg?.notify?.targets ?? []).filter((t) => shouldFire(t, payload));
  const picked = payload._targetIds ? targets.filter((t) => payload._targetIds.includes(t.id)) : targets;
  const results = [];
  for (const t of picked) {
    const req = buildRequest(t, payload);
    if (!req.url) {
      results.push({ id: t.id, name: t.name, kind: t.kind, ok: false, error: '未填写地址 / no URL configured' });
      continue;
    }
    let lastErr = null;
    // 一次重试：网络抖动导致的漏推是最难察觉的失败
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await netFetch(
          req.url,
          {
            method: req.method,
            headers: req.headers,
            body: req.body ?? undefined,
            signal: AbortSignal.timeout(20000),
          },
          { cfg, subject: t }
        );
        const text = await res.text().catch(() => '');
        let business = null;
        try {
          business = JSON.parse(text);
        } catch {
          /* 不是 JSON 就算了 */
        }
        // Bark / Server酱 / 钉钉 / 企业微信 / 飞书 都用 200 + 业务码表示结果
        const bad =
          business &&
          ((typeof business.code === 'number' && business.code !== 0) ||
            (typeof business.errcode === 'number' && business.errcode !== 0) ||
            (typeof business.StatusCode === 'number' && business.StatusCode !== 0));
        const ok = res.ok && !bad;
        if (ok) {
          results.push({ id: t.id, name: t.name, kind: t.kind, ok: true, status: res.status, error: null });
          log?.info(`通知已发送 / notified: ${t.name} (${t.kind})`);
        } else {
          const err = business?.message ?? business?.errmsg ?? business?.msg ?? `HTTP ${res.status}`;
          results.push({ id: t.id, name: t.name, kind: t.kind, ok: false, status: res.status, error: err });
          log?.warn(`通知失败 / notify failed: ${t.name} — ${err}`);
        }
        lastErr = null;
        break;
      } catch (err) {
        const cause = err?.cause?.code ?? err?.cause?.message ?? '';
        lastErr = cause ? `${err.message}(${cause})` : err.message;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
      }
    }
    if (lastErr) {
      results.push({ id: t.id, name: t.name, kind: t.kind, ok: false, error: lastErr });
      log?.warn(`通知异常 / notify error: ${t.name} — ${lastErr}`);
    }
  }
  return { sent: results.filter((r) => r.ok).length, results };
}

/**
 * 发一条通知。顺序是：目标过滤 → 去重 → 静默时段（进队列）→ 投递。
 * 失败不影响其它目标，也绝不抛出去。
 */
export async function notify(cfg, log, payload) {
  // 注意：这里**不要**顺手 flush 队列。
  // 我最初写了个 `flushQueue(cfg, log).catch(() => {})`（不 await），结果它会在
  // 调用方已经改了配置之后才真正执行 —— 静默判断用的是「执行那一刻」的配置，
  // 于是刚入队的通知会被立刻补发出去（自检里表现为「静默期内不该投递却投递了」）。
  // 补发必须由调用方在明确的时间点 await 调用（runner 每次运行结束、或手动触发）。
  if (isDuplicate(cfg, payload)) {
    log?.info(`通知重复，已跳过 / duplicate notification skipped: ${payload.title ?? ''}`);
    return { sent: 0, results: [], skipped: 'duplicate' };
  }

  if (!payload._skipQuiet) {
    const t = inQuietHours(cfg, { at: new Date(), level: payload.level ?? 'info' });
    if (t.quiet) {
      // 全部目标都豁免时才直接发；否则进队列等静默结束
      const targets = (cfg?.notify?.targets ?? []).filter((x) => shouldFire(x, payload));
      const bypassed = targets.filter((x) => x.quiet === 'bypass');
      if (!bypassed.length) {
        const item = enqueue(cfg, log, payload, { reason: t.reason });
        return { sent: 0, results: [], queued: item.id, reason: t.reason };
      }
      payload = { ...payload, _targetIds: bypassed.map((x) => x.id) };
      log?.info(`静默时段，但有 ${bypassed.length} 个目标豁免 / bypassing quiet hours for ${bypassed.length} target(s)`);
    }
  }

  const out = await deliver(cfg, log, payload);
  if (out.sent > 0) rememberSent(cfg, payload);
  return out;
}

/** 把敏感字段打码，用于只读接口 / mask secrets for read-only endpoints */
export function maskTarget(t) {
  const masked = { ...t };
  for (const k of ['key', 'token', 'secret', 'chatId', 'webhookUrl']) {
    if (!masked[k]) continue;
    if (k === 'webhookUrl') {
      // 整条路径都要抹掉：Discord / 飞书 / 企业微信的密钥就在路径里，短路径也不能漏
      // （之前的规则只打码 ≥6 字符的末段，/hook 这种就直接漏出去了）
      try {
        const u = new URL(masked[k]);
        const path = u.pathname && u.pathname !== '/' ? '/***' : '/';
        masked[k] = `${u.origin}${path}${u.search ? '?***' : ''}`;
      } catch {
        masked[k] = '***';
      }
    } else {
      const v = String(masked[k]);
      masked[k] = v.length > 8 ? `${v.slice(0, 4)}***${v.slice(-2)}` : '***';
    }
  }
  return masked;
}
