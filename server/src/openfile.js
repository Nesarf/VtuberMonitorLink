// openfile.js — "open this report in an editor", on a machine that is the user's own
//
// This is the one place in the application where a **request names a file**, and that file is then handed to
// an external program. Everything about the shape of this module follows from that single fact:
//
//   1) **The request carries a kind and an id, never a path.** The client says "the report whose name is
//      X.json" and the server resolves where that is. A path from the client would make this endpoint a
//      general "execute a program on any file" primitive, which is the one thing it must not be.
//   2) **The resolved path is asserted to be inside one of the app's own output roots** — resolved, then
//      compared component by component against the resolved root (never a `startsWith` on an unnormalised
//      string, where `<root>-backup` and `<root>/../..` both pass). A symlink is resolved first, so a link
//      pointing out of the roots is refused too, and `..` is refused before anything is stat'ed.
//   3) **No command line is ever built as a string.** The invocation is an argv array handed to
//      `execFile` with `shell: false`, so a file name containing `&`, `|` or a quote is a file name and
//      nothing else. The configured editor is split into program + arguments by the same rule.
//   4) **Nothing is guessed.** A missing editor, a file that does not exist, a file outside the roots and
//      an unusable configured command all come back as their own reason.
//
// The pure half (roots, path resolution, command resolution, argv construction) is separated from the half
// that spawns, so all four rules are testable offline — see tools/login-check-test.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { resolveDir } from './config.js';

/**
 * The kinds a request may name, and where each one lives.
 *
 * The root is resolved from the app's own configuration (`resolveDir`), not from the request: the two
 * directories that answer "where did this app write it" are the ones the rest of the code writes to.
 */
export const OPEN_KINDS = {
  report: { dirKey: 'reportsDir', label: { zh: '报告', en: 'report' } },
  feed: { dirKey: 'feedsDir', label: { zh: '情报', en: 'feed' } },
  advice: { dirKey: 'reportsDir', sub: 'advice', label: { zh: '诊断', en: 'diagnostic' } },
};

/** One entry of the roots the app is allowed to open from */
function rootOf(cfg, kind) {
  const spec = OPEN_KINDS[kind];
  if (!spec) return null;
  const base = resolveDir(cfg, spec.dirKey);
  if (!spec.sub) return path.resolve(base);
  return path.resolve(base, spec.sub);
}

/**
 * The file name may be an id or a file name, but never a path.
 *
 * Rejecting the separators here, before any resolution, is the cheapest of the three defences and the one
 * that also removes `..` (which contains none of them, so it is checked separately below). The remaining
 * two are the resolved-prefix test and the symlink test in resolveOpenPath.
 */
export function isPlainFileName(name) {
  const s = String(name ?? '').trim();
  if (!s || s.length > 200) return false;
  if (s.includes('/') || s.includes('\\') || s.includes('\0')) return false;
  if (s === '.' || s === '..') return false;
  if (s.includes('..')) return false;
  return true;
}

/**
 * Resolve a (kind, id) request to an absolute path inside the app's own output roots.
 *
 * @param {object} cfg
 * @param {string} kind one of OPEN_KINDS
 * @param {string} id a plain file name (not a path)
 * @returns {{ok:true, path:string, root:string, kind:string, name:string}
 *          |{ok:false, error:string, code:string}}
 */
