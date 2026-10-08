// remote-url.js — the one place that decides whether a URL this process is about to fetch is allowed.
//
// Why this file exists, and why it is a *policy* rather than a blacklist of bad hosts.
//
// This product's entire job is fetching addresses the user supplied, and since v1.0.4 it renders them in a
// real browser as well. Before this file, the address was cleaned for *shape* (`sanitizeCustomSource` keeps a
// field whitelist and scrubs the id/name/region) and never for *reach*: nothing anywhere looked at the
// scheme, the host, or where that host resolves. So a source could be pointed at
// `http://127.0.0.1:43110/api/config` — this app's own config route — at a router on the LAN, or at a cloud
// metadata address, and the fetch would be made. The trust boundary being crossed is not "the user attacked
// themselves"; it is that **whatever can write a source or a watch target can make this process talk to
// anything it can reach**, and on a home machine that includes the app itself and every device on the
// network. That matters more here than in a generic app because of how many doors this one has: config
// import, a custom source added from the web page, a watch target, a notification webhook, an LLM baseUrl, a
// VDB endpoint, and the egress probe.
//
// The rule is deliberately stated as a single decision with a single implementation:
//   validateRemoteUrl(url, policy)  ->  { ok: true, url, host, addresses }
//                                   ->  { ok: false, code, reason, host }
// Every caller that fetches a user-supplied or config-supplied URL goes through it. There is **no second
// copy** of these rules to drift: the structural section of tools/integrity-check.mjs reads the inventory
// exported at the bottom of this file and fails the build if a module performs a network call without
// referencing this function, or if a second place starts spelling out the ranges itself.
//
// Three design points that were decided rather than discovered, each with its reason:
//
//   1) **A hostname is not an address.** Checking the name alone is defeated by the most ordinary thing DNS
//      does: `localhost` and any name an attacker or a rebinding service controls can answer 127.0.0.1. So
//      the name is resolved and *the answers* are checked. A mixed answer (one public address and one
//      loopback address) is refused as a whole — a resolver that returns both is either a rebinding service
//      mid-switch or a round-robin that would reach the private address on some fraction of requests, and
//      "which one did we get this time" is not a security property.
//
//   2) **A name that does not resolve is refused** (`dns-unresolved`). This is a decision, not an oversight,
//      and it is worth stating exactly why: we cannot check where a name points without resolving it, so
//      accepting an unresolved name would mean accepting an address we never inspected. The cost is
//      concrete and known — a machine behind a proxy whose *exit* resolves names, or one that is simply
//      offline, can no longer reach a host that its local resolver cannot answer for. That cost is paid
//      only on the `direct` egress (`skipDns` below), because on the proxy/Tor egress the exit node is the
//      one resolving and connecting: asking whether *this machine* can resolve is then a statement about
//      the wrong machine.
//
//   3) **`allowLoopback` is the only allowance, it is per caller, and it is off by default.** It exists
//      because the project's own traversals run a deterministic fixture on 127.0.0.1 and register it as a
//      custom source, a watch target and an LLM baseUrl, and because a *local* LLM (the Ollama preset) is a
//      documented feature the loopback rule would otherwise delete. It is not an environment variable and
//      not a config-wide switch on purpose: both of those would be one keystroke away from turning the rule
//      off for everything, while a per-entry flag can only ever admit the entry that carries it. It relaxes
//      **the loopback rule only** — a private range, link-local or metadata address is refused even when it
//      is set (`allowLoopback` is not "allow anything local"), which the test pins in both directions.
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';

// ───────────────────────────────────────────── the policy table

/**
 * The ranges that are refused, and the reason each one is on the list. Kept as data so the rule can be
 * reported to a user (see `urlPolicyTable`) instead of living only as an `if` in the middle of the check.
 */
