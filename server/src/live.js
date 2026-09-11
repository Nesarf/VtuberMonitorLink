// live.js — 开播监测 / live status
//
// 功能来源：dd-center/bilibili-dd-monitor（MIT, (c) 2020 wdpm）—— 一个「DD 多屏看播」
// 桌面工具。它的两个核心是「开播/下播实时检测」与「多播放器自动网格布局」。
// 这里按本项目的栈（Express + React）重新实现，**没有复制上游代码或资源**：
//   • 上游依赖 vtbs.moe 的 /v1/live，实测该端点已 404（项目停更），所以换成本机实测可用的
//     B 站批量接口；
//   • 播放器直接用 B 站官方的 blanc 内嵌页（实测无 X-Frame-Options，可嵌），不做转发与代理。
//
// 实测要点：
//   GET https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids?uids[]=672328094
//     -> code=0，data 以 uid 为键：{ room_id, live_status, title, uname, cover, online }
//   live_status: 0 = 未开播，1 = 直播中，**2 = 轮播**（不是真开播，必须分开显示，
//                否则会把一堆轮播误报成「开播了」）
//   直连可用；走代理反而可能被风控（与本项目其它 bilibili 来源一致）。
import fs from 'node:fs';
import path from 'node:path';
import { resolveDir } from './config.js';
import { netFetch } from './net.js';

const API = 'https://api.live.bilibili.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const LIVE_STATUS = { OFF: 0, LIVE: 1, ROUND: 2 };

function headers() {
  return {
    'user-agent': UA,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    referer: 'https://live.bilibili.com/',
    origin: 'https://live.bilibili.com',
  };
}

/** 一份 uid 列表从哪来：live.uids 配置 + B 站动态来源的 uid + 监视对象里的 B 站 uid */
export function liveUids(cfg, sources) {
  const out = new Map();
  for (const u of cfg?.live?.uids ?? []) {
    const uid = String(typeof u === 'string' ? u : u?.uid ?? '').trim();
    if (/^\d+$/.test(uid)) out.set(uid, typeof u === 'object' ? u.name ?? '' : '');
  }
  for (const s of sources ?? []) {
    if (s.uid && /^\d+$/.test(String(s.uid))) out.set(String(s.uid), s.name?.zh ?? s.id);
  }
  for (const t of cfg?.watch?.targets ?? []) {
    if (t.kind === 'bili-opus' && t.uid && /^\d+$/.test(String(t.uid))) out.set(String(t.uid), t.label ?? '');
  }
  return [...out.entries()].map(([uid, name]) => ({ uid, name }));
}

function statePath(cfg) {
  return path.join(resolveDir(cfg, 'logsDir'), 'live-state.json');
}

export function loadLiveState(cfg) {
  try {
    const f = statePath(cfg);
    if (!fs.existsSync(f)) return {};
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return {};
  }
}

function saveLiveState(cfg, state) {
  try {
    const f = statePath(cfg);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(state, null, 1), 'utf8');
  } catch {
    /* 状态写不进也不该影响运行 */
  }
}

/** 批量查询开播状态（一次最多 100 个 uid，超了分批） */
export async function fetchLiveStatus(cfg, uids) {
  const list = [...new Set(uids.map((u) => String(u)).filter((u) => /^\d+$/.test(u)))];
  if (!list.length) return { ok: true, rooms: {}, batches: 0 };
  const rooms = {};
  let batches = 0;
  for (let i = 0; i < list.length; i += 50) {
    const batch = list.slice(i, i + 50);
    const qs = batch.map((u) => `uids[]=${encodeURIComponent(u)}`).join('&');
    batches++;
    try {
      const r = await netFetch(
        `${API}/room/v1/Room/get_status_info_by_uids?${qs}`,
        { headers: headers(), signal: AbortSignal.timeout(25000) },
        { cfg, mode: 'direct' } // 直播接口和动态接口一样：直连才通，走代理会被风控
      );
      const j = await r.json().catch(() => null);
      if (j?.code !== 0) return { ok: false, error: `code=${j?.code ?? 'bad-json'} ${j?.message ?? ''}`, rooms };
      for (const [uid, v] of Object.entries(j.data ?? {})) {
        rooms[uid] = {
          uid,
          roomId: v.room_id,
          uname: v.uname ?? '',
          title: v.title ?? '',
          cover: v.cover ?? '',
          online: v.online ?? 0,
          areaName: v.area_name ?? '',
          status: Number(v.live_status ?? 0),
          url: `https://live.bilibili.com/${v.room_id}`,
          // 多屏用的官方内嵌页：实测无 X-Frame-Options，可安全 iframe
          embed: `https://live.bilibili.com/blanc/${v.room_id}?hidePanel=1`,
        };
      }
    } catch (e) {
      return { ok: false, error: e.message, rooms };
    }
  }
  return { ok: true, rooms, batches };
}

