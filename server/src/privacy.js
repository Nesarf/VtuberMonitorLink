// privacy.js — the live facts a reader needs in order to answer "what does this thing send, and where is my data?"
//
// Why this is a module and not a route body: the documents (`docs/PRIVACY.md`, `SECURITY.md`) state the *policy*,
// and a policy cannot answer "which endpoints is **my** configuration talking to" or "how big is my history". The
// answer has to be derived from the running configuration, and the one thing that must never happen is a secret
// passing through it - which is a property worth testing without a server, a browser or a port.
//
// Two rules the code exists to keep:
//
//   · **the field list is data.** Every endpoint this product can contact is named in ENDPOINT_FIELDS with what it
//     is; a new integration that forgets to add its field leaves the privacy page silently incomplete, which is
//     why the test asserts that a URL placed in *any* listed field shows up rather than that "a URL shows up".
//   · **a webhook URL is a credential, an API base URL is not.** The application's own masking rule (see
//     `PARTIAL_SECRET_RES` in config.js and BUGS #4) says the important half of a webhook is its path, so a
//     webhook is reduced to its host and nothing else. An API base URL keeps its path, because "which endpoint"
//     is the question there, and the credential for it lives in a different field entirely.
import path from 'node:path';
import { resolveDir } from './config.js';

/** Where the app writes, and what a reader would call it. `tempDir`/`browsersDir` are empty by default. */
export const DATA_DIRS = [
  { key: 'reportsDir', what: 'Reports (the daily/intel HTML documents)' },
  { key: 'feedsDir', what: 'Feeds (raw fetched items)' },
  { key: 'logsDir', what: 'Logs (server log, client errors, run history)' },
  { key: 'watchDir', what: 'Watch baselines (what each watched page looked like last time)' },
  { key: 'tempDir', what: 'Temporary files (empty = the system temp directory)' },
  { key: 'browsersDir', what: 'Browser engine (empty = the default Playwright location)' },
];

/**
 * Every configuration field that names an endpoint, with the words a reader needs. `hostOnly` marks the ones
 * whose path is itself a credential.
 */
export const ENDPOINT_FIELDS = [
  { path: 'llm.providers[].baseUrl', what: 'LLM profile endpoint' },
  { path: 'llm.baseUrl', what: 'LLM endpoint (legacy single-profile field)' },
  { path: 'vdb.url', what: 'Roster download (dd-center/vdb)' },
  { path: 'proxy.url', what: 'HTTP proxy' },
  { path: 'proxy.torSocks', what: 'Tor SOCKS port (browser and per-source egress)' },
  { path: 'proxy.controlUrl', what: 'Proxy control endpoint (circuit rotation)' },
  { path: 'watch.targets[].url', what: 'Watched page' },
  { path: 'watch.targets[].apiUrl', what: 'Watched wiki API' },
  { path: 'customSources[].url', what: 'Custom source' },
  { path: 'share.sites[].url', what: 'Share site' },
  { path: 'notify.targets[].webhookUrl', what: 'Notification webhook', hostOnly: true },
];

/** Read `a.b[].c` out of a config, returning every value it finds (arrays are walked, missing keys yield none). */
export function readPath(cfg, dotted) {
  const parts = String(dotted).split('.');
  let current = [cfg];
  for (const raw of parts) {
    const many = raw.endsWith('[]');
    const key = many ? raw.slice(0, -2) : raw;
    const next = [];
    for (const node of current) {
      if (!node || typeof node !== 'object') continue;
      const value = node[key];
      if (many) {
        if (Array.isArray(value)) next.push(...value);
      } else {
        next.push(value);
      }
    }
    current = next;
  }
  return current.filter((v) => typeof v === 'string' && v.trim() !== '');
}

/**
 * What a reader may see of one configured address.
 *
 * Anything unparseable is reported verbatim in brackets rather than dropped: a value the product cannot parse is
 * exactly the thing a privacy page must not hide, and it cannot be a secret *and* unparseable at the same time
 * without the user having a bigger problem than this page.
 */
export function describeAddress(value, { hostOnly = false } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return `${raw} (not a parsable URL)`;
  }
  const host = u.host || u.hostname;
  if (hostOnly) return `${u.protocol}//${host}/…`;
  const where = `${u.protocol}//${host}${u.pathname === '/' ? '' : u.pathname}`;
  return u.search ? `${where}?…` : where;
}

