// i18n.jsx — multi-locale strings + regional formatting
//
// The two complete dictionaries, zh and en, live here (for historical reasons, 600+ entries each).
// The other 24 locales live in locales/index.js and hold **only their differences**, falling back
// level by level along their chain.
// Adding a language: append one line to LOCALES + write one dict; missing keys fall back to
// en-US automatically, so the UI never goes blank.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { LOCALES, byCode, negotiate } from './locales/index.js';
import { GENERATED } from './locales/generated.js';
// The machine-translation layer: produced by tools/i18n-translate.mjs, and the lowest priority
// layer (hand-written entries always beat it).
// The file is committed as an empty table `{}` first - that way the build can resolve it, and the
// UI is completely unaffected until a key is configured.
import MACHINE from './locales/machine.json';
import { HAND, HAND_COMMON } from './locales/overlays.js';
import { PLURALS } from './locales/plurals.js';
import { convertDict, toBritish } from './locales/spelling.js';
import { countLabel, fillParams, pickPlural } from './plural.js';

/** Regional overlay entries: only the keys that differ from the level above (characters, spelling, wording, date habits) */
export const OVERLAY = HAND;

export const STRINGS = {
  zh: {
    appTitle: "Vtuber's Monitor Link",
    appSub: '本地 VTuber 情报监测',
    // About / README panel: the document itself is bilingual, so these are only the chrome around it
    aboutTitle: '关于',
    aboutHint: '在界面里直接读这份说明（右上角打开，可即时切换中英文，不用另开页面）',
    readmeLang: '这份文档的语言',
    readmeLangZh: '中文',
    readmeLangEn: 'English',
    readmeFail: '读不到说明文件',
    readmeNote: '同一份文档也在程序目录里',
    tab_intel: '情报',
    tab_run: '运行',
    tab_sources: '来源',
    tab_watch: '监视',
    tab_settings: '设置',
    tab_reports: '报告',
    tab_calendar: '日历',
    tab_people: '关注',
    mergeEvents: '合并重复事件',
    visionTag: '图片打标',
    visionTagged: '已打标',
    visionCached: '缓存命中',
    shareTitle: '一键分享',
    shareHint:
      '把情报打成一个**单文件**发给朋友：自带样式、没有任何外部引用，对方双击就能看（离线也行）。不需要登录的方式永远可用；需要登录的方式会如实告诉你缺什么，做不到的会直接标成「不支持」而不是给你一个点了没反应的按钮。发到 B 站动态属于对外发声 —— 必须你两次确认，而且第一次成功发出之前它一直是不可用状态。',
    shareScope: '分享范围',
    shareScopeLatest: '最近一次情报',
    shareScopeDay: '某一天',
    shareScopePerson: '某个人',
    shareFormat: '格式',
    shareNotePh: '附一句话（可选）',
    shareDownload: '生成并下载',
    shareCopy: '复制文本',
    shareSaved: '已保存',
    shareCopied: '已复制到剪贴板',
    shareTarget: '分享方式',
    shareLogin: '需要登录',
    shareStatus: '当前状态',
    shareAction: '操作',
    shareReady: '✅ 可用',
    shareNeedsLogin: '🔒 缺登录态',
    shareNeedsVerify: '⚠ 待验证',
    shareUnsupported: '✕ 不支持',
    shareUnsupportedShort: '不提供',
    shareCannotWithoutLogin: '先登录',
    sharePost: '对外发送',
    shareVerifyPost: '验证并发送',
    sharePostConfirm: '确认发到「{target}」？发出去就收不回来了。',
    sharePosted: '已发送',
    shareVerifiedNow: '已标记为可用',
    shareAccounts: '检测到的账号',
    shareAudit: '分享记录',
    shareAuditHint: '谁在什么时候导出了什么、有没有对外发送过',
    chartsTitle: '趋势图表',
    chartsArchive: '归档',
    chartsDays: '天',
    chartsRange: '时间范围',
    chartsBackfill: '补录最近情报',
    chartsEmpty:
      '还没有归档数据。跑一次运行就会自动增量写入；也可以点上面的「补录最近情报」把已经收集到的情报补进来。（归档在 feeds/archive.db，按条目 id 幂等，重跑不会让数字变大。）',
    chartsHint:
      '归档是增量写入的 SQLite（每天运行时追加，跳过已存在的条目）。图表用内联 SVG 画，不引入图表库 —— 便携版不该为了几根柱子多背几百 KB。',
    chartsDaily: '每天条目数',
    chartsDailyHint: '柱状：每天抓到的条目数（没跑的日子显示 0，不假装连续）',
    chartsSources: '来源占比与告警',
    chartsSourcesHint: '横向条：各来源累计条目数；下面是每天的告警命中数',
    chartsPeople: '关注对象活跃度',
    chartsPeopleHint: '横向条：每个关注对象累计命中的条目数',
    chartsNoPeople: '还没有命中关注对象的数据（先在「关注」页加人）。',
    chartsKeywords: '关键词趋势',
    chartsKeywordsHint: '横向条：命中次数最多的关键词',
    chartsNoKeywords: '还没有关键词命中数据（关键词在设置里配置）。',
    chartsHealth: '来源健康度',
    chartsHealthHint: '每个来源的检查次数、成功率与平均耗时（只统计成功的耗时）',
    chartsChecks: '检查',
    chartsRate: '成功率',
    chartsAlerts: '每天告警',
    eventsTitle: '已合并事件',
    eventsStats: '事件',
    eventsMerged: '去掉重复',
    eventsConfirmed: '多源确认',
    eventsConfirmedBadge: '多源确认',
    eventsSources: '来源',
    eventsMergedShort: '合并',
    eventsItems: '参与报道的条目',
    eventsItemsHint: '同一件事被各来源分别报道的原文',
    eventsHint:
      '同一件事被多个来源各报一遍时只显示一条，并标出「几个来源确认」—— 来源越多越可信。相似度是本地算的（字符 bigram + IDF 加权 + 时间窗），不需要联网或 LLM。来源权重按「官方 > 新闻 > 社区 > 社交」给基准，并且会从「谁最先报出来」的历史里自己长。',
    open: '打开',
    peopleHint:
      '来源是「采集单位」，你真正关心的是「人」。把名字和账号填进来，程序会在本地把情报归属到人（纯字符串匹配，不联网、不用 LLM），并显示每次匹配是哪条别名在哪个字段命中 —— 判断永远可解释。日报与推送也会按人汇总；把某个人的通知级别设成 urgent，他的消息会豁免静默时段。',
    peopleEmpty: '还没有关注对象。展开下面的「添加」，或从已有实体里一键导入。',
    peopleScanned: '扫描条目',
    peopleMatched: '命中关注对象',
    peopleAliases: '别名',
    peopleItems: '条',
    peopleShowFeed: '看这个人的情报',
    peopleNoItems: '最近收集到的情报里还没有他/她的动态。',
    peopleWhy: '命中依据',
    peopleUrgent: 'urgent',
    peopleAddTitle: '添加关注对象',
    peopleAddSummary: '名字必填；别名与账号用来匹配（中英文名、@handle、uid 都行）',
    peopleNamePh: '例如：嘉然',
    peopleEnName: '英文名',
    peopleAgency: '所属',
    peopleNotifyLevel: '通知级别',
    peopleAliasesPh: '逗号或空格分隔，例如：嘉然今天吃什么, Jia Ran',
    peopleSuggestTitle: '从已有实体导入',
    peopleSuggestSummary: '用已经抽取出来的实体统计推荐（本地统计，不需要再跑 LLM）',
    peopleSuggestRun: '生成建议',
    peopleSuggestFrom: '已统计实体',
    peopleSuggestNone: '没有可推荐的（要么已经都关注了，要么实体统计还没跑过）。',
    peopleAdded: '已加入关注名单',
    language: '语言',
    name: '名称',
    date: '日期',
    detecting: '探测中…',
    calHint:
      '生日、出道日、3D披露、周年倒计时。「今天」按下面标出的时区计算（可在设置里改成对方的时区，例如盯日箱就用 Asia/Tokyo）；2 月 29 日的生日在平年会顺延到 3 月 1 日并标出来，不会悄悄算错。',
    calEmpty: '还没有纪念日。展开下面的「添加」或「从情报里找线索」开始。',
    calToday: '今天',
    calTomorrow: '明天',
    calDaysLater: '{n} 天后',
    calYearN: '第几年',
    calLeap: '闰日顺延到 3/1',
    calTotal: '共',
    calRemindWindow: '提醒窗口内',
    calWeekStart: '一周起始',
    calAddTitle: '添加纪念日',
    calAddSummary: '名字 + 日期（每年重复填 MM-DD，一次性填 YYYY-MM-DD）',
    calNamePh: '例如：嘉然生日',
    calKind: '类型',
    calKind_birthday: '生日',
    calKind_debut: '出道日',
    calKind_3d: '3D披露',
    calKind_anniversary: '周年',
    calKind_event: '活动',
    calKind_other: '其他',
    calSince: '起始年',
    calRemind: '提前提醒(天)',
    calNote: '备注',
    calAdded: '已加入日历',
    calImported: '已导入',
    calAlready: '已在日历里',
    calDetectTitle: '从情报里找线索',
    calDetectSummary: '本地正则扫描已收集的情报，不联网、不用 LLM；只给建议，不自动落库',
    calDetectRun: '扫描情报',
    calDetectScanned: '扫描',
    calDetectFound: '找到',
    calDetectNone: '没有找到带日期的纪念日线索（需要情报里明确出现「生日 / 3D披露 / 周年 / 出道」这类词）。',
    calImport: '导入勾选的',
    calGridAddHint: '临时活动（演唱会、联动）用一次性日期：',
    notifyQuiet: '静默时段',
    quietInherit: '遵守静默',
    quietBypass: '豁免静默',
    notifySecret: '加签密钥',
    notifySecretPh: '不加签就留空',
    notifyDedupe: '去重(分钟)',
    quietTitle: '静默时段',
    quietSummary: '夜里不响，早上补发（点开设置）',
    quietNow: '现在是静默时段',
    quietEnabled: '启用',
    quietStart: '开始',
    quietEnd: '结束',
    quietDays: '适用日',
    daysAll: '每天',
    daysWeekdays: '工作日',
    daysWeekend: '周末',
    quietTz: '时区',
    quietTzPh: '留空 = 跟随时区设置',
    quietHint:
      '静默期内的通知不会丢，会进队列、出静默期后自动补发（也可以点上面的按钮立刻补发）。跨午夜的时间段（例如 23:00→08:00）按「夜里」处理；开始与结束填成一样表示全天静默。urgent 级别的通知默认豁免 —— 开播这类时间敏感的消息等不起。配置填坏时会照常推送（fail-open），不会因为配错就永久静音。',
    quietFlush: '立刻补发',
    save: '保存',
    saved: '已保存',
    saving: '保存中…',
    saveStateIdle: '还没有改动',
    saveStateDirty: '有未保存的改动 —— 记得点保存',
    proxyAuto: '自动（推荐）',
    egressNotYet: '还没探测过 —— 跟随全局设置，探测后自动判定',
    egressPinned: '已手动指定，自动模式不覆盖',
    fastest: '最快',
    openAll: '展开',
    closeAll: '收起',
    llmNeedsTable: '功能对照表',
    llmNeedsSummary: '哪些要 Key、哪些不要，点开看',
    cancel: '取消',
    close: '关闭',
    add: '添加',
    delete: '删除',
    actions: '操作',
    enable: '启用',
    disable: '停用',
    check: '检查',
    history: '历史',
    loading: '加载中…',
    refresh: '刷新',
    search: '搜索',
    all: '全部',
    items: '条',
    failed: '失败',
    done: '完成',
    checking: '检查中…',
    generatedAt: '生成于',
    openSource: '打开来源',
    label: '名称',
    labelPlaceholder: '给自己看的一个名字',

    // browser
    browserTitle: '浏览器',
    browserHint:
      '选择抓取网页时使用的浏览器。要复用登录态（例如看 X 推文正文、B 站带配图动态、Twitch 关注列表）时，请选「系统浏览器」并把浏览器完全关闭后再运行。',
    mode: '模式',
    mode_bundled: '随包 Chromium（开箱即用）',
    mode_system: '系统已装浏览器（可复用登录）',
    mode_custom: '自定义路径',
    detected: '已探测到',
    executablePath: '浏览器可执行文件',
    profileDir: '用户配置目录（可选，用于复用登录态）',
    profileHint: '留空则用临时干净配置（不携带任何登录）。浏览器开着时该目录会被锁，无法复用。',
    headless: '无头模式',
    waitMs: '渲染后等待(ms)',
    checkLogin: '检查登录态',
    checkingLogin: '检查中…',
    loginOk: '读到登录 cookie',
    loginNoSession: '读到 cookie 但没有 SESSDATA（可能没登录）',
    loginNone: '没读到登录 cookie',
    loginHint:
      '这里会**只读地**复制一份浏览器的 cookie 库来取登录态（浏览器开着也没关系，不会锁定或改动它）。' +
      '日志与报告里都不会出现 cookie 内容。若浏览器启用了 App-Bound Encryption（Chrome 127+ 默认），' +
      '外部无法解密，这时只能关掉浏览器让 Playwright 复用 profile。',
    domainLabel: '要读的域名',
    cookieCount: '{n} 个',
    cookieCountWithSession: '{n} 个（含 SESSDATA）',
    browserFromSettings: '设置里指定的',

    // llm
    llmTitle: 'LLM 分析',
    llmHint: '兼容 OpenAI 格式的接口（DeepSeek / OpenAI / Kimi / 通义 / 本地 Ollama 均可）。可以存好几套档位随时切换；Key 只保存在本机 config.json。',
    llmProfiles: '档位',
    llmAddProfile: '新增档位',
    llmPreset: '提供商',
    llmActive: '当前使用',
    llmFetchModels: '拉取模型列表',
    llmModelsFetched: '已拉取模型',
    llmDeleteProfile: '删除档位',
    llmNeedKey: '请先填入 API Key',
    baseUrl: '接口地址',
    apiKey: 'API Key',
    model: '模型',
    reasoningEffort: '推理强度',
    maxTokens: '最大输出 tokens',
    testLlm: '测试连通性',
    testing: '测试中…',
    showKey: '显示',
    hideKey: '隐藏',

    // proxy
    proxyTitle: '网络代理',
    proxyHint:
      'Node 的 fetch 默认不读系统代理。若你的网络需要代理才能出网（例如国内网络），请在此启用——抓取与浏览器渲染会同时生效。注意：部分站点走代理反而会被拦（B 站就是），可在来源/监视对象上单独设为「直连」。',
    proxyEnabled: '启用代理',
    proxyUrl: '代理地址',
    proxyDetect: '探测本机常见代理端口',
    proxyDetecting: '探测中…',
    proxyFound: '探测到可用代理',
    proxyNone: '未探测到可用代理端口',
    proxyMode: '出口',
    proxyInherit: '跟随全局',
    proxyDirect: '强制直连',
    proxyUse: '强制走代理',

    // schedule
    scheduleTitle: '定时',
    scheduleHint: '内置调度器，不依赖系统计划任务；跨平台可用。开启后每次运行会连监视对象一起检查。',
    enabled: '启用定时',
    mode_weekly: '每周',
    mode_daily: '每天',
    dayOfWeek: '星期',
    time: '时间',
    nextFire: '下次运行',
    merchEveryDays: '通贩扫描间隔(天)',
    watchWithRun: '运行时同时检查监视对象',

    // UI
    uiTitle: '界面',
    uiHint: '主题跟随系统，也可以固定。运行结束后可以弹桌面通知。',
    // observation mode
    obsTitle: '观测模式',
    obsHint:
      '看整箱状态时，痕迹本身就是信息：一次把全箱扫一遍、每天固定时刻、间隔精确相等 —— 这些模式与你是从哪个 IP 来的无关。开启后每轮只随机取一部分对象（轮换补齐），间隔随机，并且只让「日志留在对方服务器上」的入口走 Tor。',
    obsEnabled: '启用观测模式',
    obsRatio: '每轮取样比例',
    obsJitter: '间隔抖动',
    obsJitterNone: '不抖动（固定间隔）',
    obsTorAgency: '箱自托管站点走 Tor',
    obsSkipLogin: '跳过需要登录态的来源',
    obsRotateExit: '每次换 Tor 出口',
    obsRotationHint:
      '「箱自托管站点」是指官方站点这类日志留在对方服务器上的入口。bilibili / Reddit / Fandom 这些平台源不走 Tor：箱看不到那些日志，而实测经 Tor 慢约 8 倍、部分接口还会被限流。换出口用的是 Tor 的 SOCKS 用户名隔离，实测不同用户名会落到不同的出口 IP。',
    obsSampling: '本轮为取样',
    obsSamplingNote: '未取到的对象会在后续轮次轮到；本地归档是增量的，覆盖会补齐。「本轮没出现」不等于「没有动静」。',
    obsSkippedLogin: '本轮跳过（需登录态）',
    // cost board
    costTitle: '用量与预算',
    costHint:
      '这个工具的钱花在模型调用上。这里只统计能拿到的用量（模型没返回用量、或走本地模型的那几次会单独计数，不猜数字）。到预算 80% 会在运行日志里提醒；超过之后默认只警告，选「拦住」才会阻止运行。',
    costToday: '今天',
    costTotal: '累计（14 天窗口外也计入总量）',
    costCalls: '次调用',
    costBudget: '每日预算（tokens，0 = 不限）',
    costUnlimited: '未设上限',
    costOnExceed: '超过预算时',
    costExceedWarn: '只警告（默认）',
    costExceedStop: '拦住这次运行',
    costRemaining: '剩余',
    costUnknown: '次未拿到用量',
    obsLastSeen: '最近观测',
    // import from VDB
    vdbTitle: '从 VDB 导入关注对象',
    vdbHint:
      'VDB 是 vtbs.moe 的上游花名册（社区维护，一万多条），每条带社团与各平台账号 —— 搜名字或平台账号就能一次把人连同社团、别名、账号一起录进来。数据只在运行时拉取（约 0.5MB，一条请求），不随本工具分发。',
    vdbSearch: '搜索',
    vdbSearchPh: '名字 / 别名 / 平台账号（如 twitch 名、YouTube 频道）',
    vdbSync: '同步花名册',
    vdbRoster: '花名册',
    vdbGroups: '个社团',
    vdbImport: '导入',
    vdbImported: '已导入',
    vdbSkipped: '跳过',
    vdbNoResult: '没找到（试试别名、或平台账号 id）',
    // group view
    groupViewTitle: '箱视角（按团体看）',
    groupViewHint:
      '逐条情报流回答不了「这个箱现在怎么样」。这里把同一团体的成员排成热力图：一格一天、深色代表当天有条目；停更的人会被标出来，多人同一天出现记为「同刻出现」（企划联动的形状），整箱安静单独提示。判据都相对每个人自己的节奏 —— 日更的人停 3 天，和月更的人停 3 天，不是一回事。',
    groupWindow: '窗口',
    groupDays: '天',
    groupNoAgency: '还没有填写团体的关注对象',
    groupPeopleCount: '位关注对象',
    groupMembers: '位成员',
    groupActive7: '近 7 天活跃',
    groupQuiet: '已静默',
    groupLast: '最近',
    groupNever: '还没有记录',
    groupTolerance: '容忍',
    groupCoActive: '同刻出现',
    groupPeopleUnit: '人',
    groupQuietStreak: '连续无人活动',
    groupFullHouse: '全员同时活跃',
    groupUngrouped: '未分组',
    groupUngroupedHint: '在关注对象里填上「团体」就会并进对应的箱',
    theme: '主题',
    themeAuto: '跟随系统',
    themeLight: '浅色',
    themeDark: '深色',
    notify: '桌面通知',
    notifyHint: '运行结束后用系统通知告知结果（需要浏览器授权）。',

    // sources
    sourcesTitle: '来源',
    sourcesHint: '勾选要抓取的站点。登录要求：none=公开数据，optional=登录更全，required=不登录拿不到（红色）。',
    category: '分类',
    login: '登录',
    fetchKind: '抓取方式',
    enabledCol: '启用',
    login_none: '无需',
    login_optional: '可选',
    login_required: '必需',
    customSources: '自定义来源',
    customSourcesHint: '内置来源覆盖不到的站点，可以自己加：给个 RSS、一个 MediaWiki API、一个 B 站 UID，或者一个需要浏览器渲染的页面。',
    addCustomSource: '新增自定义来源',
    sourceId: '标识（英文/数字/短横线）',
    sourceName: '名称',
    sourceUrl: '地址',
    sourceUid: 'UID（B 站动态用）',
    sourceCadence: '节奏',
    cadence_daily: '常规',
    cadence_merch: '通贩（14 天）',
    deleteSource: '删除',
    builtin: '内置',
    custom: '自定义',
    sourceAdded: '已添加',
    bulkToggle: '批量',
    enableAll: '全部启用',
    disableAll: '全部停用',
    onlyDaily: '只留常规（关掉通贩）',
    resetDefaults: '恢复默认',
    onlyCustom: '只看自定义',

    // watch
    watchTitle: '监视对象',
    watchHint:
      '不再只靠站点的「最近更改」流：可以盯住一个具体条目、一个具体页面、一个 B 站 UP 的动态。第一次检查只建立基线，之后每次都会给出「改了什么」。',
    watchEnabled: '启用监视',
    checkAll: '全部检查一次',
    showRules: '告警规则',
    hideRules: '收起规则',
    rulesLargeEdit: '大编辑阈值(字节)',
    rulesLargeDelete: '大删除阈值(字节)',
    rules_newPage: '新建页面告警',
    rules_anonymousEdit: '匿名编辑告警',
    rules_unpatrolled: '未巡查编辑告警',
    rulesKeywords: '关键词（顿号/逗号分隔）',
    rulesLogTypes: '关注的日志类型',
    watchAdd: '新增监视对象',
    watchKind: '类型',
    watchMode: '取文方式',
    ignorePatterns: '忽略行正则',
    pageTitle: '条目标题',
    watchPagePh: '条目标题',
    namespaces: '命名空间',
    botUser: '账号名（BotPassword 形式）',
    botPassword: 'BotPassword',
    botPasswordHint:
      '监视列表必须登录才能读。建议在萌百「参数设置 → 机器人密码」里开一个只读权限的 BotPassword，不要用主密码；它只存在本机 config.json 里。',
    biliUidHint: 'B 站 UP 的纯数字 UID（在个人空间地址里）。第一次检查建立基线，之后比对新增动态与粉丝数变化。',
    watchList: '监视列表',
    baseline: '基线',
    noBaseline: '尚未建立（下次检查建立）',
    noTargets: '还没有监视对象',
    noHistory: '还没有变更记录',
    needUrl: '请填写 URL',
    needApi: '请填写 api.php 地址',
    needApiPage: '请填写 api.php 地址与条目标题',
    needBotPassword: '监视列表需要账号名与 BotPassword',
    needUid: '请填写纯数字 UID',
    duplicateTarget: '这个监视对象已经存在了',
    watchDigest: '监视变化摘要',
    loginRequiredTag: ' · 需登录',
    ignorePatternsPh: '一行一个正则，命中的行会被忽略',
    followersCount: '粉丝 {n}',
    viewSource: '来源 ↗',

    // intel
    intelTitle: '情报卡片流',
    intelHint: '最近一次运行抓到的条目。命中告警关键词的会打上标记；B 站动态里的 [表情] 会单独标出来，配图直接内联显示。',
    intelSearchPlaceholder: '在本次情报里搜关键词…',
    onlyAlerts: '只看命中关键词',
    noIntel: '还没有情报 —— 先去「运行」跑一次',

    // run
    runTitle: '运行',
    runNow: '立即运行（常规）',
    runMerch: '运行通贩扫描',
    runWatchOnly: '只检查监视对象',
    running: '运行中…',
    step: '阶段',
    sources: '来源',
    tail: '实时日志',
    lastResult: '上次结果',
    noResult: '尚无运行记录',
    alerts: '告警',
    watchTargets: '监视对象',

    // reports
    reportsTitle: '报告',
    reportsHint: '报告保存在本机 reports/ 目录，可直接用编辑器打开；也可以在网页里直接读，并导出成单文件 HTML。',
    noReports: '还没有报告',
    exportHtml: '导出 HTML',
    exportJson: '导出 JSON',
    searchReports: '全文检索',
    searchPlaceholder: '在所有报告正文里搜…',
    matches: '处命中',
    noMatches: '没有命中',
    rendered: '渲染视图',
    rawMarkdown: '原始 Markdown',

    // reachability / health
    latency: '延迟',
    loss: '失败率',
    directEgress: '直连',
    proxyEgress: '代理',
    torEgress: 'Tor',
    egressSettled: '已判定',
    egressTrial: '试用中',
    lastRunFailed: '上次运行失败',
    customNamePh: '某某的博客',
    selfCheckHint:
      '自检在**每次运行的最后**执行：先抓完、先出报告，最后只对出异常的来源做诊断（能连通就完全不打扰）。' +
      '也可以随时在上面的行里手动点「自检」。',
    probe: '测速',
    probeAll: '全部测速',
    probing: '测速中…',
    probingOne: '正在测速…',
    neverProbed: '未测过',
    health: '站点健康',
    healthHint: '每个来源下方是实测连通数据：直连测 TCP 握手耗时，代理测经代理请求的首字节耗时；失败率 = 失败次数 ÷ 尝试次数。',
    healthProblems: '有问题的站点',
    healthOk: '没有明显异常的站点',
    verdict_direct: '建议直连',
    verdict_proxy: '建议走代理',
    verdict_none: '两个出口都不通',
    verdict_unknown: '未判定',
    egress: '出口',
    egressSelect: '该站点出口',
    failover: '自动换出口',
    probeTtl: '数据缓存(分钟)',

    // thumbnails / self-check
    thumbnail: '站点缩略图',
    loadThumb: '取缩略图',
    screenshot: '截图',
    diagnosing: '自检中…',
    diagnose: '自检',
    diagnoseHealthy: '连通正常，无需优化',
    diagnoseBad: '发现问题，已生成诊断文件',
    adviceFiles: '诊断文件',
    adviceHint: '只有出现明显异常时才会生成；点开就是一份可读网页，里面写了实测数据与推荐研究项。',
    openAdvice: '打开',
    noAdvice: '暂无诊断文件',
    deleteAdvice: '删除',

    // scheduled tasks
    scheduleTasks: '计划任务',
    scheduleHint2: '可以建多条任务，各自设定模式、频率与时间；程序没开时错过的任务会在启动后补跑一次。',
    addTask: '新增任务',
    taskName: '任务名',
    taskMode: '模式',
    taskMode_daily: '常规收集',
    taskMode_merch: '通贩扫描',
    taskMode_watch: '只检查监视对象',
    freq: '频率',
    freq_weekly: '每周',
    freq_daily: '每天',
    catchUp: '错过补跑',
    catchUpTag: '（补跑）',
    nextFireAt: '下次运行',
    preview: '接下来几次',
    taskRunNow: '立即运行',
    lastFire: '上次运行',
    historyTitle: '执行历史',
    noScheduleHistory: '还没有执行记录',

    // alert delivery
    notifyTitle: '告警推送',
    notifyPanelHint: '命中关键词、监视变更或运行失败时推到手机。留空表示不启用该通道。',
    addTarget: '新增通道',
    notifyKind: '通道',
    notifyOn: '触发条件',
    on_always: '每次都推',
    on_alerts: '仅告警',
    on_failures: '仅失败',
    testNotify: '发送测试',
    notifyTestOk: '测试消息已发出',
    desktopNotify: '桌面通知',

    // proxy nodes
    nodesTitle: '代理节点',
    nodesHint: '从本机 mihomo / Clash 读取节点列表，并测每个节点到你指定站点的延迟（内核的延迟接口本身就支持指定 URL）。',
    detectControl: '探测控制接口',
    controlNotFound: '未发现控制接口（需在内核配置里打开 external-controller）',
    controlFound: '找到控制接口',
    group: '策略组',
    currentNode: '当前节点',
    testAgainst: '测速目标',
    switchTo: '切换',
    switched: '已切换',

    // import & export
    ioTitle: '配置导入导出',
    ioHint: '把站点、监视对象、LLM 档位、通知与排版一并导出成 JSON，换机器一键导入。默认不含任何密钥。',
    exportNoSecrets: '导出（不含密钥）',
    exportWithSecrets: '导出（含密钥，慎用）',
    importConfig: '导入配置',
    importHint: '选择之前导出的 JSON 文件；空字符串不会覆盖已有的密钥。',
    imported: '已导入',

    // layout DIY
    layoutTitle: '排版',
    layoutHint: '报告与情报卡的呈现方式，改完立刻生效（也算即时预览）。',
    layoutMode: '呈现方式',
    layout_cards: '卡片墙（小鸡词典式罗列）',
    layout_list: '列表',
    layout_compact: '紧凑',
    layout_timeline: '时间线',
    layout_table: '表格',
    columns: '列数',
    columns_auto: '自适应',
    density: '密度',
    density_comfortable: '舒适',
    density_compact: '紧凑',
    fontScale: '字号缩放',
    showThumbs: '显示图片',
    showStats: '显示互动数',
    showTime: '显示时间',
    showSource: '显示来源',
    accent: '主题色',

    // intel
    starred: '星标',
    onlyStarred: '只看星标',
    onlyUnread: '只看未读',
    markRead: '标记已读',
    markUnread: '标记未读',
    compare: '本次 vs 上次',
    comparedAdded: '新增',
    comparedRemoved: '消失',
    comparedChanged: '内容变化',
    noPreviousRun: '还没有上一次可以对比',

    // search (pure local matching, no LLM needed)
    tab_llm: 'LLM',
    llmEmptyHint: '还没有任何档位 —— 先选一个提供商建一个，输入框才会出现（此前它们包在「有档位才渲染」的条件里，所以看起来像没有地方可填）。',
    llmCreateFirst: '建一个档位',
    llmProfileFields: '档位设置',
    llmKeySet: '已填 Key',
    llmKeyMissing: '未填 Key',
    llmKeyLocalOnly: '只存在本机 config.json；不入仓库、不进发行包（发布自检会拦）。',
    llmVisionHint: '这是视觉模型 —— 配好之后，分析层可以真的看 B 站动态里的配图。',
    llmSaveHint: '改完记得点最下面的「保存」。',
    llmNeedsTitle: '哪些功能需要它',
    llmNeedsHint: '不配也能用大半功能；配了才有报告、特征抽取与「帮我认人」。',
    llmFeature: '功能',
    llmNeedsLlmCol: '需要 LLM',
    yes: '需要',
    no: '不需要',
    llmFeat_report: '生成报告（分析层）',
    llmFeat_features: '特征抽取（人名/游戏/事件变成可检索）',
    llmFeat_assist: '帮我认人（只记得特征忘了名字）',
    llmFeat_search: '检索（关键词/标签/时间）',
    llmFeat_live: '开播监测与多屏观看',
    llmFeat_danmaku: '发弹幕',
    llmFeat_probe: '站点测速 / 健康看板 / 自检',
    tab_live: '直播',
    liveTitle: '开播监测与多屏观看',
    liveHint:
      '开播是最有时效性的情报 —— 比任何关键词都值得立刻知道。这里显示监测对象的开播状态，并可以直接把多个直播间铺成网格同时看（用 B 站官方内嵌播放器，不经过任何转发，也不涉及登录态）。注意「轮播」不是真开播，所以单独标出来。',
    danmakuTitle: '发评论（弹幕）',
    danmakuWarn:
      '注意：这跟本工具其它一切不同 —— 它会**用你自己的账号身份在直播间公开发言**，而且不会撤销。它不属于任何自动流程（定时任务与收集流程都不会调用），每次都必须你手动确认。',
    danmakuAccount: '用哪个账号',
    danmakuNoAccount: '没有找到可用的登录账号（需要在某个浏览器里登录过 B 站，并保持该 profile 可读）',
    danmakuRoom: '直播间号',
    danmakuText: '内容',
    danmakuConfirm: '我确认以上述账号身份发送，且知道这是公开发言',
    danmakuSend: '发送',
    danmakuSending: '发送中…',
    danmakuOk: '发送成功',
    danmakuAudit: '发送记录',
    danmakuAuditHint: '本地审计日志（只记账号 / 房间 / 内容 / 结果，不含任何凭据）',
    danmakuRefresh: '刷新账号',
    danmakuLen: '字',
    liveAddOther: '添加其他平台',
    liveAddOtherHint:
      '三家都实测可嵌：Twitch 的嵌入页 CSP 明确放行 127.0.0.1，YouTube 的 /embed/ 没有 frame-ancestors，bilibili 的 blanc 无限制。加进来之后和其它格子一样可混排。',
    livePlatform: '平台',
    liveId: '频道 / 房间 / 视频 ID',
    liveProxyCaveat:
      '带 * 的平台（Twitch / YouTube）需要你的**浏览器**本身能访问它们 —— 本机直连不通，所以浏览器要走系统代理，否则格子里会是一片空白或加载失败。bilibili 不需要。',
      liveProbe: '测网络',
    liveQualityUnavailable: '码率 / 帧数：跨域嵌入播放器测不到（浏览器同源策略），不是没实现',
    liveQualityWhy:
      'YouTube / Twitch / B 站的官方嵌入播放器都跑在跨域 iframe 里，父页面拿不到它的 <video> 元素，因此 getVideoPlaybackQuality()、buffered、码率都读不到。要真测这些，必须把流地址拿过来自己播（bilibili 可由 getRoomPlayInfo 拿到，但只有真开播的房间才有；YouTube/Twitch 需要 yt-dlp 一类的工具来取流，有 ToS 与稳定性代价）。上面那一行「测网络」测的是网络层延迟与失败率，这一层是第三方页面能够诚实测量的。',
      liveCheck: '检查开播状态',
    liveNow: '直播中',
    liveRound: '轮播',
    liveOff: '未开播',
    // Placeholders and short labels that used to be hard-coded Chinese in the JSX, which meant
    // every one of the 25 locales showed Chinese (see docs/ENGLISH-LOGIC.md on the boundary).
    liveHintBilibili: '直播间号，如 22637261',
    liveHintTwitch: '频道名，如 neurosama',
    liveHintYoutube: '频道 ID(UC…，取直播) 或视频 ID',
    liveManualLabelPh: '显示用的名字',
    liveRoomManualPh: '也可手填',
    danmakuTextPh: '要发的内容',
    auditRoom: '房间',
    liveMonitored: '监测中',
    addAllLive: '在播的全部加入多屏',
    clearGrid: '清空多屏',
    multiScreen: '多屏',
    gridColumns: '网格列数',
    addToGrid: '加入多屏',
    removeFromGrid: '移出',
    openStream: '打开直播间',
    liveNoTitle: '（无标题）',
    liveNoTargets: '还没有可监测的对象 —— 启用任意 B 站来源，或手动加一个 uid',
    noLiveNow: '当前没有正在直播的',
    liveFindUid: '按名字找 uid',
    liveFindHint: '数据来自 vtbs.moe 的 VTuber 花名册（约 9700 条）。找到后加入监测即可。',
    liveFindPlaceholder: '输入名字的一部分，如 泠鸢',
    added: '已加入监测',
    tab_search: '检索',
    searchTitle: '情报检索',
    searchHint:
      '纯本地匹配：关键词 + 标签 + 时间区间，像查论文那样组条件。**不需要 LLM，也不需要联网**，没配 AI 一样能用。',
    searchPlaceholder2: '关键词，空格分隔为 AND（例：2434 毕业）',
    searchField: '检索范围',
    field_any: '全部字段',
    field_title: '标题',
    field_text: '正文',
    field_tag: '标签',
    field_source: '来源',
    field_url: '链接',
    sortBy: '排序',
    sort_relevance: '相关度',
    sort_time: '时间倒序',
    timeRange: '时间区间',
    range_all: '不限',
    range_7d: '近 7 天',
    range_30d: '近 30 天',
    range_90d: '近 90 天',
    range_365d: '近一年',
    from: '起',
    to: '止',
    tagsInUse: '已选标签',
    clickToRemove: '点击移除',
    indieTag: ' · 个人势',
    noTags: '（未选，点下面的标签加条件）',
    tagCloud: '标签',
    vocabHint: '括号里是别名，点一下加为条件；多个标签是 AND 关系',
    corpus: '语料',
    outsideRange: '条因时间条件被排除',
    expandedTo: '别名展开',
    entitiesTitle: '人物档案',
    entitiesHint: '由 LLM 特征抽取聚合出来的对象（谁出现过、什么游戏、哪些事件）。纯本地统计，不需要联网；数字是出现过的条目数，点一下就是一次检索。',
    assistTitle: '帮我认人',
    needsLlm: '需要 LLM',
    assistHint: '只记得特征、忘了名字时用（外貌 / 声音 / 名场面 / 所属）。普通检索用不上它。',
    assistDescribe: '你还记得什么',
    assistPlaceholder: '例：红发、笑声很特别、玩马里奥赛车很强、好像是大箱旗下的',
    assistRun: '让 AI 猜一下',
    assistTerms: '建议检索词',
    assistTags: '建议标签',

    // export / features
    exportXlsx: '导出 Excel',
    exportDocx: '导出 Word',
    exportDocxReport: '导出 Word',
    extractFeatures: '抽取特征',
    featuresShort: '特征抽取',
    featuresHint: '用 LLM 把条目抽成结构化属性（人名 / 所属 / 游戏 / 事件类型 / 标签），抽完之后这些属性都能被检索命中。有缓存，同一条不会重复花钱。',
    featuresStats: '已抽取',
    torTitle: 'Tor 无痕出口',
    torHint:
      '把全部抓取改走 Tor 的 SOCKS5，出口 IP 不指向你。需要本机能跑 Tor（Tor Browser 默认 127.0.0.1:9150，独立 tor 默认 9050）。注意 Tor 很慢，且不少站点会拒绝 Tor 出口。',
    torSocks: 'SOCKS5 地址',
    torExe: 'tor.exe 路径（可选，用于一键启动）',
    torProbe: '检测 Tor',
    torStart: '启动 Tor',
    torOk: 'Tor 可用',
    torNotTor: '端口能连，但出口不像 Tor',
    torFail: 'Tor 不可用',
    mode_http: 'HTTP 代理',
    mode_tor: 'Tor（无痕）',
    proxyModeTitle: '出口方式',

    // anonymous mode
    privacyTitle: '隐私 / 无痕',
    privacyHint: '匿名模式下完全不使用登录态：不读浏览器 cookie、不复用 profile。准备发布或做无痕化处理时打开它。',
    anonymousMode: '匿名模式',
    outputTitle: '输出格式与落盘位置',
    outputHint:
      '每日情报的主文件默认写成自带样式的 .html：VSCode 里打开即可预览，不需要装 Markdown 插件，纯文本编辑器也照样能读。无论选哪种格式，都会另存一份 .json 源（含原文），导出 Word/Excel、全文检索和逐次对比都基于它。',
    reportFormat: '情报报告格式',
    fmtHtml: '单文件网页（推荐，VSCode 可预览）',
    fmtJson: '结构化数据',
    tempDir: '临时文件目录',
    tempDirPh: '留空 = 系统临时目录',
    tempDirHint:
      '读浏览器 cookie 时会先把 cookie 数据库复制到临时目录。不想写到系统盘（Windows 上即 C 盘的 %TEMP%）就指到别的盘，例如 E:\\YourCache\\tmp。',
    browsersDir: '浏览器内核目录',
    browsersDirPh: '留空 = 系统默认位置',
    browsersDirHint: 'Playwright 浏览器内核的位置。Windows 默认在 %LOCALAPPDATA%（即 C 盘）；要守「不写 C 盘」的红线就指到别的盘。',
  },
  en: {
    appTitle: "Vtuber's Monitor Link",
    appSub: 'Local VTuber intelligence monitor',
    aboutTitle: 'About',
    aboutHint: 'Read this document inside the app — it opens from the top bar and switches between Chinese and English instantly, with no separate page',
    readmeLang: 'Language of this document',
    readmeLangZh: '中文',
    readmeLangEn: 'English',
    readmeFail: 'Could not load the document',
    readmeNote: 'The same document ships in the app directory',
    tab_intel: 'Intel',
    tab_run: 'Run',
    tab_sources: 'Sources',
    tab_watch: 'Watch',
    tab_settings: 'Settings',
    tab_reports: 'Reports',
    tab_calendar: 'Calendar',
    tab_people: 'People',
    mergeEvents: 'Merge duplicates',
    visionTag: 'Tag images',
    visionTagged: 'tagged',
    visionCached: 'cache hits',
    shareTitle: 'Share',
    shareHint:
      'Turn the intel into a **single file** to send someone: styled, with no external references, so it opens by double-click even offline. Ways that need no login always work; ways that need one tell you exactly what is missing, and unsupported platforms are labelled rather than offered as a dead button. Posting to bilibili is speaking in public — it requires two confirmations and stays unavailable until one post has actually succeeded.',
    shareScope: 'Scope',
    shareScopeLatest: 'Latest intel',
    shareScopeDay: 'A specific day',
    shareScopePerson: 'A person',
    shareFormat: 'Format',
    shareNotePh: 'add a line (optional)',
    shareDownload: 'Build and download',
    shareCopy: 'Copy text',
    shareSaved: 'Saved',
    shareCopied: 'Copied to clipboard',
    shareTarget: 'Method',
    shareLogin: 'Login',
    shareStatus: 'Status',
    shareAction: 'Action',
    shareReady: '✅ ready',
    shareNeedsLogin: '🔒 login required',
    shareNeedsVerify: '⚠ needs verification',
    shareUnsupported: '✕ unsupported',
    shareUnsupportedShort: 'not offered',
    shareCannotWithoutLogin: 'log in first',
    sharePost: 'Post',
    shareVerifyPost: 'Verify and post',
    sharePostConfirm: 'Post to "{target}"? This cannot be undone.',
    sharePosted: 'Posted',
    shareVerifiedNow: 'now marked available',
    shareAccounts: 'Detected accounts',
    shareAudit: 'Share log',
    shareAuditHint: 'what was exported when, and whether anything was posted',
    chartsTitle: 'Trends',
    chartsArchive: 'archive',
    chartsDays: 'days',
    chartsRange: 'Range',
    chartsBackfill: 'Backfill from intel',
    chartsEmpty:
      'No archived data yet. Running a collection writes it incrementally; you can also hit "Backfill from intel" above to import what has already been collected. (The archive lives in feeds/archive.db and is idempotent per item id, so re-running never inflates the numbers.)',
    chartsHint:
      'The archive is incremental SQLite (appended on every run, existing items skipped). Charts are inline SVG — no charting library, because a portable exe should not carry hundreds of KB for a few bars.',
    chartsDaily: 'Items per day',
    chartsDailyHint: 'bars: items collected each day (days with no run show 0 rather than a fake continuous line)',
    chartsSources: 'Sources and alerts',
    chartsSourcesHint: 'bars: cumulative items per source; below: daily keyword-hit counts',
    chartsPeople: 'People activity',
    chartsPeopleHint: 'bars: cumulative matched items per followed person',
    chartsNoPeople: 'No people matches yet (add people on the People tab first).',
    chartsKeywords: 'Keyword trends',
    chartsKeywordsHint: 'bars: most frequently hit keywords',
    chartsNoKeywords: 'No keyword hits yet (keywords are configured in Settings).',
    chartsHealth: 'Source health',
    chartsHealthHint: 'checks, success rate and average latency per source (latency counts successful checks only)',
    chartsChecks: 'checks',
    chartsRate: 'success',
    chartsAlerts: 'Alerts per day',
    eventsTitle: 'Merged events',
    eventsStats: 'events',
    eventsMerged: 'duplicates removed',
    eventsConfirmed: 'multi-source',
    eventsConfirmedBadge: 'multi-source',
    eventsSources: 'sources',
    eventsMergedShort: 'merged',
    eventsItems: 'Reported items',
    eventsItemsHint: 'the original posts from each source for this same event',
    eventsHint:
      'When several sources report the same thing it is shown once, with a "multi-source" badge — the more sources, the more trustworthy. Similarity is computed locally (character bigrams + IDF weighting + a time window); no network or LLM. Source weight starts from a base (official > news > community > social) and grows from who reported an event first.',
    open: 'open',
    peopleHint:
      'Sources are the collection unit; what you actually care about is people. Add names and accounts and the app maps intel onto people locally (plain string matching, no network, no LLM), always showing which alias matched in which field, so every attribution is explainable. The daily report and notifications group by person; set someone to urgent and their messages bypass quiet hours.',
    peopleEmpty: 'No people followed yet. Expand "Add" below, or import from the entity stats.',
    peopleScanned: 'items scanned',
    peopleMatched: 'matched people',
    peopleAliases: 'aliases',
    peopleItems: 'items',
    peopleShowFeed: 'show this person’s intel',
    peopleNoItems: 'Nothing collected for this person yet.',
    peopleWhy: 'matched by',
    peopleUrgent: 'urgent',
    peopleAddTitle: 'Add a person',
    peopleAddSummary: 'name is required; aliases and accounts drive matching (CJK/native names, @handles, uids)',
    peopleNamePh: 'e.g. Diana',
    peopleEnName: 'Latin name',
    peopleAgency: 'Agency',
    peopleNotifyLevel: 'Notify level',
    peopleAliasesPh: 'comma or space separated, e.g. 嘉然今天吃什么, Jia Ran',
    peopleSuggestTitle: 'Import from entities',
    peopleSuggestSummary: 'suggestions from the already-extracted entity stats (local counting, no extra LLM run)',
    peopleSuggestRun: 'Build suggestions',
    peopleSuggestFrom: 'entities counted',
    peopleSuggestNone: 'Nothing to suggest (either everyone is followed already, or entity extraction has not run yet).',
    peopleAdded: 'Added to the follow list',
    language: 'Language',
    name: 'Name',
    date: 'Date',
    detecting: 'Detecting…',
    calHint:
      "Birthdays, debut days, 3D reveals and anniversaries. \"Today\" is computed in the timezone shown below (set it in Settings — e.g. Asia/Tokyo when following a Japanese agency). A Feb 29 birthday falls back to Mar 1 in common years and says so, instead of silently drifting.",
    calEmpty: 'No dates yet. Expand "Add" or "Find leads in the intel" below to start.',
    calToday: 'Today',
    calTomorrow: 'Tomorrow',
    calDaysLater: '{n} days away',
    calYearN: 'year',
    calLeap: 'leap day → Mar 1',
    calTotal: 'Total',
    calRemindWindow: 'within reminder window',
    calWeekStart: 'week starts',
    calAddTitle: 'Add a date',
    calAddSummary: 'name + date (MM-DD repeats yearly, YYYY-MM-DD is one-off)',
    calNamePh: 'e.g. Diana birthday',
    calKind: 'Kind',
    calKind_birthday: 'Birthday',
    calKind_debut: 'Debut',
    calKind_3d: '3D reveal',
    calKind_anniversary: 'Anniversary',
    calKind_event: 'Event',
    calKind_other: 'Other',
    calSince: 'Since year',
    calRemind: 'Remind (days)',
    calNote: 'Note',
    calAdded: 'Added to the calendar',
    calImported: 'Imported',
    calAlready: 'already in calendar',
    calDetectTitle: 'Find leads in the intel',
    calDetectSummary: 'local regex scan over collected intel — no network, no LLM; suggestions only, nothing is saved automatically',
    calDetectRun: 'Scan intel',
    calDetectScanned: 'scanned',
    calDetectFound: 'found',
    calDetectNone: 'No dated anniversaries found (the intel must actually mention birthday / 3D reveal / anniversary / debut).',
    calImport: 'Import selected',
    calGridAddHint: 'One-off events (concerts, collabs) use a full date:',
    notifyQuiet: 'Quiet hours',
    quietInherit: 'Respect quiet',
    quietBypass: 'Bypass quiet',
    notifySecret: 'Signing secret',
    notifySecretPh: 'empty if unsigned',
    notifyDedupe: 'Dedupe (min)',
    quietTitle: 'Quiet hours',
    quietSummary: 'silent at night, delivered in the morning (expand to configure)',
    quietNow: 'currently in quiet hours',
    quietEnabled: 'Enabled',
    quietStart: 'Start',
    quietEnd: 'End',
    quietDays: 'Applies to',
    daysAll: 'every day',
    daysWeekdays: 'weekdays',
    daysWeekend: 'weekends',
    quietTz: 'Timezone',
    quietTzPh: 'empty = follow the timezone setting',
    quietHint:
      'Notifications during quiet hours are not dropped — they are queued and delivered once quiet hours end (or immediately with the button above). A window crossing midnight (e.g. 23:00→08:00) is treated as night; identical start and end means all-day quiet. urgent notifications bypass quiet hours by default, because time-sensitive ones cannot wait. If the configuration is malformed it fails open (still delivers) rather than going permanently silent.',
    quietFlush: 'Deliver now',
    save: 'Save',
    saved: 'Saved',
    saving: 'Saving…',
    saveStateIdle: 'No changes yet',
    saveStateDirty: 'Unsaved changes — remember to save',
    proxyAuto: 'Automatic (recommended)',
    egressNotYet: 'Not probed yet — follows the global setting until then',
    egressPinned: 'Pinned manually; automatic mode will not override it',
    fastest: 'fastest',
    openAll: 'Expand',
    closeAll: 'Collapse',
    llmNeedsTable: 'Feature matrix',
    llmNeedsSummary: 'which features need a key and which do not',
    cancel: 'Cancel',
    close: 'Close',
    add: 'Add',
    delete: 'Delete',
    actions: 'Actions',
    enable: 'Enable',
    disable: 'Disable',
    check: 'Check',
    history: 'History',
    loading: 'Loading…',
    refresh: 'Refresh',
    search: 'Search',
    all: 'All',
    items: 'items',
    failed: 'failed',
    done: 'done',
    checking: 'Checking…',
    generatedAt: 'Generated',
    openSource: 'Open source',
    label: 'Label',
    labelPlaceholder: 'a name for yourself',

    browserTitle: 'Browser',
    browserHint:
      'Pick the browser used for scraping. To reuse a login (e.g. X post bodies, bilibili dynamics with pictures, Twitch following list), choose "System browser" and make sure that browser is fully closed before running.',
    mode: 'Mode',
    mode_bundled: 'Bundled Chromium (works out of the box)',
    mode_system: 'Installed system browser (can reuse login)',
    mode_custom: 'Custom path',
    detected: 'Detected',
    executablePath: 'Browser executable',
    profileDir: 'User data dir (optional, for reusing login)',
    profileHint: 'Leave empty for a clean temp profile (no login). The dir is locked while that browser is running.',
    headless: 'Headless',
    waitMs: 'Wait after render (ms)',
    checkLogin: 'Check login',
    checkingLogin: 'Checking…',
    loginOk: 'Login cookies found',
    loginNoSession: 'Cookies found but no SESSDATA (probably not signed in)',
    loginNone: 'No login cookies found',
    loginHint:
      'This makes a **read-only copy** of the browser cookie store to pick up a login — the browser can stay open, ' +
      'nothing is locked or modified, and cookie values never reach a log or a report. ' +
      'If the browser uses App-Bound Encryption (the default in Chrome 127+), outside decryption is impossible and ' +
      'you have to close the browser so Playwright can reuse the profile.',
    domainLabel: 'Domains to read',
    cookieCount: '{n} cookies',
    cookieCountWithSession: '{n} cookies (incl. SESSDATA)',
    browserFromSettings: 'from Settings',

    llmTitle: 'LLM analysis',
    llmHint:
      'Any OpenAI-compatible endpoint (DeepSeek / OpenAI / Kimi / Qwen / local Ollama). Keep several profiles and switch between them; the key is stored only in local config.json.',
    llmProfiles: 'Profiles',
    llmAddProfile: 'Add profile',
    llmPreset: 'Provider',
    llmActive: 'Active',
    llmFetchModels: 'Fetch models',
    llmModelsFetched: 'Models fetched',
    llmDeleteProfile: 'Delete profile',
    llmNeedKey: 'Fill in an API key first',
    baseUrl: 'Base URL',
    apiKey: 'API Key',
    model: 'Model',
    reasoningEffort: 'Reasoning effort',
    maxTokens: 'Max tokens',
    testLlm: 'Test connection',
    testing: 'Testing…',
    showKey: 'Show',
    hideKey: 'Hide',

    proxyTitle: 'Network proxy',
    proxyHint:
      'Node fetch ignores the system proxy by default. Enable this if your network requires a proxy — it applies to both scraping and browser rendering. Note: some sites are blocked *because* of a proxy (bilibili is one), so sources and watch targets can override this with "direct".',
    proxyEnabled: 'Enable proxy',
    proxyUrl: 'Proxy URL',
    proxyDetect: 'Detect common local proxy ports',
    proxyDetecting: 'Detecting…',
    proxyFound: 'Usable proxy detected',
    proxyNone: 'No usable proxy port detected',
    proxyMode: 'Egress',
    proxyInherit: 'Follow global',
    proxyDirect: 'Force direct',
    proxyUse: 'Force proxy',

    scheduleTitle: 'Schedule',
    scheduleHint: 'Built-in scheduler; no OS task needed, works cross-platform. Each run also checks the watch targets.',
    enabled: 'Enable schedule',
    mode_weekly: 'Weekly',
    mode_daily: 'Daily',
    dayOfWeek: 'Day of week',
    time: 'Time',
    nextFire: 'Next run',
    merchEveryDays: 'Merch scan interval (days)',
    watchWithRun: 'Also check watch targets on each run',

    uiTitle: 'Appearance',
    uiHint: 'Follow the system theme, or pin one. You can also get a desktop notification when a run finishes.',
    // observation mode
    obsTitle: 'Observation mode',
    obsHint:
      'When you watch a whole group, the footprint is information too: sweeping every member at once, at the same hour daily, at exactly equal gaps — none of that depends on which IP you come from. With this on, each round samples a random subset (rotation fills the coverage in), gaps are jittered, and only sources whose logs the other side owns go through Tor.',
    obsEnabled: 'Enable observation mode',
    obsRatio: 'Sample per round',
    obsJitter: 'Gap jitter',
    obsJitterNone: 'No jitter (fixed gaps)',
    obsTorAgency: 'Tor for their own sites',
    obsSkipLogin: 'Skip sources that need a login',
    obsRotateExit: 'Rotate the Tor exit',
    obsRotationHint:
      'Their own sites means entries whose logs stay on their servers (official sites). Platform sources such as bilibili / Reddit / Fandom do not use Tor: the group cannot see those logs, and measurements show Tor is about 8x slower there and some endpoints rate-limit it. Exit rotation uses Tor SOCKS username isolation — different usernames really do land on different exit IPs.',
    obsSampling: 'This round is a sample',
    obsSamplingNote:
      'Objects not picked this round come up in later rounds; the local archive is incremental, so coverage fills in. Not seen this round is not the same as nothing happened.',
    obsSkippedLogin: 'Skipped (needs login)',
    // cost board
    costTitle: 'Usage and budget',
    costHint:
      'This tool spends money on model calls. Only usage we can actually see is counted (calls where the model returned no usage, or a local model, are counted separately rather than guessed). A warning lands in the run log at 80% of the budget; past the limit the default is to warn only, pick stop to actually block the run.',
    costToday: 'Today',
    costTotal: 'All time (includes rows outside the window)',
    costCalls: 'calls',
    costBudget: 'Daily budget (tokens, 0 = unlimited)',
    costUnlimited: 'no limit set',
    costOnExceed: 'When over budget',
    costExceedWarn: 'Warn only (default)',
    costExceedStop: 'Block this run',
    costRemaining: 'remaining',
    costUnknown: 'calls without usage data',
    obsLastSeen: 'Last observed',
    // import from VDB
    vdbTitle: 'Import followed people from VDB',
    vdbHint:
      'VDB is the roster behind vtbs.moe (community maintained, ten thousand plus entries); each entry carries a group and its accounts on every platform - search by name or by a platform account and you get the person plus group, aliases and accounts in one go. The data is fetched at runtime only (about 0.5MB, one request) and is not distributed with this tool.',
    vdbSearch: 'Search',
    vdbSearchPh: 'name / alias / platform account (twitch name, YouTube channel, ...)',
    vdbSync: 'Sync roster',
    vdbRoster: 'Roster',
    vdbGroups: 'groups',
    vdbImport: 'Import',
    vdbImported: 'imported',
    vdbSkipped: 'skipped',
    vdbNoResult: 'Nothing found (try an alias or a platform account id)',
    // group view
    groupViewTitle: 'Group view',
    groupViewHint:
      'A per-item feed cannot answer "how is this group doing". Here the members of one agency are laid out as a heatmap: one cell per day, darker means more items that day; anyone who stopped is flagged, days when several members are active together are counted (that is what a project or collab looks like), and a whole group going quiet is called out. Every threshold is relative to each person own cadence.',
    groupWindow: 'window',
    groupDays: 'days',
    groupNoAgency: 'No followed person has an agency yet',
    groupPeopleCount: 'followed people',
    groupMembers: 'members',
    groupActive7: 'active in 7d',
    groupQuiet: 'quiet for',
    groupLast: 'last',
    groupNever: 'no records yet',
    groupTolerance: 'tolerance',
    groupCoActive: 'Same-day activity',
    groupPeopleUnit: 'p',
    groupQuietStreak: 'No activity for',
    groupFullHouse: 'All active together',
    groupUngrouped: 'Ungrouped',
    groupUngroupedHint: 'fill in Agency for a followed person to fold them into a group',
    theme: 'Theme',
    themeAuto: 'Follow system',
    themeLight: 'Light',
    themeDark: 'Dark',
    notify: 'Desktop notification',
    notifyHint: 'Show a system notification when a run finishes (the browser asks for permission).',

    sourcesTitle: 'Sources',
    sourcesHint:
      'Tick the sites to scrape. Login requirement: none = public, optional = fuller with login, required = unavailable without login (red).',
    category: 'Category',
    login: 'Login',
    fetchKind: 'Fetch',
    enabledCol: 'Enabled',
    login_none: 'Not needed',
    login_optional: 'Optional',
    login_required: 'Required',
    customSources: 'Custom sources',
    customSourcesHint:
      'For sites the built-in catalog misses: give it an RSS feed, a MediaWiki API, a bilibili UID, or a page that needs browser rendering.',
    addCustomSource: 'Add a custom source',
    sourceId: 'Id (letters/digits/dash)',
    sourceName: 'Name',
    sourceUrl: 'URL',
    sourceUid: 'UID (for bilibili dynamics)',
    sourceCadence: 'Cadence',
    cadence_daily: 'Regular',
    cadence_merch: 'Merch (14 days)',
    deleteSource: 'Delete',
    builtin: 'built-in',
    custom: 'custom',
    sourceAdded: 'Added',
    bulkToggle: 'Bulk',
    enableAll: 'Enable all',
    disableAll: 'Disable all',
    onlyDaily: 'Daily only (merch off)',
    resetDefaults: 'Reset to defaults',
    onlyCustom: 'Custom only',

    watchTitle: 'Watch targets',
    watchHint:
      'Not just a site-wide recent-changes firehose: pin one wiki page, one arbitrary URL, or one bilibili UP. The first check only builds a baseline; every later check reports what actually changed.',
    watchEnabled: 'Watching enabled',
    checkAll: 'Check all now',
    showRules: 'Alarm rules',
    hideRules: 'Hide rules',
    rulesLargeEdit: 'Large edit (bytes)',
    rulesLargeDelete: 'Large delete (bytes)',
    rules_newPage: 'Alert on new pages',
    rules_anonymousEdit: 'Alert on anonymous edits',
    rules_unpatrolled: 'Alert on unpatrolled edits',
    rulesKeywords: 'Keywords (comma separated)',
    rulesLogTypes: 'Log types to watch',
    watchAdd: 'Add a watch target',
    watchKind: 'Kind',
    watchMode: 'Extract',
    ignorePatterns: 'Ignore-line regexps',
    pageTitle: 'Page title',
    watchPagePh: 'Page title',
    namespaces: 'Namespaces',
    botUser: 'Account (BotPassword form)',
    botPassword: 'BotPassword',
    botPasswordHint:
      'Reading a watchlist requires a login. Create a read-only BotPassword in your wiki preferences — never the main password. It is stored only in the local config.json.',
    biliUidHint: 'The numeric UID of a bilibili UP (visible in their space URL). The first check builds a baseline; later checks diff new dynamics and follower growth.',
    watchList: 'Targets',
    baseline: 'Baseline',
    noBaseline: 'not yet (built on the next check)',
    noTargets: 'No watch targets yet',
    noHistory: 'No change recorded yet',
    needUrl: 'Please fill in a URL',
    needApi: 'Please fill in the api.php URL',
    needApiPage: 'Please fill in the api.php URL and the page title',
    needBotPassword: 'A watchlist needs an account name and a BotPassword',
    needUid: 'Please fill in a numeric UID',
    duplicateTarget: 'That watch target already exists',
    watchDigest: 'Watch changes',
    loginRequiredTag: ' · login required',
    ignorePatternsPh: 'One regex per line; matching lines are ignored',
    followersCount: '{n} followers',
    viewSource: 'Source ↗',

    intelTitle: 'Intel stream',
    intelHint:
      'Items collected by the latest run. Keyword hits are flagged; [emotes] inside bilibili dynamics are marked separately and pictures are shown inline.',
    intelSearchPlaceholder: 'Search this batch…',
    onlyAlerts: 'Keyword hits only',
    noIntel: 'Nothing yet — run a collection first',

    runTitle: 'Run',
    runNow: 'Run now (daily)',
    runMerch: 'Run merch scan',
    runWatchOnly: 'Check watch targets only',
    running: 'Running…',
    step: 'Step',
    sources: 'Sources',
    tail: 'Live log',
    lastResult: 'Last result',
    noResult: 'No runs yet',
    alerts: 'alerts',
    watchTargets: 'targets',

    reportsTitle: 'Reports',
    reportsHint:
      'Reports live in the local reports/ folder — open them with any editor, read them here, or export a self-contained HTML file.',
    noReports: 'No reports yet',
    exportHtml: 'Export HTML',
    exportJson: 'Export JSON',
    searchReports: 'Full-text search',
    searchPlaceholder: 'Search inside every report…',
    matches: 'matches',
    noMatches: 'no match',
    rendered: 'Rendered',
    rawMarkdown: 'Raw Markdown',

    latency: 'Latency',
    loss: 'Fail rate',
    directEgress: 'Direct',
    proxyEgress: 'Proxy',
    torEgress: 'Tor',
    egressSettled: 'settled',
    egressTrial: 'trial',
    lastRunFailed: 'last run failed',
    customNamePh: "Someone's blog",
    selfCheckHint:
      'Self-checks run **at the very end of each run**: fetch first, then produce the report, and only ' +
      'then diagnose the sources that misbehaved (a healthy source is never disturbed). You can also ' +
      'press "check now" on any row above at any time.',
    probe: 'Probe',
    probeAll: 'Probe all',
    probing: 'Probing…',
    probingOne: 'Probing…',
    neverProbed: 'never probed',
    health: 'Source health',
    healthHint: 'Measured reachability per source: direct is a TCP handshake, proxy is time-to-first-byte through the proxy; fail rate = failures / attempts.',
    healthProblems: 'Sources with problems',
    healthOk: 'No obvious problem',
    verdict_direct: 'Prefer direct',
    verdict_proxy: 'Prefer proxy',
    verdict_none: 'Both egresses dead',
    verdict_unknown: 'Unknown',
    egress: 'Egress',
    egressSelect: 'Egress for this source',
    failover: 'Auto failover',
    probeTtl: 'Cache (minutes)',

    thumbnail: 'Thumbnail',
    loadThumb: 'Fetch thumbnail',
    screenshot: 'Screenshot',
    diagnosing: 'Checking…',
    diagnose: 'Self-check',
    diagnoseHealthy: 'Reachable — nothing to change',
    diagnoseBad: 'Problem found — diagnostic file written',
    adviceFiles: 'Diagnostic files',
    adviceHint: 'Only written when something is clearly wrong. Clicking one opens a readable page with the measurements and what to investigate.',
    openAdvice: 'Open',
    noAdvice: 'No diagnostic files',
    deleteAdvice: 'Delete',

    scheduleTasks: 'Scheduled tasks',
    scheduleHint2: 'Keep several tasks with their own mode, frequency and time. A task missed while the app was closed runs once on the next start.',
    addTask: 'Add task',
    taskName: 'Name',
    taskMode: 'Mode',
    taskMode_daily: 'Regular collection',
    taskMode_merch: 'Merch scan',
    taskMode_watch: 'Watch targets only',
    freq: 'Frequency',
    freq_weekly: 'Weekly',
    freq_daily: 'Daily',
    catchUp: 'Catch up if missed',
    catchUpTag: '(catch-up)',
    nextFireAt: 'Next run',
    preview: 'Upcoming',
    taskRunNow: 'Run now',
    lastFire: 'Last run',
    historyTitle: 'Run history',
    noScheduleHistory: 'No runs recorded yet',

    notifyTitle: 'Alert delivery',
    notifyPanelHint: 'Push keyword hits, watch changes and failures to your phone. Leave a channel blank to disable it.',
    addTarget: 'Add channel',
    notifyKind: 'Channel',
    notifyOn: 'Trigger',
    on_always: 'Every run',
    on_alerts: 'Alerts only',
    on_failures: 'Failures only',
    testNotify: 'Send a test',
    notifyTestOk: 'Test message sent',
    desktopNotify: 'Desktop notification',

    nodesTitle: 'Proxy nodes',
    nodesHint: 'Reads the node list from the local mihomo / Clash and measures every node against a URL you choose (the kernel delay endpoint accepts a URL).',
    detectControl: 'Detect control endpoint',
    controlNotFound: 'No control endpoint found (enable external-controller in the kernel config)',
    controlFound: 'Control endpoint found',
    group: 'Group',
    currentNode: 'Current node',
    testAgainst: 'Measure against',
    switchTo: 'Switch',
    switched: 'Switched',

    ioTitle: 'Import & export',
    ioHint: 'Export sources, watch targets, LLM profiles, notifications and layout as JSON, then import on another machine. No secrets by default.',
    exportNoSecrets: 'Export (no secrets)',
    exportWithSecrets: 'Export (with secrets)',
    importConfig: 'Import config',
    importHint: 'Pick a previously exported JSON file; empty strings never overwrite an existing secret.',
    imported: 'Imported',

    layoutTitle: 'Layout',
    layoutHint: 'How reports and intel cards are presented. Applies immediately — the settings page doubles as a preview.',
    layoutMode: 'Presentation',
    layout_cards: 'Card wall (Jikipedia-style listing)',
    layout_list: 'List',
    layout_compact: 'Compact',
    layout_timeline: 'Timeline',
    layout_table: 'Table',
    columns: 'Columns',
    columns_auto: 'Auto',
    density: 'Density',
    density_comfortable: 'Comfortable',
    density_compact: 'Compact',
    fontScale: 'Font scale',
    showThumbs: 'Show pictures',
    showStats: 'Show engagement',
    showTime: 'Show time',
    showSource: 'Show source',
    accent: 'Accent colour',

    starred: 'Starred',
    onlyStarred: 'Starred only',
    onlyUnread: 'Unread only',
    markRead: 'Mark read',
    markUnread: 'Mark unread',
    compare: 'This run vs last',
    comparedAdded: 'New',
    comparedRemoved: 'Gone',
    comparedChanged: 'Changed',
    noPreviousRun: 'Nothing to compare with yet',

    tab_llm: 'LLM',
    llmEmptyHint: 'No profile yet - create one from a provider first. The fields only render when a profile exists, which is exactly why it used to look like there was nowhere to type a key.',
    llmCreateFirst: 'Create a profile',
    llmProfileFields: 'Profile settings',
    llmKeySet: 'Key set',
    llmKeyMissing: 'No key',
    llmKeyLocalOnly: 'Stored only in the local config.json; never committed, never shipped (the release check enforces this).',
    llmVisionHint: 'This is a vision model - once configured, the analysis layer can actually look at pictures in bilibili posts.',
    llmSaveHint: 'Remember to press Save at the bottom.',
    llmNeedsTitle: 'What needs it',
    llmNeedsHint: 'Most of the tool works without any LLM; reports, feature extraction and the identify helper need one.',
    llmFeature: 'Feature',
    llmNeedsLlmCol: 'Needs LLM',
    yes: 'Yes',
    no: 'No',
    llmFeat_report: 'Report generation (analysis)',
    llmFeat_features: 'Feature extraction (names/games/events become searchable)',
    llmFeat_assist: 'Identify from traits (remembered the traits, not the name)',
    llmFeat_search: 'Search (keyword / tag / time)',
    llmFeat_live: 'Live monitoring and multi-screen',
    llmFeat_danmaku: 'Posting a comment',
    llmFeat_probe: 'Probing, health board, self-check',
    tab_live: 'Live',
    liveTitle: 'Live status and multi-screen',
    liveHint:
      'Going live is the most time-sensitive intel there is. This shows the live status of everything you monitor, and tiles several rooms into a grid (the official bilibili embed player - no relay, no login involved). Note that a rerun/carousel is NOT a real broadcast, so it is labelled separately.',
    danmakuTitle: 'Post a comment (danmaku)',
    danmakuWarn:
      'Careful: unlike everything else here, it **posts publicly under your own account identity** and cannot be undone. It is not wired into any automation (scheduled tasks and collection runs never call it) and every single send needs your explicit confirmation.',
    danmakuAccount: 'Send as',
    danmakuNoAccount: 'No usable login found (sign in to bilibili in some browser, and keep that profile readable)',
    danmakuRoom: 'Room id',
    danmakuText: 'Message',
    danmakuConfirm: 'I confirm sending as this account, and that this is a public post',
    danmakuSend: 'Send',
    danmakuSending: 'Sending…',
    danmakuOk: 'Sent',
    danmakuAudit: 'Send history',
    danmakuAuditHint: 'Local audit log (account / room / text / result only - no credentials)',
    danmakuRefresh: 'Refresh accounts',
    danmakuLen: 'chars',
    liveAddOther: 'Add another platform',
    liveAddOtherHint:
      'All three are embeddable - measured: Twitch explicitly allows 127.0.0.1 in its frame-ancestors CSP, YouTube /embed/ sends no frame-ancestors, and bilibili blanc is unrestricted. Added tiles mix freely with the rest.',
    livePlatform: 'Platform',
    liveId: 'Channel / room / video id',
    liveProxyCaveat:
      'Platforms marked * (Twitch / YouTube) need your **browser** to be able to reach them. This machine cannot reach them directly, so the browser must go through the system proxy, otherwise the tile stays blank. bilibili needs no proxy.',
      liveProbe: 'Probe network',
    liveQualityUnavailable: 'Bitrate / FPS: not measurable through a cross-origin embed (same-origin policy) - not unimplemented',
    liveQualityWhy:
      'The official YouTube / Twitch / bilibili embeds all run in a cross-origin iframe, so the parent page cannot reach their <video> element and therefore cannot read getVideoPlaybackQuality(), buffered, or the negotiated bitrate. Measuring those for real means playing the stream ourselves: bilibili exposes URLs via getRoomPlayInfo (but only for genuinely live rooms), while YouTube/Twitch need a yt-dlp-class tool, with ToS and stability costs. The probe button above measures network latency and failure rate, which is the layer a third-party page can measure honestly.',
      liveCheck: 'Check live status',
    liveNow: 'Live now',
    liveRound: 'Rerun',
    liveOff: 'Offline',
    liveHintBilibili: 'Room number, e.g. 22637261',
    liveHintTwitch: 'Channel name, e.g. neurosama',
    liveHintYoutube: 'Channel ID (UC…, live tab) or a video ID',
    liveManualLabelPh: 'Name shown in the grid',
    liveRoomManualPh: 'or type it in',
    danmakuTextPh: 'Message to send',
    auditRoom: 'room',
    liveMonitored: 'monitored',
    addAllLive: 'Add every live room',
    clearGrid: 'Clear grid',
    multiScreen: 'Multi-screen',
    gridColumns: 'Grid columns',
    addToGrid: 'Add to grid',
    removeFromGrid: 'Remove',
    openStream: 'Open stream',
    liveNoTitle: '(no title)',
    liveNoTargets: 'Nothing monitored yet - enable any bilibili source, or add a uid by hand',
    noLiveNow: 'Nobody is live right now',
    liveFindUid: 'Find a uid by name',
    liveFindHint: 'Data from the vtbs.moe VTuber roster (about 9,700 entries). Add one to start monitoring it.',
    liveFindPlaceholder: 'part of a name, e.g. 泠鸢',
    added: 'Added to monitoring',
    tab_search: 'Search',
    searchTitle: 'Search',
    searchHint: 'Pure local matching: keywords + tags + a time range, assembled like a literature search. **No LLM and no network needed** — it works with no AI configured at all.',
    searchPlaceholder2: 'Keywords, space-separated = AND (e.g. 2434 graduation)',
    searchField: 'Search in',
    field_any: 'All fields',
    field_title: 'Title',
    field_text: 'Body',
    field_tag: 'Tags',
    field_source: 'Source',
    field_url: 'URL',
    sortBy: 'Sort',
    sort_relevance: 'Relevance',
    sort_time: 'Newest first',
    timeRange: 'Time range',
    range_all: 'Any time',
    range_7d: 'Last 7 days',
    range_30d: 'Last 30 days',
    range_90d: 'Last 90 days',
    range_365d: 'Last year',
    from: 'From',
    to: 'To',
    tagsInUse: 'Selected tags',
    clickToRemove: 'Click to remove',
    indieTag: ' · indie',
    noTags: '(none - click a tag below to add one)',
    tagCloud: 'Tags',
    vocabHint: 'parentheses hold aliases; click to add as a condition, several tags are ANDed',
    corpus: 'Corpus',
    outsideRange: 'excluded by the time filter',
    expandedTo: 'Aliases expanded',
    entitiesTitle: 'Entities',
    entitiesHint: 'Objects aggregated from the extracted features (who appeared, what games, which events). Pure local counting, no network; the number is how many items mention them, and clicking runs a search.',
    assistTitle: 'Help me identify',
    needsLlm: 'needs an LLM',
    assistHint: 'For when you remember the traits but not the name (looks / voice / a famous moment / affiliation). Plain search does not need it.',
    assistDescribe: 'What do you remember',
    assistPlaceholder: 'e.g. red hair, a very distinctive laugh, great at Mario Kart, probably from a big agency',
    assistRun: 'Let the model guess',
    assistTerms: 'Suggested terms',
    assistTags: 'Suggested tags',

    exportXlsx: 'Export Excel',
    exportDocx: 'Export Word',
    exportDocxReport: 'Export Word',
    extractFeatures: 'Extract features',
    featuresShort: 'Feature extraction',
    featuresHint:
      'Uses an LLM to turn items into structured attributes (names / agency / games / event types / tags) so those become searchable. Cached per item, so nothing is paid for twice.',
    featuresStats: 'Extracted',
    torTitle: 'Tor egress',
    torHint:
      'Route every fetch through the Tor SOCKS5 so the exit IP is not yours. Needs a running Tor (Tor Browser defaults to 127.0.0.1:9150, standalone tor to 9050). Tor is slow and many sites refuse its exits.',
    torSocks: 'SOCKS5 address',
    torExe: 'Path to tor.exe (optional, for the start button)',
    torProbe: 'Check Tor',
    torStart: 'Start Tor',
    torOk: 'Tor works',
    torNotTor: 'Port answers, but the exit does not look like Tor',
    torFail: 'Tor unavailable',
    mode_http: 'HTTP proxy',
    mode_tor: 'Tor (anonymous)',
    proxyModeTitle: 'Egress method',
    privacyTitle: 'Privacy / anon',
    privacyHint: 'Anonymous mode uses no login at all: no browser cookies are read and no profile is reused. Turn it on before publishing or when scrubbing.',
    outputTitle: 'Output format & disk locations',
    outputHint:
      'The daily intel file defaults to self-styled .html: open it in VSCode and you get a rendered preview with no Markdown extension, and plain-text editors still read it fine. Whatever format you pick, a .json source (with the original text) is written alongside it, and Word/Excel export, full-text search and run-to-run diffs all read from that.',
    reportFormat: 'Report format',
    fmtHtml: 'single-file web page (recommended, previews in VSCode)',
    fmtJson: 'structured data',
    tempDir: 'Temp directory',
    tempDirPh: 'empty = system temp dir',
    tempDirHint:
      'Reading browser cookies copies the cookie DB to a temp directory first. Point this elsewhere if you do not want it written to the system drive (on Windows that is %TEMP% on C:), for example E:\\YourCache\\tmp.',
    browsersDir: 'Browser engines directory',
    browsersDirPh: 'empty = platform default',
    browsersDirHint: 'Where Playwright keeps browser engines. On Windows the default is under %LOCALAPPDATA% (the C drive); point it elsewhere to avoid writing to C:.',
    anonymousMode: 'Anonymous mode',
  },
};

