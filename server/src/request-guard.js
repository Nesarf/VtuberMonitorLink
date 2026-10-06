// request-guard.js — the loopback allowlist for the HTTP surface.
//
// Why this exists. The service binds 127.0.0.1, and that was treated as "only this machine can reach it,
// so it needs no further check". The second half of that is wrong in exactly one way that matters:
// **DNS rebinding**. A page on any site points a name it controls (evil.example) at 127.0.0.1, and the
// browser then sends the request to our port with `Host: evil.example`. From inside the server that is
// indistinguishable from a normal visit — unless the Host header is actually checked. The response also
// becomes readable to that page, because the browser considers the request same-origin with the attacker's
// own name. That is what turns "it only listens on loopback" into a full read of the config, which today
// contains an LLM API key and a wiki BotPassword.
//
// Two rules, and deliberately not more:
//   1) `Host` must name loopback (`127.0.0.1`, another 127.x address, `localhost`, `[::1]`), with or
//      without a port. A browser cannot forge this header for a cross-origin page: it is derived from the
//      URL the page navigated to, which after a rebind is the attacker's name.
//   2) `Origin`, **when present**, must also be loopback. A same-origin GET from our own page normally
//      carries no Origin at all, so an absent header is fine and a present one is a statement we can check.
//
// What must not break (measured, not assumed):
//   · the UI is served from the same loopback origin, reached as 127.0.0.1 or localhost — both allowed;
//   · the three traversals drive the service at http://127.0.0.1:<port>, and the SPA's own fetches are
//     same-origin, so neither rule is triggered;
//   · a refusal is a JSON error with a status code: the caller learns *why*, and nothing is reset.
// A port is not compared against the configured one on purpose: with PORT overridden (the tests do this),
// a check against "the port we think we are on" would refuse the very client that just connected.

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1']);

/** 127.0.0.0/8 is loopback in full; a machine may also be reached as 127.0.0.2 and that is still this host. */
export function isLoopbackAddress(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (LOOPBACK_NAMES.has(h)) return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return !!m && m.slice(1).every((n) => Number(n) <= 255);
}

/**
 * Split a header-shaped `host[:port]` into its parts. Deliberately strict: anything that is not a plain
 * host, an IPv6 literal in brackets, and an optional numeric port is "unknown", and unknown is refused.
 * A lenient parser here would be a bypass (`Host: 127.0.0.1@evil.example` must not pass by starting with
 * the right characters).
 */
export function parseHostHeader(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: false };
  let host = raw;
  let port = '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end < 0) return { ok: false };
    host = raw.slice(0, end + 1);
    const rest = raw.slice(end + 1);
    if (rest) {
      if (!rest.startsWith(':')) return { ok: false };
      port = rest.slice(1);
    }
  } else if (raw.includes(':')) {
    const i = raw.lastIndexOf(':');
    host = raw.slice(0, i);
    port = raw.slice(i + 1);
  }
  if (port && !/^\d{1,5}$/.test(port)) return { ok: false };
  if (port && Number(port) > 65535) return { ok: false };
  // A userinfo '@', a path or whitespace inside the host is not a Host header a browser produces, so it
  // is refused rather than interpreted.
  if (!host || /[@/\s\\]/.test(host)) return { ok: false };
  return { ok: true, host, port };
}

/** The Host check: loopback name (with or without port), nothing else. */
export function hostAllowed(hostHeader) {
  const parsed = parseHostHeader(hostHeader);
  if (!parsed.ok) return false;
  return isLoopbackAddress(parsed.host);
}

/**
 * The Origin check. `Origin: null` arrives from sandboxed iframes and from some file:// cases; it names no
 * host, so it is not a loopback origin and is refused (the app is opened from a loopback URL, never from a
 * file). An unparseable Origin is refused for the same reason.
 */
export function originAllowed(origin) {
  const raw = String(origin ?? '').trim();
  if (!raw || raw.toLowerCase() === 'null') return false;
  let url = null;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return isLoopbackAddress(url.hostname);
}

/**
 * Decide one request. Returns null when it may proceed, or a short reason string when it must be refused
 * (the reason is handed to the client, so it says which header was wrong).
 */
export function guardDecision(headers = {}) {
  const host = headers.host ?? headers.Host;
  if (!hostAllowed(host)) return `the Host header must name loopback (127.0.0.1, localhost, [::1]); received ${host === undefined ? 'nothing' : JSON.stringify(String(host))}`;
  const origin = headers.origin ?? headers.Origin;
  if (origin !== undefined && origin !== null && String(origin).trim() !== '' && !originAllowed(origin)) {
    return `a cross-origin request is not accepted; received Origin ${JSON.stringify(String(origin))}`;
  }
  return null;
}

/**
 * Express middleware. Refuses with 403 and a JSON body (never a socket reset) and marks the answer as
 * varying by Origin, so a cache can never hand a response computed for one origin to another.
 */
export function requestGuard() {
  return (req, res, next) => {
    res.setHeader('Vary', 'Origin');
    const reason = guardDecision(req.headers);
    if (reason) return res.status(403).json({ ok: false, error: reason });
    return next();
  };
}