/** The facts, derived from a configuration and nothing else. No I/O: the caller adds anything it measured. */
export function privacyFacts(cfg = {}) {
  const endpoints = [];
  for (const field of ENDPOINT_FIELDS) {
    for (const value of readPath(cfg, field.path)) {
      endpoints.push({ what: field.what, field: field.path, where: describeAddress(value, { hostOnly: field.hostOnly }) });
    }
  }
  const dirs = DATA_DIRS.map((d) => {
    const configured = cfg?.paths?.[d.key] ?? '';
    // An empty key means "the product's default", and `resolveDir` is the one place that knows what that is -
    // reading it here keeps this page from disagreeing with where the app actually writes.
    let resolved = '';
    try {
      resolved = configured || resolveDir(cfg, d.key);
    } catch {
      resolved = '';
    }
    return { key: d.key, what: d.what, configured: String(configured ?? ''), path: resolved };
  });
  const proxy = cfg?.proxy ?? {};
  return {
    endpoints,
    dirs,
    // The switches that change what leaves the machine, reported as the values the app actually uses rather than
    // as prose: a page that says "Tor is on" while the setting is off is worse than no page.
    egress: {
      enabled: proxy.enabled === true,
      mode: String(proxy.mode ?? 'http'),
      torSocks: describeAddress(proxy.torSocks ?? ''),
      torSocksConfigured: String(proxy.torSocks ?? '').trim() !== '',
    },
    anonymousMode: cfg?.privacy?.anonymousMode === true,
    // Stated so the reader can check it rather than take it on faith: this product has no telemetry field, and
    // the day somebody adds one this page is where it would have to be declared.
    telemetryFieldPresent: Object.prototype.hasOwnProperty.call(cfg ?? {}, 'telemetry'),
  };
}

/** The report as a markdown document, so the About panel can render it with the same renderer as the documents. */
export function privacyMarkdown(facts, { sizes = null, now = new Date() } = {}) {
  const line = (s) => `${s}\n`;
  let out = line('# This machine');
  out += line('');
  out += line('Generated from the running configuration, so it answers "what is *this* install doing" rather than what the policy is. The policy is in the Privacy document next to this one.');
  out += line('');
  out += line('## Endpoints this configuration contacts');
  out += line('');
  if (!facts.endpoints.length) {
    out += line('Nothing is configured to be contacted. With no LLM profile, no source, no watch target and no notification target, this install fetches nothing at all.');
  } else {
    out += line('| What | Field | Address |');
    out += line('| --- | --- | --- |');
    for (const e of facts.endpoints) out += line(`| ${e.what} | \`${e.field}\` | \`${e.where}\` |`);
    out += line('');
    out += line('A webhook is shown as its host only: its path is the credential. An API endpoint keeps its path, because "which endpoint" is the question - its key lives in another field and is never printed here.');
  }
  out += line('');
  out += line('## Egress');
  out += line('');
  out += line(`- proxy enabled: **${facts.egress.enabled ? 'yes' : 'no'}** (mode \`${facts.egress.mode}\`)`);
  out += line(`- Tor SOCKS: ${facts.egress.torSocksConfigured ? `\`${facts.egress.torSocks}\`` : 'not configured'}`);
  out += line(`- anonymous mode: **${facts.anonymousMode ? 'on' : 'off'}**`);
  out += line('');
  out += line('## Where the data lives');
  out += line('');
  out += line('| What | Directory |');
  out += line('| --- | --- |');
  for (const d of facts.dirs) {
    const size = sizes && sizes[d.key] ? ` (${sizes[d.key].files} files, ${sizes[d.key].bytes} bytes)` : '';
    out += line(`| ${d.what} | \`${d.path || '(default)'}\`${size} |`);
  }
  out += line('');
  out += line(`No telemetry field exists in this configuration (${facts.telemetryFieldPresent ? 'a `telemetry` field is present, which this build does not define' : 'checked'}). Nothing is uploaded anywhere by this product; the endpoints above are the ones *you* configured.`);
  out += line('');
  out += line(`_Generated ${now.toISOString()}_`);
  return out;
}

/** A bounded, read-only measurement of one directory: how many files and how many bytes, and never a failure. */
export function measureDir(dir, { maxFiles = 20000, fs = null } = {}) {
  if (!dir || !fs) return null;
  // The root is probed first, and this distinction is the point: a directory that cannot be read at all is **not**
  // an empty directory, and a privacy page that answered "0 files" for a folder it was not allowed to open would
  // be misleading in exactly the direction this page exists to avoid. The first version of this function let the
  // throw inside the walk produce 0/0 and the test caught it. A *subdirectory* that cannot be read still
  // contributes nothing rather than failing the whole measurement.
  try {
    fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let files = 0;
  let bytes = 0;
  const walk = (p, depth) => {
    if (files >= maxFiles || depth > 6) return;
    let entries = [];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files >= maxFiles) return;
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else {
        files++;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          /* a file that vanished between the listing and the stat contributes its existence, not its size */
        }
      }
    }
  };
  walk(dir, 0);
  return { files, bytes, truncated: files >= maxFiles };
}
