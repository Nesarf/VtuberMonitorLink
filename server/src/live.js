// live.js — live status monitoring
//
// Feature origin: dd-center/bilibili-dd-monitor (MIT, (c) 2020 wdpm) — a "DD multi-screen live viewing"
// desktop tool. Its two cores are "real-time live/offline detection" and "automatic grid layout for many players".
// Reimplemented here on this project's stack (Express + React), **with no upstream code or asset copied**:
//   • upstream depends on vtbs.moe /v1/live, which was measured to be 404 by now (the project stopped
//     updating), so it was replaced by the bilibili batch endpoint that does work here;
//   • the player uses bilibili's official blanc embed page directly (measured: no X-Frame-Options, so it
//     can be embedded), with no forwarding and no proxying.
//
// Measured points:
//   GET https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids?uids[]=672328094
//     -> code=0, data keyed by uid: { room_id, live_status, title, uname, cover, online }
//   live_status: 0 = not live, 1 = live, **2 = carousel** (not a real stream, so the two must be shown
//                apart, otherwise a pile of carousels gets reported as "went live")
//   direct works; going through the proxy may actually get risk-controlled instead (same as every other bilibili source in this project).
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

/** where the uid list comes from: the live.uids config + the uids of bilibili dynamic sources + bilibili uids among the watch targets */
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
    /* an unwritable state file must not affect the run either */
  }
}

/** batch-query live status (one call takes at most 100 uids, anything past that is split into batches) */
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
        { cfg, mode: 'direct' } // same as the dynamics endpoint: the live endpoint only works over direct, the proxy gets it risk-controlled
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
          // the official embed page used by the multi-screen grid: measured to send no X-Frame-Options, safe to iframe
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
 * Check one round of live status and diff it against the previous round to derive "just went live / just went offline".
 * @returns {{ok:boolean, live:Array, round:Array, off:Array, wentLive:Array, wentOff:Array, checked:number, error?:string}}
 */
export async function checkLive(cfg, sources, log) {
  const wanted = liveUids(cfg, sources);
  if (!wanted.length) return { ok: true, live: [], round: [], off: [], wentLive: [], wentOff: [], checked: 0, note: '没有可监测的 uid' };

  const r = await fetchLiveStatus(cfg, wanted.map((w) => w.uid));
  if (!r.ok) {
    log?.warn(`live check failed — ${r.error}`);
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
  log?.info(`live check: live ${live.length}, carousel ${round.length}, offline ${off.length}${wentLive.length ? `, newly live ${wentLive.length}` : ''}`);
  return { ok: true, live, round, off, wentLive, wentOff, checked: wanted.length, at: new Date().toISOString() };
}

/**
 * vtbs.moe roster (9762 entries mid -> roomid/uname), used for "find the UID by name".
 * The /v1/live that upstream dd-monitor uses is 404 by now, but this roster is still alive, so it is kept as a helper.
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
    /* a corrupt cache simply means fetching again */
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
