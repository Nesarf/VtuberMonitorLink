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
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat',
    reasoningEffort: 'high',
    maxTokens: 8192,
    temperature: 0.3,
  },
  schedule: {
    enabled: false,
    mode: 'weekly', // weekly | daily
    dayOfWeek: 2, // 0=Sun … 6=Sat（2=Tuesday）
    time: '23:30',
    merchEveryDays: 14,
  },
  run: {
    // 预抓取节流：Reddit 类站点按 IP 限流，主动拉开间隔比连击重试有效
    defaultGapSeconds: 2,
    maxParallel: 3,
  },
  proxy: {
    // 重要：Node 的 fetch(undici) 默认**不读**系统代理；
    // 本工具会按此配置显式走代理，抓取与浏览器渲染同时生效。
    enabled: false,
    url: '',
  },
  paths: {
    reportsDir: 'reports',
    feedsDir: 'feeds',
    logsDir: 'logs',
  },
  sources: {
    // id -> { enabled: boolean, login: 'none'|'optional'|'required' }
  },
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
