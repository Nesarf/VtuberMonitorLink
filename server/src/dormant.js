// dormant.js — 已停止活动的对象（毕业 / 长期休止）：日报末尾统一列他们的最新内容
//
// 为什么需要：日报是「今天有什么新东西」，于是**停了的人永远不会出现在日报里** ——
// 哪怕他昨天刚发了一条（那是他半年来唯一的一条，恰恰最该被看见）。
// 反过来，一个已经半年没动的人，如果突然动了，也应该在日报里一眼看到。
//
// 所以规则是：把「停止活动达到阈值（默认 6 个月）」的人在日报**末尾**统一列出来，
// 每人附上他最新的一两条内容与日期。这样日报对「人」这件事是连续的：
// 活跃的人在上面（今天的动态），休眠的人在下面（他们的最近一次），谁突然动了都一眼可见。
//
// 判据只看**事实**（最后一次活动距今多久），不猜「是不是毕业了」：
// 毕业、休止、换平台，在数据上都只是「很久没有新条目」。
import { baselineOf } from './silence.js';

export const DORMANT_DEFAULTS = {
  enabled: true,
  months: 6, // 用户要的阈值：半年
  maxPeople: 12, // 一次最多列几个人（多了就变成噪音）
  maxItems: 2, // 每人最多几条
  comebackDays: 3, // 「复出」判定：休眠这么久之后，最近几天又有动静
};

const DAY_MS = 86400000;
const dayOf = (v) => new Date(v).toISOString().slice(0, 10);

/** 距今天数（按天粒度） */
export function daysSince(day, now = new Date()) {
  if (!day) return null;
  const d = Date.parse(String(day).slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(d)) return null;
  return Math.max(0, Math.round((Date.parse(dayOf(now)) - d) / DAY_MS));
}

/**
 * 这个人算「已停止活动」吗。
 * months 用 30.44 天/月（不用 30 天：半年差出一天多，边界上会前后不一致）。
 */
export function isDormant({ lastDay, now = new Date(), months = DORMANT_DEFAULTS.months } = {}) {
  const days = daysSince(lastDay, now);
  if (days === null) return { dormant: false, days: null };
  const threshold = Math.round(Number(months) * 30.44);
  return { dormant: days >= threshold, days, thresholdDays: threshold };
}

/**
 * 组织日报末尾的那个区块。
 *
 * @param {object} o
 * @param {Array}  o.people       关注对象
 * @param {object} o.byDay        archive.peopleSeries().byDay（算最后活跃日）
 * @param {object} o.latestItems  { personId: [{title, day, url}] } —— 由 archive 查来
 * @param {object} o.todayPeople  今天有条目的 personId 集合（用来识别「复出」）
 * @param {object} o.rules
 * @returns {{dormant:Array, returnees:Array, markdown:string, skipped:number}}
 */
export function dormantBlock({ people = [], byDay = {}, latestItems = {}, todayPeople = [], rules = {}, now = new Date() } = {}) {
  const r = { ...DORMANT_DEFAULTS, ...rules };
  const out = { dormant: [], returnees: [], markdown: '', skipped: 0 };
  if (!r.enabled || !people.length) return out;

  const today = new Set(todayPeople);
  const candidates = [];

  for (const p of people) {
    const days = byDay[String(p.id)] ?? {};
    const baseline = baselineOf(days, { now });
    if (baseline.lastDay === null) {
      // 从来没有记录过：不是「停止活动」，是「还没见过」——不列（列出来等于噪音）
      out.skipped++;
      continue;
    }
    const activeDays = Object.keys(days)
      .filter((d) => Number(days[d]) > 0)
      .sort();
    // 复出要这样看：最近几天动了，而**在那之前**已经静默了至少一整个阈值 ——
    // 只看「最后活跃日」是抓不到的（复出的人最后活跃日就是今天，看上去很健康）。
    const recentActive = daysSince(activeDays.at(-1), now) <= (Number(r.comebackDays) || DORMANT_DEFAULTS.comebackDays);
    const prevDay = activeDays.length >= 2 ? activeDays.at(-2) : null;
    const gapBeforeRecent = prevDay ? daysSince(prevDay, now) : null;
    const thresholdDays = Math.round(Number(r.months ?? DORMANT_DEFAULTS.months) * 30.44);
    const comeback = recentActive && gapBeforeRecent !== null && gapBeforeRecent >= thresholdDays;

    const st = isDormant({ lastDay: baseline.lastDay, now, months: r.months });
    if (!st.dormant && !comeback) continue;
    const items = (latestItems[String(p.id)] ?? []).slice(0, Math.max(1, Number(r.maxItems) || 1));
    const quietDays = st.dormant ? st.days : gapBeforeRecent;
    const rec = {
      id: String(p.id),
      name: p.name ?? String(p.id),
      agency: p.agency ?? null,
      lastDay: baseline.lastDay,
      quietDays,
      months: Number((quietDays / 30.44).toFixed(1)),
      items,
      comeback,
    };
    if (rec.comeback) out.returnees.push(rec);
    else candidates.push(rec);
  }

  // 复出的排前面（那是最该被看见的），其余按「谁最近有过动静」排
  out.returnees.sort((a, b) => a.quietDays - b.quietDays);
  candidates.sort((a, b) => (b.lastDay ?? '').localeCompare(a.lastDay ?? ''));
  const picked = [...out.returnees, ...candidates].slice(0, Math.max(1, Number(r.maxPeople) || DORMANT_DEFAULTS.maxPeople));
  out.dormant = picked;
  out.hidden = Math.max(0, out.returnees.length + candidates.length - picked.length);

  const lines = [];
  if (out.returnees.length) {
    lines.push(`**🟢 可能有动静了**（原本已休眠 ≥${r.months} 个月）：`);
    for (const p of out.returnees) {
      lines.push(`- **${p.name}**${p.agency ? `（${p.agency}）` : ''} —— 上次活动 ${p.lastDay}（停了约 ${p.months} 个月）`);
      for (const it of p.items) lines.push(`    - ${it.day ?? ''} ${String(it.title ?? '').slice(0, 90)}${it.url ? ` — ${it.url}` : ''}`);
    }
  }
  if (candidates.length) {
    lines.push('');
    lines.push(`**⏳ 已停止活动 ≥${r.months} 个月**（${candidates.length} 人，下面是他们各自最新的内容）：`);
    for (const p of candidates.slice(0, Math.max(0, (Number(r.maxPeople) || DORMANT_DEFAULTS.maxPeople) - out.returnees.length))) {
      lines.push(`- **${p.name}**${p.agency ? `（${p.agency}）` : ''} —— 最后 ${p.lastDay}（约 ${p.months} 个月前）`);
      for (const it of p.items) lines.push(`    - ${it.day ?? ''} ${String(it.title ?? '').slice(0, 90)}${it.url ? ` — ${it.url}` : ''}`);
    }
    if (out.hidden) lines.push(`- …另有 ${out.hidden} 位同样处于停止活动状态（超过每次上限）`);
  }
  out.markdown = lines.length ? `## 🌙 停止活动 / 毕业（≥${r.months} 个月无动静）\n\n${lines.join('\n')}` : '';
  return out;
}
