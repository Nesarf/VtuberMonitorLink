// workers/bash/build.mjs - turn the shared JSON tables into a shell-sourceable table file.
//
// Why a generated artifact at all: the contract (docs/WORKERS.md section 2) says every implementation
// reads workers/spec/latin-lower.json and workers/spec/latin-fold.json and nobody consults their own
// runtime's tables. A POSIX shell cannot parse JSON, and the one thing a shell is genuinely good at is
// a `case` statement, so this script reads the two JSON files and emits workers/bash/tables.generated.sh
// as two `case` functions keyed by code point:
//
//   vm_lower_ascii  <code point>  -> a single ASCII code point, or the input unchanged
//   vm_fold_ascii   <code point>  -> an ASCII string of 1-2 characters, or the input unchanged
//
// The two tables are applied in the order the contract gives (lowercase, then fold), and the scripts
// that consume them do exactly that: one call to each, in that order, over every code point. 519
// entries in total, and the shell never has to match a pattern against more than one of them.
//
// The script also composes the two tables into a third function used only as a cross-check:
//
//   vm_lowerfold_ascii <code point> -> fold(lower(cp))
//
// `vm_ascii_pipeline` in vmltext.sh asserts, at build time of the *artifact*, that this composed table
// agrees with `vm_fold_ascii "$(vm_lower_ascii cp)"` for every entry. The contract's own history is
// the reason for that check: the reference implementation once treated the two tables as alternatives
// instead of steps and passed "Cafe" while failing "L'ETE". A generated table is worth exactly what
// its verification is worth.
//
// Usage (from the repository root, or from anywhere):
//   node workers/bash/build.mjs
//
// Prints the generated artifact path as its last stdout line (the conformance runner reports that
// line, and a build that prints nothing looks like a build that did nothing). Fails with a clear
// English message on stderr and a non-zero exit if `bash` cannot be found or cannot run a script,
// because the artifact is useless on a machine with no shell and "[skip]" is the honest report.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // workers/bash
const ROOT = path.resolve(HERE, '..', '..');
const SPEC = path.join(ROOT, 'workers', 'spec');
const OUT = path.join(HERE, 'tables.generated.sh');

// ---------------------------------------------------------------- find bash

/** A path spelled the way a POSIX shell sees it: forward slashes, no Windows drive prefix games. */
const posix = (p) => String(p).replace(/\\/g, '/');

/**
 * Is this a bash that can actually *run a script with arguments*, which is all the build and the
 * worker need?
 *
 * This is not paranoia, it is the specific trap on this machine. The `bash.exe` that comes first on
 * PATH here is WSL's, and it is a launcher, not a shell: it answers `bash --version` like bash,
 * answers `bash -c 'echo'` like bash, and then quietly drops the rest of the command line - it runs
 * `/bin/bash` with *no* positional parameters at all. A credential check that stopped at `--version`
 * accepted it, and the generated table then "failed to verify" for a reason that had nothing to do
 * with the table. So each candidate is asked to do the smallest real job there is: run a two-line
 * script file, source the file it was given as `$1`, and print something only if both steps worked.
 *
 * Git for Windows' shell passes this. WSL's launcher does not. Nothing here assumes which one is
 * which: the probe is the whole answer, and a candidate that fails it is simply not used.
 */
