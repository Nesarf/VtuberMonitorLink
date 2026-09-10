// sources.js — 内置来源适配器目录 / built-in source adapters.
// 每条来源都是声明式的：抓取方式、登录要求、限流参数都在这里定义，
// UI 只负责展示与勾选。用户也可以在 config.json 的 sources 里覆盖 enabled/login，
// 或直接在网页「来源」页里新增自定义来源（存进 config.customSources）。
//
// fetch 取值：rss | mediawiki-api | browser | search-only | bili-opus | bili-dynamic
// login 取值：none | optional | required
//   none     —— 公开数据
//   optional —— 登录更全（如 Twitch 的关注列表）
//   required —— 不登录拿不到（如 X 推文正文 / B 站带图动态），UI 需标红并在跑前检查
// proxy 取值：direct | proxy | 省略（跟随全局）
//   B 站是必须写 direct 的典型：实测经代理会稳定 412 / -352 风控

export const CATEGORIES = {
  community: { zh: '社区', en: 'Community' },
  wiki: { zh: '百科', en: 'Wiki' },
  live: { zh: '直播', en: 'Live' },
  social: { zh: '社交', en: 'Social' },
  video: { zh: '视频', en: 'Video' },
  news: { zh: '新闻', en: 'News' },
  official: { zh: '官方', en: 'Official' },
  resource: { zh: '资源/通贩', en: 'Resource' },
  bili: { zh: 'B 站', en: 'bilibili' },
};

const R = (names) => names; // 仅作可读性标注

export const BUILTIN_SOURCES = [
  // ── 社区 / Community（走 RSS，Reddit 限流需主动拉开间隔）
  ...R(['VirtualYoutubers', 'Hololive', 'Nijisanji', 'VShojo']).map((sub) => ({
    id: `reddit-${sub}`,
    name: { zh: `Reddit r/${sub}`, en: `Reddit r/${sub}` },
    category: 'community',
    fetch: 'rss',
    url: `https://www.reddit.com/r/${sub}/.rss`,
    login: 'none',
    rateLimit: { gapSeconds: 35, retries: 1, deadlineMinutes: 6 },
    defaultEnabled: true,
    note: { zh: '浏览器与 .json 均被拦，仅 .rss 可用', en: 'Browser & .json blocked; .rss only' },
  })),

  // ── 百科 / Wiki
  {
    id: 'fandom-vtuber-wiki',
    name: { zh: 'Fandom「Virtual YouTuber Wiki」', en: 'Fandom Virtual YouTuber Wiki' },
    category: 'wiki',
    fetch: 'mediawiki-api',
    url: 'https://virtualyoutuber.fandom.com/api.php?action=query&list=recentchanges&rclimit=50&rcprop=title|timestamp|user|comment&format=json',
    login: 'none',
    defaultEnabled: true,
    note: { zh: 'Special:RecentChanges 被 Cloudflare 拦，API 直通', en: 'RecentChanges blocked by Cloudflare; API works' },
  },
  {
    id: 'moegirl',
    name: { zh: '萌娘百科（hololive / 虚拟UP主 等条目）', en: 'Moegirlpedia (zh wiki)' },
    category: 'wiki',
    fetch: 'browser',
    url: 'https://zh.moegirl.org.cn/',
    pages: ['hololive', '虚拟UP主'],
    login: 'none',
    defaultEnabled: true,
    note: { zh: 'web_fetch 被 403，需浏览器渲染；仅作背景与考据', en: 'web_fetch gets 403; needs browser render' },
  },

  // ── 直播 / Live
  {
    id: 'twitch-vtuber',
    name: { zh: 'Twitch「vtuber」标签直播目录', en: 'Twitch VTuber directory' },
    category: 'live',
    fetch: 'browser',
    url: 'https://www.twitch.tv/directory/all/tags/vtuber',
    login: 'optional',
    defaultEnabled: true,
    note: { zh: '登录后额外含「正在关注」', en: 'Login adds your following list' },
  },

  // ── 社交 / Social（不登录只有登录墙）
  {
    id: 'x-twitter',
    name: { zh: 'X / Twitter（官方与爆料账号）', en: 'X / Twitter' },
    category: 'social',
    fetch: 'browser',
    url: 'https://x.com/',
    login: 'required',
    defaultEnabled: true,
    note: { zh: '未登录只显示登录墙，必须复用浏览器登录态', en: 'Login wall without session' },
  },

  // ── 视频 / Video
  {
    id: 'youtube-official',
    name: { zh: 'YouTube 官方频道公告', en: 'YouTube official channels' },
    category: 'video',
    fetch: 'search-only',
    login: 'optional',
    defaultEnabled: true,
  },

  // ── 新闻 / News
  ...R([
    ['ann', 'Anime News Network', 'https://www.animenewsnetwork.com/'],
    ['kaiyou', 'KAI-YOU', 'https://kai-you.net/'],
    ['4gamers', '4Gamers', 'https://www.4gamers.com.tw/'],
    ['kaori', 'KAORI Nusantara', 'https://www.kaorinusantara.or.id/'],
    ['moguravr', 'MoguraVR', 'https://www.moguravr.com/'],
    ['dengeki', '電撃オンライン', 'https://dengekionline.com/'],
  ]).map(([id, label, url]) => ({
    id: `news-${id}`,
    name: { zh: label, en: label },
    category: 'news',
    fetch: 'browser',
    url,
    login: 'none',
    defaultEnabled: true,
  })),

  // ── 官方 / Official（纯 HTTP 只返回 JS 骨架）
  ...R([
    ['anycolor', 'ANYCOLOR（にじさんじ）', 'https://www.anycolor.co.jp/news'],
    ['hololive', 'hololive production', 'https://hololive.hololivepro.com/en/news'],
    ['bravegroup', 'Brave group', 'https://bravegroup.co.jp/news/'],
    ['vspo', 'ぶいすぽっ！', 'https://vspo.jp/news/'],
    ['cover', 'COVER Corp.', 'https://cover-corp.com/en/news'],
  ]).map(([id, label, url]) => ({
    id: `official-${id}`,
    name: { zh: label, en: label },
    category: 'official',
    fetch: 'browser',
    url,
    login: 'none',
    defaultEnabled: true,
    note: { zh: '纯 HTTP 只返回 JS 骨架，需浏览器渲染', en: 'Plain HTTP returns JS shell only' },
  })),

  // ── 资源 / 通贩（默认按 14 天节奏）
  ...R([
    ['fanbox', 'Pixiv FANBOX', 'https://www.fanbox.cc/'],
    ['cien', 'Ci-en', 'https://ci-en.dlsite.com/'],
    ['booth', 'BOOTH', 'https://booth.pm/'],
    ['dlsite', 'DLsite', 'https://www.dlsite.com/'],
  ]).map(([id, label, url]) => ({
    id: `merch-${id}`,
    name: { zh: label, en: label },
    category: 'resource',
    fetch: 'search-only',
    url,
    login: 'optional',
    defaultEnabled: true,
    cadence: 'merch', // 归入 14 天一次的第二次运行
  })),
];

