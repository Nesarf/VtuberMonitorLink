// LoginCheck.jsx — the "check login state" affordance, shared by every surface that configures a login
//
// Why this is one component rather than a button written five times: the requirement is that the control
// exists **everywhere a login state can be configured**, that it always measures rather than displays an
// assumption, and that it is never hidden behind a condition that is usually false. Written five times, that
// requirement would be five independent judgement calls; written once, it is one rule:
//
//   • it renders whenever the page can answer "can this be checked?" -- the button is **not** wrapped in a
//     condition, and the only things that disable it are its own check running and a **stated** reason (the
//     login kind has no probe, the site has no host, a required field is empty);
//   • every disabled case carries that reason in its `title`, so a greyed-out control always says why;
//   • the result is whatever was measured -- a cookie count and names, a verified account, or the site's own
//     reason -- and never a pass this app did not measure.
//
// The wording comes from the dictionary (no English invented here), and the sentences for the states where
// nothing can be measured are shared so all five surfaces say the same thing.
import { useState } from 'react';
import { useI18n } from './i18n.jsx';

/** FNV-1a over two count strings, base36 — a stable React key for a bare numeral pair, nothing secret. */
export function countKey(a, b) {
  const h = (s) => {
    let x = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      x ^= s.charCodeAt(i);
      x = Math.imul(x, 0x01000193) >>> 0;
    }
    return x;
  };
  return `${h(String(a))}-${h(String(b))}`;
}

/**
 * "used / limit" for a site's body, plus whether it fits.
 *
 * The pair is two bare numerals, so it needs no dictionary entry (the requirement spells this out); the
 * label that says *which* limit it is reuses `shareTextLimit`, which already carries `{n}` and already exists
 * in every locale.
 */
export function textCounter(text, limit) {
  const used = typeof text === 'string' ? text.length : 0;
  const n = Number.isFinite(Number(limit)) ? Number(limit) : null;
  return { used, limit: n, over: n !== null && used > n, fits: n === null || used <= n };
}

/**
 * The message for a login check, from the answer the server actually sent.
 *
 * Two sources and two shapes, both honest about it: the cookie probe answers with **counts and names**
 * (never a value), while a site's own probe answers with the account it confirmed or the reason it refused.
 * Sharing this keeps Settings, Live, Sources and both Share surfaces saying the same thing.
 *
 * @param {object} r the server's answer
 * @param {Function} t dictionary lookup
 * @param {Function} tn number-aware dictionary lookup (plural forms, see web/src/plural.js)
 */
export function loginCheckMessage(r, t, tn) {
  if (!r) return null;
  if (r.status === 'unavailable') return { ok: false, text: `— ${r.detail?.en ?? r.reason ?? ''}` };
  if (typeof r.cookieCount === 'number') {
    const names = (r.names ?? []).slice(0, 8).join(', ');
    if (!r.ok) {
      if (r.cookieCount > 0) {
        return { ok: false, text: `⚠️ ${t('loginNoSession')}: ${tn('cookieCount', r.cookieCount)}${names ? ` · ${names}` : ''}` };
      }
      const why = r.reason ?? '';
      return { ok: false, text: `❌ ${t('loginNone')}${r.domain ? `: ${r.domain}` : ''}${why ? ` · ${why}` : ''}` };
    }
    return {
      ok: true,
      text: `✅ ${t('loginOk')}: ${tn(r.hasSession ? 'cookieCountWithSession' : 'cookieCount', r.cookieCount)}${r.domain ? ` · ${r.domain}` : ''}`,
    };
  }
  // A site's own probe: an account, or the site's own reason.
  if (r.ok) return { ok: true, text: `✅ ${t('loginOk')}: ${r.accountName ?? r.accountId ?? ''}${r.probe ? ` · ${r.probe}` : ''}` };
  return { ok: false, text: `❌ ${t('loginNone')}: ${r.detail?.en ?? r.reason ?? ''}` };
}

/** The cookie-probe half for a plain domain: the sources page, which is not a share target. */
export function cookieProbeMessage(r, t, tn) {
  if (!r) return null;
  const names = (r.names ?? []).slice(0, 8).join(', ');
  if (!r.ok) {
    if ((r.names ?? []).length) return { ok: false, text: `⚠️ ${t('loginNoSession')}: ${tn('cookieCount', r.cookieCount)}${names ? ` · ${names}` : ''}` };
    const why = r.error ?? '';
    return { ok: false, text: `❌ ${t('loginNone')}${r.domains?.[0] ? `: ${r.domains[0]}` : ''}${why ? ` · ${why}` : ''}` };
  }
  return { ok: true, text: `✅ ${t('loginOk')}: ${tn(r.hasSession ? 'cookieCountWithSession' : 'cookieCount', r.cookieCount)}` };
}

/**
 * The button itself.
 *
 * `disabledReason` is the whole point of the component: when the check cannot run, the reason becomes the
 * `title` and the button is disabled with that explanation attached, instead of the caller making the button
 * vanish. `onCheck` returns the server's answer and the caller decides what to do with it.
 */
export default function LoginCheckButton({ onCheck, disabledReason = '', extraDisabled = false, size = 'tiny', onResult = null }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const blocked = !!disabledReason || extraDisabled;
  const title = busy ? t('checkingLogin') : disabledReason || t('loginCheckTitle');
  const run = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await onCheck();
      onResult?.(r);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-check" style={{ gap: 4 }}>
      <button className={`ghost ${size}`} title={title} disabled={busy || blocked} onClick={run}>
        {busy ? t('checkingLogin') : t('checkLogin')}
      </button>
      {err ? <span className="warn-text small">{err}</span> : null}
    </span>
  );
}