/**
 * 检查一轮开播状态，并与上次比对得出「刚开播 / 刚下播」。
 * @returns {{ok:boolean, live:Array, round:Array, off:Array, wentLive:Array, wentOff:Array, checked:number, error?:string}}
 */
export async function checkLive(cfg, sources, log) {
  const wanted = liveUids(cfg, sources);
  if (!wanted.length) return { ok: true, live: [], round: [], off: [], wentLive: [], wentOff: [], checked: 0, note: '没有可监测的 uid' };

  const r = await fetchLiveStatus(cfg, wanted.map((w) => w.uid));
  if (!r.ok) {
    log?.warn(`开播检查失败 / live check failed — ${r.error}`);
    return { ok: false, error: r.error, live: [], round: [], off: [], wentLive: [], wentOff: [], checked: 0 };
  }

  const prev = loadLiveState(cfg);
  const next = {};
  const live = [];
  const round = [];
  const off = [];
  const wentLive = [];
  const wentOff = [];

  for (const w of wanted) {
    const v = r.rooms[w.uid];
    const name = v?.uname || w.name || w.uid;
    const status = v ? v.status : -1;
    next[w.uid] = { status, roomId: v?.roomId ?? null, at: new Date().toISOString() };
    const entry = { ...(v ?? { uid: w.uid, uname: name }), name, status };
    if (status === LIVE_STATUS.LIVE) {
      live.push(entry);
      if (prev[w.uid] && prev[w.uid].status !== LIVE_STATUS.LIVE) wentLive.push(entry);
    } else if (status === LIVE_STATUS.ROUND) {
      round.push(entry);
    } else {
      off.push(entry);
      if (prev[w.uid] && prev[w.uid].status === LIVE_STATUS.LIVE) wentOff.push(entry);
    }
  }

  saveLiveState(cfg, next);
  log?.info(`开播检查：直播中 ${live.length}、轮播 ${round.length}、未开播 ${off.length}${wentLive.length ? `，新开播 ${wentLive.length}` : ''}`);
  return { ok: true, live, round, off, wentLive, wentOff, checked: wanted.length, at: new Date().toISOString() };
}

/**
 * vtbs.moe 花名册（9762 条 mid -> roomid/uname），用于「按名字找 UID」。
 * 上游 dd-monitor 用的 /v1/live 已经 404，但这个花名册还活着，所以留着当辅助。
 */
export async function searchRoster(cfg, keyword, limit = 20) {
  const key = String(keyword ?? '').trim().toLowerCase();
  if (!key) return { ok: false, error: 'keyword is required', hits: [] };
  const cacheFile = path.join(resolveDir(cfg, 'logsDir'), 'vtbs-roster.json');
  let roster = null;
  try {
    if (fs.existsSync(cacheFile)) {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const age = Date.now() - Date.parse(c.at ?? 0);
      if (age < (Number(cfg?.live?.cacheRosterHours ?? 24) * 3600_000)) roster = c.list;
    }
  } catch {
    /* 缓存坏了就重取 */
  }
  if (!roster) {
    try {
      const r = await netFetch('https://api.vtbs.moe/v1/short', { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) }, { cfg });
      const j = await r.json();
      if (!Array.isArray(j)) return { ok: false, error: 'unexpected roster payload', hits: [] };
      roster = j.map((x) => ({ mid: String(x.mid), roomid: x.roomid, uname: x.uname }));
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({ at: new Date().toISOString(), list: roster }), 'utf8');
    } catch (e) {
      return { ok: false, error: e.message, hits: [] };
    }
  }
  const hits = roster.filter((x) => String(x.uname ?? '').toLowerCase().includes(key)).slice(0, limit);
  return { ok: true, total: roster.length, hits };
}
