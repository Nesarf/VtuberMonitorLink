// sources.js — built-in source adapters.
// Every source is declarative: the fetch method, login requirement and rate-limit parameters are all
// defined here, and the UI only displays and checks them. Users can also override enabled/login in the
// sources map of config.json, or add a custom source straight from the Sources page in the web UI
// (stored in config.customSources).
//
// fetch values: rss | mediawiki-api | browser | search-only
//
// `region` (optional, an ISO country code) is what a source wants to *appear from*. It is only used by
// automatic egress selection, and only as a weight: an exit measured in another country pays a penalty
// rather than being ruled out, so a region-bound source still works on a day when nothing in that region
// answers. Sources that do not set it behave exactly as they did before the field existed.
// login values: none | optional | required
//   none -- public data
//   optional -- logging in gives more (e.g. the Twitch following list)
//   required -- unavailable without login; the UI must flag it and check before a run
// proxy values: direct | proxy | omitted (follow the global setting)
//   `direct` is for a site that is measured to misbehave *because* of a proxy (risk control, a 4xx wall),
//   not as a default.

export const CATEGORIES = {
  community: { zh: '社区', en: 'Community' },
  wiki: { zh: '百科', en: 'Wiki' },
  video: { zh: '视频', en: 'Video' },
  news: { zh: '新闻', en: 'News' },
  official: { zh: '官方', en: 'Official' },
  resource: { zh: '资源/通贩', en: 'Resource' },
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
    // The site is Chinese; a fast exit somewhere else is still the wrong door.
    region: 'CN',
    pages: ['hololive', '虚拟UP主'],
    login: 'none',
    defaultEnabled: true,
    note: { zh: 'web_fetch 被 403，需浏览器渲染；仅作背景与考据', en: 'web_fetch gets 403; needs browser render' },
  },

  // ── video
  // The Twitch directory page is a video source: the Live tab that used to read it is gone, the page is not.
  {
    id: 'twitch-vtuber',
    name: { zh: 'Twitch「vtuber」标签直播目录', en: 'Twitch VTuber directory' },
    category: 'video',
    fetch: 'browser',
    url: 'https://www.twitch.tv/directory/all/tags/vtuber',
    login: 'optional',
    defaultEnabled: true,
    note: { zh: '登录后额外含「正在关注」', en: 'Login adds your following list' },
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
    ['4gamers', '4Gamers', 'https://www.4gamers.com.tw/', 'TW'],
    ['kaori', 'KAORI Nusantara', 'https://www.kaorinusantara.or.id/', 'ID'],
    ['moguravr', 'MoguraVR', 'https://www.moguravr.com/'],
    ['dengeki', '電撃オンライン', 'https://dengekionline.com/'],
  ]).map(([id, label, url, region]) => ({
    id: `news-${id}`,
    ...(region ? { region } : {}),
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

/** Merge catalog with user config to get the "effective sources" */
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
// `uid` is deliberately NOT in this list any more: it existed so a hand-added source could name an account id
// for the one fetch kind that read one, and that kind went with the platform it belonged to. A field the
// fetch stage never reads would sit in the config looking like a setting that does something.
export const CUSTOM_SOURCE_FIELDS = ['id', 'name', 'category', 'fetch', 'url', 'login', 'cadence', 'note', 'proxy', 'enabled', 'region'];

export function sanitizeCustomSource(input) {
  const out = {};
  for (const k of CUSTOM_SOURCE_FIELDS) if (input?.[k] !== undefined) out[k] = input[k];
  if (out.id) out.id = String(out.id).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60);
  if (out.name && typeof out.name === 'string') out.name = { zh: out.name, en: out.name };
  // `region` is compared against the country an exit actually measured, so the only usable values are a
  // two-letter code and the absence of one. Anything else - a longer name, a mixed-case code, an object
  // sent by a hand-written request - is dropped rather than stored: a value that can never match would sit
  // in the config looking like a setting the user made. Absence is a real state here (no preference), so
  // "dropped" and "never set" behave identically.
  if (out.region !== undefined) {
    const code = String(out.region).trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(code)) out.region = code;
    else delete out.region;
  }
  if (!out.category) out.category = 'community';
  if (!out.fetch) out.fetch = 'rss';
  if (!out.login) out.login = 'none';
  out.custom = true;
  return out;
}

/**
 * Merge a partial override into the entry that already exists for a source.
 *
 * Why this is a function instead of a spread at the call site: the spread is exactly where the bug lived.
 * `{ ...base, url, uid, proxy, note }` writes `undefined` over every field the caller did not mention, and
 * because the sanitiser skips undefined values that field's previous value does not survive - it is simply
 * gone. The sources page made it visible: changing only the region of a source whose override carried a url
 * deleted the url. Here, a key may only overwrite something if the caller actually sent a value for it.
 */
export function mergeSourceOverride(base, patch) {
  const next = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch ?? {})) if (v !== undefined) next[k] = v;
  return sanitizeCustomSource(next);
}

/**
 * Which host a source's login state would have to come from.
 *
 * The source's own `url` decides it: a login is a property of the site being read, so the honest probe is
 * the read-only cookie probe for that site's host. `www.` is dropped because a cookie is stored against
 * the registrable domain more often than against the `www` label.
 *
 * A source with no usable host answers `null`; the caller must say so instead of quietly doing nothing or
 * guessing a domain the cookie was never stored against.
 * @param {{url?:string}} source
 * @returns {string|null}
 */
export function sourceLoginHost(source = {}) {
  const raw = String(source?.url ?? '').trim();
  if (!raw) return null;
  try {
    const host = new URL(raw).host.toLowerCase();
    return host ? host.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}
