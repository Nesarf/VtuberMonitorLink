// proxyctl-test.mjs — how the app finds a running proxy core's control interface, and what it says when it cannot.
//
// Why this exists: the first version probed six common ports and, failing, said only that no local proxy control
// interface had been found. On the machine this was written for, the running core is a client's bundled mihomo
// whose configuration declares **no external-controller at all** - so no port could ever answer, the core was never
// mentioned, and the user was told nothing they could act on. Discovery now reads the running core's own command
// line and configuration, and the diagnosis names the artefact and the fix.
//
// Only the pure half is tested here: which configuration file a command line points at, what a configuration
// declares, and what the message says for each kind of failure. Process enumeration and the actual HTTP probe are
// not in this file on purpose - they need a running core, and the shapes above are where the silent mistakes live.
import assert from 'node:assert/strict';
import path from 'node:path';
import { controlDiagnosis, controllerFromConfig, coreConfigFromCommandLine } from '../server/src/proxyctl.js';

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    process.stdout.write('  [ok]   ' + name + '\n');
  } catch (e) {
    fail++;
    process.stdout.write('  [FAIL] ' + name + '  -- ' + e.message + '\n');
  }
};

t('a core started with -d is read from that directory, quoting and all', () => {
  // A real path on this machine is `<drive>:\...\MAOMAOYUNAPP\resources\extra`; it is written with the placeholder
  // because a machine path in a published file is what the repository's sanitize check refuses (BUGS #67), and the
  // parser does not care which drive letter it is.
  const win = coreConfigFromCommandLine('"<drive>:\\app with spaces\\extra\\mihomo.exe" -d "<drive>:\\app with spaces\\extra"');
  assert.equal(win.dir, '<drive>:\\app with spaces\\extra', 'a quoted -d value must survive, spaces and all');
  assert.equal(win.file, path.join('<drive>:\\app with spaces\\extra', 'config.yaml'));
  // control: with no -d at all, the working directory is the one the executable sits in - mihomo's own convention,
  // which is exactly how the client on this machine starts it.
  const bare = coreConfigFromCommandLine('mihomo.exe', '<drive>:\\core\\mihomo.exe');
  assert.equal(bare.dir, '<drive>:\\core', 'the fallback must be the executable directory');
  assert.equal(bare.file, path.join('<drive>:\\core', 'config.yaml'));
  assert.notEqual(bare.dir, win.dir, 'the control: the two shapes must not collapse to one answer');
});

t('a core started with -f or --config is read from that file, and the directory follows it', () => {
  for (const flag of ['-f', '--config']) {
    const got = coreConfigFromCommandLine(`mihomo ${flag} /etc/mihomo/config.yaml`);
    assert.equal(got.file, '/etc/mihomo/config.yaml', `${flag} must be honoured`);
    assert.equal(got.dir, '/etc/mihomo', `${flag}: the directory is the file's`);
  }
  const single = coreConfigFromCommandLine("mihomo -f '/opt/core/my config.yaml'");
  assert.equal(single.file, '/opt/core/my config.yaml', 'single quotes must survive too');
  // control: an unknown flag is not a config path. With no executable path to fall back on nothing can be derived
  // at all, and with one the fallback applies - the first version of this assertion expected a made-up value
  // ("core") and failed, which is the useful kind of failure: the expectation was wrong, not the code.
  const unknown = coreConfigFromCommandLine('mihomo -x /tmp/other.yaml');
  assert.equal(unknown.file, '', 'an unknown flag must not be read as a config path');
  assert.equal(unknown.dir, '', 'and nothing can be derived without an executable path');
  assert.equal(
    coreConfigFromCommandLine('mihomo -x /tmp/other.yaml', '<drive>:\\core\\mihomo.exe').dir,
    '<drive>:\\core',
    'with an executable path, the executable-directory fallback still applies'
  );
});

t('a configuration that declares a controller yields it, loopback-mapped and with the secret reduced to a boolean', () => {
  const loop = controllerFromConfig('external-controller: 0.0.0.0:9090\nsecret: hunter2\n');
  assert.equal(loop.ok, true);
  assert.equal(loop.url, 'http://127.0.0.1:9090', 'a 0.0.0.0 binding must map to loopback: this app only talks to loopback');
  assert.equal(loop.hasSecret, true, 'the presence of a secret is reported');
  assert.equal(loop.secret, undefined, 'and the secret itself is never part of the result');
  const bare = controllerFromConfig('external-controller: 9097\n');
  assert.equal(bare.url, 'http://127.0.0.1:9097', 'a bare port is accepted');
  const named = controllerFromConfig('external-controller: 192.168.1.5:9090\n');
  assert.equal(named.url, 'http://192.168.1.5:9090', 'an explicit address is kept');
  assert.equal(named.hasSecret, false);
  // control: an empty secret is not a secret
  assert.equal(controllerFromConfig('external-controller: 9090\nsecret: "  "\n').hasSecret, false);
});

t('a configuration without a controller says so, and says whether it had a secret', () => {
  const none = controllerFromConfig('mixed-port: 7890\nsocks-port: 7891\nsecret: abc\n');
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'no-external-controller', 'this is the shape that produced the useless message');
  assert.equal(none.hasSecret, true, 'the secret is still reported, because it is the half the user may already have');
  // controls: the other two ways a configuration can fail, kept distinct because the advice differs
  assert.equal(controllerFromConfig('').reason, 'empty');
  assert.equal(controllerFromConfig('a: [unclosed\n').reason, 'unparsable');
  assert.equal(controllerFromConfig('external-controller: ""\n').reason, 'no-external-controller');
});