export const URL_POLICY_TABLE = [
  {
    code: 'scheme',
    what: 'any scheme other than http / https',
    why: 'file: reads a local path with this process\u2019s rights, data: and javascript: carry no host at all so there is nothing left to check, and ftp:/gopher: are scheme-confusion material for anything that parses the URL after us. The two fetchable schemes are the only ones that can be reasoned about here.',
  },
  {
    code: 'loopback',
    what: '127.0.0.0/8, ::1, and the name localhost resolving to them',
    why: 'this process serves its own HTTP API on loopback, and that API can write to the config \u2014 an address that reaches the app itself is not a remote source, it is a handle on the machine.',
  },
  {
    code: 'private',
    what: '10/8, 172.16/12, 192.168/16, 100.64/10 (CGNAT), fc00::/7 (unique-local)',
    why: 'the LAN: routers, NAS boxes, printers and other people\u2019s machines are reachable from here, and a monitor that fetches a user-supplied URL is not a tool that should be probing them.',
  },
  {
    code: 'link-local',
    what: '169.254.0.0/16 and fe80::/10',
    why: 'link-local is where cloud metadata services live on every major provider, so it is refused as a range rather than by naming the addresses \u2014 naming hosts is how a check goes stale.',
  },
  {
    code: 'metadata',
    what: '169.254.169.254 (and 169.254.170.2, fd00:ec2::254)',
    why: 'the instance-credential endpoints. They are inside link-local and are called out separately so the log line says what was actually attempted.',
  },
  {
    code: 'unspecified',
    what: '0.0.0.0, ::, and an empty host',
    why: '0.0.0.0 is accepted by URL parsers and by some HTTP clients as "this host", so it is a way to write loopback without writing 127.0.0.1.',
  },
  {
    code: 'dns-unresolved',
    what: 'a name the resolver did not answer for — the lookup failed (NXDOMAIN, no resolver reachable, a refused query)',
    why: 'the addresses of an unresolved name were never inspected, which is the same as no check at all. See point (2) in the header for the cost this accepts and where it is not paid. This is the code for "the lookup did not complete"; a lookup that completed with an empty answer is `dns-empty` below, because the two are different things to tell a user.',
  },
  {
    code: 'dns-empty',
    what: 'a name the resolver answered with an empty address list',
    why: 'a successful lookup with no addresses is a resolver saying "yes" and then naming nowhere; treating it as resolved would skip the address check entirely. Kept distinct from `dns-unresolved` on purpose: "this name has no address" and "this name could not be looked up" are different diagnoses, and the second is the one that means the machine\'s DNS is the problem.',
  },
];

/** The reason codes, exported as data so a caller (and the test) can pin them rather than match strings. */
export const URL_POLICY_CODES = [
  'empty',
  'unparsable',
  'scheme',
  'userinfo',
  'unspecified',
  'loopback',
  'private',
  'link-local',
  'metadata',
  'zone-id',
  'dns-unresolved',
  'dns-empty',
  'dns-timeout',
  'loopback-rejected',
  'redirect-hop',
  'too-many-redirects',
  'redirect-loop',
];

/**
 * The judgement for one address literal. Pure and synchronous on purpose: this half has no I/O, so the
 * write-time check (`remoteUrlShapeProblem`) and the resolve-time check share exactly these rules.
 *
 * `allowLoopback` relaxes the loopback verdict and *only* that one: a link-local or metadata address stays
 * refused with it set, because those are not "this machine" but "the machine's credentials".
 *
 * @param {string} address an IPv4 or IPv6 literal
 * @param {{allowLoopback?:boolean}} [policy]
 * @returns {{ok:true}|{ok:false, code:string, reason:string}}
 */
export function checkAddress(address, policy = {}) {
  const kind = classifyAddress(address);
  if (kind === 'loopback') {
    if (policy.allowLoopback) return { ok: true };
    return { ok: false, code: 'loopback', reason: `the address ${address} is loopback` };
  }
  if (kind === 'metadata') return { ok: false, code: 'metadata', reason: `the address ${address} is a cloud metadata endpoint` };
  if (kind === 'link-local') return { ok: false, code: 'link-local', reason: `the address ${address} is link-local` };
  if (kind === 'private') return { ok: false, code: 'private', reason: `the address ${address} is in a private range` };
  if (kind === 'unspecified') return { ok: false, code: 'unspecified', reason: `the address ${address} is unspecified (0.0.0.0/::)` };
  return { ok: true };
}

