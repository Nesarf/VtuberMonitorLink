// silence.js — 静默/缺失检测：**「没动静」也是一条情报**
//
// 为什么需要：现有告警全是「内容变了」——改了多少字节、命中哪个关键词。
// 但对「判断一个箱的真实状态」来说，**缺失**往往比内容更有信息量：
// 日更的人突然停更、几个人同时安静、整箱连着几天没有任何动静（企划结束？集体休假？账号出事？）。
// 这些在现在的告警体系里是**看不见的**：没有条目就没有告警。
//
// 判据分两层，都相对**各自的基线**，不用拍脑袋的固定天数：
//   1. 个人：某人连续多少天没有条目，超过他自己近期节奏的容忍区间才报（日更的人和月更的人
//      不该用同一个阈值）；完全没有历史的人不报（没有基线就没有异常）。
//   2. 整箱：同一 agency 的成员**同时**没动静 —— 单个人安静是常态，一箱人同时安静才可疑。
//
// 结果是「告警」而不是「结论」：这里只负责把可疑的缺失摆出来，
// 判断留给人（也可能是企划休假、也可能是真出事了）。
import { AGENCY_HOSTS, urlHost } from './observe.js';

/** 一天一条都没有时，允许静默多少天才会报警（默认按个人节奏推导，这里是兜底下限/上限） */
export const SILENCE_DEFAULTS = {
  enabled: true,
  sampleDays: 20, // 用最近多少个**活跃日**估节奏
  minDays: 3, // 至少静默这么多天才值得报（避免正常间隔被当成异常）
  maxDays: 90, // 兜底上限：再长的节奏也不至于让人等一年才报
  factor: 2.5, // 容忍区间 = 平均间隔 × factor，再夹在 minDays / maxDays 之间
  groupQuietDays: 5, // 一箱人同时静默多少天算箱级信号
  minMembers: 3, // 少于这么多成员的「箱」不参与箱级判断
};

const DAY_MS = 86400000;
const dayOf = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * 从「某人 -> { 日期: 条数 }」算出他的**节奏**与最后活跃时间。
 *
 * 节奏 = 最近若干个活跃日之间的**平均间隔**（不是「窗口内活跃天数 / 窗口长度」）。
 * 踩过的坑：第一版把窗口锚在「最后一次活跃那天」，于是「三个月只发了三条」的人
 * 窗口里只剩他自己那一格 → 间隔算成 1 天 → 被当成日更，容忍区间塌到 3 天，
 * 停 5 天就误报。节奏要按**相邻活跃日的间距**算，才和「多久没动静」可比。
 *
 * @returns {{mean:number|null, gapDays:number|null, lastDay:string|null, quietDays:number|null, activeDays:number, items:number}}
 */
export function baselineOf(byDayForPerson, { now = new Date(), sampleDays = SILENCE_DEFAULTS.sampleDays } = {}) {
  const entries = Object.entries(byDayForPerson ?? {}).filter(([, n]) => Number(n) > 0);
  const items = entries.reduce((a, [, n]) => a + Number(n), 0);
  if (!entries.length) return { mean: null, gapDays: null, lastDay: null, quietDays: null, activeDays: 0, items: 0 };

  const days = entries.map(([d]) => d).sort();
  const lastDay = days.at(-1);
  const quietDays = Math.max(0, Math.round((Date.parse(dayOf(now)) - Date.parse(lastDay)) / DAY_MS));
  const recent = days.slice(-Math.max(2, Number(sampleDays) || SILENCE_DEFAULTS.sampleDays));

  let gapDays = null;
  if (recent.length >= 2) {
    const span = (Date.parse(recent.at(-1)) - Date.parse(recent[0])) / DAY_MS;
    gapDays = Number((span / (recent.length - 1)).toFixed(2));
  }

  return {
    mean: Number((items / days.length).toFixed(2)), // 每个活跃日平均几条（只用于展示）
    gapDays,
    lastDay,
    quietDays,
    activeDays: days.length,
    items,
  };
}

/** 这个人的容忍区间（天）：基线间隔 × factor，夹在 minDays 与 maxDays 之间 */
export function toleranceDays(baseline, rules = SILENCE_DEFAULTS) {
  const gap = baseline?.gapDays;
  if (!gap || !Number.isFinite(gap)) return null; // 没有基线（只有一天记录）→ 不判断，宁可不报
  const raw = gap * (Number(rules.factor) || SILENCE_DEFAULTS.factor);
  return Math.min(Number(rules.maxDays) || SILENCE_DEFAULTS.maxDays, Math.max(Number(rules.minDays) || SILENCE_DEFAULTS.minDays, raw));
}

