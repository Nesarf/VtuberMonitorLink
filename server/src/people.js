// people.js — 按「人」关注 / follow people, not sources
//
// 为什么需要这一层：来源是**采集单位**，不是使用者真正关心的东西 ——
// 使用者心里想的是「我要盯这 20 个人」。之前只能靠「把 20 个来源都打开」来近似，
// 结果是关心的人漏了、不关心的刷了一片。
//
// 这一层的职责正好三件：
//   1) 把「人」和「这个人的账号在哪」绑起来（bilibili uid / X handle / YouTube 频道 / Twitch）
//   2) 把情报条目**本地**归属到人（纯字符串匹配，不联网、不用 LLM）
//   3) 按人聚合输出（信息流 / 导出 / 通知文案）
//
// 匹配规则的两个要点（都踩过坑才写成这样）：
//   · **中日文没有词边界**，所以 CJK 别名必须用子串匹配（否则「嘉然」永远匹配不到
//     「【嘉然】新动态」这种标题）
//   · **拉丁字母必须要求词边界**，否则 `Mika` 会命中 `Mikado`、`Rei` 会命中 `Reimu` ——
//     这是人名匹配最常见的假阳性
//   · 命中要**带证据**（命中了哪个别名、在哪个字段），界面上要能解释「凭什么说这条是他的」

/** 别名里是否含 CJK（汉字/假名/韩文）→ 决定用子串还是词边界匹配 */
function hasCJK(s) {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(s);
}

export function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从人身上提取所有可用于匹配的别名（名字、别名、账号、uid） */
export function aliasesOf(person) {
  const out = new Set();
  const add = (v, source) => {
    const s = String(v ?? '').trim();
    if (s.length >= 2) out.add(JSON.stringify([s, source])); // 用 JSON 保序去重
  };
  add(person?.name, 'name');
  add(person?.enName, 'enName');
  for (const a of person?.aliases ?? []) add(a, 'alias');
  for (const t of person?.tags ?? []) add(t, 'tag');
  const links = person?.links ?? {};
  if (links.bilibili) {
    add(String(links.bilibili), 'uid');
    add(`space.bilibili.com/${String(links.bilibili).trim()}`, 'uid-url');
  }
  for (const k of ['twitter', 'x']) if (links[k]) {
    const h = String(links[k]).replace(/^@/, '').trim();
    add(h, 'handle');
    add('@' + h, 'handle');
  }
  for (const k of ['youtube', 'twitch', 'tiktok', 'weibo', 'bilibiliName']) if (links[k]) add(links[k], 'handle');
  return [...out].map((s) => {
    const [value, source] = JSON.parse(s);
    return { value, source };
  });
}

/**
 * 条目里参与匹配的字段（标题权重最高）。
 *
 * `sourceName` 一定要在里面：来源名字本身就常是人名（`B站动态 · 嘉然今天吃什么`），
 * 那说明「这个来源就是这个人的账号」—— 这是最强的归属信号之一，
 * 漏掉它会让一整类条目（标题里没写名字的）完全归属不到人。
 */
const FIELDS = [
  ['title', 3],
  ['sourceName', 3],
  ['text', 2],
  ['contentText', 2],
  ['summary', 2],
  ['content', 2],
  ['author', 2],
  ['uploader', 2],
  ['desc', 2],
  ['url', 1],
];

/**
 * 编译匹配器。预先把正则建好，避免逐条编译。
 * @returns {{person:object, alias:string, source:string, re:RegExp}[]}
 */