export function resolveOpenPath(cfg, kind, id) {
  const spec = OPEN_KINDS[kind];
  if (!spec) return { ok: false, code: 'unknown-kind', error: `unknown kind: ${String(kind)}` };
  const name = String(id ?? '').trim();
  // A raw path must be refused **by name**, not merely fail to be found: the difference is a person being
  // told why, and this is the rule the whole endpoint exists to keep.
  if (!isPlainFileName(name)) {
    return {
      ok: false,
      code: 'not-a-file-name',
      error: 'this endpoint takes a file name, not a path (no separators, no "..")',
    };
  }
  const root = rootOf(cfg, kind);
  if (!root) return { ok: false, code: 'unknown-kind', error: `unknown kind: ${String(kind)}` };
  const candidate = path.resolve(root, name);
  if (!isInside(root, candidate)) {
    return { ok: false, code: 'outside-roots', error: `refused: ${name} resolves outside ${root}` };
  }
  if (!fs.existsSync(candidate)) {
    return { ok: false, code: 'missing', error: `no such file: ${name}` };
  }
  // A symlink that leaves the roots is the case a prefix test alone cannot see: the path looks right and
  // the file is somewhere else. realpath resolves the whole chain, and the same resolved-prefix rule is
  // applied to what it points at.
  let linkTarget = null;
  try {
    linkTarget = fs.realpathSync.native(candidate);
  } catch {
    linkTarget = null;
  }
  if (linkTarget) {
    let realRoot = root;
    try {
      realRoot = fs.realpathSync.native(root);
    } catch {
      realRoot = root;
    }
    if (!isInside(realRoot, linkTarget)) {
      return { ok: false, code: 'outside-roots', error: `refused: ${name} is a link to a file outside ${root}` };
    }
  }
  let stat = null;
  try {
    stat = fs.statSync(candidate);
  } catch {
    stat = null;
  }
  if (!stat?.isFile()) return { ok: false, code: 'not-a-file', error: `${name} is not a regular file` };
  return { ok: true, path: candidate, root, kind, name };
}

/**
 * The resolved-prefix test the rules above rely on.
 *
 * `path.relative` is used rather than `startsWith`: it is component-wise, so `<root>-backup` is not inside
 * `<root>`, and it is computed on already-resolved paths. Empty means "the root itself", which is not a file
 * and is refused by the caller's own check.
 */
export function isInside(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  return !path.isAbsolute(rel);
}

/**
 * Split a configured editor command into a program and its arguments.
 *
 * The setting exists because VS Code is only the default: anyone using another editor or a wrapper should
 * not have to invent a file association to use this button. It is split **without a shell**: quotes group a
 * word, and runs of spaces separate them. It is never handed to `sh -c`, so a value that looks like a shell
 * fragment is just a program name that will not be found.
 *
 * @param {string|string[]} command
 * @returns {string[]} argv (empty when nothing usable was configured)
 */
export function parseEditorCommand(command) {
  if (Array.isArray(command)) return command.filter((x) => typeof x === 'string' && x.length > 0);
  const s = String(command ?? '').trim();
  if (!s) return [];
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Which program opens a file, given the setting and the platform.
 *
 * The default is VS Code on PATH (`code`), because that is where these files are edited; when it is not
 * installed the fallback is the platform's own opener, and when even that is unknown the caller is told
 * rather than left with a silent nothing. `probe` is injectable so the resolution is testable offline.
 */
export function resolveEditorCommand(setting, platform = process.platform, probe = isOnPath) {
  const configured = parseEditorCommand(setting);
  if (configured.length) {
    return { program: configured[0], args: configured.slice(1), source: 'configured', platform };
  }
  if (probe('code')) return { program: 'code', args: [], source: 'vscode', platform };
  // On Windows the fallback is `explorer`, not `cmd /c start`. `cmd` is a shell, and it re-parses the
  // characters of whatever follows /c, so a file name containing `&` would stop being one argument and start
  // being two commands -- which is exactly rule 3 of this module, broken in its least visible branch. A file
  // name here is a name the app itself wrote and the endpoint refuses separators and `..`, so nothing
  // exploitable was reachable, but a shell in the argv is a shell in the argv: `explorer <path>` hands the
  // path to the shell's file association without any re-parsing. `login-check-test.mjs` asserts no platform
  // fallback resolves to a shell, with the old `cmd /c start` shape as its control.
  if (platform === 'win32') return { program: 'explorer', args: [], source: 'platform', platform };
  if (platform === 'darwin') return { program: 'open', args: [], source: 'platform', platform };
  if (platform === 'linux') return { program: 'xdg-open', args: [], source: 'platform', platform };
  return { program: null, args: [], source: 'none', platform };
}

/** Is a program name on PATH? (`where` on Windows, `which` elsewhere) — synchronous and cheap */
export function isOnPath(program) {
  const name = String(program ?? '').trim();
  if (!name) return false;
  // An absolute path is not "on PATH": it is a program, and it is checked by existence.
  if (path.isAbsolute(name)) return fs.existsSync(name);
  const dirs = String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.com', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(dir, name + ext))) return true;
      } catch {
        /* an unreadable PATH entry is not a match */
      }
    }
  }
  return false;
}

