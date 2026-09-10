// sources.js — 内置来源适配器目录 / built-in source adapters.
// 每条来源都是声明式的：抓取方式、登录要求、限流参数都在这里定义，
// UI 只负责展示与勾选。用户也可以在 config.json 的 sources 里覆盖 enabled/login。
//
// fetch 取值：rss | mediawiki-api | browser | search-only
// login 取值：none | optional | required
//   none     —— 公开数据
//   optional —— 登录更全（如 Twitch 的关注列表）
//   required —— 不登录拿不到（如 X 推文正文），UI 需标红并在跑前检查

export const CATEGORIES = {
  community: { zh: '社区', en: 'Community' },
  wiki: { zh: '百科', en: 'Wiki' },
  live: { zh: '直播', en: 'Live' },
  social: { zh: '社交', en: 'Social' },
  video: { zh: '视频', en: 'Video' },
  news: { zh: '新闻', en: 'News' },
  official: { zh: '官方', en: 'Official' },
  resource: { zh: '资源/通贩', en: 'Resource' },
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

/** 与用户配置合并，得到「生效来源」 / merge catalog with user config */
export function effectiveSources(config) {
  const overrides = config?.sources ?? {};
  return BUILTIN_SOURCES.map((s) => {
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
    return merged;
  });
}

export function findSource(id) {
  return BUILTIN_SOURCES.find((s) => s.id === id) ?? null;
}
