// notify.js — outbound alert delivery
//
// Goal: make "early warning" actually land on a phone.
//
// This version fills in the three things that were genuinely missing:
//
//  1) **Quiet hours**. Pushing "Jaran is live today" at 3 a.m. is pointless -- but **dropping** it is
//     worse, because the user never learns it happened. So notifications during quiet hours go into a
//     **queue** and are flushed once quiet hours end.
//     The cross-midnight window (23:00→08:00) is the most common shape and the easiest place to get
//     it wrong: it cannot be written as `start <= t && t < end` (that window is never true for 23:00→08:00).
//     Also "what time it is" has to be computed in the configured time zone -- when watching a JP agency
//     your 23:00 is not their 23:00.
//
//  2) **Deduplication**. Pushing the same title again within a few hours is pure harassment (report titles are often the same).
//
//  3) **More channels**: DingTalk (needs an HMAC signature), WeCom, ntfy, Gotify, PushPlus, Slack.
//     DingTalk's signature cannot be appended to the URL with plain `+` (base64 contains `+`/`/`),
//     so it has to go through encodeURIComponent.
//
// Everything still goes through netFetch, so it follows the proxy config (and can override it per target).
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
    // always: push on every run | alerts: only when there are alerts | failures: only on failure
    on: 'alerts',
    // inherit: respect quiet hours (flush later) | bypass: ignore quiet hours, push at once
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

/** Should this target fire for this event? */
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

// ───────────────────────────────────────────── quiet hours

/** 'HH:MM' → minutes */
export function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** The "minutes into the day" and the weekday of an instant in the given time zone */
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
 * Are we inside quiet hours right now.
 *
 * Cross-midnight is the easiest place to get it wrong: a 23:00 → 08:00 window cannot be tested with
 * `start <= t < end` (that interval is always empty within a single day). The correct approach is to
 * test "is it inside the forbidden zone":
 *   start > end  → t >= start || t < end      (crosses midnight)
 *   start <= end → t >= start && t < end      (within the same day)
 * start === end counts as "all-day quiet" (that is how the user explicitly says "do not push").
 */
export function inQuietHours(cfg, { at = new Date(), kind = null, level = 'info' } = {}) {
  const q = cfg?.notify?.quietHours ?? {};
  if (!q.enabled) return { quiet: false };
  const start = toMinutes(q.start ?? '23:00');
  const end = toMinutes(q.end ?? '08:00');
  if (start === null || end === null) return { quiet: false, error: 'invalid quiet hours' };
  // Reason strings in this section are shown in Settings ("quiet now · <reason>") and in the
  // notification queue, i.e. they are product copy: they stay in the product's language.
  if (start === end) return { quiet: true, until: null, reason: '全天静默' };

  const { minutes, weekday, hhmm } = localClock(at, q.timeZone || cfg?.calendar?.timeZone);
  const days = q.days ?? 'all';
  const dayOk = days === 'all' || (days === 'weekdays' ? weekday >= 1 && weekday <= 5 : weekday === 0 || weekday === 6);
  if (!dayOk) return { quiet: false, clock: hhmm };

  const quiet = start > end ? minutes >= start || minutes < end : minutes >= start && minutes < end;
  if (!quiet) return { quiet: false, clock: hhmm };

  // Levels exempt from quiet hours (urgent is exempt by default: time-sensitive notifications like a stream starting cannot wait)
  const bypass = q.bypassLevels ?? ['urgent'];
  if (Array.isArray(bypass) && bypass.includes(level)) return { quiet: false, clock: hhmm, bypassed: true };

  return { quiet: true, clock: hhmm, start: q.start, end: q.end, reason: `静默时段 ${q.start}–${q.end}` };
}

// ───────────────────────────────────────────── queue and dedupe

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
    // A failed write must not take the notification flow down
  }
}

function fingerprint(payload) {
  return crypto
    .createHash('sha256')
    .update(`${payload.title ?? ''}|${String(payload.body ?? '').slice(0, 300)}`)
    .digest('hex')
    .slice(0, 16);
}

/** The same content is pushed only once per N minutes */
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
  // Also clear out expired entries along the way so the file cannot grow forever
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

/** Notifications piling up during quiet hours */
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
    targetIds, // null = send to every target that should have fired at the time
  };
  q.push(item);
  // A cap on the backlog: keeping more than that would be meaningless, so the most recent 200 are kept
  const capped = q.slice(-200);
  writeJson(cfg, 'notify-queue.json', capped);
  log?.info(`queued: ${item.title} (${item.reason})`);
  return item;
}