/**
 * 检测静默。
 *
 * @param {object} o
 * @param {object} o.byDay     archive.peopleSeries() 的 byDay：{ personId: { 'YYYY-MM-DD': n } }
 * @param {Array}  o.people    config.people（拿来取名字与 agency）
 * @param {object} o.rules     config.silence
 * @param {Date}   o.now
 * @returns {{person:Array, group:Array, checked:number, skippedNoBaseline:number}}
 */
export function detectSilence({ byDay = {}, people = [], rules = {}, now = new Date() } = {}) {
  const r = { ...SILENCE_DEFAULTS, ...rules };
  const out = { person: [], group: [], checked: 0, skippedNoBaseline: 0 };
  if (!r.enabled) return out;

  const byId = new Map((people ?? []).map((p) => [String(p.id), p]));
  const rows = [];

  for (const [personId, days] of Object.entries(byDay)) {
    const baseline = baselineOf(days, { now, sampleDays: r.sampleDays });
    const tol = toleranceDays(baseline, r);
    if (!baseline.lastDay) continue;
    const person = byId.get(String(personId));
    const name = person?.name ?? personId;
    if (tol === null) {
      out.skippedNoBaseline++;
      continue;
    }
    out.checked++;
    if (baseline.quietDays >= tol) {
      out.person.push({
        kind: 'silence-person',
        personId,
        name,
        agency: person?.agency ?? null,
        quietDays: baseline.quietDays,
        toleranceDays: tol,
        baselineGapDays: baseline.gapDays,
        lastDay: baseline.lastDay,
        level: baseline.quietDays >= tol * 2 ? 'high' : 'warn',
        reason: `${name} 已 ${baseline.quietDays} 天没有新条目（他自己的节奏约 ${baseline.gapDays} 天一条，容忍 ${tol} 天）`,
      });
    }
    rows.push({ personId, name, agency: person?.agency ?? null, quietDays: baseline.quietDays, lastDay: baseline.lastDay });
  }

  // 箱级：同一 agency 的成员**同时**安静
  const byAgency = new Map();
  for (const row of rows) {
    if (!row.agency) continue;
    if (!byAgency.has(row.agency)) byAgency.set(row.agency, []);
    byAgency.get(row.agency).push(row);
  }
  for (const [agency, members] of byAgency) {
    if (members.length < (Number(r.minMembers) || SILENCE_DEFAULTS.minMembers)) continue;
    const quiet = members.filter((m) => m.quietDays >= (Number(r.groupQuietDays) || SILENCE_DEFAULTS.groupQuietDays));
    if (quiet.length >= 2 && quiet.length >= members.length - 1) {
      out.group.push({
        kind: 'silence-group',
        agency,
        quietDays: Math.min(...quiet.map((m) => m.quietDays)),
        members: quiet.map((m) => m.name),
        memberCount: members.length,
        level: quiet.length === members.length ? 'high' : 'warn',
        reason: `${agency} 的 ${quiet.length}/${members.length} 位成员同时安静了 ${Math.min(...quiet.map((m) => m.quietDays))} 天以上 —— 单个人安静是常态，一箱人同时安静值得看一眼`,
      });
    }
  }

  out.person.sort((a, b) => b.quietDays - a.quietDays);
  out.group.sort((a, b) => b.quietDays - a.quietDays);
  return out;
}

/** 把静默检测结果压成一行摘要（给日志/报告/推送用） */
export function silenceSummary(res) {
  const parts = [];
  if (res?.group?.length) parts.push(`箱级安静 ${res.group.length} 个：${res.group.map((g) => g.agency).join('、')}`);
  if (res?.person?.length) parts.push(`个人静默 ${res.person.length} 人：${res.person.slice(0, 5).map((p) => p.name).join('、')}`);
  if (!parts.length) return res?.checked ? `静默检测：${res.checked} 人有基线，均在正常区间` : '静默检测：暂无可判断的基线';
  return parts.join('；');
}

/** 一箱（agency）的成员名单；没填 agency 的按来源/未分组处理 */
export function membersOfAgency(people, agency) {
  return (people ?? []).filter((p) => String(p.agency ?? '') === String(agency));
}

/** 从箱自托管域名反推 agency 名（official-* 那些来源的 url 就是箱的域名） */
export function agencyFromSourceUrl(url) {
  const host = urlHost(url);
  const hit = AGENCY_HOSTS.find((h) => host === h || host.endsWith('.' + h));
  return hit ?? null;
}