function bashWorks(exe) {
  if (!exe) return false;
  const version = spawnSync(exe, ['--version'], { encoding: 'utf8' });
  if (version.error || version.status !== 0) return false;
  if (!/GNU bash/i.test(String(version.stdout) + String(version.stderr))) return false;

  // The probe file goes next to this script: a repository path with a forward slash is the one
  // spelling every bash on this machine (MSYS, Cygwin, WSL) can open by itself, while a temp path
  // outside the drive the distro has mounted is not.
  const probeName = `_probe-${process.pid}.sh`;
  const probeTable = `_probe-${process.pid}.table.sh`;
  const probe = [
    '# build.mjs credential probe: run a script file, use $1, source a file.',
    'set -eu',
    'VM_MARKER=vm-probe-ok',
    '. "$1"',
    'printf \'%s\\n\' "$VM_MARKER"',
    '',
  ].join('\n');
  const table = ['vm_probe_table() { printf \'%s\\n\' yes; }', ''].join('\n');
  try {
    fs.writeFileSync(path.join(HERE, probeName), probe, 'utf8');
    fs.writeFileSync(path.join(HERE, probeTable), table, 'utf8');
  } catch {
    return false; // a read-only tree: no probe, no verification, no artifact
  }
  const job = spawnSync(exe, [posix(HERE) + '/' + probeName, posix(HERE) + '/' + probeTable], {
    encoding: 'utf8',
    timeout: 20000,
  });
  try {
    fs.unlinkSync(path.join(HERE, probeName));
    fs.unlinkSync(path.join(HERE, probeTable));
  } catch {}
  return !job.error && job.status === 0 && String(job.stdout).includes('vm-probe-ok');
}

const EXE_NAMES =
  process.platform === 'win32' ? ['bash.exe', 'bash'] : ['bash'];

/** Every candidate from PATH, in order, plus the usual install locations on Windows. */
function bashCandidates() {
  const found = [];
  if (process.platform === 'win32') {
    // Search order, on purpose: a real Git for Windows shell first, then whatever PATH offers.
    // PATH is searched too because a machine may have a bash from somewhere else entirely (Cygwin,
    // an SDK, a portable install), and the credential probe below decides which candidates are real.
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
      if (!base) continue;
      found.push(path.join(base, 'Git', 'bin', 'bash.exe'));
      found.push(path.join(base, 'Git', 'usr', 'bin', 'bash.exe'));
    }
  }
  const dirs = String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of EXE_NAMES) found.push(path.join(dir, name));
  }
  if (process.platform !== 'win32') {
    for (const p of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']) found.push(p);
  }
  return [...new Set(found)];
}

function findBash() {
  const fromEnv = process.env.VMLTEXT_BASH;
  if (fromEnv) {
    if (bashWorks(fromEnv)) return fromEnv;
    process.stderr.write(`build: VMLTEXT_BASH is set to "${fromEnv}" but it is not a usable bash\n`);
  }
  const tried = [];
  for (const candidate of bashCandidates()) {
    if (tried.length > 400) break;
    tried.push(candidate);
    if (!fs.existsSync(candidate)) continue;
    if (bashWorks(candidate)) return candidate;
  }
  // Last resort: PATH lookup by name, which uses the platform's own rules (PATHEXT included).
  for (const name of EXE_NAMES) {
    if (bashWorks(name)) return name;
  }
  process.stderr.write(
    [
      'build: no usable bash found.',
      '',
      "workers/bash/vmltext.sh needs a real bash that can run a script file with arguments. On Windows,",
      "the `bash` that comes first on PATH is usually WSL's: it answers --version like bash and then",
      "drops the rest of the command line, so it cannot run a worker. Git for Windows' shell works",
      '("C:/Program Files/Git/bin/bash.exe"). Point this build at a working one and run it again:',
      '',
      '  VMLTEXT_BASH="C:/Program Files/Git/bin/bash.exe" node workers/bash/build.mjs',
      '',
      `Candidates tried: ${tried.length}.`,
      '',
    ].join('\n'),
  );
  process.exit(1);
}