/**
 * Flush the queue entries that are due.
 * @param {object} o
 * @param {boolean} o.force ignore quiet hours (used by the manual "flush now" button)
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
      // A flush does not re-enter the quiet check (quiet hours are already over), but target filtering still applies
      _skipQuiet: true,
      _targetIds: item.targetIds,
    });
    if (res.sent > 0 || res.results.length === 0) sentIds.add(item.id);
    else if (res.results.every((r) => r.ok === false && r.error)) sentIds.add(item.id); // even a total failure must not stay stuck in the queue forever
  }
  const remaining = q.filter((x) => !sentIds.has(x.id));
  writeJson(cfg, 'notify-queue.json', remaining);
  if (sentIds.size) log?.info(`flushed ${sentIds.size} queued notifications`);
  return { flushed: sentIds.size, remaining: remaining.length };
}

// ───────────────────────────────────────────── channel request construction

/** DingTalk signing: HMAC-SHA256(timestamp + "\n" + secret) then base64, and finally it must be URL-encoded */
export function dingtalkSign(secret, timestamp) {
  const stringToSign = `${timestamp}\n${secret}`;
  const hmac = crypto.createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64');
  return { sign: hmac, query: `timestamp=${timestamp}&sign=${encodeURIComponent(hmac)}` };
}

/** Turn one notification into a concrete request */
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

/** HTTP headers cannot contain CJK characters or newlines -- ntfy's Title goes in a header, so it must be encoded */
function encodeHeader(s) {
  const ascii = /^[\x20-\x7E]*$/.test(s);
  if (ascii) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

// ───────────────────────────────────────────── delivery

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
    // One retry: a dropped push caused by network jitter is the hardest kind of failure to notice
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
          /* if it is not JSON, that is fine here */
        }
        // Bark / ServerChan / DingTalk / WeCom / Feishu all express the result as 200 plus a business code
        const bad =
          business &&
          ((typeof business.code === 'number' && business.code !== 0) ||
            (typeof business.errcode === 'number' && business.errcode !== 0) ||
            (typeof business.StatusCode === 'number' && business.StatusCode !== 0));
        const ok = res.ok && !bad;
        if (ok) {
          results.push({ id: t.id, name: t.name, kind: t.kind, ok: true, status: res.status, error: null });
          log?.info(`notified: ${t.name} (${t.kind})`);
        } else {
          const err = business?.message ?? business?.errmsg ?? business?.msg ?? `HTTP ${res.status}`;
          results.push({ id: t.id, name: t.name, kind: t.kind, ok: false, status: res.status, error: err });
          log?.warn(`notify failed: ${t.name} — ${err}`);
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
      log?.warn(`notify error: ${t.name} — ${lastErr}`);
    }
  }
  return { sent: results.filter((r) => r.ok).length, results };
}

/**
 * Send one notification. The order is: target filtering → dedupe → quiet hours (into the queue) → delivery.
 * A failure does not affect the other targets, and it is never thrown outwards.
 */
export async function notify(cfg, log, payload) {
  // Note: do **not** casually flush the queue here.
  // I originally wrote a `flushQueue(cfg, log).catch(() => {})` (without awaiting), and it ended up
  // running only after the caller had already changed the config -- the quiet check uses the config as it
  // is at the moment it runs, so a notification that had just been queued was flushed straight out again
  // (in the self-test this showed up as "delivered during quiet hours when it should not have been").
  // A flush must be awaited by the caller at a well-defined moment (at the end of every runner run, or
  // on a manual trigger).
  if (isDuplicate(cfg, payload)) {
    log?.info(`duplicate notification skipped: ${payload.title ?? ''}`);
    return { sent: 0, results: [], skipped: 'duplicate' };
  }

  if (!payload._skipQuiet) {
    const t = inQuietHours(cfg, { at: new Date(), level: payload.level ?? 'info' });
    if (t.quiet) {
      // Send straight away only when every target is exempt; otherwise queue it and wait for quiet hours to end
      const targets = (cfg?.notify?.targets ?? []).filter((x) => shouldFire(x, payload));
      const bypassed = targets.filter((x) => x.quiet === 'bypass');
      if (!bypassed.length) {
        const item = enqueue(cfg, log, payload, { reason: t.reason });
        return { sent: 0, results: [], queued: item.id, reason: t.reason };
      }
      payload = { ...payload, _targetIds: bypassed.map((x) => x.id) };
      log?.info(`quiet hours, but ${bypassed.length} target(s) are exempt`);
    }
  }

  const out = await deliver(cfg, log, payload);
  if (out.sent > 0) rememberSent(cfg, payload);
  return out;
}

/** Mask secrets for read-only endpoints */
export function maskTarget(t) {
  const masked = { ...t };
  for (const k of ['key', 'token', 'secret', 'chatId', 'webhookUrl']) {
    if (!masked[k]) continue;
    if (k === 'webhookUrl') {
      // The whole path has to be erased: the Discord / Feishu / WeCom secrets live in the path, and a short path must not slip through either
      // (the previous rule only masked a trailing segment of >= 6 characters, so something like /hook leaked straight out)
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