// ───────────────────────────────────────────── address literal parsing (pure)

/** @returns {'ipv4'|'ipv6'|'name'} */
export function addressFamily(host) {
  const h = stripBrackets(host);
  if (!h) return 'name';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isIpv4(h) ? 'ipv4' : 'name';
  return h.includes(':') ? (isIpv6(h) ? 'ipv6' : 'name') : 'name';
}

function stripBrackets(host) {
  return String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
}

/**
 * Whether the text is a dotted quad. Each octet must be a decimal number in range — a leading zero is
 * accepted as decimal (NOT octal), because treating `0177.0.0.1` as octal is the classic way a filter and a
 * client come to different conclusions about the same string, and the octet form has no legitimate use in a
 * URL whose host was written by hand.
 */
function isIpv4(h) {
  const parts = h.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function isIpv6(h) {
  if (!h.includes(':')) return false;
  // "::" may appear once; the rest is 1-4 hex digits per group, with at most one IPv4 tail
  const doubleColon = h.split('::').length - 1;
  if (doubleColon > 1) return false;
  const halves = doubleColon === 1 ? h.split('::') : [h];
  let groups = 0;
  for (let i = 0; i < halves.length; i++) {
    const half = halves[i];
    if (!half) continue;
    const parts = half.split(':');
    for (let j = 0; j < parts.length; j++) {
      const p = parts[j];
      if (p === '') return false;
      if (p.includes('.')) {
        // an embedded IPv4 is only valid as the last part of the whole address
        if (i !== halves.length - 1 || j !== parts.length - 1) return false;
        if (!isIpv4(p)) return false;
        groups += 2;
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(p)) return false;
      groups += 1;
    }
  }
  return doubleColon === 1 ? groups <= 7 : groups === 8;
}

/**
 * The dotted quad of an address, so one set of range rules covers both families.
 *
 * An IPv4-mapped or IPv4-compatible IPv6 address (`::ffff:127.0.0.1`, `::127.0.0.1`) carries an IPv4
 * address, and the only safe reading of it is the IPv4 one: `::ffff:127.0.0.1` reaches the loopback
 * interface exactly as `127.0.0.1` does, so a check that only knew `::1` would be walked straight past.
 * NAT64 (`64:ff9b::/96`) is unwrapped for the same reason — the last 32 bits are the IPv4 destination.
 */
function addressBytes(h) {
  const host = stripBrackets(h);
  if (isIpv4(host)) return { ipv4: host.split('.').map(Number) };
  if (!isIpv6(host)) return null;

  // An IPv6 address may end in a dotted quad (`::ffff:127.0.0.1`). The quad is **rewritten into the two hex
  // groups it stands for** and then expanded by the ordinary `::` rule, because the alternative — splitting
  // the quad off by hand — has an off-by-one that produced a real bypass while this was being written: the
  // greedy head for `::ffff:127.0.0.1` is `::ffff`, and a hand-rolled "pad the head to six groups" step turned
  // it into 0:ffff:0:0:0:0:7f00:1, which classifies as **public**. Rewriting first means there is only one
  // expansion rule in this function, so the two forms cannot disagree.
  const embedded = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  let normalized = host;
  if (embedded) {
    const hex = (a, b) => (((Number(a) << 8) | Number(b)) >>> 0).toString(16);
    normalized = `${embedded[1]}${hex(embedded[2], embedded[3])}:${hex(embedded[4], embedded[5])}`;
  }

  let groups;
  if (normalized.includes('::')) {
    const [left, right] = normalized.split('::');
    const l = left ? left.split(':') : [];
    const r = right ? right.split(':') : [];
    groups = [...l, ...Array(Math.max(0, 8 - l.length - r.length)).fill('0'), ...r];
  } else groups = normalized.split(':');
  if (groups.length !== 8) return null;
  const words = groups.map((g) => parseInt(g || '0', 16));
  if (words.some((w) => !Number.isFinite(w))) return null;

  // IPv4-mapped (`::ffff:a.b.c.d`) and IPv4-compatible (`::a.b.c.d`, deprecated but still routable in
  // practice) both carry an IPv4 destination in the last 32 bits, and `::ffff:127.0.0.1` reaches the loopback
  // interface exactly as `127.0.0.1` does — so reading them as IPv6 would walk straight past the loopback
  // rule, and reading them as IPv4 is the only safe direction.
  //
  // `::` and `::1` are the two addresses that fit this bit pattern without being a mapped IPv4 address, and
  // they are the unspecified and loopback addresses themselves; both are classified correctly as IPv6 below.
  const isMappedOrCompatible =
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    (words[5] === 0xffff || (words[5] === 0 && !(words[6] === 0 && (words[7] === 0 || words[7] === 1))));
  if (isMappedOrCompatible) {
    return { ipv4: [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff], ipv6: host };
  }
  // NAT64 (64:ff9b::/96): the last 32 bits are the IPv4 destination, so `64:ff9b::127.0.0.1` is loopback here
  if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((w) => w === 0)) {
    return { ipv4: [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff], ipv6: host };
  }
  return { words, ipv6: host };
}

