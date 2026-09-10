// i18n.js — 中英双语 / bilingual strings (zh + en)
import { createContext, useContext, useEffect, useState } from 'react';

export const STRINGS = {
  zh: {
    appTitle: "Vtuber's Monitor Link",
    appSub: '本地 VTuber 情报监测',
    tab_settings: '设置',
    tab_sources: '来源',
    tab_run: '运行',
    tab_reports: '报告',
    save: '保存',
    saved: '已保存',
    saving: '保存中…',
    cancel: '取消',

    // browser
    browserTitle: '浏览器',
    browserHint:
      '选择抓取网页时使用的浏览器。要复用登录态（例如看 X 推文正文、Twitch 关注列表）时，请选「系统浏览器」并把浏览器完全关闭后再运行。',
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

    // llm
    llmTitle: 'LLM 分析',
    llmHint: '兼容 OpenAI 格式的接口（DeepSeek / OpenAI / 本地 Ollama、vLLM 均可）。Key 仅保存在本机 config.json。',
    baseUrl: '接口地址',
    apiKey: 'API Key',
    model: '模型',
    reasoningEffort: '推理强度',
    maxTokens: '最大输出 tokens',
    testLlm: '测试连通性',
    testing: '测试中…',

    // proxy
    proxyTitle: '网络代理',
    proxyHint:
      'Node 的 fetch 默认不读系统代理。若你的网络需要代理才能出网（例如国内网络），请在此启用——抓取与浏览器渲染会同时生效。',
    proxyEnabled: '启用代理',
    proxyUrl: '代理地址',
    proxyDetect: '探测本机常见代理端口',
    proxyDetecting: '探测中…',
    proxyFound: '探测到可用代理',
    proxyNone: '未探测到可用代理端口',

    // schedule
    scheduleTitle: '定时',
    scheduleHint: '内置调度器，不依赖系统计划任务；跨平台可用。',
    enabled: '启用定时',
    mode_weekly: '每周',
    mode_daily: '每天',
    dayOfWeek: '星期',
    time: '时间',
    nextFire: '下次运行',
    merchEveryDays: '通贩扫描间隔(天)',

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

    // run
    runTitle: '运行',
    runNow: '立即运行（常规）',
    runMerch: '运行通贩扫描',
    running: '运行中…',
    step: '阶段',
    sources: '来源',
    tail: '实时日志',
    lastResult: '上次结果',
    noResult: '尚无运行记录',

    // reports
    reportsTitle: '报告',
    reportsHint: '报告保存在本机 reports/ 目录，可直接用编辑器打开。',
    refresh: '刷新',
    noReports: '还没有报告',
    loading: '加载中…',
  },
  en: {
    appTitle: "Vtuber's Monitor Link",
    appSub: 'Local VTuber intelligence monitor',
    tab_settings: 'Settings',
    tab_sources: 'Sources',
    tab_run: 'Run',
    tab_reports: 'Reports',
    save: 'Save',
    saved: 'Saved',
    saving: 'Saving…',
    cancel: 'Cancel',

    browserTitle: 'Browser',
    browserHint:
      'Pick the browser used for scraping. To reuse a login (e.g. X post bodies, Twitch following list), choose "System browser" and make sure that browser is fully closed before running.',
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

    llmTitle: 'LLM analysis',
    llmHint: 'Any OpenAI-compatible endpoint (DeepSeek / OpenAI / local Ollama, vLLM). The key is stored only in local config.json.',
    baseUrl: 'Base URL',
    apiKey: 'API Key',
    model: 'Model',
    reasoningEffort: 'Reasoning effort',
    maxTokens: 'Max tokens',
    testLlm: 'Test connection',
    testing: 'Testing…',

    // proxy
    proxyTitle: 'Network proxy',
    proxyHint:
      'Node fetch ignores the system proxy by default. Enable this if your network requires a proxy to reach the internet — it applies to both scraping and browser rendering.',
    proxyEnabled: 'Enable proxy',
    proxyUrl: 'Proxy URL',
    proxyDetect: 'Detect common local proxy ports',
    proxyDetecting: 'Detecting…',
    proxyFound: 'Usable proxy detected',
    proxyNone: 'No usable proxy port detected',

    scheduleTitle: 'Schedule',
    scheduleHint: 'Built-in scheduler; no OS task needed, works cross-platform.',
    enabled: 'Enable schedule',
    mode_weekly: 'Weekly',
    mode_daily: 'Daily',
    dayOfWeek: 'Day of week',
    time: 'Time',
    nextFire: 'Next run',
    merchEveryDays: 'Merch scan interval (days)',

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

    runTitle: 'Run',
    runNow: 'Run now (daily)',
    runMerch: 'Run merch scan',
    running: 'Running…',
    step: 'Step',
    sources: 'Sources',
    tail: 'Live log',
    lastResult: 'Last result',
    noResult: 'No runs yet',

    reportsTitle: 'Reports',
    reportsHint: 'Reports live in the local reports/ folder — open them with any editor.',
    refresh: 'Refresh',
    noReports: 'No reports yet',
    loading: 'Loading…',
  },
};

export const WEEKDAYS = {
  zh: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
};

const Ctx = createContext(null);

export function I18nProvider({ children }) {
  const [lang, setLang] = useState(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('vml-lang') : null;
    if (saved) return saved;
    return typeof navigator !== 'undefined' && navigator.language?.startsWith('zh') ? 'zh' : 'en';
  });
  useEffect(() => {
    try {
      localStorage.setItem('vml-lang', lang);
    } catch {}
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }, [lang]);
  const t = (k) => STRINGS[lang]?.[k] ?? STRINGS.en[k] ?? k;
  return <Ctx.Provider value={{ lang, setLang, t }}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n must be used inside I18nProvider');
  return v;
}
