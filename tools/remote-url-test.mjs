// ---------------------------------------------------------------------------------------------------
// remote-url-test.mjs — the one rule about which addresses this process may fetch, and every way it can
// silently stop being applied.
//
// The finding this answers (P0 #3 of the v1.0.5 security release): a source URL, a watch target, an LLM
// endpoint, a notification webhook and a VDB address are all addresses the **user or the config supplies**,
// and until now nothing looked at the scheme, the host, or where that host resolves. `sanitizeCustomSource`
// kept a field whitelist and scrubbed the id; it never asked whether the address pointed at
// `http://127.0.0.1:<the app's own port>/api/config`, at a router on the LAN, or at a cloud metadata
// endpoint. The rule that replaces it is one exported function, `validateRemoteUrl` in
// server/src/remote-url.js, and this file is its proof.
//
// Three things are being checked here, and they fail in different ways:
//
//   A. **the verdicts.** Every refused class (scheme, loopback literal, loopback by name, private ranges,
//      link-local, cloud metadata, IPv6 loopback and unique-local, a mixed A/AAAA answer, a name that does
//      not resolve) and the accepted ones. The assertion is on the *reason code*, not on the message: a
//      check that only looked at "was it refused" passes when the right verdict arrives through the wrong
//      rule, and that is not a hypothetical — writing this file found two real defects in `addressBytes`
//      where `::1` and `::ffff:127.0.0.1` were misparsed and produced plausible-but-wrong classifications.
//
//   B. **the fetch path, not just the function.** A validator nobody calls protects nothing, so the
//      decisions are also exercised through the real HTTP routes (`POST /api/sources/custom`,
//      `POST /api/probe`) and through netFetch's own redirect walk. The strongest of these is the TCP one:
//      `POST /api/probe` measures a real connection, so "the refusal happened" is observable as "the
//      fixture server was never contacted".
//
//   C. **the allowance, and that it is what does the allowing.** The project's own traversals fetch a
//      loopback fixture, and a local LLM is a documented feature, so a strict policy would delete both. The
//      allowance is a single per-entry field (`allowLoopback`), off by default. Each allowance test is
//      paired with its control — the same fixture without the field must fail — because an allowance that
//      is not shown to be load-bearing is a hole with a comment on it.
//
// **Mutations.** "Every check needs a control on a deliberately wrong input" is the project's rule, and for
// a *policy* the honest control is a mutation of the code under test: each assertion below is paired with a
// one-line change to server/src that makes it fail, declared in `MUTATIONS` at the bottom of this file.
//   · `node tools/remote-url-test.mjs`             the checks themselves (this is what verify:fast runs)
//   · `node tools/remote-url-test.mjs --mutation`   the mutation harness: for every declared mutation, apply
//     it, run the one case it must break, require that it DID break, then restore the file and check the
//     bytes are identical to the original. A mutation that fails to break its case is reported as a problem
//     of the same weight as a failing check, because it means the assertion proves nothing.
// The mutations are declared here rather than left as a list of commands in a commit message for the reason
// the project gives for the numbered integrity sections: a control that has to be remembered is a control
// that stops running. Nothing is written under the string `MUTATION` unless it is a mutation, and the word
// never appears in server/src at all (asserted at the end of this file), so `grep -c MUTATION` across the
// tree is a real check that nothing was left applied.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = (rel) => path.join(ROOT, rel);
// This file's own path, so a control run can spawn itself against a mutated copy.
const SELF = fileURLToPath(import.meta.url);

// ── harness
//
// The mutation harness runs this same file with `--only <case>` and `--quiet`, so the cases have to be
// addressable by name. Names are stable identifiers (no counts, no paths) because a mutation names the case
// it is supposed to break.
const argv = process.argv.slice(2);
const ONLY = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 ? argv[i + 1] : null;
})();
const QUIET = argv.includes('--quiet');

let pass = 0;
let fail = 0;
let skipped = 0;
const failures = [];
/**
 * The runner for the control assertions. Deliberately **not** filtered by --only: the child of a control run
 * is spawned with `--only <case>`, and if the parent's controls were filtered too, every control assertion
 * would be skipped in exactly the run that is supposed to check them — which is a harness that reports success
 * for a mutation it never tested. (Written after that happened: the first version used runCase everywhere and
 * every mutant "passed".)
 */
const runControlCase = (name, fn) => {
  flushSection();
  try {
    fn();
    pass++;
    if (!QUIET) process.stdout.write('  [ok]   ' + name + '\n');
  } catch (e) {
    fail++;
    failures.push(name + ' — ' + e.message);
    if (!QUIET) process.stdout.write('  [FAIL] ' + name + ' — ' + e.message + '\n');
  }
};
const runCase = (name, fn) => {
  if (ONLY && name !== ONLY) {
    skipped++;
    return;
  }
  flushSection();
  try {
    fn();
    pass++;
    if (!QUIET) process.stdout.write('  [ok]   ' + name + '\n');
  } catch (e) {
    fail++;
    failures.push(name + ' — ' + e.message);
    if (!QUIET) process.stdout.write('  [FAIL] ' + name + ' — ' + e.message + '\n');
  }
};
const asyncCases = [];
const runAsyncCase = (name, fn) => {
  asyncCases.push([name, fn]);
};
// Sections are named as the file is written, but the asynchronous checks are *collected* and run at the
// bottom, so printing a header where it is declared would put every header before every result. Each one is
// therefore held and flushed when the first of its results is about to print.
let pendingSection = null;
const section = (s) => {
  pendingSection = s;
};
const flushSection = () => {
  if (QUIET || !pendingSection) return;
  process.stdout.write('\n' + pendingSection + '\n');
  pendingSection = null;
};

// Under a control run, tools/lib/mutant-resolve.mjs has already pointed every server/src import at the copy,
// so this file imports normally and still gets the mutant. Nothing here needs to know a control is running.


const {
  URL_POLICY_CALLERS,
  URL_POLICY_CODES,
  URL_POLICY_EXEMPT,
  URL_POLICY_TABLE,
  checkAddress,
  classifyAddress,
  markUrlCleared,
  remoteUrlShapeProblem,
  urlClearedFor,
  validateRemoteUrl,
} = await import('../server/src/remote-url.js');
const { netFetch } = await import('../server/src/net.js');
const { sourcePolicy, sanitizeCustomSource } = await import('../server/src/sources.js');
const { sanitizeTarget } = await import('../server/src/watch.js');
const { sanitizeTarget: sanitizeNotifyTarget } = await import('../server/src/notify.js');
const { checkChatEndpoint, listModels, newProvider, presetOf, providerPolicy } = await import('../server/src/llm.js');
const { renderUrl } = await import('../server/src/fetchers/browser.js');
const { probeUrl } = await import('../server/src/probe.js');

