// locales/index.js — 语言与地区注册表 / locale registry
//
// 设计要点（这决定了后面加语言有多贵）：
//
// 1. **地区方言是「覆盖」而不是「复制」**。zh-TW 和 zh-Hans 的差别只有用词，
//    en-GB 和 en-US 的差别只有拼写/日期顺序，pt-BR 与 pt-PT 同理。
//    所以每个 locale 只写自己**不一样**的键，其余沿 chain 逐级回落 →
//    16 个语言的成本从「16 × 600 条」降到「2 套完整 + 14 套差异」。
//
// 2. **回落链必须显式写出来**，不能靠猜：zh-HK → zh-Hant → zh-Hans；
//    en-AU/GB/CA/NZ → en-US；es-MX/AR → es-419 → es-ES；pt-BR → pt-BR → pt-PT。
//    注意 uk/sr/pl 是**独立语言**，把 ru 放进它们的 chain 只是「缺键时兜底」，
//    不是「它们是俄语的方言」—— 这一点在界面上不能搞错。
//
// 3. **区域差异不只体现在文案上**：日期顺序、一周起始日、数字/货币格式都不一样。
//    这些交给 Intl + weekStart 字段，不要自己拼字符串。
//
// 4. 阿拉伯语等 RTL 语言用 dir:'rtl' 驱动 <html dir>。
//
// 想加一个语言：往 LOCALES 里加一行，再写一份 dict。缺的键自动回落，不会白屏。

/** 一周起始日：0=周日（美/日/韩/港台…），1=周一（中/欧/俄/拉美…） */
export const LOCALES = [
  { code: 'zh-Hans', name: '简体中文', chain: ['zh-Hans', 'zh'], weekStart: 1, lang: 'zh' },
  { code: 'zh-Hant', name: '繁體中文', chain: ['zh-Hant', 'zh-Hans'], weekStart: 1, lang: 'zh' },
  { code: 'zh-HK', name: '香港繁體', chain: ['zh-HK', 'zh-Hant', 'zh-Hans'], weekStart: 0, lang: 'zh' },
  { code: 'zh-TW', name: '臺灣正體', chain: ['zh-TW', 'zh-Hant', 'zh-Hans'], weekStart: 0, lang: 'zh' },
  { code: 'ja-JP', name: '日本語', chain: ['ja-JP', 'en-US'], weekStart: 0 },
  { code: 'ko-KR', name: '한국어', chain: ['ko-KR', 'en-US'], weekStart: 0 },
  { code: 'en-US', name: 'English (US)', chain: ['en-US', 'en'], weekStart: 0 },
  { code: 'en-GB', name: 'English (UK)', chain: ['en-GB', 'en-US'], weekStart: 1 },
  { code: 'en-AU', name: 'English (Australia)', chain: ['en-AU', 'en-GB', 'en-US'], weekStart: 1 },
  { code: 'en-CA', name: 'English (Canada)', chain: ['en-CA', 'en-GB', 'en-US'], weekStart: 0 },
  { code: 'es-ES', name: 'Español (España)', chain: ['es-ES', 'en-US'], weekStart: 1 },
  { code: 'es-419', name: 'Español (Latinoamérica)', chain: ['es-419', 'es-ES', 'en-US'], weekStart: 1 },
  { code: 'es-MX', name: 'Español (México)', chain: ['es-MX', 'es-419', 'es-ES'], weekStart: 1 },
  { code: 'es-AR', name: 'Español (Argentina)', chain: ['es-AR', 'es-419', 'es-ES'], weekStart: 1 },
  { code: 'pt-PT', name: 'Português (Portugal)', chain: ['pt-PT', 'en-US'], weekStart: 1 },
  { code: 'pt-BR', name: 'Português (Brasil)', chain: ['pt-BR', 'pt-PT'], weekStart: 0 },
  { code: 'fr-FR', name: 'Français', chain: ['fr-FR', 'en-US'], weekStart: 1 },
  { code: 'fr-CA', name: 'Français (Canada)', chain: ['fr-CA', 'fr-FR'], weekStart: 0 },
  { code: 'de-DE', name: 'Deutsch', chain: ['de-DE', 'en-US'], weekStart: 1 },
  { code: 'it-IT', name: 'Italiano', chain: ['it-IT', 'en-US'], weekStart: 1 },
  { code: 'ru-RU', name: 'Русский', chain: ['ru-RU', 'en-US'], weekStart: 1 },
  { code: 'uk-UA', name: 'Українська', chain: ['uk-UA', 'ru-RU', 'en-US'], weekStart: 1 },
  { code: 'sr-RS', name: 'Српски', chain: ['sr-RS', 'ru-RU', 'en-US'], weekStart: 1 },
  { code: 'pl-PL', name: 'Polski', chain: ['pl-PL', 'ru-RU', 'en-US'], weekStart: 1 },
  { code: 'ar-SA', name: 'العربية', chain: ['ar-SA', 'en-US'], weekStart: 0, dir: 'rtl' },
];

export const byCode = (code) => LOCALES.find((l) => l.code === code) ?? null;

/** 从浏览器语言列表里挑一个我们支持的地区 */
export function negotiate(langs) {
  const list = (langs ?? []).map((s) => String(s).replace('_', '-'));
  for (const raw of list) {
    const exact = LOCALES.find((l) => l.code.toLowerCase() === raw.toLowerCase());
    if (exact) return exact.code;
    const base = raw.split('-')[0].toLowerCase();
    // 先看同语言的完整地区有哪几个：有就把第一个（通常是「母国」）给它
    const sameLang = LOCALES.filter((l) => l.code.split('-')[0].toLowerCase() === base);
    if (sameLang.length) {
      const preferred = { zh: 'zh-Hans', en: 'en-US', es: 'es-ES', pt: 'pt-PT', fr: 'fr-FR' }[base];
      return (preferred && sameLang.find((l) => l.code === preferred)?.code) || sameLang[0].code;
    }
  }
  return 'en-US';
}

// ─────────────────────────────────────────────────────────────
// 覆盖词条：只写「和上一级不一样」的键。
// 完整的 zh-Hans / en-US 两套在 i18n.jsx 里（它们已经有 600+ 条）。
// ─────────────────────────────────────────────────────────────

// 简→繁的对照表**已删除**：手写表无法区分「简繁同形」与「漏字」，会产出混排界面。
// 现在繁体由 tools/i18n-hant.mjs 在构建期用 OpenCC 词典整份生成（locales/generated.js），
// 港繁/台繁用 hk / twp 词典，含用词差异（軟體/網路/資訊/預設/儲存…）。
// 英式拼写在 locales/overlays.js 的 GB_SPELL / GB_STEMS 里。
