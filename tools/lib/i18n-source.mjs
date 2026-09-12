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

/** 抹掉 `//` 行注释（引号内的 `//` 不算注释） */
export function stripComments(s) {
  let out = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      out += c;
      if (c === '\\') {
        out += s[i + 1] ?? '';
        i++;
      } else if (c === q) q = null;
    } else if (c === "'" || c === '"' || c === '`') {
      q = c;
      out += c;
    } else if (c === '/' && s[i + 1] === '/') {
      break; // 行注释：后面都不是代码（也不是文案）
    } else out += c;
  }
  return out;
}

/** 「抹字符串 + 抹注释」的组合，用于判断结构（逗号、花括号） */
export function noComment(s) {
  return String(s)
    .split(/\r?\n/)
    .map((l) => stripStrings(stripComments(l)))
    .join('\n');
}

/** 从一段源码里取出所有字符串字面量并拼起来（跨行 `'a' + 'b'` 就是同一个值） */
export function literalValue(src) {
  const out = [];
  const cleaned = String(src)
    .split(/\r?\n/)
    .map((l) => stripComments(l))
    .join('\n');
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
  for (const m of cleaned.matchAll(re)) {
    const body = m[1] ?? m[2] ?? '';
    out.push(body.replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n'));
  }
  return out.join('');
}

/**
 * 字典自身一层的「键 → 值」。
 *
 * 值的形态有四种，全都要认（早期版本只认「同一行的单引号字符串」，于是
 * `appTitle: "Vtuber's Monitor Link"`（双引号）与
 * `loginHint:` 换行后 `'甲' + '乙' + '丙'`（跨行拼接）被读成空串 ——
 * 空串在管线里等于「这条不用翻」，于是这两种词条在**所有语言**里都静默缺译）。
 *   · 同一行 '值' / "值"
 *   · 冒号后换行，值在下一行
 *   · 值跨多行用 + 拼起来（长句的常见形态）
 *   · 值是对象/数组（嵌套）→ 记空串，且**不吃掉后面的行**
 */
export function dictEntries(block) {
  const entries = new Map();
  const lines = block.split(/\r?\n/);
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = stripStrings(raw);
    if (depth === 1) {
      const m = /^\s*(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))\s*:/.exec(stripped);
      if (m) {
        const key = m[1] ?? m[2];
        const tail = raw.slice(m[0].length);
        const tailStripped = noComment(tail);
        if (/[{[]/.test(tailStripped)) {
          entries.set(key, ''); // 嵌套对象/数组：不是文案
        } else {
          let acc = tail;
          let j = i;
          // 值一直读到「收尾的逗号」为止（最多 40 行，防止畸形源码把整个字典吃光）
          while (!/[,;]/.test(noComment(acc)) && j < lines.length - 1 && j - i < 40) {
            j++;
            acc += '\n' + lines[j];
          }
          entries.set(key, literalValue(acc));
          i = j;
        }
      }
    }
    // 深度：必须用**改写过 i 之后**的那一行来数（跨行值里的 {} 都在引号内，会被抹掉）
    for (const ch of noComment(lines[i])) {
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
