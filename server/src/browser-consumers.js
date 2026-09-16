// browser-consumers.js — who depends on the browser/profile targeting, and what each of them reports.
//
// One list, read by three readers, because three copies of it would drift on the first change:
//   • the server route /api/browser/target, which answers with the per-feature status;
//   • web/src/pages/Browser.jsx, which draws that status ("what this feature needs, and whether it is met
//     right now") and names each row through the dictionary (`browserConsumer_<id>` / `browserConsumerWhy_<id>`);
//   • tools/integrity-check.mjs, whose structural section asserts that each of these files really resolves
//     the shared key instead of reading `browser.profileDir` itself.
//
// Every row carries the same `key`. That is not decoration: the test pins it, so a consumer that starts
// reading a different key cannot be added here without the check failing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserProfileKey, inventoryKeyProblems, resolveProfileTarget } from './browser-target.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The shape of one consumer row:
 *
 *   id            stable key — also the i18n id, if a page ever wants its own copy
 *   file          the module the consumer lives in, relative to the repo root
 *   symbol        the resolver call that must appear in that file (the structural check reads it)
 *   needsProfile  whether the feature can do its job with an empty profile dir
 *   key           the config key it gets the profile from — the same one for every row, by construction
 *                 (pinned by inventoryKeyProblems and by tools/browser-config-test.mjs)
 *   what / why    the copy the page shows for this row, bilingual in the same shape the share sites use
 *                 (`{ zh, en }`, see SHARE_SITES in share.js). Product copy that a server route returns
 *                 travels this way in this project rather than through the web dictionary, so the page can
 *                 never render a row whose sentence is missing.
 *   satisfied(w)  the verdict, computed from the resolved target — never from a second reading of the key
 */
export const BROWSER_CONSUMERS = [
  {
    id: 'scraping',
    file: 'server/src/fetchers/browser.js',
    symbol: 'resolveProfileDir',
    needsProfile: false,
    key: 'browser.profileDir',
    what: {
      zh: '浏览器渲染抓取（fetch: browser 的来源）：用配置的浏览器打开页面取正文。',
      en: 'Browser-rendered scraping (a source with `fetch: browser`) renders the page with the configured browser.',
    },
    why: {
      zh: '临时干净配置就够用，所以这一项在配置目录为空时也能工作。',
      en: 'A clean temporary profile is enough, which is why this works with the setting empty.',
    },
    satisfied: () => ({ ok: true, reason: 'temporary-profile' }),
  },
  {
    id: 'loginProbe',
    file: 'server/src/share.js',
    symbol: 'resolveProfileDir',
    needsProfile: true,
    key: 'browser.profileDir',
    what: {
      zh: '所有登录态检查背后的只读 cookie 读取（分享页、来源页、本页）。',
      en: 'The read-only cookie probe behind every login-state check (share page, sources page, this page).',
    },
    why: {
      zh: '它从你指定的配置目录里复制一份 cookie 库来读；没有指定就没有可读的东西。',
      en: 'It copies a cookie store out of the profile you point at; with none named there is nothing to read.',
    },
    satisfied: (w) => {
      if (w.profile.dir) return NEEDS_DIR;
      // The answer the owner never got: the reason names the state, and the page turns it into a link to the
      // one place that fills it in — instead of handing him the cookie reader's internal error string.
      if (w.profile.anonymous) return { ok: false, reason: 'anonymous-mode' };
      return { ok: false, reason: 'nothing-configured' };
    },
  },
  {
    id: 'sharePost',
    file: 'server/src/server.js',
    symbol: 'resolveProfileTarget',
    needsProfile: true,
    key: 'browser.profileDir',
    what: {
      zh: '对外分享发送：凭证在发送时现读，不用缓存里的结论。',
      en: 'Publishing a share: the credential is read from the profile at send time, not from a cached verdict.',
    },
    why: {
      zh: '发送这一步会重新读一次凭证，所以发送时配置目录必须可读。',
      en: 'The send stage re-reads the credential, so the profile must be readable when the post is sent.',
    },
    satisfied: (w) => (w.profile.dir ? NEEDS_DIR : { ok: false, reason: 'nothing-configured' }),
  },
  {
    // The share page's own login check (`GET /api/share/check-login`) resolves the profile in server.js as
    // well, so it is its own row: "the page's check answered `profileDir is empty`" was the complaint this
    // round started from, and a status table that folded it into the send stage would not have shown it.
    id: 'shareLoginCheck',
    file: 'server/src/server.js',
    symbol: 'resolveProfileTarget',
    needsProfile: true,
    key: 'browser.profileDir',
    what: {
      zh: '分享页与来源页的「检查登录态」：点一下就用配置目录现读一次。',
      en: 'The share page’s and the sources page’s “Check login”: each press re-reads the configured profile.',
    },
    why: {
      zh: '这就是那个曾经回答「profileDir is empty」的检查，所以它自己也要在表里现身。',
      en: 'This is the check that answered “profileDir is empty”, which is why it appears in the table itself.',
    },
    satisfied: (w) => (w.profile.dir ? NEEDS_DIR : { ok: false, reason: 'nothing-configured' }),
  },
];