/**
 * What class an address belongs to. Returns `'public'` for anything that is none of the refused classes,
 * which is the only verdict that lets a request out.
 *
 * @param {string} address IPv4 or IPv6 literal
 * @returns {'public'|'loopback'|'private'|'link-local'|'metadata'|'unspecified'}
 */
export function classifyAddress(address) {
  const bytes = addressBytes(address);
  if (!bytes) return 'public'; // not an address literal at all; the caller resolves names separately
  if (bytes.ipv4) {
    const [a, b] = bytes.ipv4;
    if (a === 0) return 'unspecified';
    if (a === 127) return 'loopback';
    if (a === 169 && b === 254) {
      const quad = bytes.ipv4.join('.');
      // AWS/GCP/Azure share .169.254; ECS task credentials are .170.2; Alibaba Cloud is .23.9/…; Oracle is .169.254.169.254
      if (quad === '169.254.169.254' || quad === '169.254.170.2' || quad === '169.254.169.253' || (a === 169 && b === 254 && bytes.ipv4[2] === 23)) return 'metadata';
      return 'link-local';
    }
    if (a === 10) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 100 && b >= 64 && b <= 127) return 'private'; // CGNAT, and the range a Tailscale net lives in
    return 'public';
  }
  const words = bytes.words;
  const text = bytes.ipv6 ?? '';
  if (words.every((w) => w === 0)) return 'unspecified';
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return 'loopback'; // ::1
  // The metadata address is named *before* the range that contains it: fd00:ec2::254 is inside fc00::/7, and
  // reporting it as "a private range" would lose the one fact worth acting on. IPv4 has the same ordering
  // (link-local is checked, then the metadata addresses inside it).
  if (text === 'fd00:ec2::254' || text === 'fd00:ec2:0:0:0:0:0:254') return 'metadata'; // AWS IMDSv6
  if ((words[0] & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 unique-local
  if ((words[0] & 0xffc0) === 0xfe80) return 'link-local'; // fe80::/10
  return 'public';
}

// ───────────────────────────────────────────── resolution

const DEFAULT_DNS_TIMEOUT_MS = 5000;

/**
 * Names that are refused **by name**, before any resolution.
 *
 * This is not a blacklist of bad hosts (the ranges are the rule); it is the belt to the resolver's braces.
 * `localhost` reaching the loopback check already depends on the machine's hosts file being intact — and a
 * hosts file is a user-editable file that this process did not write. Checking the three names that mean "this
 * machine" by their spelling makes the verdict independent of that file. The `.localhost` suffix is included
 * because RFC 6761 reserves the whole tree for loopback, and some resolvers answer wildcards under it.
 */
const LOOPBACK_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);