/**
 * The invocation, as an argv array.
 *
 * This function is the whole reason the module is shaped the way it is: it returns `{ command, args }`, and
 * there is no code path anywhere in this module that concatenates a command string. The test asserts exactly
 * that ("nothing reaches a shell"), so a later edit that goes back to `exec(` has to change this shape first.
 *
 * `cwd` is the file's own directory: the VS Code CLI (and most editors) resolve a relative name against the
 * working directory, so a name with an ampersand in it stays a name.
 */
export function buildOpenInvocation({ path: file, editor, platform = process.platform }) {
  if (!file) return { ok: false, error: 'no file to open' };
  if (!editor?.program) {
    return { ok: false, error: 'no editor is available: install a CLI editor or set one in Settings' };
  }
  return {
    ok: true,
    command: editor.program,
    args: [...(editor.args ?? []), file],
    // Never a shell: the values above are passed as separate argv entries, and this flag is what makes
    // "a file name is data, not syntax" true rather than merely intended.
    shell: false,
    cwd: path.dirname(file),
    display: `${editor.program} ${[...(editor.args ?? []), path.basename(file)].join(' ')}`,
  };
}

/**
 * Run the invocation. The only side effect in this module, and it is deliberately a thin wrapper: every
 * decision was made by the pure functions above, and every failure comes back as a reason.
 *
 * `spawnImpl` is injectable so the wiring is testable without launching anything.
 */
export function openResolvedPath({ file, editor, platform = process.platform, displayName = null, spawnImpl = execFile }) {
  const inv = buildOpenInvocation({ path: file, editor, platform });
  if (!inv.ok) return Promise.resolve({ ok: false, error: inv.error, code: 'no-editor' });
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    try {
      const child = spawnImpl(inv.command, inv.args, { cwd: inv.cwd, shell: false, windowsHide: false }, (err) => {
        if (err) {
          done({ ok: false, code: 'launch-failed', error: `${inv.command}: ${err.message}` });
          return;
        }
        done({ ok: true, error: null, opened: displayName ?? path.basename(file), editor: inv.display, command: inv.command, args: inv.args });
      });
      child?.on?.('error', (err) => done({ ok: false, code: 'launch-failed', error: `${inv.command}: ${err.message}` }));
      // The platform opener detaches (it hands the file to a running instance and exits), so the launch is
      // reported when the process has been started rather than when it exits: waiting for a Windows
      // `start` would mean waiting for the editor to close.
      if (editor.source === 'platform' && inv.command !== 'code') {
        setTimeout(() => done({ ok: true, error: null, opened: displayName ?? path.basename(file), editor: inv.display, command: inv.command, args: inv.args, detached: true }), 250);
      }
    } catch (e) {
      done({ ok: false, code: 'launch-failed', error: e.message });
    }
  });
}

/** What the UI shows after a successful open: what was opened, and with what */
export function openResultNote(result, editor) {
  if (!result?.ok) {
    return { zh: `没打开：${result?.error ?? '未知原因'}`, en: `not opened: ${result?.error ?? 'unknown reason'}` };
  }
  const where = result.editor ?? editor?.program ?? '?';
  return { zh: `已用 ${where} 打开 ${result.opened}`, en: `opened ${result.opened} with ${where}` };
}
