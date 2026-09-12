// config.js — 配置读写 / Config load & save.
// 所有路径都可配置：不写死任何机器专属路径。
// All paths are configurable; no hard-coded machine-specific paths.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 项目根目录 / project root */
export const APP_ROOT = path.resolve(__dirname, '..', '..');
export const CONFIG_PATH = path.join(APP_ROOT, 'config.json');

export const DEFAULT_CONFIG = {
  browser: {
    // bundled: 随包分发的 Chromium | system: 系统已装浏览器 | custom: 用户指定路径
    mode: 'bundled',
    executablePath: '',
    // 复用登录态时指向浏览器的 user-data-dir（留空则用临时干净配置）
    profileDir: '',
    headless: true,
    waitMs: 6000,
    hardTimeoutMs: 90000,
  },
  llm: {
    // 多档位：网页里可以存好几套（便宜的 / 出报告用的）随时切换
    // 兼容旧格式：若只有扁平的 baseUrl/apiKey/model，会被 activeProvider() 当成单档位
    activeId: '',
    providers: [],
    // 以下为旧格式遗留字段，保留以便平滑迁移
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat',
    reasoningEffort: 'high',
    maxTokens: 8192,
    temperature: 0.3,
  },
  schedule: {
    // 多条计划任务；旧版的扁平写法（enabled/mode/dayOfWeek/time）会自动迁移成一条
    enabled: false, // 兼容字段，实际以 tasks 为准
    mode: 'weekly', // weekly | daily
    dayOfWeek: 2,
    time: '23:30',
    merchEveryDays: 14,
    tasks: [],
  },
  run: {
    // 预抓取节流：Reddit 类站点按 IP 限流，主动拉开间隔比连击重试有效
    defaultGapSeconds: 2,
    maxParallel: 3,
    // 每次运行是否顺带检查监视对象 / also run the watch targets
    watchWithRun: true,
    // 某个出口失败时，自动换另一个出口再试一次（来源没显式指定出口时才生效）
    autoFailover: true,
    // 运行**最后**对出异常的来源做自检并生成诊断文件（连通正常的不打扰）
    diagnoseFailed: true,
    // 用 LLM 抽结构化特征（人名/所属/游戏/事件），让检索能按属性命中；有缓存、有上限
    extractFeatures: true,
    featureLimit: 40,
  },
  proxy: {
    // 重要：Node 的 fetch(undici) 默认**不读**系统代理；
    // 本工具会按此配置显式走代理，抓取与浏览器渲染同时生效。
    // 例外：部分站点（如 B 站）走代理反而被风控，可按来源设 direct。
    enabled: false,
    url: '',
    // 出口模式：http = 走下面的 HTTP 代理；tor = 走 Tor 的 SOCKS5（无痕化）
    mode: 'http',
    // Tor 的 SOCKS5 地址（Tor Browser 默认 9150，独立 tor 默认 9050）
    torSocks: 'socks5://127.0.0.1:9150',
    // 可选：一键启动 tor 用的可执行文件路径（留空则不提供该按钮）
    torExe: '',
    // mihomo / Clash.Meta 的控制接口（用于列节点、切节点、测每个节点到某站的延迟）
    controlUrl: '',
    controlSecret: '',
  },
  live: {
    // 开播监测（功能来源见 docs/REVIEW-live.md；上游 dd-center/bilibili-dd-monitor 为 MIT）
    enabled: true,
    // 额外要监测的 uid；B 站动态来源与监视对象里的 uid 会自动并入
    uids: [],
    // 每次运行顺带查一次开播状态
    checkWithRun: true,
    // 有人从「未开播」变成「直播中」时推送（轮播不算，轮播会误报）
    notifyOnLive: true,
    // vtbs.moe 花名册缓存时长（小时）
    cacheRosterHours: 24,
  },
  // 按「人」关注：名单本身就是配置（谁的名字、别名、账号在哪）
  // [{ id, name, enName, agency, aliases[], tags[], notes, links{bilibili,twitter,youtube,twitch},
  //    enabled, notifyLevel: info|alert|urgent }]
  people: [],
  peopleOptions: {
    // 情报页默认是否只看关注对象（默认关：先让人看到全量，再自己决定收窄）
    onlyFollowed: false,
    // 命中关注对象时，按那个人的 notifyLevel 推送
    notifyOnMatch: true,
    // 日报里列出关注对象的动态
    reportMatches: true,
  },
  // 一键分享 / one-click sharing
  share: {
    // 下载分享包时的默认格式
    defaultFormat: 'html',
    // 已经用真实账号验证过、允许对外使用的发帖目标（第一次成功发布后会自动写进来）
    // 之所以要有这个列表：对外发东西不可撤销，没验证过的代码路径不该被当成可用
    verifiedTargets: [],
  },
  // 图片理解打标 / image understanding
  // 注意：**默认关闭**。开启意味着把情报里的配图发送到你配置的模型服务 ——
  // 这是隐私相关的动作，必须由使用者明确打开，不能默认偷偷发。
  vision: {
    enabled: false,
    // 用哪个档位打标（留空 = 用当前激活档位）
    providerId: '',
    // 一次运行最多打多少张（按图 URL 缓存，重复的图不重复花钱）
    runLimit: 40,
    concurrency: 2,
    maxTokens: 300,
    timeoutMs: 60000,
    // 自定义提示词（留空用内置的）
    prompt: '',
    // 档位被标记为「不支持视觉」时是否仍然尝试
    requireVisionModel: true,
  },
  // 多源同事件合并 / 相似度去重 / 来源权重
  cluster: {
    enabled: true,
    // IDF 加权 Dice 阈值：太低会把不相干的事并起来（信息被吞），太高等于没合并
    threshold: 0.52,
    // 超过这个时间差就不算同一件事（防止把去年的同一活动并进来）
    windowHours: 72,
  },
  // 来源权重的静态基准（按分类给默认值），可在这里按来源 id 覆盖
  // 例：{ "news-ann": 1.4, "community-reddit": 0.6 }
  sourceWeights: {},
  notify: {
    desktop: true,
    // 同一条内容在 N 分钟内只推一次（0 = 不去重）。报告标题往往每次都一样，
    // 不去重就是纯骚扰。
    dedupeMinutes: 0,
    // 静默时段：**不是丢弃，是入队补发**。
    // 跨午夜（23:00→08:00）是最常见的形态，calendar.js / notify.js 里都按
    // 「start > end 即跨午夜」处理。start === end 表示全天静默。
    // bypassLevels 默认豁免 urgent（开播这类时间敏感的通知等不起）；
    // 配置写坏时 fail-open（照常推送），因为「配错导致所有通知消失」严重得多。
    quietHours: {
      enabled: false,
      start: '23:00',
      end: '08:00',
      days: 'all', // all | weekdays | weekend
      timeZone: '', // 留空 = 跟随 calendar.timeZone / 系统时区
      bypassLevels: ['urgent'],
    },
    // [{ id, kind, name, enabled, on: always|alerts|failures, quiet: inherit|bypass,
    //    key, server, topic, token, secret, chatId, webhookUrl }]
    targets: [],
  },
  bilibili: {
    // 免登录的图文动态每页 20 条，pages 控制翻几页
    pages: 1,
  },
  watch: {
    enabled: true,
    targets: [],
    rules: {
      largeEditBytes: 5000,
      largeDeleteBytes: 2000,
      newPage: true,
      anonymousEdit: true,
      unpatrolled: true,
      logTypes: ['delete', 'move', 'protect', 'block', 'rights', 'abusefilter', 'upload', 'import'],
      keywords: ['毕业', '卒業', '解约', '引退', '炎上', '休止', '终止', '解散', '独立', '移籍', '道歉', '声明'],
      maxEvents: 40,
    },
  },
  ui: {
    // 默认深色（使用者指定）。auto = 跟随系统；浅色只在显式选 light 时出现，
    // 因为夜间看推送/情报流是主要场景，默认深色更不刺眼。
    theme: 'dark', // auto | light | dark
    notify: true, // 兼容字段，实际看 notify.desktop
    intelPerSource: 24,
    probeSamples: 3,
    probeTtlMinutes: 30,
    // 报告 / 情报的呈现排版（网页里可 DIY，参考小鸡词典那种卡片罗列）
    layout: {
      mode: 'cards', // cards | list | compact | timeline | table
      columns: 'auto', // auto | 1 | 2 | 3 | 4
      density: 'comfortable', // comfortable | compact
      fontScale: 1, // 0.85 ~ 1.35
      showThumbs: true,
      showStats: true,
      showTime: true,
      showSource: true,
      accent: '', // 留空用主题色
    },
  },
  privacy: {
    // 匿名模式：完全不使用登录态（不读浏览器 cookie、不复用 profile），
    // 发布前自检与「无痕化」场景下打开它最省心。
    anonymousMode: false,
    // 抓取时是否发送 Referer / Origin 这类可能带上站点身份的请求头
    sendReferer: true,
  },
  // 纪念日 / 生日 / 3D披露 / 周年 倒计时
  calendar: {
    // 留空 = 用系统时区。要盯日本箱就填 Asia/Tokyo，这样「今天」按对方的时间算。
    timeZone: '',
    // 默认提前几天提醒（条目自己还能覆盖）
    remindDaysBefore: 3,
    // 日报里列出未来多少天内的纪念日
    reportDays: 30,
    entries: [],
  },
  paths: {
    reportsDir: 'reports',
    feedsDir: 'feeds',
    logsDir: 'logs',
    watchDir: 'watch',
    // 临时文件目录。留空 = 系统临时目录（对便携发行的通用默认）。
    // 这台机器有「不往 C 盘写临时文件」的红线，所以本机配置会指到 E 盘。
    // 使用者：读浏览器 cookie 库时的副本、以及需要落临时文件的抓取。
    tempDir: '',
    // Playwright 浏览器内核目录。留空 = Playwright 默认位置
    // （Windows 上是 %LOCALAPPDATA%\ms-playwright，即 C 盘）。
    // 守红线就指到 E 盘；启动时写进 PLAYWRIGHT_BROWSERS_PATH。
    browsersDir: '',
  },
  reports: {
    // 每日情报输出格式。默认 html：VSCode 直接预览，不需要 Markdown 插件。
    // html = 自带样式的单文件网页 / adoc = AsciiDoc / md = 旧行为 / json = 结构化
    format: 'html',
    // 除主文件外始终写一份 .json 源（含 markdown 原文），供导出 Word / 检索 / 逐次对比
    keepJsonSource: true,
  },
  sources: {
    // id -> { enabled: boolean, login: 'none'|'optional'|'required' }
  },
  // 使用者自定义的来源（在网页「来源」页里可视化增删改）
  customSources: [],
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 深合并：用 defaults 补齐用户配置缺失项 / deep-merge user config over defaults */
export function mergeDefaults(user, defaults = DEFAULT_CONFIG) {
  const out = Array.isArray(defaults) ? [...defaults] : { ...defaults };
  if (!isPlainObject(user)) return out;
  for (const [k, v] of Object.entries(user)) {
    out[k] = isPlainObject(v) && isPlainObject(defaults?.[k]) ? mergeDefaults(v, defaults[k]) : v;
  }
  return out;
}

export function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return structuredClone(DEFAULT_CONFIG);
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return mergeDefaults(raw);
  } catch (err) {
    console.error('[config] 读取失败 / load failed:', err.message);
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(cfg) {
  const merged = mergeDefaults(cfg);
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

/** 把配置里的相对路径解析成绝对路径 / resolve a configured dir to an absolute path */
export function resolveDir(cfg, key) {
  const rel = cfg?.paths?.[key] ?? DEFAULT_CONFIG.paths[key] ?? key;
  return path.isAbsolute(rel) ? rel : path.join(APP_ROOT, rel);
}

/**
 * 首次保存时把旧的扁平配置升级成新结构。
 * 只在真正写盘时调用，读配置时不动文件。
 */
export function migrateConfig(cfg) {
  const next = mergeDefaults(cfg);

  // ── LLM：扁平 → 档位列表
  const llm = next.llm ?? {};
  if (!Array.isArray(llm.providers) || llm.providers.length === 0) {
    if (llm.apiKey || (llm.baseUrl && llm.baseUrl !== DEFAULT_CONFIG.llm.baseUrl)) {
      next.llm = {
        ...llm,
        providers: [
          {
            id: 'default',
            preset: 'custom',
            name: '默认',
            baseUrl: llm.baseUrl ?? '',
            apiKey: llm.apiKey ?? '',
            model: llm.model ?? '',
            models: llm.model ? [llm.model] : [],
            reasoningEffort: llm.reasoningEffort ?? '',
            maxTokens: llm.maxTokens ?? 8192,
            temperature: llm.temperature ?? 0.3,
          },
        ],
        activeId: 'default',
      };
    }
  }
  if (Array.isArray(next.llm?.providers) && next.llm.providers.length && !next.llm.activeId) {
    next.llm.activeId = next.llm.providers[0].id;
  }

  // ── 定时：扁平 → 任务列表
  const sched = next.schedule ?? {};
  if (!Array.isArray(sched.tasks) || sched.tasks.length === 0) {
    if (sched.enabled) {
      next.schedule = {
        ...sched,
        tasks: [
          {
            id: 'task-1',
            name: sched.mode === 'daily' ? '每天情报收集' : '每周情报收集',
            enabled: true,
            mode: 'daily',
            freq: sched.mode === 'daily' ? 'daily' : 'weekly',
            dayOfWeek: Number.isInteger(sched.dayOfWeek) ? sched.dayOfWeek : 2,
            time: sched.time ?? '23:30',
            catchUp: true,
          },
        ],
      };
    }
  }

  // ── 桌面通知开关搬家：ui.notify → notify.desktop
  if (next.notify && next.ui && next.ui.notify === false && next.notify.desktop === DEFAULT_CONFIG.notify.desktop) {
    next.notify = { ...next.notify, desktop: false };
  }

  return next;
}