// ── B 站 / bilibili
// 实测要点：
//   • api.bilibili.com 直连可用，走代理反而稳定 412 / -352，所以 proxy 一律 'direct'
//   • opus/feed/space 这个端点无需登录、无需 wbi 签名，稳定返回图文动态（正文+点赞数）
//   • feed/space（带配图的完整动态）风控极严，只有复用登录态才拿得到 → login: 'required'
const BILI_OPUS = [
  ['jaran', '嘉然今天吃什么（A-SOUL）', '672328094'],
  ['asoul', 'A-SOUL 官方', '703007996'],
  ['yousa', '泠鸢yousa', '282994'],
  ['hanser', 'hanser', '11073'],
];

export const BILIBILI_SOURCES = [
  ...BILI_OPUS.map(([id, label, uid]) => ({
    id: `bili-opus-${id}`,
    name: { zh: `B站动态 · ${label}`, en: `bilibili · ${label}` },
    category: 'bili',
    fetch: 'bili-opus',
    url: `https://space.bilibili.com/${uid}/dynamic`,
    uid,
    proxy: 'direct',
    login: 'none',
    rateLimit: { gapSeconds: 3, retries: 2 },
    defaultEnabled: true,
    note: {
      zh: '图文动态，含正文与点赞数；无需登录。想要带配图的完整动态请改用 bili-dynamic 并配置登录。',
      en: 'Text/image dynamics with text and likes; no login needed. For full dynamics with pictures use bili-dynamic with a login.',
    },
  })),
  {
    id: 'bili-dynamic-login',
    name: { zh: 'B站完整动态（含配图，需登录）', en: 'bilibili full dynamics with pictures (login required)' },
    category: 'bili',
    fetch: 'bili-dynamic',
    url: 'https://space.bilibili.com/672328094/dynamic',
    uid: '672328094',
    proxy: 'direct',
    login: 'required',
    defaultEnabled: false,
    note: {
      zh: '用「设置 → 浏览器」里指定的已登录 profile 渲染动态页；未登录会弹滑块验证。uid 可在网页里改。',
      en: 'Renders the dynamic page with the signed-in profile from Settings → Browser; without a login bilibili shows a captcha. The uid is editable in the UI.',
    },
  },
];

BUILTIN_SOURCES.push(...BILIBILI_SOURCES);

/** 与用户配置合并，得到「生效来源」 / merge catalog with user config */
export function effectiveSources(config) {
  const overrides = config?.sources ?? {};
  const custom = Array.isArray(config?.customSources) ? config.customSources : [];
  const list = [...BUILTIN_SOURCES, ...custom];
  return list.map((s) => {
    const o = overrides[s.id] ?? {};
    const merged = {
      ...s,
      // cadence 始终显式给出，避免消费方（UI / selectSources）去猜缺省值
      // Always state the cadence so consumers never have to infer a default.
      cadence: s.cadence === 'merch' ? 'merch' : 'daily',
      enabled: o.enabled ?? s.defaultEnabled ?? true,
      login: o.login ?? s.login ?? 'none',
    };
    if (o.custom !== undefined) merged.custom = o.custom;
    else if (s.custom !== undefined) merged.custom = s.custom;
    return merged;
  });
}

export function findSource(id) {
  return BUILTIN_SOURCES.find((s) => s.id === id) ?? null;
}

/** 自定义来源的字段白名单（新增/编辑时清洗，避免往配置里塞任意东西） */
export const CUSTOM_SOURCE_FIELDS = ['id', 'name', 'category', 'fetch', 'url', 'login', 'cadence', 'note', 'uid', 'proxy', 'enabled'];

export function sanitizeCustomSource(input) {
  const out = {};
  for (const k of CUSTOM_SOURCE_FIELDS) if (input?.[k] !== undefined) out[k] = input[k];
  if (out.id) out.id = String(out.id).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60);
  if (out.name && typeof out.name === 'string') out.name = { zh: out.name, en: out.name };
  if (!out.category) out.category = 'community';
  if (!out.fetch) out.fetch = 'rss';
  if (!out.login) out.login = 'none';
  out.custom = true;
  return out;
}