/**
 * Every address a name resolves to.
 *
 * Both families are returned, and deliberately so: a name whose A record points at a public address and whose
 * AAAA record points at `::1` must be refused, and an IPv4-only query would never see the second half.
 *
 * **`dns.lookup` (the platform resolver), not `dns.Resolver`.** Measured on this machine while writing this
 * (Node 24): a fresh `dns.Resolver` has no promise-returning `resolve`, so `await resolver.resolve(name, 'A')`
 * fails with `ERR_INVALID_ARG_TYPE: The "callback" argument must be of type function` — and that error was
 * being read as "the name does not resolve", which would have refused every hostname in the product while
 * looking like a policy that works. The platform lookup is also the honest choice for this rule's purpose:
 * it is the resolution the *fetch* will use, including the hosts file, so a name mapped to 127.0.0.1 in the
 * hosts file is caught here rather than slipping past a check that consulted a different resolver than the
 * connection does.
 *
 * `all: true` is what makes both families come back in one call. There is no cancellable timeout on the
 * platform lookup, so the bound is a race — a resolver that hangs must not hang a fetch forever.
 */
async function resolveAll(host, { timeoutMs = DEFAULT_DNS_TIMEOUT_MS, dnsResolve = null } = {}) {
  const query =
    dnsResolve ??
    (async (name) => {
      const all = await dnsPromises.lookup(name, { all: true, verbatim: true });
      return all.map((r) => r?.address).filter((a) => typeof a === 'string' && a.trim());
    });
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('ETIMEOUT')), timeoutMs);
    timer.unref?.();
  });
  try {
    const answers = await Promise.race([query(host), timeout]);
    if (Array.isArray(answers)) return [...new Set(answers.map((a) => String(a).trim()).filter(Boolean))];
    if (answers && typeof answers === 'object' && typeof answers.address === 'string') return [answers.address];
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ───────────────────────────────────────────── the one entry point

/**
 * Decide whether this process may fetch `url`.
 *
 * @param {string|URL} url the address as configured or typed by the user
 * @param {{
 *   allowLoopback?: boolean,   // the only allowance (see the header); loopback only, default off
 *   skipDns?: boolean,         // the egress resolves the name, not this machine (proxy / Tor)
 *   dnsTimeoutMs?: number,
 *   dnsResolve?: Function,     // test seam: (host, 'A'|'AAAA') -> string[]
 *   dnsResolver?: object,      // test seam: a dns.Resolver-shaped object
 * }} [policy]
 * @returns {Promise<{ok:true, url:string, host:string, addresses:string[], port:string, allowLoopback:boolean}
 *                 |{ok:false, code:string, reason:string, host:string|null, message:string}>}
 *
 * On success `url` is the normalised form to fetch (`url.href`, so `HTTP://Example.COM:80/a` becomes
 * `http://example.com/a`), and `addresses` is what was checked — empty when `skipDns` was set, which is the
 * honest answer: nothing was resolved here.
 *
 * On refusal, `code` is one of URL_POLICY_CODES and is what a caller switches on; `reason` is the technical
 * sentence; `message` is the bilingual sentence to hand to the user (the project's API-error convention).
 */
export async function validateRemoteUrl(url, policy = {}) {
  const p = {
    allowLoopback: policy.allowLoopback === true,
    skipDns: policy.skipDns === true,
    dnsTimeoutMs: policy.dnsTimeoutMs,
    dnsResolve: policy.dnsResolve ?? null,
    dnsResolver: policy.dnsResolver ?? null,
  };
  const refuse = (code, reason, host = null) => ({
    ok: false,
    code,
    reason,
    host,
    message: `地址不被允许 / URL refused (${code}): ${reason}`,
  });

  const raw = typeof url === 'string' ? url.trim() : url instanceof URL ? url.href : String(url?.href ?? '').trim();
  if (!raw) return refuse('empty', '没有地址 / no URL was given');

  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    return refuse('unparsable', `无法解析为 URL / not parsable as a URL: ${JSON.stringify(raw.slice(0, 200))}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return refuse('scheme', `不接受的协议 / scheme not accepted: ${parsed.protocol.replace(':', '')}（只允许 http / https）`, parsed.hostname);
  }
  // Credentials in the URL are not checked for safety, they are refused for a different reason: this project
  // logs the addresses it fetches, and a password in the userinfo is a secret that would ride along into the
  // log. The wiki credential path (watch.js) puts its password in an Authorization header for this reason.
  if (parsed.username || parsed.password) {
    return refuse('userinfo', 'URL 里带着用户名/密码，日志会把它一起记录下来 / the URL carries userinfo, which this project would log', parsed.hostname);
  }

  const host = stripBrackets(parsed.hostname);
  if (!host) return refuse('unspecified', '没有主机名 / the URL has no host', null);

  // IPv6 **zone ids** (`[fe80::1%25eth0]`) are refused by the URL parser itself — measured:
  // `new URL('http://[fe80::1%25eth0]/')` throws, and the verdict is `unparsable`. There is therefore no
  // branch for them in this function, and one would be dead code. The synchronous half
  // (remoteUrlShapeProblem) does carry an explicit check, because a sanitiser can hand it a bare host string
  // that never went through the URL parser.
  const literal = addressFamily(host) !== 'name';
  if (!literal && (LOOPBACK_NAMES.has(host) || host.endsWith('.localhost'))) {
    if (!p.allowLoopback) return refuse('loopback', `${host} 是本机地址 / the name ${host} means this machine`, host);
  }
  if (literal) {
    const verdict = checkAddress(host, p);
    if (!verdict.ok) return refuse(verdict.code, verdict.reason, host);
    return { ok: true, url: parsed.href, host, addresses: [host], port: parsed.port, allowLoopback: p.allowLoopback };
  }

  // A name is not an address: resolve it and judge the answers (point (1) in the header).
  if (p.skipDns) {
    return { ok: true, url: parsed.href, host, addresses: [], port: parsed.port, allowLoopback: p.allowLoopback };
  }

  let addresses = [];
  try {
    addresses = await resolveAll(host, p);
  } catch (e) {
    const code = String(e?.message ?? e) === 'ETIMEOUT' ? 'dns-timeout' : 'dns-unresolved';
    return refuse(code, `无法解析 ${host} / could not resolve the name: ${e?.message ?? e}`, host);
  }
  // An answer with no addresses in it is **not** the same diagnosis as a resolver that did not answer,
  // and the two are told apart here because the user's next move differs: `dns-empty` says the name
  // exists and has no A/AAAA record to reach (a domain whose records were removed, a name only served
  // over a record type this lookup does not ask for, a filtered answer), while `dns-unresolved` says
  // the lookup itself failed (NXDOMAIN, no resolver reachable, a broken stack). The distinction is
  // available — `resolveAll` returns `[]` only for a query that *completed* with nothing in it, and
  // throws for one that failed — so the code and URL_POLICY_TABLE are made to agree on it rather than
  // declaring `dns-empty` and never returning it.
  if (!addresses.length) {
    return refuse('dns-empty', `域名解析不到地址 / the name resolves to no address: ${host}`, host);
  }

  // Every answer must pass. One bad address in a mixed answer refuses the whole name: the resolver that
  // returned it would reach the private address on some fraction of requests, and "we happened to get the
  // public one" is not a property to rely on.
  for (const addr of addresses) {
    const verdict = checkAddress(addr, p);
    if (!verdict.ok) {
      const mixed = addresses.length > 1 ? `（解析结果里有 ${addresses.length} 个地址，其中这个不合格 / one of ${addresses.length} answers）` : '';
      return refuse(verdict.code, `${host} 解析到 ${verdict.reason}${mixed}`, host);
    }
  }
  return { ok: true, url: parsed.href, host, addresses, port: parsed.port, allowLoopback: p.allowLoopback };
}

// ───────────────────────────────────────────── the write-time half

/**
 * The same rules, synchronously, for the moment a value is *stored* rather than fetched.
 *
 * Why both halves exist: refusing at fetch time is the enforcement, but a source that can never be fetched
 * sitting in the config is a setting that looks like it does something. The sanitizers already drop values
 * that can never match (see the `region` note in sources.js) for exactly this reason, so an address with a
 * refused scheme or a private literal is dropped at the door with a reason.
 *
 * DNS is deliberately **not** resolved here. A form submission must not depend on the resolver being up —
 * and more importantly, the answer at write time is not the answer at fetch time (that is the whole point of
 * rebinding), so the authoritative check stays where the connection is made.
 *
 * @returns {null|{code:string, reason:string}} null when the value is acceptable
 */
export function remoteUrlShapeProblem(url, policy = {}) {
  const raw = typeof url === 'string' ? url.trim() : url instanceof URL ? url.href : String(url?.href ?? '').trim();
  if (!raw) return null; // an empty address is "not set", which the callers already report in their own words
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    return { code: 'unparsable', reason: `not parsable as a URL: ${raw.slice(0, 120)}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { code: 'scheme', reason: `scheme not accepted: ${parsed.protocol.replace(':', '')} (http / https only)` };
  }
  if (parsed.username || parsed.password) return { code: 'userinfo', reason: 'the URL carries userinfo, which this project would log' };
  const host = stripBrackets(parsed.hostname);
  if (!host) return { code: 'unspecified', reason: 'the URL has no host' };
  // The URL parser already refuses a bracketed zone id, but this half also sees bare host strings from the
  // sanitisers, where `%` has no other meaning — and a client that strips `%eth0` reaches the address behind it.
  if (host.includes('%')) return { code: 'zone-id', reason: `the host carries an IPv6 zone id: ${host}` };
  if (addressFamily(host) === 'name') return null; // the address behind a name is only knowable at fetch time
  const verdict = checkAddress(host, policy);
  return verdict.ok ? null : { code: verdict.code, reason: verdict.reason };
}

// ───────────────────────────────────────────── the inventory the structural check reads

/**
 * Every place this process fetches a URL that a user or the config supplied, and how each one reaches the
 * policy. This is an **inventory, not documentation**: tools/integrity-check.mjs reads it to assert that
 * each named module really references `validateRemoteUrl`, and that no module under server/src performs a
 * network call while appearing in neither this list nor EXEMPT below. A caller that quietly goes back to
 * fetching on its own is the defect this list exists to catch.
 *
 * `via` says how the rule is reached: 'direct' (the module calls validateRemoteUrl itself), 'shared'
 * (it hands its URL to a module that does), or 'net.js' (it relies on netFetch, which validates every hop).
 */
export const URL_POLICY_CALLERS = [
  { file: 'server/src/net.js', what: 'the one fetch choke point: every hop of every redirect', via: 'direct' },
  { file: 'server/src/sources.js', what: 'custom sources, at the moment one is stored', via: 'direct' },
  { file: 'server/src/watch.js', what: 'watch targets (url / apiUrl), at store time and at fetch time', via: 'direct' },
  { file: 'server/src/notify.js', what: 'notification webhooks, at store time and at delivery', via: 'direct' },
  { file: 'server/src/fetchers/rss.js', what: 'an RSS/Atom source', via: 'net.js' },
  { file: 'server/src/fetchers/mediawiki.js', what: 'a MediaWiki API source', via: 'net.js' },
  { file: 'server/src/fetchers/browser.js', what: 'a browser-rendered source, including every redirect hop', via: 'direct' },
  { file: 'server/src/llm.js', what: 'the LLM endpoint (every profile, every mode)', via: 'direct' },
  { file: 'server/src/vdb.js', what: 'the VDB roster endpoint', via: 'direct' },
  { file: 'server/src/probe.js', what: 'the egress probes (TCP connect and the HTTP TTFB tier)', via: 'direct' },
  { file: 'server/src/thumbs.js', what: 'the homepage / icon / og:image fetches, and the screenshot', via: 'direct' },
  // The four below send an address that a *shared* builder assembled, which is why the policy is not called
  // inside them: one check in one place (llm.js's checkedChatRequest, net.js's fetch) is what makes "every one
  // of them" true by construction rather than by each caller remembering. They are listed anyway — the point of
  // an inventory is that a reader can see every door, and that a new door cannot be added without appearing.
  { file: 'server/src/analyze.js', what: 'the run and the preflight, over the active LLM profile', via: 'shared' },
  { file: 'server/src/features.js', what: 'feature extraction, over the active LLM profile', via: 'shared' },
  { file: 'server/src/vision.js', what: 'the vision tagger, over the active LLM profile', via: 'shared' },
  { file: 'server/src/proxyctl.js', what: 'the local proxy kernel control endpoint (Clash / mihomo external-controller)', via: 'net.js' },
];

/**
 * Network calls that are **not** user-supplied addresses, and are therefore not under the policy. Each one is
 * named with its reason; a module that appears here cannot be a bypass for a user-supplied URL, because the
 * structural check also fails any file here that reads a config or request URL without going through the
 * policy.
 */
export const URL_POLICY_EXEMPT = [
  { file: 'server/src/probe.js', what: 'TRACE_URL, a fixed constant (cloudflare.com/cdn-cgi/trace) used to learn an exit country', why: 'not user input' },
  { file: 'server/src/socks.js', what: 'check.torproject.org/api/ip, the fixed Tor reachability check', why: 'not user input' },
  { file: 'server/src/server.js', what: 'api.ipify.org in the local-proxy detection route', why: 'a fixed constant; the addresses probed are local proxy ports, not this URL' },
];

/**
 * The record of "this exact URL has already been through validateRemoteUrl, under this policy".
 *
 * Why it exists: several call sites assemble a request in one function and send it in another (llm.js builds
 * the chat URL, the caller fetches it; the watch login checker builds a request, jget sends it). The address
 * would therefore be judged twice — once where it is built, once at the choke point — and the second judgement
 * has to be told what the first one knew (the profile's allowance), or it silently applies the strict default
 * instead. Threading the allowance through every intermediate function would work, but it would make each of
 * them carry a security decision they have no opinion about.
 *
 * So the verdict travels beside the string, in this module's own map. Three properties, and each one is the
 * point of the design rather than an implementation detail:
 *   · it cannot be spelled in a config file or a request body — nothing outside this module can insert into
 *     the map, so a "cleared" URL is only ever one this module cleared;
 *   · a mark made **without** the allowance never satisfies a policy **with** it (see urlClearedFor), so a
 *     plain fetch of a loopback fixture cannot borrow a mark some other caller made;
 *   · the map is bounded, because it is keyed by an address a server could vary forever.
 *
 * It is deliberately not a property on the string: strings are primitives and cannot hold one — measured, that
 * throws `TypeError: Object.defineProperty called on non-object` — and a boxed String object would have broken
 * every comparison and every log line in the fetch path.
 */
const CLEARED = new Map();
const CLEARED_MAX = 500;

/** Record a verdict that already passed. Only ever called with a URL validateRemoteUrl accepted. */
export function markUrlCleared(url, policy = {}) {
  const value = String(url);
  if (CLEARED.size >= CLEARED_MAX) CLEARED.delete(CLEARED.keys().next().value);
  CLEARED.set(value, { allowLoopback: policy.allowLoopback === true, at: Date.now() });
  return value;
}

/** Whether a marked URL's verdict holds for the policy now being applied. */
export function urlClearedFor(url, policy = {}) {
  const mark = CLEARED.get(String(url));
  if (!mark) return false;
  // A mark made with the allowance may be used without it (the stricter reading is always available); a mark
  // made without it may never be used with it.
  return policy.allowLoopback !== true || mark.allowLoopback === true;
}

/** The policy table as printable rows, so `GET /api/config/health`-style reporting can state the rule. */
export function urlPolicyTable() {
  return URL_POLICY_TABLE.map((r) => ({ ...r }));
}