export function buildMatchers(people) {
  const matchers = [];
  for (const p of people ?? []) {
    if (!p || p.enabled === false) continue;
    for (const { value, source } of aliasesOf(p)) {
      const re = hasCJK(value)
        ? new RegExp(escapeRe(value), 'iu') // CJK：子串
        : new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(value)}(?![\\p{L}\\p{N}])`, 'iu'); // 拉丁：词边界
      matchers.push({ person: p, alias: value, source, re });
    }
  }
  return matchers;
}

/**
 * 取出某个字段里**所有可匹配的字符串**。
 *
 * 为什么不能直接 String(field)：条目里的 `sourceName` 是本地化对象 `{ zh, en }`，
 * `String({zh,en})` 等于 `"[object Object]"` —— 那样来源名这条最强的归属信号
 * 在生产数据上**完全失效**，而且不会报错（只有用对象当别名的荒谬情况才会命中）。
 * 所以对象要摊平成一串候选字符串。
 */
function fieldStrings(value) {
  if (!value) return [];
  if (typeof value === 'string') return value ? [value] : [];
  if (typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(fieldStrings);
  if (typeof value === 'object') return Object.values(value).flatMap(fieldStrings);
  return [];
}

/**
 * 一条情报属于哪些人。
 * @returns {{ids:string[], hits:{id:string,name:string,alias:string,source:string,field:string}[]}}
 */
export function matchItem(item, matchers) {
  const hits = [];
  const ids = new Set();
  for (const m of matchers) {
    for (const [field, weight] of FIELDS) {
      const candidates = fieldStrings(item?.[field]);
      if (!candidates.length) continue;
      if (!candidates.some((s) => m.re.test(s))) continue;
      ids.add(m.person.id);
      hits.push({ id: m.person.id, name: m.person.name, alias: m.alias, source: m.source, field, weight });
      break; // 一个人在同一字段命中一次就够
    }
  }
  return { ids: [...ids], hits };
}

/** 给整批条目打上归属（就地写入 people / peopleHits） */
export function annotateItems(items, people) {
  const matchers = buildMatchers(people);
  let matched = 0;
  const list = (items ?? []).map((it) => {
    const { ids, hits } = matchItem(it, matchers);
    if (ids.length) matched++;
    return { ...it, people: ids, peopleHits: hits };
  });
  return { items: list, matched, peopleCount: new Set(matchers.map((m) => m.person.id)).size };
}

/**
 * 按人聚合：每个人的条目数、最近一次、以及条目本身。
 * 排序用「最近出现」而不是条目数 —— 关注名单里最先要看的永远是「谁刚有动静」。
 */
export function feedByPerson(items, people, { id = null, limit = 100 } = {}) {
  const matchers = buildMatchers(people);
  const byId = new Map();
  for (const p of people ?? []) byId.set(p.id, { person: p, items: [], count: 0, lastAt: null, kinds: {} });

  for (const it of items ?? []) {
    const { ids, hits } = matchItem(it, matchers);
    for (const pid of ids) {
      if (id && pid !== id) continue;
      const bucket = byId.get(pid);
      if (!bucket) continue;
      bucket.items.push({ ...it, peopleHits: hits.filter((h) => h.id === pid) });
      bucket.count++;
      const at = it.publishedAt ?? it.at ?? it.ts ?? null;
      if (at && (!bucket.lastAt || String(at) > String(bucket.lastAt))) bucket.lastAt = at;
      const k = it.kind ?? it.category ?? 'other';
      bucket.kinds[k] = (bucket.kinds[k] ?? 0) + 1;
    }
  }

  let rows = [...byId.values()];
  if (id) rows = rows.filter((r) => r.person.id === id);
  for (const r of rows) r.items = r.items.slice(0, limit);
  rows.sort((a, b) => String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? '')) || b.count - a.count);
  return rows;
}

/** 从实体聚合里推荐「值得加进关注名单的人」（本地统计，不联网） */
export function suggestFromPeople(entities, people, { minCount = 2, limit = 30 } = {}) {
  const known = new Set();
  for (const p of people ?? []) for (const { value } of aliasesOf(p)) known.add(value.toLowerCase());
  return (entities ?? [])
    .filter((e) => (e.count ?? 0) >= minCount)
    .filter((e) => !known.has(String(e.value ?? '').toLowerCase()))
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .slice(0, limit)
    .map((e) => ({ name: e.value, count: e.count, kind: e.kind ?? null, sample: e.sample ?? null }));
}

const LINK_KEYS = ['bilibili', 'twitter', 'x', 'youtube', 'twitch', 'tiktok', 'weibo'];

export function sanitizePerson(input, i = 0) {
  const id = String(input?.id ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 60);
  const name = String(input?.name ?? '').trim().slice(0, 80);
  if (!name) return { error: 'name is required' };
  const links = {};
  for (const k of LINK_KEYS) {
    const v = String(input?.links?.[k] ?? '').trim().slice(0, 120);
    if (v) links[k] = v;
  }
  const uniq = (arr, n) => [...new Set((Array.isArray(arr) ? arr : []).map((x) => String(x ?? '').trim()).filter((x) => x.length >= 2))].slice(0, n);
  return {
    person: {
      id: id || `p-${Date.now().toString(36)}-${i}`,
      name,
      enName: String(input?.enName ?? '').trim().slice(0, 80),
      agency: String(input?.agency ?? '').trim().slice(0, 60),
      aliases: uniq(input?.aliases, 20),
      tags: uniq(input?.tags, 20),
      notes: String(input?.notes ?? '').trim().slice(0, 500),
      links,
      enabled: input?.enabled !== false,
      // 这个人的消息用什么级别推（urgent 会豁免静默时段）
      notifyLevel: ['info', 'alert', 'urgent'].includes(input?.notifyLevel) ? input.notifyLevel : 'alert',
    },
  };
}

/** 单人的导出（给「把某个人的情报发给朋友」和 RSS/JSON 消费用） */
export function personExport(person, items, format = 'json') {
  const rows = items ?? [];
  if (format === 'json') {
    return {
      mime: 'application/json; charset=utf-8',
      file: `${person.id}.json`,
      body: JSON.stringify({ person: { ...person }, count: rows.length, generatedAt: new Date().toISOString(), items: rows }, null, 2),
    };
  }
  const lines = rows.map((it) => {
    const when = it.publishedAt ?? it.at ?? '';
    const title = it.title ?? String(it.text ?? '').slice(0, 80);
    return `- ${when ? `**${when}** · ` : ''}${title}${it.url ? ` — ${it.url}` : ''}`;
  });
  const md = `# ${person.name}${person.agency ? `（${person.agency}）` : ''}\n\n共 ${rows.length} 条 · 生成于 ${new Date().toISOString()}\n\n${lines.join('\n')}\n`;
  return { mime: 'text/markdown; charset=utf-8', file: `${person.id}.md`, body: md };
}