/**
 * Weekday names are no longer a hand-written array: they are derived from the locale with Intl,
 * which is automatically correct for all 26 locales, and it also respects each region's first day
 * of the week (US / JP / KR / HK / TW start on Sunday, CN / EU / RU on Monday).
 */
function weekdaysFor(code, weekStart, style = 'short') {
  const fmt = new Intl.DateTimeFormat(code, { weekday: style, timeZone: 'UTC' });
  const out = [];
  for (let i = 0; i < 7; i++) {
    // 2024-01-07 is a Sunday; rotate by weekStart
    const d = new Date(Date.UTC(2024, 0, 7 + ((weekStart + i) % 7)));
    out.push(fmt.format(d));
  }
  return out;
}

/**
 * Expand the fallback chain recursively -- **recursion is mandatory here**.
 * The pitfall we hit: zh-TW's chain is written as ['zh-TW','zh-Hant','zh-Hans'],
 * but the base dictionary key is 'zh', not 'zh-Hans', so it never reached the Simplified base
 * and dropped straight to English instead.
 * With recursive expansion: zh-TW -> zh-Hant -> zh-Hans -> zh ✓
 */
function resolveChain(code, seen = new Set()) {
  if (seen.has(code)) return [];
  seen.add(code);
  const loc = byCode(code);
  const parents = (loc?.chain ?? [code]).filter((c) => c !== code);
  const out = [];
  for (const p of parents) out.push(...resolveChain(p, seen));
  out.push(code);
  return out;
}

