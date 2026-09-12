// i18n-source.mjs — 词条源码解析 / parse the shipped dictionaries out of i18n.jsx
//
// 为什么单独抽出来：覆盖度统计与翻译管线都要「读出简体词条」和「列出界面用到的键」，
// 各写一份必然会漂移（一处按 4 空格缩进匹配、另一处按任意缩进，结果两边数字对不上）。
// 所以这里做**唯一一份**解析实现。
//
// 注意两个已经踩过的坑，都在这里处理了：
//   · 数花括号前必须**抹掉字符串内容**（词的正文里会出现 `{ title, body }` 这种）
//   · 只取字典**自身一层**的键（缩进分不出来：词条拆行后是 6 空格，嵌套对象的键也是 6 空格）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const I18N_PATH = path.join(ROOT, 'web/src/i18n.jsx');

/** 把字符串字面量内容抹掉（保留引号位置） */
export function stripStrings(s) {
  let out = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\') {
        out += '  ';
        i++;
      } else if (c === q) {
        q = null;
        out += c;
      } else out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      q = c;
      out += c;
    } else out += c;
  }
  return out;
}

/** 取出某一本字典的文本范围（以「2 空格缩进的收尾 `},`」为边界） */
export function dictBlock(src, which) {
  const startIdx = src.indexOf(`  ${which}: {`);
  if (startIdx < 0) return '';
  const after = src.slice(startIdx);
  const end = /\n  \},\n/.exec(after);
  return after.slice(0, end ? end.index : after.length);
}

/** 字典自身一层的「键 → 值」（值可能是多行字符串） */
export function dictEntries(block) {
  const entries = new Map();
  const lines = block.split(/\r?\n/);
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = stripStrings(raw);
    if (depth === 1) {
      const m = /^\s*(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))\s*:\s*(.*)$/.exec(stripped);
      if (m) {
        const key = m[1] ?? m[2];
        // 值：优先同一行的字符串；否则取下一行（长句的常见形态）
        const inline = /:\s*'([\s\S]*)',?\s*$/.exec(raw);
        if (inline) entries.set(key, inline[1]);
        else {
          const next = lines[i + 1] ?? '';
          const m2 = /^\s*'([\s\S]*)',?\s*$/.exec(next);
          entries.set(key, m2 ? m2[1] : '');
        }
      }
    }
    for (const ch of stripped) {
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
    }
  }
  return entries;
}

/** 读源码里的 zh / en 两本字典 */
export function readDicts(src = fs.readFileSync(I18N_PATH, 'utf8')) {
  return {
    zh: dictEntries(dictBlock(src, 'zh')),
    en: dictEntries(dictBlock(src, 'en')),
  };
}

/** 界面真正用到的键：`t('key')` + 动态前缀（tab_/calKind_/…） */
export function usedKeys(extraDynPrefixes = []) {
  const files = [];
  const CODE = ['.js', '.jsx'];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (['node_modules', 'dist', 'locales'].includes(e.name)) continue;
        walk(path.join(dir, e.name));
      } else if (CODE.includes(path.extname(e.name))) files.push(path.join(dir, e.name));
    }
  })(path.join(ROOT, 'web/src'));
  const used = new Set();
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bt\(\s*'([^']+)'\s*\)/g)) used.add(m[1]);
  }
  const { en } = readDicts();
  const dyn = ['tab_', 'calKind_', 'llmFeat_', 'taskMode_', 'on_', 'freq_', 'field_', 'mode_', 'sort_', ...extraDynPrefixes];
  for (const k of en.keys()) if (dyn.some((p) => k.startsWith(p))) used.add(k);
  return used;
}