t('a file with content that is not a YAML mapping is not called empty', () => {
  // The measurement this exists for: 340928 bytes of base64 parse into one long string, and the first version of
  // this function called that "empty" - which sends the user looking for an empty file that is not there, and
  // hides the one fact that matters (the client encodes its configuration).
  const blob = 'j86WF8GtqoPvP7+pRUhcnNQzOrcxkZCJ0ZVUjr4I'.repeat(40);
  const verdict = controllerFromConfig(blob);
  assert.equal(verdict.reason, 'not-a-mapping', JSON.stringify(verdict));
  assert.equal(verdict.bytes, blob.length, 'the byte count travels with the verdict, so the message can say it');
  assert.equal(verdict.kind, 'string');
  // controls: a genuinely empty file is still empty, and a real mapping still yields its controller
  assert.equal(controllerFromConfig('').reason, 'empty');
  assert.equal(controllerFromConfig('   \n  ').reason, 'empty');
  assert.equal(controllerFromConfig('external-controller: 127.0.0.1:9090').ok, true);
});

t('the diagnosis names the branch, the core and the fix, for every way discovery can fail', () => {
  // Asserted by `code` and by ASCII fragments (the core's name, its configuration file, the ports). The message
  // itself is Chinese like the rest of this feature's API errors, and an assertion that looks for Chinese text
  // inside code is exactly what the repository's English-only rule for the engineering layer refuses - correctly,
  // which is why these branches carry a code at all.
  const noCore = controlDiagnosis({ cores: [], probed: [9090, 9790] });
  assert.equal(noCore.code, 'no-core');
  assert.match(noCore.message, /9090, 9790/, 'and the ports that were probed');
  assert.match(noCore.message, /external-controller/, 'and the setting that would fix it by hand');

  const noController = controlDiagnosis({
    cores: [{ name: 'mihomo-windows-386.exe', file: '<drive>:\\app\\extra\\config.yaml' }],
    config: { ok: false, reason: 'no-external-controller', file: '<drive>:\\app\\extra\\config.yaml' },
    probed: [9090],
  });
  assert.equal(noController.code, 'no-external-controller', 'the shape that produced the useless message is its own branch');
  assert.match(noController.message, /mihomo-windows-386\.exe/, 'the core must be named');
  assert.match(noController.message, /config\.yaml/, 'and the configuration file it was started with');
  assert.match(noController.message, /external-controller/, 'and the actual reason, not "not found"');

  // control: a declared-but-silent controller is a different branch, because the advice differs
  const silent = controlDiagnosis({
    cores: [{ name: 'mihomo.exe', file: '<drive>:\\c\\config.yaml' }],
    config: { ok: true, declared: '127.0.0.1:9090', file: '<drive>:\\c\\config.yaml' },
    probed: [9090],
  });
  assert.equal(silent.code, 'controller-silent');
  assert.match(silent.message, /127\.0\.0\.1:9090/, 'the declared address is named');
  assert.notEqual(silent.code, noController.code, 'the two cases must not share one branch');

  const unparsable = controlDiagnosis({
    cores: [{ name: 'clash.exe', file: '<drive>:\\c\\config.yaml' }],
    config: { ok: false, reason: 'unparsable', detail: 'bad indentation', file: '<drive>:\\c\\config.yaml' },
  });
  assert.equal(unparsable.code, 'config-unparsable');
  assert.match(unparsable.message, /bad indentation/, 'the parser own words are passed through');

  const unreadable = controlDiagnosis({
    cores: [{ name: 'clash.exe', file: '<drive>:\\c\\config.yaml' }],
    config: { ok: false, reason: 'unreadable', detail: 'EACCES', file: '<drive>:\\c\\config.yaml' },
  });
  assert.equal(unreadable.code, 'config-unreadable');
  assert.ok(unreadable.message.includes('clash.exe'), 'the core is named in this branch too');

  // a configuration that was read and parsed to nothing is its own case: some clients keep the real configuration
  // elsewhere (or encrypted), which is exactly what was measured on the machine this was written for.
  const empty = controlDiagnosis({
    cores: [{ name: 'mihomo-windows-386.exe', file: '<drive>:\\c\\config.yaml' }],
    config: { ok: false, reason: 'empty', file: '<drive>:\\c\\config.yaml' },
  });
  assert.equal(empty.code, 'config-empty', 'an empty parse must not be reported as an unreadable file');

  // Content that is not a YAML mapping is its own branch with its own advice, and the byte count is what keeps
  // "empty" from being a plausible reading of it.
  const notYaml = controlDiagnosis({
    cores: [{ name: 'mihomo-windows-386.exe', file: '<drive>:\\c\\config.yaml' }],
    config: { ok: false, reason: 'not-a-mapping', kind: 'string', bytes: 340928, file: '<drive>:\\c\\config.yaml' },
  });
  assert.equal(notYaml.code, 'config-not-yaml', 'content that is not YAML must not be reported as an empty file');
  assert.match(notYaml.message, /340928/, 'and it says how much content there was');
  assert.notEqual(notYaml.code, empty.code, 'the two cases must not share one branch');

  // every branch is distinct, so a test can tell them apart rather than matching one sentence
  const codes = new Set([noCore.code, noController.code, silent.code, unparsable.code, unreadable.code, empty.code, notYaml.code]);
  assert.equal(codes.size, 7, 'the seven ways discovery can fail must carry seven codes: ' + [...codes].join(', '));
});

process.stdout.write(`\nproxyctl: ${pass} ok, ${fail} failed\n`);
if (fail) process.exit(1);