/**
 * The fallback chain that is actually usable: **regional differences are inherited only within one
 * language**; anything cross-language falls back to English.
 *
 * Why it has to be this way: the chain of uk-UA / pl-PL / sr-RS listed ru-RU (originally just
 * meant as "a fallback when a key is missing"), and as a result they showed **Russian strings** as
 * their own UI copy -- presenting Russian as Ukrainian is plainly wrong, not merely "a translation
 * that is not good enough". Regional inheritance inside one language is correct
 * (es-MX->es-419->es-ES, fr-CA->fr-FR, pt-BR->pt-PT, zh-TW->zh-Hant->zh-Hans, en-AU->en-GB->en-US);
 * cross-language has to take the English fallback -- English that is not translated at least
 * offends nobody.
 */
function usableChain(code) {
  const base = String(code).split('-')[0];
  return resolveChain(code).filter((c) => String(c).split('-')[0] === base);
}

const Ctx = createContext(null);

/**
 * Apply the theme to <html>.
 *
 * It is also stored in localStorage on the way: config.json only arrives after one API round trip,
 * and the page has already painted one frame by then - so anyone on "system is light + I picked
 * dark" saw a white flash on every reload. index.html carries a small **synchronous** script that
 * paints from the remembered value first, and this then overwrites it with the server config
 * (the single source of truth).
 */