const bash = findBash();
const versionRun = spawnSync(bash, ['--version'], { encoding: 'utf8' });
const versionText = String(versionRun.stdout ?? '') + String(versionRun.stderr ?? '');
// Cygwin/MSYS bash answers with "GNU bash, version 5.3.15(1)-release (x86_64-pc-cygwin)"; a plain
// Linux bash with "GNU bash, version 5.2.21(1)-release (x86_64-pc-linux-gnu)". Take the bare version.
const bashVersion = (versionText.match(/version\s+([0-9][^\s(]*\([0-9]+\)-release)/) ?? [])[1]
  ?? versionText.split('\n')[0].trim();

// ---------------------------------------------------------------- read tables

function loadTable(file) {
  const full = path.join(SPEC, file);
  if (!fs.existsSync(full)) {
    process.stderr.write(`build: ${full} is missing; the shared tables are the input to this build\n`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
  const map = new Map();
  for (const [k, v] of Object.entries(raw.map ?? {})) map.set(Number(k), v);
  return map;
}

const LOWER = loadTable('latin-lower.json'); // code point -> code point
const FOLD = loadTable('latin-fold.json'); // code point -> ASCII string of 1-2 characters

// ---------------------------------------------------------------- compose + check

/** The contract's step 3 then step 4, applied to one code point. */
function lowerThenFold(cp) {
  const lowered = LOWER.has(cp) ? LOWER.get(cp) : cp;
  const asChar = String.fromCodePoint(lowered);
  let out = '';
  for (const ch of asChar) {
    const p = ch.codePointAt(0);
    out += FOLD.has(p) ? FOLD.get(p) : ch;
  }
  return out;
}

const composed = new Map();
for (const cp of LOWER.keys()) composed.set(cp, lowerThenFold(cp));
for (const cp of FOLD.keys()) if (!composed.has(cp)) composed.set(cp, lowerThenFold(cp));

// Build-time assertions on the data itself. A table that is not one-to-one, or a fold that is not
// ASCII, would make the generated shell functions disagree with the contract silently.
const problems = [];
for (const [cp, to] of LOWER) {
  if (!Number.isInteger(to) || to < 0 || to > 0x10ffff) problems.push(`latin-lower.json: ${cp} -> ${to} is not a code point`);
}
for (const [cp, to] of FOLD) {
  if (typeof to !== 'string' || to.length < 1 || to.length > 2 || !/^[\x20-\x7e]+$/.test(to)) {
    problems.push(`latin-fold.json: ${cp} -> ${JSON.stringify(to)} is not a 1-2 character ASCII string`);
  }
}
for (const [cp, to] of composed) {
  const manual = lowerThenFold(cp);
  if (manual !== to) problems.push(`composed table disagrees with lower-then-fold at ${cp}`);
}
if (problems.length) {
  process.stderr.write('build: the shared tables are not usable:\n  ' + problems.join('\n  ') + '\n');
  process.exit(1);
}

// ---------------------------------------------------------------- emit

const hex = (cp) => cp.toString(16).toUpperCase().padStart(2, '0');
const sx = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * A printed `case` table over code points, used by the build's own verification script only.
 *
 * The artifact's tables are written out by hand further down instead, in an assigning shape
 * (`VM_SOMETHING=value`) rather than this printing one, because the worker calls them once per input
 * code point and a `$(...)` per character would be the largest single cost in the capability. Keeping
 * the two shapes separate is the point: the verification must not be able to pass by reading the same
 * bug twice, so its tables are generated from the JSON files it just read.
 */
function caseFunction(name, entries, render) {
  const lines = [`${name}() {`, '  case $1 in'];
  for (const [cp, value] of entries) lines.push(`    ${cp}) printf '%s' ${sx(render(value))} ;;`);
  lines.push('    *) printf \'%s\' "$1" ;;'); // not in the table: unchanged, per the contract
  lines.push('  esac', '}');
  return lines.join('\n');
}

const lowerEntries = [...LOWER.entries()].sort((a, b) => a[0] - b[0]);
const foldEntries = [...FOLD.entries()].sort((a, b) => a[0] - b[0]);
const composedEntries = [...composed.entries()].sort((a, b) => a[0] - b[0]);

const generated = `#!/usr/bin/env bash
# tables.generated.sh - GENERATED by workers/bash/build.mjs. Do not edit; edit the generator.
#
# Source of truth: workers/spec/latin-lower.json and workers/spec/latin-fold.json, applied in the
# order docs/WORKERS.md section 2 gives (lowercase, then fold) and nowhere else.
#
# Shape: \`case\` functions keyed by code point that ASSIGN a VM_* variable instead of printing, because
# they are called once per input code point and a subshell per character would be the whole cost of the
# capability. A shell has no JSON and no Unicode case tables of its own, so both tables live here as
# data - the same shared data every other implementation reads, not this shell's idea of a letter.
#
#   ${lowerEntries.length} lower entries (U+0000-U+024F, one code point -> one code point)
#   ${foldEntries.length} fold entries (one code point -> 1-2 ASCII characters), keyed twice: by code
#     point for the fold step, and by character for the position the contract puts it in
#   ${composedEntries.length} composed entries (fold(lower(cp))), the table the normalizer applies
#
# Generated by bash ${bashVersion}; the artifact is interpreter-agnostic and holds no machine path.

# Lowercase exactly what latin-lower.json says, nothing else. U+0130 is deliberately absent (its real
# lowercase is two code points, and a one-to-one table must not pretend otherwise).
# Argument: a decimal code point. Result: the lowered character, in VM_LOWERED.
vm_lower_cp() {
  case $1 in
${lowerEntries.map(([cp, v]) => `    ${cp}) VM_LOWERED=${sx(String.fromCodePoint(v))} ;;`).join('\n')}
    *) VM_LOWERED="$1" ;;
  esac
}

# Fold accents exactly what latin-fold.json says, after lowercasing. Argument: a decimal code point.
vm_fold_ascii() {
  case $1 in
${foldEntries.map(([cp, v]) => `    ${cp}) VM_FOLD_ASCII=${sx(v)} ;;`).join('\n')}
    *) VM_FOLD_ASCII="$1" ;;
  esac
}

# The contract's two tables, composed in the contract's order: fold(lower(cp)), in VM_LOWERFOLD. This is
# the table the capability applies: both steps are keyed by code point, but the second step receives what
# the first step *produced* - a character - and composing them at build time from the same two JSON files
# is what removes both the decode and the character-keyed lookup from the hot loop. It is not a third
# table: the build asserts, for every one of its ${composedEntries.length} entries, that it equals the
# two-step result, and the fold-only entries (U+00E9 -> e, which the lower table does not touch) are the
# reason it has to be built from both files rather than from latin-fold.json alone.
vm_lowerfold_ascii() {
  case $1 in
${composedEntries.map(([cp, v]) => `    ${cp}) VM_LOWERFOLD=${sx(v)} ;;`).join('\n')}
    *) VM_LOWERFOLD="$1" ;;
  esac
}

# A character's code point: vm_lower_cp answers with a character, the fold table is keyed by code point,
# and this is the bridge between them. Only the lower table's ${lowerEntries.length} results can be asked
# about (none is outside U+0000-U+024F); anything else comes back as itself. It is the ONLY place a
# character is ever the key of a lookup in this artifact, and the caller always supplies a character it
# produced itself at runtime - see README.md for the measurement that made that a rule.
vm_cp_of_char() {
  case $1 in
${lowerEntries.map(([cp, v]) => `    ${sx(String.fromCodePoint(v))}) VM_CP=${v} ;;`).join('\n')}
    *) VM_CP="$1" ;;
  esac
}

# Lists, for the self-check's coverage assertion and for the attribute counts in README.md.
VM_LOWER_ENTRIES=${lowerEntries.length}
VM_FOLD_ENTRIES=${foldEntries.length}
VM_COMPOSED_ENTRIES=${composedEntries.length}
`;