// ── fixtures
//
// A resolver that never touches the network, so every name-shaped case is deterministic. `answers` maps a
// hostname to what it "resolves" to; a name that is not in the map throws ENOTFOUND, which is the
// "cannot resolve" case.
const resolverFor = (answers) => async (host) => {
  if (!Object.prototype.hasOwnProperty.call(answers, host)) {
    const err = new Error(`getaddrinfo ENOTFOUND ${host}`);
    err.code = 'ENOTFOUND';
    throw err;
  }
  return answers[host];
};
const PUBLIC_V4 = '93.184.216.34';
const PUBLIC_V6 = '2606:4700:10::6814:179a';

/** One assertion per refusal class, each with the reason code it must carry. */
const REFUSED = [
  ['scheme-file', 'file:///etc/passwd', {}, 'scheme'],
  ['scheme-data', 'data:text/html,<script>alert(1)</script>', {}, 'scheme'],
  ['scheme-javascript', 'javascript:fetch("/api/config")', {}, 'scheme'],
  ['scheme-ftp', 'ftp://example.com/x', {}, 'scheme'],
  ['loopback-literal', 'http://127.0.0.1:43110/api/config', {}, 'loopback'],
  ['loopback-127-range', 'http://127.9.9.9/', {}, 'loopback'],
  ['loopback-ipv6', 'http://[::1]:80/', {}, 'loopback'],
  ['loopback-mapped-v6', 'http://[::ffff:127.0.0.1]/', {}, 'loopback'],
  ['loopback-by-name', 'http://localhost:8080/feed.xml', { dnsResolve: resolverFor({ localhost: ['127.0.0.1', '::1'] }) }, 'loopback'],
  ['loopback-name-suffix', 'http://api.localhost/', { dnsResolve: resolverFor({ 'api.localhost': ['127.0.0.1'] }) }, 'loopback'],
  ['loopback-by-dns', 'http://feed.example.test/', { dnsResolve: resolverFor({ 'feed.example.test': ['127.0.0.1'] }) }, 'loopback'],
  ['private-10', 'http://10.0.0.5/', {}, 'private'],
  ['private-172', 'http://172.20.3.4/', {}, 'private'],
  ['private-192', 'http://192.168.31.1/', {}, 'private'],
  ['private-cgnat', 'http://100.100.1.1/', {}, 'private'],
  ['private-ipv6-ula', 'http://[fd00::1]/', {}, 'private'],
  ['private-by-dns', 'http://router.example.test/', { dnsResolve: resolverFor({ 'router.example.test': ['192.168.1.1'] }) }, 'private'],
  ['link-local-v4', 'http://169.254.1.1/', {}, 'link-local'],
  ['link-local-v6', 'http://[fe80::1]/', {}, 'link-local'],
  ['metadata-aws', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/', {}, 'metadata'],
  ['metadata-ecs', 'http://169.254.170.2/v2/credentials', {}, 'metadata'],
  ['metadata-ipv6', 'http://[fd00:ec2::254]/', {}, 'metadata'],
  ['metadata-by-dns', 'http://imds.example.test/', { dnsResolve: resolverFor({ 'imds.example.test': ['169.254.169.254'] }) }, 'metadata'],
  ['unspecified-v4', 'http://0.0.0.0:8080/', {}, 'unspecified'],
  ['unspecified-v6', 'http://[::]/', {}, 'unspecified'],
  ['userinfo', 'https://user:secret@example.com/', {}, 'userinfo'],
  ['unparsable', 'not a url at all', {}, 'unparsable'],
  ['empty', '   ', {}, 'empty'],
  ['unresolved', 'http://nope.example.test/', { dnsResolve: resolverFor({}) }, 'dns-unresolved'],
  // The distinction this row pins, and the reason it is two rows rather than one: `resolverFor({})` above
  // *throws* (ENOTFOUND), which is a lookup that failed, while the resolver here **answers with an empty
  // list** - a domain that exists and has no address to reach. Both are refused, and what must not happen
  // is the two collapsing into one code: `dns-empty` was declared in URL_POLICY_TABLE and never returned,
  // so a user with a filtered or record-less name was told their DNS was broken.
  ['dns-empty-answer', 'http://empty.example.test/', { dnsResolve: async () => [] }, 'dns-empty'],
];

/** The same policy, and the addresses that must come out of it allowed. */
const ACCEPTED = [
  // Every row injects its resolver. The first version of this table left `example.com` to the machine's
  // own resolver, which made three of these checks - and the control below - assertions about whatever
  // DNS the runner happens to have: measured with a resolver that answers nothing, all four fail with
  // `dns-unresolved`. The policy's verdict is what is under test here; the real `dns.lookup` path has
  // its own case further down, where the prerequisite it needs is measured before it is asserted.
  ['accept-public-https', 'https://example.com/feed.xml', { dnsResolve: resolverFor({ 'example.com': [PUBLIC_V4, PUBLIC_V6] }) }, 'example.com'],
  ['accept-public-http', 'http://example.com:8080/a?b=c', { dnsResolve: resolverFor({ 'example.com': [PUBLIC_V4] }) }, 'example.com'],
  ['accept-ipv4-literal', 'http://93.184.216.34/', {}, '93.184.216.34'],
  ['accept-ipv6-literal', 'http://[2606:4700:10::6814:179a]/', {}, '2606:4700:10::6814:179a'],
  ['accept-name-resolving-public', 'http://feed.example.test/x', { dnsResolve: resolverFor({ 'feed.example.test': [PUBLIC_V4, PUBLIC_V6] }) }, 'feed.example.test'],
  ['accept-normalises', 'HTTP://Example.COM:80/a/../b', { dnsResolve: resolverFor({ 'example.com': [PUBLIC_V4] }) }, 'example.com'],
];

// ── the servers the end-to-end cases talk to

const servers = [];
const serve = async (handler) => {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return { server: s, port: s.address().port, url: `http://127.0.0.1:${s.address().port}` };
};
const closeAll = () => {
  for (const s of servers) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
};

// A fixture that records every request it receives, so "the refusal happened before the connection" is an
// observable fact rather than an inference from the error text.
const hits = [];
const fixture = await serve((req, res) => {
  hits.push(req.url);
  if (req.url === '/redir-loopback') {
    res.writeHead(302, { location: `http://127.0.0.1:${req.socket.localPort}/blocked` });
    return res.end();
  }
  if (req.url === '/redir-relative') {
    res.writeHead(302, { location: '/final' });
    return res.end();
  }
  if (req.url === '/redir-self') {
    res.writeHead(302, { location: '/redir-self' });
    return res.end();
  }
  if (req.url === '/redir-feed') {
    res.writeHead(301, { location: '/final' });
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`at ${req.url}`);
});

// ───────────────────────────────────────────── A. the verdicts

section('A. one function, every refused class, and the reason code it refuses with');

for (const [name, url, policy, code] of REFUSED) {
  runAsyncCase(`refuses ${name} as ${code}`, async () => {
    const r = await validateRemoteUrl(url, policy);
    assert.equal(r.ok, false, `expected a refusal: ${JSON.stringify(r)}`);
    assert.equal(r.code, code, `wrong reason: ${r.code} (${r.reason})`);
    assert.ok(r.message.includes(code), 'the refusal must carry its code for the caller: ' + r.message);
  });
}
// The control for the whole table: the same assertions against the *accepting* policy must not hold. If
// validateRemoteUrl answered "ok:false" for everything, every row above would still pass — this is the case
// that fails when it does. Its resolver is injected for the same reason the rows' are: a control that
// depends on this machine's DNS is a control that reports the machine, not the policy.
runAsyncCase('control: the refusals are verdicts, not a function that always refuses', async () => {
  const r = await validateRemoteUrl('https://example.com/feed.xml', {
    dnsResolve: resolverFor({ 'example.com': [PUBLIC_V4, PUBLIC_V6] }),
  });
  assert.equal(r.ok, true, `a plain public https URL must be accepted: ${JSON.stringify(r)}`);
});
runAsyncCase('every reason code in the table is reachable data', () => {
  const declared = new Set(URL_POLICY_TABLE.map((r) => r.code));
  for (const r of URL_POLICY_TABLE) {
    assert.ok(r.what && r.why, `the policy table row ${r.code} must say what and why`);
  }
  // The codes the validator can answer with are declared, and the table documents the classes it refuses.
  for (const code of ['scheme', 'loopback', 'private', 'link-local', 'metadata', 'unspecified']) {
    assert.ok(declared.has(code), `the policy table no longer documents ${code}`);
  }
  for (const code of URL_POLICY_CODES) assert.ok(typeof code === 'string' && code.length > 2, 'bad code: ' + code);
});

section('B. the name is not the address');
runAsyncCase('a mixed A/AAAA answer is refused as a whole (not "we got the public one")', async () => {
  const r = await validateRemoteUrl('http://mixed.example.test/', {
    dnsResolve: resolverFor({ 'mixed.example.test': [PUBLIC_V4, '::1'] }),
  });
  assert.equal(r.ok, false, 'a name that answers both a public and a loopback address must be refused');
  assert.equal(r.code, 'loopback');
  assert.ok(r.reason.includes('2'), 'the reason should say the answer was mixed: ' + r.reason);
});
runAsyncCase('control: the same resolver with only public answers is accepted', async () => {
  const r = await validateRemoteUrl('http://mixed.example.test/', {
    dnsResolve: resolverFor({ 'mixed.example.test': [PUBLIC_V4, PUBLIC_V6] }),
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.addresses, [PUBLIC_V4, PUBLIC_V6], 'the checked addresses are reported back');
});

for (const [name, url, policy, host] of ACCEPTED) {
  runAsyncCase(`accepts ${name}`, async () => {
    const r = await validateRemoteUrl(url, policy);
    assert.equal(r.ok, true, `expected acceptance: ${JSON.stringify(r)}`);
    assert.equal(r.host, host);
    assert.ok(r.url.startsWith('http'), 'a normalised URL that is still fetchable: ' + r.url);
  });
}

// ── the one case whose prerequisite is this machine's resolver
//
// Every other name-shaped case injects its resolver, on purpose: the policy's verdicts are the subject,
// and a verdict that flips with the runner's DNS is not a verdict. The real `dns.lookup` path still has
// to be exercised once — it is what the product uses on the `direct` egress, and it is the half that a
// `dns.Resolver` mistake silently broke (see the note beside `resolveAll`) — so it is asserted here with
// its prerequisite **measured first**: the prerequisite is "this machine resolves the name, and every
// answer is a public address". When it is absent (no resolver, an offline box, a hosts entry or a
// transparent proxy in the way) that is an environment statement — the cost the policy's header point
// (2) accepts — rather than a failing check.
const dnsPromises = (await import('node:dns/promises')).default;
// Bounded exactly the way the policy bounds its own lookup (a resolver that hangs must not hang a
// fetch, and it must not hang this file either): a race against a timer that does not hold the process
// open. The answer carries *why* it is empty, because that sentence is what the environment statement
// prints - "could not resolve" and "the resolver never answered" are different facts about a machine.
const DNS_PROBE_TIMEOUT_MS = 5000;
const lookupHere = (name) => {
  const timedOut = { addresses: [], why: `the resolver did not answer for ${name} within ${DNS_PROBE_TIMEOUT_MS} ms` };
  return Promise.race([
    dnsPromises
      .lookup(name, { all: true, verbatim: true })
      .then((all) => ({
        addresses: [...new Set(all.map((a) => a?.address).filter((a) => typeof a === 'string' && a.trim()))],
        why: null,
      }))
      .catch((e) => ({ addresses: [], why: `${name} did not resolve here (${e?.code ?? e?.message ?? e})` })),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(timedOut), DNS_PROBE_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]);
};
const resolvedHere = await lookupHere('example.com');
// RFC 6761 reserves `.invalid`, so no conformant resolver answers it - which is what makes it usable as
// the control below. A wildcard resolver is measured rather than assumed, because that is the one way
// the control would be reporting the resolver instead of the policy.
const invalidHere = await lookupHere('nothing-here.invalid');
runAsyncCase('the platform resolver decides when none is injected (an environment statement when there is none)', async () => {
  const { addresses, why } = resolvedHere;
  const allPublic = addresses.length > 0 && addresses.every((a) => classifyAddress(a) === 'public');
  if (!allPublic) {
    process.stdout.write(
      `         this machine ${addresses.length ? 'answers example.com with ' + addresses.join(', ') : why},\n` +
        '         so the platform-resolver case is a statement about the environment rather than a failure\n' +
        '         (the injected rows above are what tests the policy itself)\n',
    );
    return;
  }
  const r = await validateRemoteUrl('https://example.com/feed.xml');
  assert.equal(r.ok, true, `this machine resolves example.com to ${addresses.join(', ')}, so the policy must accept it: ${JSON.stringify(r)}`);
  assert.equal(r.host, 'example.com');
  assert.ok(r.addresses.length >= 1, 'the check must report the addresses it resolved: ' + JSON.stringify(r.addresses));
  for (const a of r.addresses) assert.ok(addresses.includes(a), `an address the resolver never answered with was checked: ${a}`);
});
// ...and its control, which is what makes the case above a verdict rather than a constant: the same
// call, with no injected resolver, against a name that cannot resolve must be refused as unresolvable.
runAsyncCase('control: a name that cannot resolve is refused when the platform resolver answers', async () => {
  if (invalidHere.addresses.length) {
    process.stdout.write(
      `         this resolver answers .invalid with ${invalidHere.addresses.join(', ')} (a wildcard resolver), so the\n` +
        '         control has no unresolvable name to use here and says so instead of reporting the resolver\n',
    );
    return;
  }
  const r = await validateRemoteUrl('https://nothing-here.invalid/feed.xml');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'dns-unresolved', `refused for the wrong reason: ${r.code} (${r.reason})`);
});
runAsyncCase('a refusal never throws — the caller gets a value it can report', async () => {
  const r = await validateRemoteUrl('http://169.254.169.254/');
  assert.equal(typeof r.message, 'string');
  assert.ok(r.message.includes('169.254.169.254'), 'the refusal names the address it refused: ' + r.message);
});
runAsyncCase('an allowance does not relax anything but loopback', async () => {
  const allow = { allowLoopback: true };
  for (const [url, code] of [
    ['http://10.1.1.1/', 'private'],
    ['http://192.168.0.1/', 'private'],
    ['http://169.254.169.254/', 'metadata'],
    ['http://169.254.1.1/', 'link-local'],
    ['file:///etc/passwd', 'scheme'],
  ]) {
    const r = await validateRemoteUrl(url, allow);
    assert.equal(r.ok, false, `allowLoopback must not admit ${url}`);
    assert.equal(r.code, code, `${url} should still be refused as ${code}`);
  }
});

section('C. skipDns says "the exit resolves this, not this machine", and nothing else');
runAsyncCase('skipDns admits a name that this machine cannot resolve, and reports no addresses', async () => {
  const r = await validateRemoteUrl('http://nope.example.test/', { skipDns: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.addresses, [], 'nothing was resolved here, and the result says so');
});
runAsyncCase('control: skipDns does not admit a refused address literal', async () => {
  const r = await validateRemoteUrl('http://127.0.0.1:1/', { skipDns: true });
  assert.equal(r.ok, false, 'a literal address needs no resolver, so skipDns cannot excuse it');
  assert.equal(r.code, 'loopback');
});

section('D. the address classes, one function (the write-time half shares them)');
runAsyncCase('classifyAddress pins every class, with the metadata addresses named inside their ranges', () => {
  const want = {
    '127.0.0.1': 'loopback',
    '127.255.255.254': 'loopback',
    '10.1.2.3': 'private',
    '172.16.0.1': 'private',
    '172.31.255.255': 'private',
    '172.32.0.1': 'public',
    '192.168.1.1': 'private',
    '100.64.0.1': 'private',
    '100.128.0.1': 'public',
    '169.254.169.254': 'metadata',
    '169.254.170.2': 'metadata',
    '169.254.1.1': 'link-local',
    '0.0.0.0': 'unspecified',
    '93.184.216.34': 'public',
    '::1': 'loopback',
    '::': 'unspecified',
    '::ffff:127.0.0.1': 'loopback',
    '::ffff:8.8.8.8': 'public',
    '::127.0.0.1': 'loopback',
    'fd00::1': 'private',
    'fd00:ec2::254': 'metadata',
    'fe80::1': 'link-local',
    '2001:db8::1': 'public',
    '64:ff9b::127.0.0.1': 'loopback',
  };
  for (const [addr, klass] of Object.entries(want)) {
    assert.equal(classifyAddress(addr), klass, `classifyAddress(${addr})`);
  }
});
runAsyncCase('checkAddress is the same judgement the validator uses, and honours the allowance', () => {
  assert.equal(checkAddress('127.0.0.1').ok, false);
  assert.equal(checkAddress('127.0.0.1').code, 'loopback');
  assert.equal(checkAddress('127.0.0.1', { allowLoopback: true }).ok, true);
  assert.equal(checkAddress('169.254.169.254', { allowLoopback: true }).ok, false);
});
runAsyncCase('the write-time half refuses a scheme and a literal, and lets a name through to fetch time', () => {
  assert.equal(remoteUrlShapeProblem('https://example.com/x'), null);
  assert.equal(remoteUrlShapeProblem('file:///etc/passwd').code, 'scheme');
  assert.equal(remoteUrlShapeProblem('http://127.0.0.1/').code, 'loopback');
  assert.equal(remoteUrlShapeProblem('http://127.0.0.1/', { allowLoopback: true }), null);
  assert.equal(remoteUrlShapeProblem('http://192.168.1.1/').code, 'private');
  assert.equal(remoteUrlShapeProblem('https://user:pw@example.com/').code, 'userinfo');
  // A name is not judged here on purpose: its address is only knowable where it is resolved, and the answer
  // at write time is not the answer at fetch time (that is what rebinding is).
  assert.equal(remoteUrlShapeProblem('http://feed.example.test/'), null);
  assert.equal(remoteUrlShapeProblem(''), null, 'an empty address is "not set", which callers report themselves');
});

// ───────────────────────────────────────────── E. the config write path

section('E. the sanitisers drop what can never be fetched, at the door');
runCase('a custom source with a refused scheme is stored without an address, with the reason', () => {
  const s = sanitizeCustomSource({ id: 'x', url: 'file:///etc/passwd', name: 'x' });
  assert.equal(s.urlProblem?.code, 'scheme', JSON.stringify(s));
  assert.equal(s.url, 'file:///etc/passwd', 'the value is kept so the person can see what they typed');
});
runCase('a custom source pointing at a private literal says so', () => {
  const s = sanitizeCustomSource({ id: 'x', url: 'http://192.168.1.1/admin', name: 'x' });
  assert.equal(s.urlProblem?.code, 'private', JSON.stringify(s));
});
runCase('control: a plain public source carries no problem', () => {
  const s = sanitizeCustomSource({ id: 'x', url: 'https://example.com/feed.xml', name: 'x' });
  assert.equal(s.urlProblem, undefined, JSON.stringify(s));
  assert.equal(s.allowLoopback, undefined, 'the allowance is absent unless it was written');
});
runCase('the loopback allowance is a boolean, and a string "false" does not turn it on', () => {
  const on = sanitizeCustomSource({ id: 'x', url: 'http://127.0.0.1:9/feed.xml', name: 'x', allowLoopback: true });
  assert.equal(on.allowLoopback, true);
  assert.equal(on.urlProblem, undefined, 'with the allowance the fixture address is acceptable at the door');
  const off = sanitizeCustomSource({ id: 'y', url: 'http://127.0.0.1:9/feed.xml', name: 'y', allowLoopback: 'false' });
  assert.equal(off.allowLoopback, false);
  assert.equal(off.urlProblem?.code, 'loopback', 'and the refused address is recorded as refused');
});
runCase('sourcePolicy reads the allowance from the entry and nowhere else', () => {
  assert.deepEqual(sourcePolicy({}), { allowLoopback: false });
  assert.deepEqual(sourcePolicy({ allowLoopback: true }), { allowLoopback: true });
  // A truthy value that is not `true` is not an allowance.
  assert.deepEqual(sourcePolicy({ allowLoopback: 1 }), { allowLoopback: false });
});
runCase('a watch target and a notify target carry the same one field', () => {
  const w = sanitizeTarget({ kind: 'url', url: 'http://10.0.0.9/', allowLoopback: true });
  assert.equal(w.allowLoopback, true);
  assert.equal(w.urlProblem?.code, 'private', 'the allowance is loopback-only, so a private literal is still refused');
  const n = sanitizeNotifyTarget({ kind: 'custom', webhookUrl: 'http://127.0.0.1:9/hook' });
  assert.equal(n.urlProblem?.code, 'loopback', JSON.stringify(n));
  const n2 = sanitizeNotifyTarget({ kind: 'custom', webhookUrl: 'http://127.0.0.1:9/hook', allowLoopback: true });
  assert.equal(n2.urlProblem, undefined);
});
runCase('providerPolicy reads the stored profile when a transient one is handed in', () => {
  const cfg = { llm: { providers: [{ id: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', allowLoopback: true }] } };
  assert.deepEqual(providerPolicy({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' }, cfg), { allowLoopback: true });
  assert.deepEqual(providerPolicy({ id: 'other', baseUrl: 'http://127.0.0.1:11434/v1' }, cfg), { allowLoopback: false });
  assert.deepEqual(providerPolicy({}, null), { allowLoopback: false });
});

section('E2. the shipped Ollama preset works out of the box, and nothing else gains the allowance');

// The product decision this block pins: PRESETS' ollama entry carries `allowLoopback: true`, because a local
// model server is on loopback by design and that address is ours rather than something a user typed. Three
// assertions, and the middle one is the **control**: if the flag were being applied globally rather than per
// entry, the control would pass and this block would be asserting nothing.
runAsyncCase('1. the Ollama preset profile is accepted on address grounds, and its flag reaches the profile', async () => {
  const ollama = presetOf('ollama');
  assert.equal(ollama?.allowLoopback, true, 'the shipped preset must carry the allowance');
  // Built the way the product builds one, so a preset field that fails to reach the profile fails here rather
  // than silently: newProvider copies fields explicitly (see the note beside `local: true`).
  const profile = newProvider('ollama');
  assert.equal(profile.allowLoopback, true, 'newProvider must carry the preset allowance onto the profile');
  assert.equal(profile.baseUrl, ollama.baseUrl);
  // The endpoint check is where a shipped profile is judged when someone presses "test connectivity".
  const accepted = await checkChatEndpoint(profile, { llm: { providers: [profile] } });
  assert.equal(accepted.ok, true, `the Ollama preset must not be refused: ${accepted.error ?? ''}`);
  // No other preset gains it: the flag is per entry, not per table.
  assert.equal(presetOf('deepseek').allowLoopback, undefined, 'no other preset may carry the allowance');
  assert.equal(newProvider('deepseek').allowLoopback, undefined);
  assert.equal(newProvider('custom').allowLoopback, undefined);
});
runAsyncCase('2. CONTROL: a user-typed loopback profile without the flag is still refused', async () => {
  // Deliberately not the Ollama preset and carrying no flag: exactly the shape a person types. If the allowance
  // were global — or if providerPolicy read the preset table instead of the profile — this would be accepted and
  // the assertion below would fail, which is what makes it the control for assertion 1.
  const typed = { id: 'typed-by-a-person', name: 'my local server', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'k', model: 'm' };
  assert.equal(typed.allowLoopback, undefined, 'the control profile must not carry the flag');
  const check = await checkChatEndpoint(typed, { llm: { providers: [typed] } });
  assert.equal(check.ok, false, 'a typed loopback profile must be refused');
  assert.equal(check.code, 'loopback', `refused for the wrong reason: ${check.code} (${check.error})`);
  // ...and the only difference from assertion 1 is the flag: same address, same policy, one field.
  const withFlag = { ...typed, allowLoopback: true };
  const okNow = await checkChatEndpoint(withFlag, { llm: { providers: [withFlag] } });
  assert.equal(okNow.ok, true, 'the same profile with the flag is accepted');
});
runAsyncCase('3. the flag relaxes loopback only: private / link-local / metadata stay refused', async () => {
  for (const [baseUrl, code] of [
    ['http://192.168.31.1/v1', 'private'],
    ['http://10.0.0.9:8080/v1', 'private'],
    ['http://169.254.1.1/v1', 'link-local'],
    ['http://169.254.169.254/latest/meta-data', 'metadata'],
    ['http://[fd00::1]/v1', 'private'],
    ['file:///etc/passwd', 'scheme'],
  ]) {
    const profile = { id: 'p', baseUrl, apiKey: 'k', model: 'm', allowLoopback: true };
    const check = await checkChatEndpoint(profile, { llm: { providers: [profile] } });
    assert.equal(check.ok, false, `allowLoopback must not admit ${baseUrl}`);
    assert.equal(check.code, code, `${baseUrl} should still be refused as ${code}, got ${check.code}`);
  }
});
runAsyncCase('the allowance is what lets the shipped preset through: a real request reaches a local server', async () => {
  // The end-to-end half of assertion 1 — a local OpenAI-compatible server is what Ollama is — paired with the
  // unflagged control against the same server. That pair is what makes "the flag is load-bearing" an
  // observation instead of a claim.
  hits.length = 0;
  const s = await serve((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen2.5:14b' }] }));
  });
  const presetProfile = { ...newProvider('ollama'), baseUrl: `${s.url}/v1`, apiKey: 'k' };
  const listed = await listModels({ llm: { providers: [presetProfile] } }, presetProfile);
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.deepEqual(listed.models, ['qwen2.5:14b']);
  assert.deepEqual(hits, ['/v1/models'], 'the flagged profile reached the local server');

  hits.length = 0;
  const typedProfile = { id: 'typed', baseUrl: `${s.url}/v1`, apiKey: 'k', model: 'm' };
  const refused = await listModels({ llm: { providers: [typedProfile] } }, typedProfile);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'loopback', JSON.stringify(refused));
  assert.deepEqual(hits, [], 'the unflagged profile never reached it');
});

// ───────────────────────────────────────────── F. redirects, hop by hop

section('F. a redirect is a new address, so it is checked again');
runAsyncCase('the default refuses a chain whose first hop is loopback (control for the two below)', async () => {
  hits.length = 0;
  await assert.rejects(
    () => netFetch(`${fixture.url}/redir-relative`, {}, { cfg: { proxy: { enabled: false } } }),
    (e) => e.code === 'loopback',
  );
  assert.deepEqual(hits, [], 'the refused address was never contacted');
});
runAsyncCase('with the allowance the same chain is followed, and both hops are recorded', async () => {
  hits.length = 0;
  const r = await netFetch(
    `${fixture.url}/redir-relative`,
    {},
    { cfg: { proxy: { enabled: false } }, policy: { allowLoopback: true } },
  );
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'at /final');
  assert.deepEqual(hits, ['/redir-relative', '/final'], 'netFetch follows the chain itself, one request per hop');
});
runAsyncCase('redirect:false hands the 3xx back untouched (so a caller can stop at a hop boundary)', async () => {
  hits.length = 0;
  const r = await netFetch(
    `${fixture.url}/redir-relative`,
    {},
    { cfg: { proxy: { enabled: false } }, policy: { allowLoopback: true }, redirect: false },
  );
  assert.equal(r.status, 302, 'the caller sees the redirect, not its target');
  assert.deepEqual(hits, ['/redir-relative'], 'and no second request is made');
});
runAsyncCase('a hop to a *different* refused address is refused at that hop, not at the start', async () => {
  // The start address passes (it is the allowed fixture); the Location header points at a private address.
  hits.length = 0;
  const target = `http://10.11.12.13:${fixture.port}/blocked`;
  const s = await serve((req, res) => {
    hits.push(req.url);
    res.writeHead(302, { location: target });
    res.end();
  });
  await assert.rejects(
    () => netFetch(`${s.url}/redir-private`, {}, { cfg: { proxy: { enabled: false } }, policy: { allowLoopback: true } }),
    (e) => {
      assert.equal(e.code, 'private', 'the refusal must name the hop, not the first address: ' + e.message);
      assert.equal(e.hop, 1, 'and it must say which hop it was: ' + e.hop);
      return true;
    },
  );
  assert.deepEqual(hits, ['/redir-private'], 'only the first hop was ever requested');
});
runAsyncCase('control: the same shape with a public hop address is followed to the end', async () => {
  // The control for the case above has to change the *hop target*, not the mechanism: a /final hop that is
  // refused would prove nothing. Here the hop target is the allowed fixture itself, and the chain completes.
  hits.length = 0;
  const r = await netFetch(
    `${fixture.url}/redir-feed`,
    {},
    { cfg: { proxy: { enabled: false } }, policy: { allowLoopback: true } },
  );
  assert.equal(await r.text(), 'at /final');
  assert.deepEqual(hits, ['/redir-feed', '/final']);
});
runAsyncCase('a redirect that points at itself is refused as a loop instead of spinning', async () => {
  await assert.rejects(
    () => netFetch(`${fixture.url}/redir-self`, {}, { cfg: { proxy: { enabled: false } }, policy: { allowLoopback: true } }),
    (e) => e.code === 'redirect-loop',
  );
});
runAsyncCase('a marked URL is honoured for the first hop, and the mark cannot be forged from outside', async () => {
  // The mark is what lets llm.js hand its checked address to netFetch; the property is set by remote-url.js
  // only, so a string that merely *looks* allowed is not.
  const allowed = markUrlCleared(`${fixture.url}/final`, { allowLoopback: true });
  assert.equal(urlClearedFor(allowed, { allowLoopback: true }), true);
  assert.equal(urlClearedFor(allowed, {}), true, 'a stricter policy may always re-use a permissive verdict');
  const strict = markUrlCleared(`${fixture.url}/final`, {});
  assert.equal(urlClearedFor(strict, { allowLoopback: true }), false, 'a strict verdict must not satisfy a permissive policy');
  assert.equal(urlClearedFor(`${fixture.url}/final`, { allowLoopback: true }), false, 'an unmarked string is not cleared');
  // ...and it is not a property on the string, so nothing about the URL's textual form carries it.
  assert.equal(Object.getOwnPropertySymbols(allowed).length, 0, 'no visible marker on the string');
});

// ───────────────────────────────────────────── G. the callers

section('G. every caller goes through the one function');
runCase('the inventory names real files, and each one references the policy', () => {
  const src = (rel) => fs.readFileSync(SRC(rel), 'utf8');
  for (const row of URL_POLICY_CALLERS) {
    assert.ok(fs.existsSync(SRC(row.file)), `the inventory names a file that does not exist: ${row.file}`);
    assert.ok(row.what && row.via, `the inventory row for ${row.file} must say what and how`);
    const text = src(row.file);
    // The same four routes tools/integrity-check.mjs (section 5l) reads: a module either calls the policy
    // itself, or sends through netFetch (which validates every hop), or uses the shared request builder that
    // does the checking for it, or reads a policy object out of an entry.
    const okByRoute = {
      direct: text.includes('validateRemoteUrl') || text.includes('remoteUrlShapeProblem'),
      'net.js': /netFetch\(/.test(text),
      shared: /checkedChatRequest\(/.test(text),
      'policy-shape': /ProviderPolicy\(|sourcePolicy\(|targetPolicy\(|notifyPolicy\(|thumbPolicy\(|providerPolicy\(/.test(text),
    }[row.via];
    assert.ok(okByRoute === true, `${row.file} does not reach the URL policy by the route it declares (via=${row.via})`);
  }
  for (const row of URL_POLICY_EXEMPT) {
    assert.ok(fs.existsSync(SRC(row.file)), `the exempt list names a file that does not exist: ${row.file}`);
    assert.ok(row.why, `an exemption must carry its reason: ${row.file}`);
  }
});
runCase('no module fetches a user-supplied URL without the policy (the structural rule, in miniature)', () => {
  // The full version lives in tools/integrity-check.mjs (section 5l), which scans every file under server/src.
  // This is the same rule stated where the policy is tested, so a reader of this file sees it.
  const named = new Set([
    ...URL_POLICY_CALLERS,
    ...URL_POLICY_EXEMPT,
    // Modules that fetch an address a shared builder assembled: the policy runs inside the builder
    // (llm.js's checkedChatRequest), which is what makes "every one of them" true by construction rather than
    // by each caller remembering. proxyctl.js talks to a loopback control endpoint this app does not choose.
    { file: 'server/src/analyze.js' },
    { file: 'server/src/features.js' },
    { file: 'server/src/vision.js' },
    { file: 'server/src/proxyctl.js' },
  ].map((r) => (typeof r === 'string' ? r : r.file)));
  const dir = SRC('server/src');
  const walk = (d) =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) return walk(p);
      return e.name.endsWith('.js') ? [p] : [];
    });
  const offenders = [];
  for (const file of walk(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/netFetch\(|fetch\(/.test(text)) continue;
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (named.has(rel)) continue;
    offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'these files fetch and are in neither list: ' + offenders.join(', '));
});
runCase('the browser fetcher checks every hop, and the check is not removable by accident', () => {
  // Why this is an assertion rather than a comment: the route handler is the *only* place the browser path can
  // be policed (a browser resolves and follows redirects itself), and deleting three lines of it would leave
  // every other check in this file green. So its presence is pinned structurally.
  for (const rel of ['server/src/fetchers/browser.js', 'server/src/thumbs.js']) {
    const text = fs.readFileSync(SRC(rel), 'utf8');
    assert.ok(/page\.route\(/.test(text), `${rel} no longer intercepts the browser's requests`);
    assert.ok(/validateRemoteUrl\(/.test(text), `${rel} no longer checks the address it renders`);
  }
});

// ───────────────────────────────────────────── H. the routes (end to end)

section('H. through the real HTTP surface');
process.env.VML_CONFIG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vml-remote-url-')), 'config.json');
const { createApp } = await import('../server/src/server.js');
const { loadConfig, mergeDefaults } = await import('../server/src/config.js');
// VML_CONFIG_PATH was pointed at a temporary directory above, so this is a first run with defaults.
let appCfg = loadConfig();
const app = createApp({
  getConfig: () => appCfg,
  setConfig: (next) => {
    appCfg = mergeDefaults(next);
    return appCfg;
  },
  log: { info() {}, warn() {}, error() {}, debug() {} },
  onConfigChanged: () => {},
});
const api = await serve((req, res) => app(req, res));
const call = async (method, p, body) => {
  const r = await fetch(`${api.url}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
};

runAsyncCase('the probe route refuses a loopback URL by default (and never contacts it)', async () => {
  hits.length = 0;
  const r = await call('POST', '/api/probe', { url: `${fixture.url}/probe-me`, samples: 1, modes: ['direct'] });
  assert.equal(r.status, 200);
  assert.equal(r.json.results?.[0]?.error?.includes('loopback'), true, JSON.stringify(r.json).slice(0, 200));
  assert.deepEqual(hits, [], 'the TCP tier must not have opened a socket to the refused address');
});
runAsyncCase('the probe route contacts the same URL once the entry carries the allowance', async () => {
  hits.length = 0;
  // A saved custom source is the only way an allowance reaches the probe, which is the point: it is per entry.
  const saved = await call('POST', '/api/sources/custom', {
    id: 'probe-fixture',
    name: 'probe fixture',
    url: `${fixture.url}/probe-me`,
    fetch: 'rss',
    allowLoopback: true,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json).slice(0, 200));
  const r = await call('POST', '/api/probe', { id: 'probe-fixture', samples: 1, modes: ['direct'] });
  const direct = r.json.results?.[0]?.modes?.direct;
  assert.equal(direct?.ok, true, JSON.stringify(r.json).slice(0, 300));
  assert.equal(direct?.method, 'tcp-connect');
  assert.equal(r.json.results?.[0]?.error, undefined, 'no refusal should be reported for an allowed entry');
});
runAsyncCase('a custom source added with a public address is stored without a problem marker', async () => {
  const r = await call('POST', '/api/sources/custom', { id: 'public-one', name: 'public', url: 'https://example.com/feed.xml', fetch: 'rss' });
  assert.equal(r.status, 200);
  const stored = (r.json.sources ?? []).find((s) => s.id === 'public-one');
  assert.equal(stored?.urlProblem, undefined, JSON.stringify(stored).slice(0, 200));
});

// ───────────────────────────────────────────── I. the browser path, without a browser

section('I. the browser path refuses before it launches anything');
runAsyncCase('renderUrl refuses a loopback source when the source does not carry the allowance', async () => {
  // No browser is ever started: the refusal happens before the launch, which is also why this case can run in
  // a checkout with no Playwright engine installed.
  const r = await renderUrl(`${fixture.url}/page`, { browser: {}, proxy: { enabled: false } }, {
    log: null,
    subject: { id: 'no-allowance' },
  });
  assert.equal(r.ok, false, JSON.stringify(r).slice(0, 200));
});
runCase('renderUrl is reached with the source allowance from the one place it is defined', () => {
  const text = fs.readFileSync(SRC('server/src/fetchers/browser.js'), 'utf8');
  assert.ok(/policy:\s*sourcePolicy\(source\)/.test(text), 'fetchBrowser must pass the source policy');
});

// ───────────────────────────────────────────── J. the controls the project already relies on

section('J. the tree is clean');
runCase('no applied mutation is left in server/src (the rule the controls depend on)', () => {
  // Only the product source is checked, and that is the rule tools/config-durability-test.mjs already states
  // for its own controls ("no mutation is left in the tree"): a harness file is *supposed* to contain the
  // mutations — that is what makes it a harness — while an applied one must never survive in a source file.
  // The harness below restores every file and compares its bytes, so this is the second lock on the same door.
  const seen = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) walk(q);
      else if (/\.js$/.test(e.name)) {
        const text = fs.readFileSync(q, 'utf8');
        if (/MUTANT|MUTATION|_UNUSED\b/.test(text)) seen.push(path.relative(ROOT, q));
      }
    }
  };
  walk(SRC('server/src'));
  assert.deepEqual(seen, [], 'a mutated copy marker is in the real source: ' + seen.join(', '));
});

// ---------------------------------------------------------------------------------------------------
// The mutation controls.
//
// Each entry: the one change that must make the named assertion fail, and why that change is the finding.
// The server source is copied into a throwaway package that mirrors the repo layout (the modules import each
// other by bare relative path, so a lone copied file resolves nothing), the change is applied to the COPY,
// and this same file is spawned against it with `--only <the case the change must break>`. The child must
// exit non-zero. Nothing under server/src is written to at all — that is stronger than restoring it, and it
// is why the harness asserts the byte-identity of every source file afterwards anyway: the assertion is what
// makes the claim checkable rather than a promise about how the code is written.
//
// Why each mutation names a case rather than a section: one-line mutations are used throughout, and the
// point of a control is that *this* assertion, and no other, is what notices the change.
// ---------------------------------------------------------------------------------------------------
const MUTATIONS = [
  {
    source: 'server/src/remote-url.js',
    what: 'the pre-fix validator: no scheme check at all',
    from: "  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {\n    return refuse('scheme'",
    to: "  if (false) {\n    return refuse('scheme'",
    breaks: 'refuses scheme-file as scheme',
  },
  {
    source: 'server/src/remote-url.js',
    what: 'the pre-fix validator: the loopback rule deleted',
    from: "  if (a === 127) return 'loopback';",
    to: "  if (false) return 'loopback';",
    breaks: 'refuses loopback-literal as loopback',
  },
  {
    source: 'server/src/remote-url.js',
    what: 'the pre-fix validator: the private ranges deleted',
    from: "    if (a === 10) return 'private';",
    to: "    if (false) return 'private';",
    breaks: 'refuses private-10 as private',
  },
  {
    source: 'server/src/remote-url.js',
    what: 'the pre-fix validator: link-local treated as an ordinary address',
    from: "      return 'link-local';",
    to: "      return 'public';",
    breaks: 'refuses link-local-v4 as link-local',
  },
  {
    source: 'server/src/remote-url.js',
    what: 'the pre-fix validator: the cloud metadata addresses not named',
    from: "      if (quad === '169.254.169.254' || quad === '169.254.170.2' || quad === '169.254.169.253' || (a === 169 && b === 254 && bytes.ipv4[2] === 23)) return 'metadata';",
    to: "      if (false) return 'metadata';",
    breaks: 'refuses metadata-aws as metadata',
  },
  {
    source: 'server/src/remote-url.js',
    what: 'the pre-fix validator: the name is checked, the addresses it resolves to are not',
    from: '  for (const addr of addresses) {',
    to: '  for (const addr of addresses.slice(0, 1)) {',
    breaks: 'a mixed A/AAAA answer is refused as a whole (not "we got the public one")',
  },
  {
    source: 'server/src/remote-url.js',
    what: 'the pre-fix validator: a name that resolves to nothing is treated as a name that resolved',
    from: "  if (!addresses.length) {\n    return refuse('dns-empty'",
    to: "  if (false) {\n    return refuse('dns-empty'",
    // The assertion this breaks is the *empty* answer: a resolver that throws is caught above this line and is
    // still refused, so pointing the control at "unresolved" would have been a control that never failed.
    breaks: 'refuses dns-empty-answer as dns-empty',
  },
  {
    source: 'server/src/llm.js',
    what: 'the shipped Ollama preset without its loopback allowance (a preset refused on first use)',
    from: "    allowLoopback: true,\n  },",
    to: "  },",
    breaks: '1. the Ollama preset profile is accepted on address grounds, and its flag reaches the profile',
  },
  {
    source: 'server/src/llm.js',
    what: 'a preset flag that never reaches the profile newProvider builds',
    from: "    ...(p.allowLoopback === true ? { allowLoopback: true } : {}),\n",
    to: '',
    breaks: '1. the Ollama preset profile is accepted on address grounds, and its flag reaches the profile',
  },
  {
    source: 'server/src/llm.js',
    what: 'the allowance read from the whole preset table instead of the profile (a global permission)',
    from: "  if (provider?.allowLoopback === true) return { allowLoopback: true };",
    to: "  if (provider?.allowLoopback === true || true) return { allowLoopback: true };",
    breaks: '2. CONTROL: a user-typed loopback profile without the flag is still refused',
  },
  {
    source: 'server/src/remote-url.js',
    what: 'allowLoopback treated as "allow anything local" rather than loopback only',
    from: "  if (kind === 'metadata') return { ok: false, code: 'metadata', reason: `the address ${address} is a cloud metadata endpoint` };",
    to: "  if (kind === 'metadata' && !policy.allowLoopback) return { ok: false, code: 'metadata', reason: `the address ${address} is a cloud metadata endpoint` };",
    breaks: '3. the flag relaxes loopback only: private / link-local / metadata stay refused',
  },
  {
    source: 'server/src/remote-url.js',
    what: 'a mixed A/AAAA answer judged by its first address only',
    from: '  for (const addr of addresses) {',
    to: '  for (const addr of addresses.slice(0, 1)) {',
    breaks: 'a mixed A/AAAA answer is refused as a whole (not "we got the public one")',
  },
  {
    source: 'server/src/net.js',
    what: 'the pre-fix fetch: the redirect chain is never walked, so only the first hop is judged',
    from: "  const follow = opts.redirect !== 'manual' && sel.redirect !== false;",
    to: '  const follow = false;',
    breaks: 'with the allowance the same chain is followed, and both hops are recorded',
  },
  {
    source: 'server/src/net.js',
    what: 'a hop is fetched without being judged again (the redirect hole, one line)',
    from: '    const check = markedFirstHop(hop) ? { ok: true, url: current } : await validateRemoteUrl(current, policy);',
    to: '    const check = { ok: true, url: current };',
    breaks: 'a hop to a *different* refused address is refused at that hop, not at the start',
  },
  {
    source: 'server/src/probe.js',
    what: 'the pre-fix probe: a user-supplied address measured without being judged',
    from: '  const checked = await validateRemoteUrl(url, policy);\n  if (!checked.ok) {',
    to: '  const checked = { ok: true, url };\n  if (false) {',
    breaks: 'the probe route refuses a loopback URL by default (and never contacts it)',
  },
];

function runControls() {
  section('K. the controls: every mutation above is applied to a copy, and the named check must fail');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-remote-url-mutants-'));
  // One mirrored package for the whole run. `fs.cpSync` rather than a symlink: a link would let the child
  // resolve back into the real tree through the relative imports, and then the mutation would not be the thing
  // under test.
  const packageDir = path.join(dir, 'server');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.cpSync(SRC('server/src'), path.join(packageDir, 'src'), { recursive: true });
  // The mutated copy has to be able to load the project's dependencies (net.js imports undici, server.js
  // imports express), and a temp directory outside the repo has no node_modules above it. Rather than copying
  // a dependency tree, the package is given a link to the real one. Where the platform refuses the link
  // (Windows without symlink privilege creates nothing useful), the copy is placed *inside* the repository
  // instead, so the ordinary walk up from the package directory finds node_modules the normal way.
  const insideRepo = path.join(ROOT, 'server', 'src', '.mutation-package');
  const linkReal = (target) => {
    try {
      fs.symlinkSync(SRC('node_modules'), path.join(target, 'node_modules'), 'junction');
      return fs.existsSync(path.join(target, 'node_modules', 'undici'));
    } catch {
      return false;
    }
  };
  let packageRoot = path.join(dir, 'server');
  if (!linkReal(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(insideRepo), { recursive: true });
    packageRoot = path.join(insideRepo, 'server');
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.cpSync(SRC('server/src'), path.join(packageRoot, 'src'), { recursive: true });
  }

  const originals = new Map();
  for (const source of new Set(MUTATIONS.map((m) => m.source))) {
    originals.set(source, fs.readFileSync(SRC(source)));
  }

  try {
    for (const m of MUTATIONS) {
      const real = SRC(m.source);
      const text = originals.get(m.source).toString('utf8');
      const mutant = path.join(packageRoot, 'src', path.relative('server/src', m.source));
      if (!text.includes(m.from)) {
        runControlCase(`control "${m.what}" is applicable (its anchor is still in the source)`, () => {
          throw new Error('the mutation anchor is gone: the check it backs no longer exists');
        });
        continue;
      }
      fs.writeFileSync(mutant, text.replace(m.from, m.to), 'utf8');
      const child = spawnSync(process.execPath, ['--import', './tools/lib/mutant-register.mjs', SELF, '--only', m.breaks], {
        // The hook is registered by mutant-register.mjs (which calls module.register()); the three variables
        // say where the real tree is, where the copy is, and which single module is mutated in it. Without the
        // hook the app would keep importing the original module through its own importer and the mutant would
        // look like it changed nothing.
        env: {
          ...process.env,
          VML_MUTANT_ROOT: SRC('server/src'),
          VML_MUTANT_MIRROR: path.join(packageRoot, 'src'),
          VML_MUTANT_REL: path.relative('server/src', m.source).split(path.sep).join('/'),
        },
        encoding: 'utf8',
        timeout: 120000,
      });
      const out = String(child.stdout ?? '') + String(child.stderr ?? '');
      runControlCase(`control "${m.what}" makes this check fail: ${m.breaks}`, () => {
        assert.equal(
          child.status,
          1,
          `the mutant exited ${child.status} — it was supposed to fail the named check\n${out.slice(-700)}`,
        );
      });
      runControlCase(`control "${m.what}" fails with a [FAIL] line rather than a crash`, () => {
        // A child that dies of a module error also exits non-zero, and that would look like a passing control
        // while proving nothing about the assertion. The line is what distinguishes the two.
        assert.ok(/\[FAIL\]/.test(out), `the mutant reported no [FAIL] at all\n${out.slice(-700)}`);
      });
    }
    for (const [source, original] of originals) {
      runControlCase(`the real ${source} was never modified by the controls`, () => {
        assert.deepEqual(fs.readFileSync(SRC(source)), original, 'the source changed while the controls ran');
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (argv.includes('--mutation')) {
  runControls();
}

// ── run the async cases
for (const [name, fn] of asyncCases) {
  if (ONLY && name !== ONLY) {
    skipped++;
    continue;
  }
  flushSection();
  try {
    await fn();
    pass++;
    if (!QUIET) process.stdout.write('  [ok]   ' + name + '\n');
  } catch (e) {
    fail++;
    failures.push(name + ' — ' + e.message);
    if (!QUIET) process.stdout.write('  [FAIL] ' + name + ' — ' + e.message + '\n');
  }
}

closeAll();

if (!QUIET && failures.length) {
  process.stdout.write('\nfailures:\n');
  for (const f of failures) process.stdout.write('  - ' + f + '\n');
}
if (!QUIET) {
  process.stdout.write(
    `\nremote-url: ${pass}/${pass + fail} checks passed` + (skipped ? ` (${skipped} skipped)` : '') + '\n\n',
  );
}
process.exit(fail ? 1 : 0);
