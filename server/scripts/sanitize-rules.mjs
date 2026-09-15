// sanitize-rules.mjs — one definition of "what counts as a personal trace", shared by both scanners
//
// Two scanners read these rules: `sanitize-check.mjs`, which reads the working tree, and `sanitize-history.mjs`,
// which reads every blob that has ever been committed. They must agree, because a trace that the tree scanner
// knows and the history scanner does not is a trace that survives every check this project runs - and the whole
// point of scanning history is that a file deleted long ago still carries what was in it.
//
// Private names are deliberately NOT hard-coded here: this file would itself become the leak. They are read from
// outside - `$SANITIZE_NAMES`, or a `.sanitize-names` file in the repository root (one per line, `#` starts a
// comment; gitignored).
import fs from 'node:fs';
import path from 'node:path';

/** Extensions worth reading as text; a binary blob cannot carry a readable trace and is not scanned */
export const TEXT_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.md', '.yml', '.yaml', '.css', '.html', '.txt']);

/** The runtime data directories are not tracked, but if one is committed by mistake it must be reported */
export const RUNTIME_PATHS = ['config.json', 'reports', 'feeds', 'logs'];

export const BASE_RULES = [
  { id: 'home-path', desc: 'personal home paths / 个人主目录路径', re: /[A-Z]:\\Users\\[^\\/"'\s]+/i },
  { id: 'specific-drive', desc: 'hard-coded absolute drive path / 写死的盘符绝对路径', re: /(?<![A-Za-z])[A-Z]:\\[^\\/"'\s]{3,}/ },
  // The same path as it exists inside a JSON file: escaping doubles every backslash, so the rule above needs a
  // single backslash followed by a non-backslash and walks straight past the escaped form. That is not a corner
  // case - every machine path in a .json is written that way - and it was found by pointing the release copy's
  // scanner at a directory whose only content was the machine-local worker overlay and getting "clean" back.
  {
    id: 'escaped-drive',
    desc: 'hard-coded drive path with escaped backslashes, as in JSON / 被转义的写死盘符路径',
    re: /(?<![A-Za-z\\])[A-Z]:\\\\(?!(Windows|Program Files|ProgramData|Users|temp|Temp|System32|YourCache)\b)(?!(?:n|t|r|b|f|v|0|u|x)(?![A-Za-z0-9_.-]{2,}))[^\\/"'\s]{2,}/,
  },
  { id: 'api-key', desc: 'possible API key / 疑似 API Key', re: /sk-[A-Za-z0-9_-]{16,}/ },
  { id: 'cookie-blob', desc: 'possible cookie blob / 疑似 cookie 内容', re: /(cf_clearance|SID=|sessionid=|__Secure-|auth_token)\s*[:=]/i },
];

/** Machine-local files: gitignored on purpose, excluded from the release copy, and full of this computer's paths */
export const MACHINE_LOCAL_FILES = new Set(['registry.local.json']);

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function loadPrivateNames(root) {
  const names = [];
  const env = process.env.SANITIZE_NAMES;
  if (env) names.push(...env.split(','));
  try {
    const file = path.join(root, '.sanitize-names');
    if (fs.existsSync(file)) names.push(...fs.readFileSync(file, 'utf8').split(/\r?\n/));
  } catch {
    /* an unreadable list is not a reason to stop: the built-in rules still run */
  }
  return [...new Set(names.map((s) => String(s).trim()).filter((s) => s && !s.startsWith('#')))];
}

/**
 * The full rule list, including the private-name rule built from whatever this machine was told to look for.
 * Both scanners call this rather than assembling their own, so "the tree is clean" and "the history is clean"
 * are answers to the same question.
 */
export function rulesFor(root) {
  const rules = [...BASE_RULES];
  const names = loadPrivateNames(root);
  if (names.length) {
    rules.push({
      id: 'private-name',
      desc: `private name leftover / 私人名字/账号残留 (${names.length} configured)`,
      re: new RegExp(names.map(escapeRe).join('|'), 'i'),
    });
  }
  return rules;
}

/**
 * The exemptions, which matter as much as the rules: a docs example is not a leak, and a line may exempt itself
 * with `sanitize-allow` for the cases a pattern cannot tell apart (a synthetic drive path in a test fixture is
 * not this machine's, and a deliberately cookie-shaped fixture is not a credential). Both scanners use these, or
 * the history scanner would report findings the tree scanner accepts - which is how a scanner stops being read.
 */
export function isExampleLine(line) {
  return /example|示例|placeholder|例如|之类|<[A-Za-z_-]+>|…|\.\.\./i.test(line);
}

export function isAllowedLine(line) {
  return isExampleLine(line) || line.includes('sanitize-allow');
}

/**
 * A matched value is never printed in full, by either scanner.
 *
 * The point of a scan like this is that a trace should not sit somewhere a reader can find it, and a scanner
 * that prints the match has just written it into a new place: a terminal scrollback, a CI log on a public
 * repository, a transcript. The report keeps the rule, the location and the length, plus the first character -
 * enough to recognise what was found, not enough to be the thing that leaked.
 */
export function mask(value) {
  const s = String(value);
  if (s.length <= 2) return '**';
  return s[0] + '*'.repeat(Math.min(s.length - 1, 8)) + (s.length > 9 ? ` (${s.length} chars)` : '');
}