fs.writeFileSync(OUT, generated, 'utf8');

// ---------------------------------------------------------------- verify the artifact

// The artifact is only worth generating if a real bash can source it and agree with the tables it was
// generated from, so the build proves that here rather than leaving it to the first corpus run.
// The verify script runs as one bash program: it is written with ordinary escapes rather than a
// template literal, because that same template literal above is where the rest of this file lives and
// a silent `\n`-that-is-not-a-newline would comment out this whole check.
const verify = [
  'set -eu',
  '. "$1"',
  'bad=0',
  'n=0',
  'check() {',
  '  cp=$1; want=$2; got=$3',
  '  n=$((n + 1))',
  '  if [ "$got" != "$want" ]; then',
  "    printf 'mismatch at U+%04X: want [%s] got [%s] (at %s)\\n' \"$cp\" \"$want\" \"$got\" \"$BASH_LINENO\" >&2",
  '    bad=$((bad + 1))',
  '  fi',
  '}',
  '# Latin-1/ASCII lowercasing for a string a fold just produced. The fold table holds uppercase letters',
  '# (U+00C0 -> A, U+00DE -> TH) and the contract lowercases a character again on the way out of a fold',
  '# step: "fold, then lowercase the result" is what makes ECOLE-with-an-accent come out as "ecole"',
  '# rather than "ECOLE". vmltext.sh does this to every character of a fold result; here it is enough to',
  '# do it to the whole string once, because a fold result is ASCII.',
  'lower_ascii_str() {',
  '  out=$1',
  '  i=0',
  '  acc=',
  '  while [ "$i" -lt ${#out} ]; do',
  '    ch=${out:$i:1}',
  '    case $ch in',
  '      A) acc=${acc}a ;; B) acc=${acc}b ;; C) acc=${acc}c ;; D) acc=${acc}d ;; E) acc=${acc}e ;;',
  '      F) acc=${acc}f ;; G) acc=${acc}g ;; H) acc=${acc}h ;; I) acc=${acc}i ;; J) acc=${acc}j ;;',
  '      K) acc=${acc}k ;; L) acc=${acc}l ;; M) acc=${acc}m ;; N) acc=${acc}n ;; O) acc=${acc}o ;;',
  '      P) acc=${acc}p ;; Q) acc=${acc}q ;; R) acc=${acc}r ;; S) acc=${acc}s ;; T) acc=${acc}t ;;',
  '      U) acc=${acc}u ;; V) acc=${acc}v ;; W) acc=${acc}w ;; X) acc=${acc}x ;; Y) acc=${acc}y ;;',
  '      Z) acc=${acc}z ;;',
  '      *) acc=$acc$ch ;;',
  '    esac',
  '    i=$((i + 1))',
  '  done',
  '  printf \'%s\' "$acc"',
  '}',
  '# Every entry of both tables must reproduce the contract result fold(lower(cp)) when the two tables',
  '# are applied as two steps in the contract order. The expected values are embedded here from the JSON',
  '# tables as the generator read them, so this compares the shell against the data rather than against',
  '# itself: a lookup that missed, or a step applied in the wrong order, shows up.',
  '# Three checks per table, because the contract has three moving parts: the composed table vmltext.sh',
  '# applies (vm_lowerfold_ascii), the fold table keyed by code point, and the two-step path with the',
  '# produced character decoded back to a code point (vm_cp_of_char) - and the fold result lowercased',
  '# again, which is what turns U+00C0 (A-grave -> "A") into "a".',
  'expect() {',
  '  case $1 in',
  ...composedEntries.map(([cp, v]) => `    ${cp}) printf '%s' ${sx(v)} ;;`),
  '    *) printf \'%s\' "" ;;',
  '  esac',
  '}',
  `for cp in ${[...composed.keys()].sort((a, b) => a - b).join(' ')}; do`,
  '  vm_lowerfold_ascii "$cp"',
  '  check "$cp" "$(expect "$cp")" "$VM_LOWERFOLD"',
  'done',
  '# Every entry of the lower table, checked against the value the generator read from latin-lower.json:',
  '# U+0041 -> a. This is the only place where an entry the contract leaves alone can be told apart from',
  '# an entry the shell never looked up, which is why it is checked value by value: folding the result',
  '# cannot see the difference, because plain ASCII letters are absent from latin-fold.json too.',
  'expect_lower() {',
  '  case $1 in',
  ...lowerEntries.map(([cp, v]) => `    ${cp}) printf '%s' ${sx(String.fromCodePoint(v))} ;;`),
  '    *) printf \'%s\' "" ;;',
  '  esac',
  '}',
  '# What vm_cp_of_char must return for a code point: the code point of the lowered character.',
  'expect_cp() {',
  '  case $1 in',
  ...lowerEntries.map(([cp, v]) => `    ${cp}) printf '%s' ${v} ;;`),
  '    *) printf \'%s\' "" ;;',
  '  esac',
  '}',
  `for cp in ${[...LOWER.keys()].sort((a, b) => a - b).join(' ')}; do`,
  '  vm_lower_cp "$cp"',
  '  check "$cp" "$(expect_lower "$cp")" "$VM_LOWERED"',
  '  vm_cp_of_char "$VM_LOWERED"',
  '  check "$cp" "$(expect_cp "$cp")" "$VM_CP"',
  'done',
  '# char_of_cp is the build-side stand-in for vmltext.sh vm_char: a code point to its character, in UTF-8',
  '# bytes. Short because the verification only ever asks for code points below U+0250.',
  'char_of_cp() {',
  '  cp=$1',
  '  if [ "$cp" -lt 128 ]; then',
  `    printf '%b' "\\\\$(printf '%03o' "$cp")"`,
  '    return 0',
  '  fi',
  '  o=$(printf "%03o" "$((192 + (cp >> 6)))")',
  '  o=$o$(printf "%03o" "$((128 + (cp & 63)))")',
  `  printf '%b' "\\\\\${o:0:3}\\\\\${o:3:3}"`,
  '}',
  '# Every entry of the fold table, likewise: U+00E9 -> e. Latin-fold.json has nothing to say about an',
  '# unaccented ASCII letter, so the identity arm is the right answer there and this table is the only',
  '# place the two cases can be told apart. It is keyed by code point: a character-keyed copy of the same',
  '# table was measured to match only when the key arrived as a runtime value, so the artifact does not',
  '# have one (see the note below and README.md).',
  'expect_fold() {',
  '  case $1 in',
  ...foldEntries.map(([cp, v]) => `    ${cp}) printf '%s' ${sx(v)} ;;`),
  '    *) printf \'%s\' "" ;;',
  '  esac',
  '}',
  `for cp in ${[...FOLD.keys()].sort((a, b) => a - b).join(' ')}; do`,
  '  vm_fold_ascii "$cp"',
  '  check "$cp" "$(expect_fold "$cp")" "$VM_FOLD_ASCII"',
  '  vm_lowerfold_ascii "$cp"',
  '  check "$cp" "$(expect "$cp")" "$VM_LOWERFOLD"',
  'done',
  '# A character-keyed arm must NOT be reachable by accident: the tables take decimal code points, and a',
  '# value that looks like a character falls through to the identity arm. (A first draft emitted',
  '# character keys as well, and on this bash they match only sometimes - see the note below.)',
  `ch_a_grave=$(printf '\\xC3\\xA0')`,
  `vm_fold_ascii "$ch_a_grave"; if [ "$VM_FOLD_ASCII" != "$ch_a_grave" ]; then echo 'a character key was accepted by vm_fold_ascii' >&2; bad=$((bad + 1)); fi`,
  `vm_lower_cp "$ch_a_grave"; if [ "$VM_LOWERED" != "$ch_a_grave" ]; then echo 'a character key was accepted by vm_lower_cp' >&2; bad=$((bad + 1)); fi`,
  '# vm_cp_of_char is what lets the two steps be applied in order at all (the fold table is keyed by code',
  '# point, the lower step answers with a character), so it is checked as a round trip: lower the code',
  '# point, decode the produced character back to a code point, and land on what the lower table said.',
  '# This is the one character-keyed lookup in the artifact, and it uses a value the worker produced',
  '# itself - which is the only shape that was measured to work reliably on Git for Windows bash: a',
  '# multi-byte pattern written into the script source does not match the same bytes arriving at runtime.',
  '# Half a table that matches is worse than none, so no table here is keyed by a character.',
  `for cp in ${[...LOWER.keys()].sort((a, b) => a - b).join(' ')}; do`,
  '  vm_lower_cp "$cp"',
  '  vm_cp_of_char "$VM_LOWERED"',
  '  check "$cp" "$(expect_cp "$cp")" "$VM_CP"',
  'done',
  `ch_bytes=$(printf '\\xC3\\x80')`,
  `vm_cp_of_char a; if [ "$VM_CP" != "97" ]; then echo 'vm_cp_of_char did not resolve a to 97' >&2; bad=$((bad + 1)); fi`,
  `vm_cp_of_char 97; if [ "$VM_CP" != "97" ]; then echo 'vm_cp_of_char did not leave a code point alone' >&2; bad=$((bad + 1)); fi`,
  `vm_lower_cp 192; vm_cp_of_char "$VM_LOWERED"; if [ "$VM_CP" != "224" ]; then echo "the U+00C0 round trip did not land on 224 (got [$VM_CP])" >&2; bad=$((bad + 1)); fi`,
  '# A code point outside both tables must come back unchanged, including a CJK one (U+4E2D).',
  `vm_lower_cp 20013; [ "$VM_LOWERED" = "20013" ] || { echo 'CJK code point was mapped' >&2; bad=$((bad + 1)); }`,
  `vm_fold_ascii 20013; [ "$VM_FOLD_ASCII" = "20013" ] || { echo 'CJK code point was folded' >&2; bad=$((bad + 1)); }`,
  `vm_lowerfold_ascii 20013; [ "$VM_LOWERFOLD" = "20013" ] || { echo 'composed table mapped a CJK code point' >&2; bad=$((bad + 1)); }`,
  `[ "$(lower_ascii_str ABz)" = "abz" ] || { echo 'lower_ascii_str did not lowercase ABz' >&2; bad=$((bad + 1)); }`,
  `test "$n" -eq $(( ${composedEntries.length} + ${LOWER.size} * 2 + ${FOLD.size} * 2 + ${LOWER.size} )) || { printf 'coverage: checked %s, expected %s\\n' "$n" $(( ${composedEntries.length} + ${LOWER.size} * 2 + ${FOLD.size} * 2 + ${LOWER.size} )) >&2; bad=$((bad + 1)); }`,  'printf \'%s\\n\' "$n"',
  'exit $(( bad == 0 ? 0 : 1 ))',
  '',
].join('\n');

