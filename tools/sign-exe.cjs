// sign-exe.cjs - Authenticode-sign the freshly built launcher, before it is packed.
//
// Where this belongs in the build is the whole point, so it is worth stating once:
//
//   build the SEA launcher -> SIGN IT -> copy it into the package -> pack the zip -> manifest -> checksums
//
// Signing after packing is not the same operation. The zip carries a per-file manifest and the release
// carries SHA256SUMS.txt; both describe the bytes in the package, so a signature added afterwards makes
// every one of them describe something that is no longer there. A signed artifact must also be signed
// before it is described anywhere -- "mark before signing, never after" -- or the description is the
// thing that is wrong.
//
// Why the file needs repairing before it can be signed at all, measured on the v1.0.6 release:
//
//   The SEA step starts from node.exe, which its vendor has signed. `postject` copies it and appends the
//   application blob, which invalidates that signature but leaves the certificate-table directory entry
//   in the optional header pointing at the offset the base image had -- now inside section data. The
//   released VtuberMonitorLink.exe carried entry offset 93564416 / length 15688, and the eight bytes at
//   that offset read dwLength = 0, i.e. a table declaring it holds no certificate.
//
//   A file in that state cannot be signed: the signature attaches, and then no timestamp authority can
//   be reached for it. Measured, on this file: 93 MB failed three times with "no timestamp was obtained"
//   while a small file signed fine in the same minute, which rules out rate limiting and connectivity.
//   Clearing those eight bytes made the same file sign and timestamp normally. The signing tool does the
//   clearing itself, and refuses to do anything at all if the entry names a location that is not an
//   empty table -- because in that case it is a wrong number and acting on it would cut into the file.
//
// usage: node tools/sign-exe.cjs <exe> --thumbprint <sha1> [--python <exe>] [--onlysign <dir>]

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function parseArgs(argv) {
  const out = { exe: '', thumbprint: '', python: 'python', onlysign: '', ledger: '' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--thumbprint') out.thumbprint = String(argv[++i] || '').trim();
    else if (a === '--python') out.python = String(argv[++i] || 'python');
    else if (a === '--onlysign') out.onlysign = path.resolve(String(argv[++i] || ''));
    else if (a === '--ledger') out.ledger = path.resolve(String(argv[++i] || ''));
    else rest.push(a);
  }
  out.exe = rest[0] || '';
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (!args.exe) {
  process.stderr.write('sign-exe: no executable given\n  usage: node tools/sign-exe.cjs <exe> --thumbprint <sha1>\n');
  process.exit(2);
}
if (!args.thumbprint) {
  process.stderr.write(
    'sign-exe: no --thumbprint.\n' +
      '  The certificate is named by thumbprint rather than by subject, because a subject string is\n' +
      '  something any certificate can claim and the thumbprint is not.\n'
  );
  process.exit(2);
}
if (!fs.existsSync(args.exe)) {
  process.stderr.write('sign-exe: no such file: ' + args.exe + '\n');
  process.exit(1);
}
if (!args.onlysign) {
  process.stderr.write(
    'sign-exe: no --onlysign directory, so there is no signing tool to call.\n' +
      '  Pass --sign-tool <dir> to build-portable.cjs, or set ONLYSIGN_DIR.\n'
  );
  process.exit(2);
}
if (!args.ledger) {
  // Without this the tool writes its record into whatever directory the build was started from, which
  // was measured: a build run from E:\DSH left a ledger at E:\DSH\.onlysign\signings.ndjson. A record of
  // what was signed is only useful if it is in one known place, so this refuses to guess.
  process.stderr.write(
    'sign-exe: no --ledger path.\n' +
      '  The signing ledger must be named explicitly: a record of what was signed, scattered across\n' +
      '  whichever directory each build happened to run in, is not a record of anything.\n'
  );
  process.exit(2);
}

const before = fs.statSync(args.exe).size;
process.stdout.write('signing ' + path.basename(args.exe) + '  (' + Math.round(before / 1048576) + ' MB)\n');

// The tool is called as a module rather than through a console script, because a console script would
// have to be installed on PATH and this build must not require that. PYTHONPATH is how the child is told
// where the package is without touching it.
const env = Object.assign({}, process.env, {
  PYTHONPATH: args.onlysign + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : ''),
  PYTHONIOENCODING: 'utf-8',
});

const result = spawnSync(
  args.python,
  ['-m', 'onlysign', 'sign', args.exe, '--cert', args.thumbprint, '--force',
   '--ledger', args.ledger, '--note', 'VtuberMonitorLink portable build'],
  { stdio: 'inherit', env }
);

if (result.error) {
  process.stderr.write('sign-exe: could not run ' + args.python + ': ' + result.error.message + '\n');
  process.exit(1);
}
if (result.status !== 0) {
  // A build that ships an unsigned binary while claiming otherwise is worse than a build that stops, so
  // this is fatal rather than a warning. Pass no --sign at all to build without one.
  process.stderr.write('sign-exe: signing failed with exit ' + result.status + '\n');
  process.exit(result.status || 1);
}

const after = fs.statSync(args.exe).size;
if (after <= before) {
  process.stderr.write(
    'sign-exe: the file did not grow, so no certificate table was appended -- the signature did not land\n'
  );
  process.exit(1);
}
process.stdout.write('  signed: ' + Math.round(before / 1048576) + ' MB -> ' + Math.round(after / 1048576) + ' MB\n');
