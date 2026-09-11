// notify.js — 告警推送 / outbound alert delivery
//
// 目标：让「提前预警」真的落到手机上 —— 运行结束、监视命中告警、关键词命中时推一条。
// 支持 Bark / Server酱 / Telegram / Discord / 飞书 / 自定义 Webhook，全部走 netFetch，
// 因此会遵循（且可覆盖）代理配置。
import { netFetch } from './net.js';

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

export function newTarget(kind = 'bark', overrides = {}) {
  const k = NOTIFY_KINDS.find((x) => x.id === kind) ?? NOTIFY_KINDS[0];
  return {
    id: `${kind}-${Date.now().toString(36)}`,
    kind: k.id,
    name: k.name,
    enabled: true,
    // always: 每次运行都推 | alerts: 只在有告警时 | failures: 只在失败时
    on: 'alerts',
    key: '',
    server: '',
    token: '',
    chatId: '',
    webhookUrl: '',
    ...overrides,
  };
}

export function sanitizeTarget(t = {}, i = 0) {
  const fields = ['id', 'kind', 'name', 'enabled', 'on', 'key', 'server', 'token', 'chatId', 'webhookUrl', 'proxy'];
  const out = {};
  for (const f of fields) if (t[f] !== undefined) out[f] = t[f];
  out.kind = NOTIFY_KINDS.some((k) => k.id === out.kind) ? out.kind : 'custom';
  out.id = String(out.id ?? `notify-${i + 1}`).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60);
  out.name = String(out.name ?? out.kind).slice(0, 80);
  out.enabled = out.enabled !== false;
  out.on = ['always', 'alerts', 'failures'].includes(out.on) ? out.on : 'alerts';
  return out;
}

/** 这个目标该不该为本次事件触发 / should this target fire for this event */
function shouldFire(target, { level }) {
  if (!target.enabled) return false;
  if (target.on === 'always') return true;
  if (target.on === 'failures') return level === 'error';
  return level === 'alert' || level === 'error';
}

function truncate(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
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

/** 发一条。/ 返回每个目标的结果，失败不影响其它目标，也绝不抛出去。 */
export async function notify(cfg, log, payload) {
  const targets = (cfg?.notify?.targets ?? []).filter((t) => shouldFire(t, payload));
  if (!targets.length) return { sent: 0, results: [] };
  const results = [];
  for (const t of targets) {
    const req = buildRequest(t, payload);
    if (!req.url) {
      results.push({ id: t.id, ok: false, error: '未填写地址 / no URL configured' });
      continue;
    }
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
      // Bark / Server酱 用 200 + code 表示业务结果
      let business = null;
      try {
        business = JSON.parse(text);
      } catch {
        /* 不是 JSON 就算了 */
      }
      const bad = business && typeof business.code === 'number' && business.code !== 0;
      const ok = res.ok && !bad;
      results.push({ id: t.id, name: t.name, kind: t.kind, ok, status: res.status, error: ok ? null : (business?.message ?? `HTTP ${res.status}`) });
      if (ok) log?.info(`通知已发送 / notified: ${t.name} (${t.kind})`);
      else log?.warn(`通知失败 / notify failed: ${t.name} — ${results.at(-1).error}`);
    } catch (err) {
      const cause = err?.cause?.code ?? err?.cause?.message ?? '';
      const msg = cause ? `${err.message}(${cause})` : err.message;
      results.push({ id: t.id, name: t.name, kind: t.kind, ok: false, error: msg });
      log?.warn(`通知异常 / notify error: ${t.name} — ${msg}`);
    }
  }
  return { sent: results.filter((r) => r.ok).length, results };
}

/** 把敏感字段打码，用于只读接口 / mask secrets for read-only endpoints */
export function maskTarget(t) {
  const masked = { ...t };
  for (const k of ['key', 'token', 'chatId', 'webhookUrl']) {
    if (!masked[k]) continue;
    if (k === 'webhookUrl') {
      // 整条路径都要抹掉：Discord / 飞书的密钥就在路径里，短路径也不能漏
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