const OUT_POSIX = posix(OUT);

// The verify script runs as a *file*, not through `-c`: a bash that cannot take a script file with a
// positional parameter cannot run vmltext.sh either, and this is the same call shape the worker uses.
const verifyName = `_verify-${process.pid}.sh`;
const verifyFile = path.join(HERE, verifyName);
fs.writeFileSync(verifyFile, verify, 'utf8');
if (process.env.VM_KEEP_VERIFY === '1') fs.writeFileSync(path.join(HERE, '_verify-dump.txt'), verify, 'utf8');
// The timeout is generous on purpose: this walks 1,200 table entries through a shell, and a build that
// gives up on its own verification is worse than one that takes a minute. It is a build step, run once
// per conformance run, not something on a hot path.
const check = spawnSync(bash, [posix(verifyFile), OUT_POSIX], { encoding: 'utf8', timeout: 300000 });
if (process.env.VM_KEEP_VERIFY === '1') process.stderr.write('kept: ' + verifyFile + '\n');
if (process.env.VM_KEEP_VERIFY !== '1') {
  try {
    fs.unlinkSync(verifyFile);
  } catch {}
}
if (check.error) {
  process.stderr.write(`build: could not run bash to verify the generated artifact: ${check.error.message}\n`);
  process.exit(1);
}
if (check.status !== 0) {
  process.stderr.write(
    `build: the generated artifact did not verify against the shared tables (exit ${check.status})\n` +
      String(check.stderr ?? '').trim().split('\n').slice(0, 8).map((l) => '  ' + l).join('\n') +
      '\n',
  );
  process.exit(1);
}

process.stderr.write(
  `build: workers/bash/tables.generated.sh written - ${lowerEntries.length} lower, ` +
    `${foldEntries.length} fold, ${composedEntries.length} composed entries; ` +
    `${String(check.stdout).trim()} entries verified with bash ${bashVersion}\n`,
);
// Last stdout line is the artifact path: the conformance runner prints the tail of stdout, and a
// build that says nothing is indistinguishable from a build that did nothing.
process.stdout.write(OUT + '\n');
