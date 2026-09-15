// sources.js — built-in source adapters.
// Every source is declarative: the fetch method, login requirement and rate-limit parameters are all
// defined here, and the UI only displays and checks them. Users can also override enabled/login in the
// sources map of config.json, or add a custom source straight from the Sources page in the web UI
// (stored in config.customSources).
//
// fetch values: rss | mediawiki-api | browser | search-only | bili-opus | bili-dynamic
// login values: none | optional | required
//   none -- public data
//   optional -- logging in gives more (e.g. the Twitch following list)
//   required -- unavailable without login (e.g. the body of an X post / bilibili dynamics with images); the UI must flag it and check before a run
// proxy values: direct | proxy | omitted (follow the global setting)
//   bilibili is the classic case that must say direct: measured to hit a steady 412 / -352 risk control through a proxy

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

const R = (names) => names; // readability annotation only

export const BUILTIN_SOURCES = [
  // ── community (via RSS; Reddit rate limits need the gap opened up deliberately)
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

  // ── wiki
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

  // ── live
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

  // ── social (without a login there is only the login wall)
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

  // ── video
  {
    id: 'youtube-official',
    name: { zh: 'YouTube 官方频道公告', en: 'YouTube official channels' },
    category: 'video',
    fetch: 'search-only',
    // This was the only built-in source without a url, and the consequence was visible in the UI: the
    // probe skips a source that has no address to measure (server.js: `if (s.url)`), so asking for this
    // one alone answered 400 "nothing to probe" and the panel showed it as untestable. It has no single
    // feed - it spans several official channels - but its fetches go to youtube.com, which is what a
    // latency probe measures, so the site it actually talks to is the honest target.
    url: 'https://www.youtube.com/',
    login: 'optional',
    defaultEnabled: true,
  },

  // ── news
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

  // ── official (plain HTTP returns only the JS shell)
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

  // ── resource (merch, default cadence of 14 days)
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
    cadence: 'merch', // folded into the second run of the 14-day cycle
  })),
];

// ── bilibili
// Measured points:
//   • api.bilibili.com works on a direct connection while a proxy gives a steady 412 / -352, so proxy is always 'direct'
//   • the opus/feed/space endpoint needs no login and no wbi signature, and reliably returns text/image dynamics (body plus like count)
//   • feed/space (full dynamics with attached images) is under very strict risk control and is only obtainable by reusing a login session → login: 'required'
//
// **No built-in source here decides the Live tab.** Every one of them carries liveCheck: false, so the
// live check reads the uids the user chose - live.uids, or a bilibili watch target - and starts with an
// empty Live tab instead of the shipped example accounts. Dynamics monitoring is unaffected, and a
// source added by hand is live-checked as before.
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
    // These four ship enabled, and their live status used to be the whole default content of the Live
    // tab. They are *dynamics* sources: two of them are group accounts rather than a person whose
    // stream one follows, and the set as a whole is a starter example nobody chose. So they no longer
    // feed the live check - a uid in live.uids, or a watch target, still does, which keeps the feature
    // and drops the default. See docs/LIVE.md.
    liveCheck: false,
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
    // by default it points at an UP who really does post images, so "with images" is visible out of the box; the uid can be changed in the web UI
    url: 'https://space.bilibili.com/282994/dynamic',
    uid: '282994',
    // Same rule as the four above: a built-in source does not decide the Live tab. This one points at the
    // same person as bili-opus-yousa, so leaving it in would have kept that account in the default list.
    liveCheck: false,
    proxy: 'direct',
    login: 'required',
    defaultEnabled: false,
    note: {
      zh: '先用「设置 → 浏览器」里配的 profile 只读提取登录 cookie 调接口（浏览器开着也行）；拿不到再退回浏览器渲染。uid 可在网页里改。',
      en: 'Reads login cookies read-only from the profile in Settings → Browser (works while that browser is open); falls back to browser rendering. The uid is editable in the UI.',
    },
  },
];

BUILTIN_SOURCES.push(...BILIBILI_SOURCES);

/** Merge catalog with user config to get the "effective sources" / merge catalog with user config */
export function effectiveSources(config) {
  const overrides = config?.sources ?? {};
  const custom = Array.isArray(config?.customSources) ? config.customSources : [];
  const list = [...BUILTIN_SOURCES, ...custom];
  return list.map((s) => {
    const o = overrides[s.id] ?? {};
    const merged = {
      ...s,
      // Always state the cadence explicitly so consumers (UI / selectSources) never have to guess the default.
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

/** Field whitelist for custom sources (cleaned on create/edit so arbitrary values cannot be stuffed into the config) */
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