/**
 * The requirement "the feature needs the profile dir and it has to exist here".
 *
 * It answers a single marker rather than doing the filesystem test itself: whether a directory exists is a
 * fact about **the machine the report is being made for**, and that filesystem is handed to
 * browserTargetReport (see finishVerdict). Deciding it here would silently use this module's own `fs` — which
 * is exactly what happened while this was being written (measured: the injected filesystem resolved a profile
 * and the verdict still said the dir was empty).
 */
const NEEDS_DIR = { reason: 'needs-dir-exists' };

/**
 * Finish a requirement's verdict: "the dir is named, but does it exist on this machine?"
 *
 * The `fs` is the one the **caller** injected, never this module's own import: a report computed from one
 * filesystem while the resolution it describes came from another is exactly the kind of quiet disagreement
 * this whole file exists to prevent (measured while writing it: the injected filesystem resolved a profile
 * and the verdict still said `profile-is-empty`, because this helper reached for the real one).
 */
function finishVerdict(verdict, dir, fsImpl) {
  if (verdict.reason !== 'needs-dir-exists') return { ok: !!verdict.ok, reason: verdict.reason };
  const exists = (() => {
    try {
      return !!fsImpl?.existsSync?.(dir);
    } catch {
      return false;
    }
  })();
  return exists ? { ok: true, reason: 'profile-resolves' } : { ok: false, reason: 'profile-is-empty' };
}

/**
 * The report behind both the route and the page: the resolved target, plus one status row per consumer.
 *
 * Nothing here reads the config key itself — the whole point is that this report and the feature it describes
 * are looking at the same resolution.
 */
export function browserTargetReport(cfg, opts = {}) {
  const fsImpl = opts.fs ?? fs;
  const profile = resolveProfileTarget(cfg, { fs: fsImpl, roots: opts.roots });
  const key = browserProfileKey();
  const consumers = BROWSER_CONSUMERS.map((row) => {
    // Anonymous mode is a verdict about **logins**, and that is exactly what `needsProfile` marks: a consumer
    // that needs the profile is the one that loses it, while browser-rendered scraping keeps working with a
    // clean temporary profile (it never carried a login into that mode in the first place).
    const verdict =
      profile.anonymous && row.needsProfile
        ? { ok: false, reason: 'anonymous-mode' }
        : finishVerdict(row.satisfied({ profile }), profile.dir, fsImpl);
    return {
      id: row.id,
      file: row.file,
      // The documented key, not the row's own string: the page shows which key a feature reads, and the
      // inventory is checked against this one (the test mutates a row and expects the mismatch to show).
      key,
      needsProfile: row.needsProfile,
      what: row.what,
      why: row.why,
      ok: !!verdict.ok,
      reason: verdict.reason,
    };
  });
  return {
    key,
    profile: {
      // What the consumers actually get (`dir`, empty when nothing is configured or anonymous mode is on),
      // next to what the page has to show beside it: the stored setting and the documented default.
      dir: profile.dir,
      source: profile.source,
      reasons: profile.reasons,
      configured: profile.configured,
      default: profile.default,
      anonymous: profile.anonymous,
    },
    consumers,
    // Rows whose own `key` is not the documented one (an inventory that drifted from the resolver)
    keyProblems: inventoryKeyProblems(BROWSER_CONSUMERS, key),
  };
}

/** The rows the structural check needs: the file and the resolver symbol it must import */
export function consumerSources(rootDir = ROOT) {
  return BROWSER_CONSUMERS.map((row) => ({
    file: row.file,
    id: row.id,
    symbol: row.symbol,
    path: path.join(rootDir, row.file),
  }));
}

/** Consumer rows pointing at a file that does not exist (an inventory naming a moved file is worse than none) */
export function missingConsumerFiles(rootDir = ROOT) {
  return consumerSources(rootDir)
    .filter((c) => !fs.existsSync(c.path))
    .map((c) => c.file);
}
