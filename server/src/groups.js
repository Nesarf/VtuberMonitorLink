// groups.js — 箱视角：把「按人关注」聚成「按团体看」
//
// 为什么需要：逐条情报流适合「今天有什么新闻」，不适合回答「这个箱现在怎么样」。
// 判断一个箱的状态，要看的是**一组人**在时间上的形状：
//   · 谁在动、谁停了（缺失也是情报）
//   · 是不是**同时**动（同一天多人活跃 = 企划/联动，而不是 N 条互不相关的新闻）
//   · 是不是**同时**停（整箱安静 = 值得看一眼的信号）
//   · 每个人相对**自己**的节奏是否异常（日更的人停 3 天 vs 月更的人停 3 天，其实不是一回事）
//
// 这里只做聚合，不做判断：把上面四件事算成结构化数据交给人看。
// 纯函数（输入 byDay + people + 日期轴），所以自检能把形状钉住。
import { baselineOf, toleranceDays, SILENCE_DEFAULTS } from './silence.js';

const DAY_MS = 86400000;
const dayOf = (d) => new Date(d).toISOString().slice(0, 10);

/** 生成日期轴（含今天），升序 */
export function dayAxis(days, endDay = null) {
  const end = endDay ?? dayOf(new Date());
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(dayOf(Date.parse(end + 'T00:00:00Z') - i * DAY_MS));
  return out;
}

/**
 * 把一个 agency 的成员聚成一块。
 *
 * @param {object} o
 * @param {Array}  o.members   成员（people 里同 agency 的那些）
 * @param {object} o.byDay     archive.peopleSeries().byDay：{ personId: { day: n } }
 * @param {string[]} o.axis    日期轴（升序）
 * @param {object} o.rules     config.silence（复用同一套节奏判据）
 * @param {Date}   o.now
 */
export function agencyBlock({ agency, members = [], byDay = {}, axis = [], rules = {}, now = new Date() } = {}) {
  const r = { ...SILENCE_DEFAULTS, ...rules };
  const rows = members.map((p) => {
    const days = byDay[String(p.id)] ?? {};
    const baseline = baselineOf(days, { now, sampleDays: r.sampleDays });
    const tol = toleranceDays(baseline, r);
    const counts = axis.map((d) => Number(days[d] ?? 0));
    const active = counts.filter((n) => n > 0).length;
    const level = !tol || baseline.quietDays === null ? 'unknown' : baseline.quietDays >= tol * 2 ? 'high' : baseline.quietDays >= tol ? 'warn' : 'ok';
    return {
      id: String(p.id),
      name: p.name ?? String(p.id),
      aliases: p.aliases ?? [],
      tags: p.tags ?? [],
      counts, // 与 axis 一一对应的每日条数（热力图直接用）
      activeDays: active,
      items: counts.reduce((a, b) => a + b, 0),
      lastDay: baseline.lastDay,
      quietDays: baseline.quietDays,
      gapDays: baseline.gapDays,
      toleranceDays: tol,
      level,
    };
  });

  // 每日合计（箱级节奏）
  const perDay = axis.map((_, i) => rows.reduce((a, row) => a + row.counts[i], 0));

  // 同刻出现：同一天有 ≥2 人活跃 → 多半是企划/联动，而不是 N 条独立新闻
  const coActive = [];
  let allActiveDays = 0;
  for (let i = 0; i < axis.length; i++) {
    const who = rows.filter((row) => row.counts[i] > 0).map((row) => row.name);
    if (who.length >= 2) coActive.push({ day: axis[i], members: who, count: who.length });
    if (rows.length >= 2 && who.length === rows.length) allActiveDays++;
  }

  // 共同沉默：从轴尾往前数，连续多少天**一个成员都没动**
  let quietStreak = 0;
  for (let i = axis.length - 1; i >= 0; i--) {
    if (perDay[i] > 0) break;
    quietStreak++;
  }

  const silent = rows.filter((row) => row.level === 'warn' || row.level === 'high').sort((a, b) => (b.quietDays ?? 0) - (a.quietDays ?? 0));
  const activeLast7 = rows.filter((row) => row.counts.slice(-7).some((n) => n > 0)).length;

  // 箱级信号：整箱安静（一个都没动），或多数人同时安静。
  // 两条都要求成员数 ≥ minMembers —— 「1~2 个人也算一个箱」会一直刷信号，
  // 那是噪音而不是情报（真在意两人组的人可以把 minMembers 调成 2）。
  const minMembers = Number(r.minMembers) || SILENCE_DEFAULTS.minMembers;
  const groupSignal =
    rows.length < minMembers
      ? null
      : quietStreak >= (Number(r.groupQuietDays) || SILENCE_DEFAULTS.groupQuietDays)
        ? { level: 'high', kind: 'all-quiet', days: quietStreak, reason: `整箱 ${rows.length} 人已经 ${quietStreak} 天没有任何动静` }
        : silent.length >= 2 && silent.length >= rows.length - 1
          ? { level: 'warn', kind: 'most-quiet', days: Math.min(...silent.map((s) => s.quietDays ?? 0)), reason: `${rows.length} 人里有 ${silent.length} 人同时安静` }
          : null;
  return {
    agency,
    members: rows.sort((a, b) => b.items - a.items || a.name.localeCompare(b.name)),
    perDay,
    totals: { items: rows.reduce((a, r2) => a + r2.items, 0), members: rows.length, activeMembers: rows.filter((r2) => r2.items > 0).length },
    activeLast7,
    coActiveDays: coActive.length,
    coActive: coActive.slice(-8).reverse(), // 最近几次「多人同时出现」
    fullHouseDays: allActiveDays,
    quietStreak,
    silent,
    // quietStreak 仍然是数字：成员太少时不出「信号」，但数据照样给界面显示
    groupSignal,
  };
}

/**
 * 按 agency 聚合全部关注对象。
 * 没填 agency 的人归入一个显式的「未分组」块（而不是被悄悄丢掉）。
 */
export function groupView({ byDay = {}, people = [], days = 30, rules = {}, now = new Date(), endDay = null } = {}) {
  const axis = dayAxis(days, endDay);
  const byAgency = new Map();
  const ungrouped = [];
  for (const p of people ?? []) {
    const a = String(p.agency ?? '').trim();
    if (!a) {
      ungrouped.push(p);
      continue;
    }
    if (!byAgency.has(a)) byAgency.set(a, []);
    byAgency.get(a).push(p);
  }
  const groups = [...byAgency.entries()]
    .map(([agency, members]) => agencyBlock({ agency, members, byDay, axis, rules, now }))
    .sort((a, b) => b.totals.items - a.totals.items || String(a.agency).localeCompare(String(b.agency)));

  return {
    from: axis[0],
    to: axis[axis.length - 1],
    days,
    axis,
    groups,
    ungrouped: ungrouped.length
      ? agencyBlock({ agency: null, members: ungrouped, byDay, axis, rules, now })
      : null,
    people: (people ?? []).length,
  };
}