export function applyTheme(theme) {
  const root = document.documentElement;
  const value = theme === 'light' || theme === 'dark' ? theme : 'auto';
  if (value === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', value);
  try {
    localStorage.setItem('vml-theme', value);
  } catch (e) {
    /* If private mode refuses the write, so be it - it does not affect rendering */
  }
}

export function I18nProvider({ children }) {
  const [lang, setLang] = useState(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('vml-lang') : null;
    if (saved && byCode(saved)) return saved;
    const nav = typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : [];
    return negotiate(nav);
  });

  const loc = byCode(lang) ?? byCode('en-US');

  // The derived regional dictionaries. Traditional Chinese is no longer a runtime lookup table -
  // it is generated wholesale at build time from the OpenCC dictionaries by tools/i18n-hant.mjs
  // (see locales/generated.js):
  //   zh-Hant -> t (generic) · zh-HK -> hk (Hong Kong) · zh-TW -> twp (Taiwan standard, with wording)
  // The generator self-checks: the ASCII / placeholder structure must not be broken, an abnormal
  // difference rate is an error, and an unreviewed "suspected untranslated Simplified character"
  // fails the build outright.
  const derived = useMemo(() => {
    const brit = convertDict(STRINGS.en, toBritish);
    return {
      ...GENERATED,
      'en-GB': brit,
      'en-AU': brit, // Australia follows British spelling
      'en-CA': brit, // Canadian spelling is mostly British
    };
  }, []);

  const dict = useMemo(() => {
    // Merge order: usableChain returns **base -> specific** (zh -> zh-Hans -> zh-Hant -> zh-TW),
    // merged forwards, later overriding earlier, so **the specific locale always beats the base**.
    // This direction must stay forward: I once assumed "the parent overrides the child" and
    // reversed it, and all three Traditional variants fell back to Simplified (caught by the
    // traversal check on the spot).
    //
    // Priority inside each level (later overrides earlier):
    //   machine translations -> hand-written common entries -> the region's own entries
    // In other words, "a machine translation never beats a hand-written one".
    let out = {};
    for (const c of usableChain(loc.code)) {
      const level = {
        ...(MACHINE[c] ?? {}),
        ...(HAND_COMMON[c] ?? {}),
        // Number-dependent forms sit at the same priority as hand-written wording:
        // `<key>_<plural category>` beats the machine layer, and the plain key stays as the
        // fallback for languages that do not inflect (see locales/plurals.js, BUGS #54).
        ...(PLURALS[c] ?? {}),
        ...(OVERLAY[c] ?? derived[c] ?? STRINGS[c] ?? {}),
      };
      out = { ...out, ...level };
    }
    // English fallback: fill in only the keys nothing above provided
    out = { ...STRINGS.en, ...out };
    return out;
  }, [loc, derived]);

  /**
   * `t(key)` → the plain string.
   * `t(key, { n: 5 })` → picks `<key>_<plural category>` for that number when the language
   *   provides one, and substitutes `{n}` (or any other `{name}` from params).
   * For a full "count + noun" label use `tn(key, n)` instead — that is the one that decides
   * whether the number goes inside the phrase (see web/src/plural.js and BUGS #54).
   */
  const t = useCallback(
    (k, params) => {
      const num = params && Number.isFinite(params.n) ? params.n : null;
      const raw =
        (num !== null ? pickPlural(dict, k, loc.code, num) : null) ?? dict[k] ?? STRINGS.en?.[k] ?? k;
      return params ? fillParams(raw, params) : raw;
    },
    [dict, loc.code]
  );

  /** Full "count + noun" label: plural category + the number placed where the language wants it. */
  const tn = useCallback(
    (k, n) => {
      const raw = pickPlural(dict, k, loc.code, n) ?? dict[k] ?? STRINGS.en?.[k] ?? k;
      return countLabel(raw, n);
    },
    [dict, loc.code]
  );

  useEffect(() => {
    try {
      localStorage.setItem('vml-lang', lang);
    } catch {}
    const root = document.documentElement;
    root.lang = loc.code;
    // RTL languages (Arabic and friends): the whole page direction flips with it, and the layout
    // only holds together if it uses logical properties
    root.dir = loc.dir ?? 'ltr';
  }, [lang, loc]);

  const value = useMemo(() => {
    const weekdays = weekdaysFor(loc.code, loc.weekStart);
    return {
      // lang is the **base language** (zh / en / ja ...), not a region code.
      // The server returns names keyed only by {zh,en}, and a dozen places in the UI rely on
      // `name[lang]`.
      // Switching lang to a full region code such as 'zh-Hans' once made every one of those lookups
      // come back empty and degrade to showing the id.
      // Where a full region code is needed, use localeCode.
      lang: loc.code.split('-')[0],
      localeCode: loc.code,
      setLang,
      t,
      tn,
      locale: loc,
      weekStart: loc.weekStart,
      dir: loc.dir ?? 'ltr',
      weekdays,
      // A fixed Sun-first week: the storage semantics of dayOfWeek in scheduled tasks is 0=Sunday,
      // and the order must not be rotated along with the region - that would silently move tasks
      // that are already stored onto a different day.
      weekdaysSunFirst: weekdaysFor(loc.code, 0),
      weekdaysLong: weekdaysFor(loc.code, loc.weekStart, 'long'),
      fmtDate: (d, opts) => new Intl.DateTimeFormat(loc.code, opts ?? { dateStyle: 'medium' }).format(new Date(d)),
      fmtTime: (d, opts) => new Intl.DateTimeFormat(loc.code, opts ?? { timeStyle: 'medium' }).format(new Date(d)),
      fmtDateTime: (d) => new Intl.DateTimeFormat(loc.code, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d)),
      fmtNumber: (n, opts) => new Intl.NumberFormat(loc.code, opts).format(n),
      fmtRelative: (d) => {
        const diff = (new Date(d).getTime() - Date.now()) / 1000;
        const rtf = new Intl.RelativeTimeFormat(loc.code, { numeric: 'auto' });
        const units = [
          ['day', 86400],
          ['hour', 3600],
          ['minute', 60],
        ];
        for (const [unit, sec] of units) {
          if (Math.abs(diff) >= sec) return rtf.format(Math.round(diff / sec), unit);
        }
        return rtf.format(Math.round(diff), 'second');
      },
    };
  }, [lang, loc, t, tn]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n must be used inside I18nProvider');
  return v;
}
