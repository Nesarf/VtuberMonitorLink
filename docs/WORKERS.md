# Workers: one capability, several languages [WORK IN PROGRESS]

This document is the contract for the project's multilingual layer. It exists because of a specific
observation: a capability implemented once, in one language, hides its own redundancy — duplicated
rules, cross-cutting assumptions, and "logic" that is really just an accident of one runtime's
standard library. Implement the same capability several times against one written contract, run one
corpus through all of them, and the implementations put each other under pressure: any disagreement
is either a bug in one implementation or a hole in the contract, and both are worth finding.

The Node core stays the orchestrator. A capability has a **reference implementation in JavaScript**
(always present, the fallback) and any number of **workers** in other languages. The host prefers a
worker when one is registered and available; when none is, it falls back to the reference without
changing behaviour.

Status: this layer is **development-tree only for now** — it is not packaged into the release
artifact, and the release checks are unchanged. Nothing here is shipped until it has earned it.

## 1. Protocol v1

Both sides speak **JSON Lines over stdio**: one JSON object per line, UTF-8, LF, no BOM. stdout
carries protocol messages and nothing else; **stderr is free-form human text** (English) for
diagnostics. A worker that writes to stdout anything but a protocol line is broken by definition.

Request (host to worker):

```json
{"id": 1, "op": "describe"}
{"id": 2, "op": "invoke", "capability": "text.normalize", "input": {"text": "..."}}
{"id": 3, "op": "shutdown"}
```

Response (worker to host):

```json
{"id": 1, "ok": true, "worker": {"protocol": 1, "capability": "text.normalize", "language": "java", "impl": "table-driven", "runtime": "JDK 17.0.14", "deterministic": true}}
{"id": 2, "ok": true, "output": {"text": "..."}}
{"id": 2, "ok": false, "error": {"code": "bad-input", "message": "input.text must be a string"}}
{"id": 3, "ok": true}
```

`shutdown` answers that bare envelope and nothing else. The implementations disagreed about this at
first — two of them carried an extra `"output"` payload from an earlier draft of the reference — and
because the disagreement was invisible to the corpus (nothing diffs a shutdown line), it survived
four implementations. It is written down here so it does not survive five: **the reference is not
the contract; when the two differ, this document wins.**

Rules:

- One worker process handles one capability (`capability` in the descriptor is what it implements).
- `id` is echoed unchanged. Responses may arrive in order; the host may pipeline requests but must
  not assume out-of-order completion. A response that fails to parse is a protocol error, not a
  warning: the worker is dropped.
- `ok: false` is a normal answer (bad input, refused work). A non-zero exit, a stderr line followed
  by exit, or a timeout is a crash, and the host then treats that worker as unavailable for the rest
  of the run and falls back to the reference.
- Error `code` comes from a closed set: `bad-input`, `unsupported`, `internal`, `timeout`.
- **Determinism is part of the contract.** The same input must produce byte-identical output JSON,
  including key order and array order, on any machine, in any of the languages. A capability that
  cannot promise this must declare `"deterministic": false` and is then excluded from the
  cross-implementation diff.
- Numbers are integers where the contract says integer; a double is formatted with the shortest
  round-trip representation (`JSON.stringify`-compatible). No locale-dependent formatting anywhere.
- Nothing is logged to stdout, ever — not a banner, not a version line, not a progress dot.
- **Flush stdout after every response line, before reading the next request.** This is not a style
  preference: C's stdio buffers fully when stdout is a pipe rather than a terminal, so a worker that
  writes a correct answer and does not flush answers *nothing* until it exits — and the host sees a
  timeout, not a buffering problem. The first C++ implementation was caught by exactly this, and it
  cost an hour of looking at a worker that was right. Flush stderr too when you write diagnostics,
  or a crash report arrives after the crash that mattered.

### 1.1 How a worker is started and registered

The host starts a worker with the capability it wants, as the first argument:

```
<artifact> --capability text.normalize
```

The worker answers `describe` with that capability, runs the request loop, and exits 0 on
`shutdown`. One extra argument is required of every implementation, because it is what makes the
worker testable on its own: `--selfcheck` runs a short built-in case list, prints one English line per
case plus a `N/M checks passed` summary, and exits non-zero on a failure (no protocol traffic on
stdout in this mode). Anything else on the command line is an error, reported on stderr with exit 2.
A worker that is asked to `invoke` a capability other than the one it was started with answers
`unsupported` and stays alive: the host launches one worker per capability, so the field is only
there to catch a wiring mistake, and answering it is cheaper to debug than ignoring it. A request line
that is not JSON cannot be answered with an echo of its `id`, so it answers `{"id": null, "ok": false,
"error": {"code": "bad-input", ...}}`; the message text is the language's own and is not compared.

`workers/registry.json` lists what exists:

```json
{
  "workers": [
    {
      "id": "java-text",
      "language": "java",
      "capabilities": ["text.normalize", "text.extract", "text.fingerprint"],
      "build": ["node", "workers/java/build.mjs"],
      "artifact": "workers/java/dist/vmltext.jar",
      "launch": ["java", "-Dfile.encoding=UTF-8", "-Dsun.stdout.encoding=UTF-8", "-jar", "workers/java/dist/vmltext.jar"],
      "notes": "JDK 17, no dependencies"
    }
  ]
}
```

`build` is run once per run when the artifact is missing or older than the sources; `launch` gets
`--capability <name>` appended. A missing artifact is reported as `[skip]`, never as a pass.

### 1.2 The Windows encoding trap (read this before writing a worker)

The transport is UTF-8 **bytes** on stdin, stdout and stderr, on every platform. On Windows that is
not the default in most languages, and it fails in the worst possible way: a worker that decodes
stdin with the system code page (GBK on a Chinese Windows) turns the contract's `text` into mojibake
while still looking like it works, and the corpus then blames the wrong implementation.

- **Java**: `System.out` uses the platform encoding on Java 17 (UTF-8 only from Java 18). Pass
  `-Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8`, or wrap
  `System.out`/`System.in` in explicit UTF-8 readers and writers. Do both if unsure.
- **Python**: `sys.stdin.reconfigure(encoding='utf-8')` and the same for stdout/stderr, or open the
  file descriptors in binary mode and decode explicitly.
- **C/C++**: read and write bytes (`fread`/`fwrite` on `stdin`/`stdout` in binary mode:
  `_setmode(_fileno(stdout), _O_BINARY)` on Windows). Never use the wide-character console APIs.
  **And do not read through a buffered `fread` either**: on a pipe it keeps asking for bytes until its
  4096-byte buffer is full, so a worker whose host holds stdin open answers *nothing* while
  `echo ... | worker` looks perfect. Read the descriptor unbuffered (`_read`/`read`) or line by line.
  This is the second half of the same trap and it is what actually broke the first C++ worker: the
  flushes were already correct, the reads were not.
- **Go**: already UTF-8; make sure the binary is built for the host platform.
- **Shell**: `pwsh` needs `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)`; POSIX
  shells need `LC_ALL=C.UTF-8` (or a `UTF-8` locale) and must not rely on the terminal's code page.
- Also true for the **decimal separator**: never format a number with a locale, and never parse one
  that way. `1,5` is a bug in this protocol.
- **Line endings are part of the same family, and one language cannot obey them.** The transport is
  LF. Most languages emit LF without being asked, but **base R on Windows cannot**: its stdout is a
  text-mode CRT stream that rewrites every LF as CR LF, `writeBin(..., stdout())` refuses with "can
  only write to a binary connection", `file("stdout", "wb")` is not special-cased and creates a file
  literally named `stdout`, and flipping the flag with `_setmode` through the CRT does not affect an
  already-initialised stream. The R implementation answers with CR LF, says so in its README, and is
  right to: the host parses JSON, and a trailing CR is whitespace there. This is a "this language
  cannot do X exactly" result rather than an approximation — and the rule for reporting one is the
  same as everywhere else here: write it down, in the README, with the evidence.

## 2. Capability: `text.normalize`

The normalizer is the base of the text pipeline (fetch -> extract -> normalize -> fingerprint), and
it is where independent implementations normally disagree, because every language ships different
case tables and different Unicode normalization. Two decisions remove that entire class of
divergence:

- **No general Unicode normalization.** `NFKC`/`NFD` are not required and must not be used: Java,
  Python and JavaScript have them, C++ and Go (without extra modules) do not, and the tables differ
  by Unicode version. The contract uses explicit, listed rules instead.
- **The case and fold tables are shared data**, not per-language library behaviour:
  `workers/spec/latin-lower.json` and `workers/spec/latin-fold.json`. Every implementation reads
  them (or embeds them at build time); nobody consults their own runtime's tables. A language whose
  standard library would do more is expected to do exactly what the tables say and no more.

Input `{"text": string}` -> output `{"text": string}`. Steps, in this order, over Unicode scalar
values:

1. **Delete** these code points: `U+0000-U+0008`, `U+000B`, `U+000C`, `U+000E-U+001F`, `U+007F`,
   `U+200B-U+200F`, `U+202A-U+202E`, `U+2060-U+2064`, `U+FEFF`, and the combining marks
   `U+0300-U+036F`, `U+1AB0-U+1AFF`, `U+1DC0-U+1DFF`, `U+20D0-U+20FF`, `U+FE20-U+FE2F`. (Tab, LF and
   CR are not deleted; step 5 folds them into spaces. Deleting the combining marks is what makes a
   decomposed string — `e` + `U+0301`, which is what half the feeds on the web contain — compare
   equal to its composed form, without asking any language for NFKC.)
2. **Map** code points, one to one, using this table (anything not listed is left alone):
   | From | To |
   | --- | --- |
   | `U+00A0`, `U+2000-U+200A`, `U+2028`, `U+2029`, `U+202F`, `U+205F`, `U+3000` | `U+0020` space |
   | `U+FF01-U+FF5E` | subtract `0xFEE0` (full-width ASCII -> ASCII) |
   | `U+2018`, `U+2019`, `U+201B`, `U+2032` | `'` |
   | `U+201C`, `U+201D`, `U+201F`, `U+2033` | `"` |
   | `U+2010`, `U+2011`, `U+2012`, `U+2013`, `U+2014`, `U+2015`, `U+2212` | `-` |
   | `U+2026` | `...` |
   | `U+3001` | `,` |
   | `U+3002` | `.` |
3. **Lowercase** exactly what `workers/spec/latin-lower.json` says, and nothing else. The table
   covers `U+0000-U+024F` only, one code point to one code point. `U+0130` (Latin capital I with
   dot above) is deliberately **absent**: its real lowercase is two code points, and a
   one-to-one table must not pretend otherwise.
4. **Fold** accents exactly as `workers/spec/latin-fold.json` says: a code point maps to an ASCII
   string of one or two characters (`é` -> `e`, `ø` -> `o`, `ß` -> `ss`, `Æ` -> `AE`). Folding
   happens *after* lowercasing, so the tables are applied in that order and both are needed.
5. **Collapse** runs of `U+0020`, tab, LF and CR into a single space.
6. **Trim** leading and trailing spaces.

Invariants (asserted by the corpus, not by hope):

- Idempotent: `normalize(normalize(x)) == normalize(x)` for every case.
- Output contains no deleted code point, no mapped code point, no table entry, no run of two
  spaces, and never starts or ends with a space.
- Han, kana, Hangul, Cyrillic, Arabic, Thai and every other script the tables do not mention pass
  through **unchanged**: this normalizer is Latin-oriented on purpose and must not quietly mangle
  the other 24 interface languages the project ships.

## 3. Capability: `text.extract`

Input `{"html": string, "baseUrl": string | null}` -> output
`{"title": string, "text": string, "links": [{"href": string, "absolute": boolean, "text": string}], "images": number}`.

A specified state machine, not "whatever the runtime's HTML parser does" (there is no HTML parser in
C++ or Go without a dependency, and the project has no HTML dependency on purpose).

**Pass order matters, and the numbering below is not the order to run the passes in.** The observable
order is: hide every CDATA body first, then remove comments and doctypes, then remove the listed
elements (step 1) with their content, and only then walk what is left (steps 3 to 7). The corpus pins
the consequence: a CDATA section inside a removed element is removed with it, while a `<script>` inside
a CDATA *body* is text and survives (`cdata-inside-removed-element`). An implementation that removes
elements before hiding CDATA gets that case wrong — the Go implementation did, and this paragraph
exists because of it. The reference implementation runs the passes in this order; the numbers below
are a description of the rules, not a schedule.

1. Remove, with their content, the elements `script`, `style`, `noscript`, `template`, `svg`,
   `iframe` (tag names matched case-insensitively; a missing closing tag means "to end of input").
2. Remove `<!-- ... -->` comments and `<!DOCTYPE ...>` declarations. `<![CDATA[...]]>` keeps its
   inner text.
3. Newline instead of a tag, on both the opening and the closing tag, for exactly:
   `br`, `p`, `div`, `li`, `ul`, `ol`, `tr`, `th`, `td`, `h1`, `h2`, `h3`, `h4`, `h5`, `h6`,
   `section`, `article`, `header`, `footer`, `aside`, `nav`, `blockquote`, `pre`, `table`, `hr`,
   `dd`, `dt`, `figure`, `figcaption`, `main`, `form`.
4. Every other tag is dropped; its text content stays. `<a href="...">text</a>` additionally
   produces a link entry: `href` **verbatim** (no resolution — resolving URLs needs a URI library
   that C++ does not have, and it would put a network-semantics question inside a text function),
   `absolute` = whether the href starts with a scheme (`[A-Za-z][A-Za-z0-9+.-]*:`), and `text` =
   the text between `<a>` and `</a>` with tags dropped and entities decoded, untouched otherwise
   (no case folding, no whitespace collapsing — the link's text obeys exactly the same rules as the
   main text, and nothing here normalizes). Three anchor rules the corpus pins, because each of them
   is otherwise guesswork. **Nesting:** HTML does not allow nested anchors and a browser closes the
   open one and starts the new one, so the outer link is reported with the text it had collected and
   the inner becomes the open anchor. An earlier version of this document said "ignore the inner
   anchor", which was simpler and **silently dropped a link** — the Go implementation flagged it, and
   it was worth the three implementations having to change. **No `href`:** an anchor without one still
   produces an entry, with an empty `href`. **Unclosed:** an anchor still open at the end of the input
   is reported with the text it collected, rather than dropped.
5. The first `<title>` outside a removed element becomes the output title. **The title's own text is
   not part of `text`** — a browser does not render it either, and entities inside it belong to the
   title, not to the body. A missing title is the empty string, never `null`.
6. Entities: decode `&amp; &lt; &gt; &quot; &apos; &nbsp; &mdash; &ndash; &hellip; &laquo; &raquo;
   &copy; &reg; &trade; &times; &middot;` — each to **its own character** (`&nbsp;` is `U+00A0`,
   `&mdash;` is `U+2014`, `&copy;` is `U+00A9`, `&times;` is `U+00D7`), never to the ASCII
   approximation that the normalizer would produce later: this function reports what the source
   says, and turning `U+2014` into `-` is the normalizer's job. The names are matched
   case-insensitively (`&AMP;` decodes) and are decoded with **or without** the trailing semicolon, as
   browsers do; numeric references `&#DDD;` (1-7 decimal digits) and `&#xHHH;` / `&#XHHH;` (1-6 hex
   digits) are also accepted with or without it, so `&#65` is `A`. The reference is looked for within
   12 characters of the `&`, and there is no backtracking: `&copy2024` stays literal. An unknown name
   stays verbatim; a lone `&` stays. Nothing here normalizes — the host composes `extract` and
   `normalize` when it wants one plain line.
7. `images` counts `<img` tags (case-insensitive, tag boundary respected).
8. **`extract` never normalizes.** The extracted text keeps its newlines, the title and every link
   text keep their case and their accents. Normalization is a separate capability, and the host
   composes `extract -> normalize` when it wants one line (which is what the product's digest does).
   A worker that quietly normalized here would make the two capabilities impossible to test apart,
   and would hide a wrong rule in one of them behind the other.

Bracket and quote rules, stated because they are where hand-written parsers diverge: `<` starts a
tag only when followed by `[A-Za-z/!]`, otherwise it is literal text; inside a tag, `'` and `"`
delimit attribute values and a `>` inside them does not end the tag; text outside any tag is copied
verbatim.

An input that ends **inside** a tag is the case where implementations silently disagree, so it is
pinned: the incomplete tag is dropped, including the characters of its name — `extract("abc<b").text`
is `"abc"`, exactly as a browser's `eof-in-tag` handling drops it — while a `<` with nothing at all
after it is literal text (`extract("a<").text` is `"a<"`, which is the browser's `tag-open` state).
This was found by an implementation reading the contract more literally than the reference did; the
corpus had no case for it at the time, and now it does.

## 4. Capability: `text.fingerprint`

Input `{"text": string}` (normalized text) -> output
`{"simhash": string, "tokens": number, "shingles": number}`.

- **Tokenize** on single spaces (the normalizer guarantees there are no runs). For each token:
  1. strip leading and trailing ASCII punctuation (the set in step 3 below). `"hello,"` and
     `"hello"` must produce the same token, or every title ending in a full stop is its own
     duplicate as far as the fingerprint is concerned. This rule was in the reference before it was
     in this document, which is its own small lesson about which one people implement.
  2. walk what is left and group code points into runs by class: CJK = Han `U+3400-U+4DBF`,
     `U+4E00-U+9FFF`, `U+F900-U+FAFF`, kana `U+3040-U+30FF`, Hangul `U+AC00-U+D7AF`; everything else
     is "other". A CJK run of length 1 emits that one code point; a CJK run of length n >= 2 emits its
     n-1 overlapping bigrams; an "other" run emits itself.
  3. emit nothing at all if the token is empty after trimming, or consists only of ASCII punctuation
     from `!?,.;:'"()[]{}<>-_/\\|*+=~`@#$%^&`.
- **Shingles** are overlapping runs of 3 consecutive emitted tokens. Fewer than 3 tokens: the whole
  token list joined by a space is the single shingle; no tokens at all: no shingles.
- **Hash** each shingle with FNV-1a, 64-bit, over its UTF-8 bytes: start at `14695981039346656037`,
  for each byte `b`: `h = h XOR b`, then `h = (h * 1099511628211) mod 2^64`. Unsigned arithmetic
  throughout; the result is the hash.
- **SimHash**: keep 64 counters. For each shingle hash and each bit position `i` in `0..63`, add 1
  if that bit is set, otherwise subtract 1. Bit `i` of the output is 1 when its counter is `> 0`,
  and 0 on a tie. Print as 16 lowercase hex characters, zero-padded.

All integer arithmetic, so "byte-identical across languages" is achievable rather than aspirational;
`tokens` and `shingles` are the counts of emitted tokens and of shingles actually hashed.

## 5. Conformance: how the implementations supervise each other

- The corpus lives in `workers/spec/cases/<capability>.json`: hand-written inputs, including the
  nasty ones (unclosed tags, entities without semicolons, mixed scripts, zero-width characters,
  full-width ASCII, an idempotency pair, an empty string, a 10 KB document).
- `workers/spec/expected/<capability>.json` holds the reviewed snapshot of the reference output.
  It is regenerated only deliberately, and the change is reviewed like a test fixture.
- `npm run workers` (tool: `tools/workers.mjs`) runs every case through **every implementation**:
  the JavaScript reference plus every registered worker that is built and available.
- An implementation that answers nothing is reported **once** as `UNUSABLE`, not once per case: one
  unflushed worker once turned 58 clean cases into 58 apparent divergences, which is a report that
  hides the truth rather than showing it. An implementation whose interpreter is not installed is a
  `[skip]`, never a failure — this layer is meant to run on machines that have different subsets of
  Java, Go, R, J, an APL interpreter and three shells.
- `--published-only` ignores `workers/registry.local.json`, so it answers the question a fresh clone
  asks: *what do the published implementations do?* A worker under development is machine-local by
  construction and must not make the published set look broken.
- `--build-only` compiles everything that is missing and stops; `--cap` and `--only` narrow a run;
  `--update` re-records the snapshot from the reference.
- The primary verdict is the **cross-implementation diff**, not "matches the reference": the tool
  reports, per case, the set of implementations that agree with each other, and names the ones that
  diverge. A worker that matches the reference while three others agree on something else is a
  finding, not a pass.
- A case where all implementations agree but disagree with the snapshot fails too — that is how the
  contract itself gets corrected, by editing the snapshot *and* the reference together, on purpose.
- `npm run workers -- --list` shows which languages/capabilities are present and which are missing a
  build; a missing worker is reported as `[skip]`, never as a pass, and never as a failure.
- The corpus is a floor, not a ceiling. `npm run workers:diff` (tool: `tools/workers-diff.mjs`) points
  the same diff at **generated** input: a seeded generator per capability produces cases nobody wrote
  down - random markup with quoted `>`, CDATA, astral characters, compatibility forms, schedules with a
  contended request budget - and every implementation answers the same generated case, so the verdict
  is still the cross-implementation diff. Everything is seeded, so a divergence is reproducible from
  the seed and case index it prints, and each one is printed as a ready-to-paste corpus entry:
  promoting a case is a review decision, so the tool never writes to `workers/spec/` itself. It fuzzes
  the published registry only, because a worker under development would report its own half-finished
  state as a divergence of the layer. Every case is also asked **twice**, the second time in the opposite
  order: every capability here is specified to be deterministic, so the repeat catches a hash-map order
  leaking into an answer, a random seed a runtime picked for itself, and state a worker kept between
  requests - and it is the one check that still means something for a capability with a single
  implementation, which is what the newest capability has today.
- A second implementation is also how a *contract* gets tested, not only an implementation. The Go
  worker found a hole in section 10 on its first run: for an `egress` of `5` it answered `bad-input`
  while the JavaScript reference reported `no-egress`, and both readings followed from the text - the
  shape paragraph said one thing and rule 1 said another. The contract now decides (a non-string egress
  is `bad-input`, because a typo in a type must not come back as a plausible-looking plan), the reference
  was corrected to match, and the corpus pins it. That is what "the implementations supervise each other"
  is supposed to mean: the disagreement was worth more than the implementation.
- That is not a hypothetical: the first fuzz run found a real bug in a published worker. The PowerShell
  implementation rejected **every** astral code point - it walked UTF-16 code units and asked .NET for a
  code point by code unit, which throws on a lone surrogate - so an emoji, which a Vtuber monitoring tool
  sees constantly, came back as `bad-input` while five other implementations normalized it. The fuzzer
  shrank it to the single code point `U+1F600` and the corpus now pins it.

## 6. Adding a language

1. Create `workers/<language>/` with the implementation and a `build.mjs` that compiles it using
   whatever the machine has (MSVC/Clang/GCC for C++, `javac` for Java, `go build` for Go, the
   interpreter for Python) and prints the artifact path.
2. Answer `describe`, then implement the capability against the tables in `workers/spec/`.
3. Register it in `workers/registry.json` (language, capability, build command, artifact path,
   launch command).
4. Run `npm run workers` and make it agree. If it cannot agree, that is either a bug in the
   implementation or a hole in this document - report the second case rather than bending the
   implementation around it.

## 7. Borrowed paths: using what the machine already has

Two things this layer needs are already installed here, and borrowing them is better than adding
another copy of anything:

- **A second Node runtime from the editor.** VS Code ships its own Node, reachable through its
  Electron binary: `ELECTRON_RUN_AS_NODE=1 "<Code.exe>" script.mjs` (find `<Code.exe>` from
  `code --version`, or from wherever the `code` shim points). On this machine that is a different
  patch release from the system Node, which makes it useful for the one question a single runtime
  cannot answer: *does the tooling actually depend on this Node build, or would any do?* Run
  `npm run workers` under both and compare.
- **A real MSVC environment without installing one.** Visual Studio is present, so a native worker
  can be built with `cl` instead of MinGW:
  `& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -property installationPath`
  gives the instance directory, and `VC\Auxiliary\Build\vcvars64.bat` inside it sets up `cl` for a
  shell. The C++ worker's `build.mjs` is expected to prefer `g++`, fall back to `clang++`, and then
  to this MSVC route — and to say in its README which one it used, because "it compiled" is not the
  same statement in three different compilers.
- **Editor tasks instead of remembered commands.** `.vscode/tasks.json` in this repository wires the
  build-all, self-check and conformance commands, so a contributor can run the layer without reading
  this document first. Nothing in it may contain an absolute path from one machine: the repository
  is published, and the release checks reject machine-specific paths.

## 8. Where this stands, and what is deliberately not here yet

Landed: the contract, the two shared tables, the reference implementation, 115 corpus cases with a
reviewed snapshot, the conformance runner (`npm run workers`), the differential fuzzer
(`npm run workers:diff`), and implementations in JavaScript, Java, C++, Go, Python, PowerShell and SQL.
Editor tasks live in `.vscode/tasks.json`, and a CI job builds, diffs and fuzzes the layer on Linux and
Windows (macOS informationally). The state of agreement is not a number to keep in this paragraph: the
runner prints it, section 5 says how to read it, and `docs/BUGS.md` records what is currently open.

Deliberately not here yet:

- **No packaging into the release artifact.** The portable exe is unchanged and the release checks do
  not know about `workers/`. This layer has to earn its way in: it is published as source first.
- **The machine-local workers are not in the published registry.** Some implementations depend on
  interpreters that not every machine has - R, J and the POSIX shell ones today; they live in
  `workers/registry.local.json`, which is gitignored, and the harness reports them as `[skip]` elsewhere
  rather than failing. A worker that cannot start is not a worker that is wrong.
- **`search.query` is implemented by three workers now** - the JavaScript reference, a Java inverted
  index and a SQL one - and `fetch.plan` is specified in section 10 with a JavaScript reference and a Go
  implementation on the way, because concurrency and per-egress limits are what Go is here for. What is
  left after that is the LLM/vision glue (Python).
- **No float-scored capability.** Scores across languages are a precision trap, so anything that ranks
  will specify integer arithmetic or an explicit tolerance, and the choice will be written down here
  before the first implementation of it exists.
- **Known open items.** Six implementations agree on every corpus case except the one this section's
  fuzzer pinned and whose fix is still in flight (see section 5 and `docs/BUGS.md`), so what is left
  here is what the corpus still cannot see. Malformed-request error *text* differs per language by
  design. The
  **removed-element pre-scan ends an opening tag at the first `>`**, so a quoted attribute containing
  `>` (`<script src="a>b">`) is mis-scanned and the whole element may not be removed; the main tag
  scanner *is* quote-aware, so this is an inconsistency between two passes of the same function. No
  corpus case covers it, and it is recorded here rather than fixed because fixing it means changing
  six implementations for a malformed-input edge — the honest sequence is to pin it first, then fix
  it, and nobody has needed it yet. The corpus is a
  floor, not a ceiling: two of the four bugs the reference had were found by an implementation
  diffing itself against the reference over inputs the corpus did not contain, which is the strongest
  argument yet for keeping more than one implementation around.

## 9. Next capability, specified before it exists: `search.query`

Written down first on purpose. A ranked capability is the one place where four languages can quietly
disagree forever: a floating-point score computed in a different order is a different number, and
"the results look about right" is not a verdict. So this specification has **no floats at all**, a
total ordering, and a specified key order for every object whose order a hash map could decide.

Input:

```json
{
  "docs": [
    {"id": "b1", "title": "…", "text": "…", "tags": ["nijisanji", "3d"], "ts": 1735689600000},
    {"id": "b2", "title": "…", "text": "…", "tags": [], "ts": null}
  ],
  "query": {"terms": ["openai", "已经"], "match": "all", "tags": ["nijisanji"], "from": null, "to": null},
  "limit": 20
}
```

- `docs` arrive **already normalized** — the host composes `text.normalize`; the same is true of
  `query.terms` and `query.tags`. A search worker therefore does not need the normalizer, and a worker
  that normalizes again anyway will produce a different answer on the combining-mark cases.
- `ts` is epoch milliseconds or `null`. `match` is `"all"` (default) or `"any"`. `limit` of `0` means
  no limit; a negative `limit` is `bad-input`.

Matching:

- Tokenize a field exactly as `text.fingerprint` does — whitespace split, edge punctuation trimmed,
  CJK runs as bigrams. A field's tokens form a **set**: order does not matter and duplicates collapse.
- A **term matches a field** when every token of the term is in that field's set. So `已经` matches a
  document whose text contains `已经开播` (through the bigram), and `openai gpt` matches only when both
  are present.
- A term is **matched by a document** when it matches the title, the text, or any tag. **The tag field
  is a list of sets, one per tag**: the term's tokens must all sit inside a *single* tag, so
  `tags: ["openai", "gpt"]` does **not** match the term `openai gpt` while `tags: ["openai gpt"]` does,
  and the +2 term score below obeys the same rule. This was written down only after two implementations
  read it the other way (one unioned the tags into a single token set); the corpus case
  `tag-tokens-must-share-one-tag` exists because the sentence above did not say it outright.
- A term with **no tokens at all** (a query of `"---"`) matches no document: "every token is in the
  set" is vacuously true for an empty token list, which would otherwise match everything.
- `excludedByTime` counts documents that passed the tag and term filters and were then dropped by the
  time range — not every document that carries no `ts`. Both implementations chose that order and the
  corpus case `excluded-by-time-counts-only-matching-docs` pins it.
- `match: "all"` requires every term to be matched by the document; `"any"` requires one. An empty
  `terms` list matches everything (that is how a filter-only query works).
- `query.tags` requires every listed tag to be present in the document's tags, compared as exact
  strings after normalization.
- `from`/`to` are inclusive bounds on `ts`. A document with `ts: null` is excluded as soon as either
  bound is set, and counted in `excludedByTime` rather than silently dropped — the product reports
  "excluded by the time filter" separately for exactly this reason.

Score — integers, and a term can earn all three:

| Condition | Points |
| --- | --- |
| the term matches the title | +3 |
| the term matches any tag | +2 |
| the term matches the text | +1 |
| every term in the query matches the title (whole-query bonus) | +4 |
| `terms` is empty | 0 |

Ordering — complete, so no two implementations may disagree:

1. score, descending
2. `ts`, descending, with `null` last
3. `id`, ascending, compared as **UTF-8 bytes** (not locale collation: "natural" ordering is a
   per-language opinion, and this contract has enough opinions already)

Output:

```json
{
  "hits": [{"id": "b1", "score": 5}],
  "total": 12,
  "facets": {"tags": {"nijisanji": 4}, "months": {"2025-01": 3}},
  "excludedByTime": 2
}
```

- `hits` is truncated to `limit`; `total` counts every matching document before the limit.
- `facets.tags` counts the matching set (before the limit); `facets.months` buckets by the UTC
  `YYYY-MM` of `ts` over the same set, and a `null` `ts` contributes to no month.
- Both facet objects are emitted with keys sorted ascending by UTF-8 bytes, so an unordered map cannot
  leak into the answer. The same rule applies to `hits`: it is an array, so it cannot.

Planned implementations, in the order they will be attempted: the JavaScript scan (the reference, and
the project's own `server/src/search.js` semantics adapted to this shape), the **Java inverted index**
(which is what a JVM brings to this problem), SQLite through `node:sqlite` as the **SQL** implementation (the SQL
language, not a library: the query *is* the implementation), and then whichever of C++, Go or Python
wants a turn. When two of them agree on a corpus with no floats and a total ordering, the agreement
means something.

## 10. Next capability, specified before it exists: `fetch.plan`

The fourth capability, and the first one that is about *when* rather than *what*. It is written down
before an implementation exists for the same reason section 9 was: a scheduler is a pile of rules that
each look obvious alone and produce different answers in different languages.

Only the **planning** is in this capability - deciding which sources to fetch now, on which egress, in
what order, and what to defer. The fetching itself stays in the application: a capability that performs
network I/O could not be diffed across implementations on a machine with no network, and the part worth
comparing is the arithmetic.

Input:

```json
{
  "now": 1735689600000,
  "sources": [
    {"id": "s1", "egress": "direct", "due": true,  "minIntervalMs": 600000, "lastRunAt": 1735680000000},
    {"id": "s2", "egress": "direct", "due": false, "minIntervalMs": 600000, "lastRunAt": null},
    {"id": "s3", "egress": "tor",    "due": true,  "minIntervalMs": 0,      "lastRunAt": null}
  ],
  "egress": {
    "direct": {"maxConcurrent": 4},
    "tor": {"maxConcurrent": 1}
  },
  "budget": {"maxRequests": 20, "maxPerEgress": {"tor": 3}}
}
```

- `now` and `sources` are required: `now` is epoch milliseconds and comes from the caller, never from
  the worker's own clock. Every source needs a non-empty string `id`, and `id`s are what the output
  refers to sources by. `due`, `minIntervalMs` (default `0`) and `lastRunAt` (default `null`, meaning
  never run) are optional; a `lastRunAt` that is present must be a number or `null`. An `egress` entry
  may carry `maxConcurrent` (default `1`). Anything outside those shapes is `bad-input`.

Output:

```json
{
  "batches": [{"egress": "direct", "sources": ["s2", "s1"]}, {"egress": "tor", "sources": ["s3"]}],
  "deferred": [{"id": "s9", "reason": "budget"}],
  "skipped": [{"id": "s7", "reason": "no-egress"}],
  "counts": {"planned": 3, "deferred": 1, "skipped": 1}
}
```

Rules, in the order they are applied:

1. **Egress must exist.** A source whose `egress` is not a key of the input's `egress` object is
   **skipped** with reason `no-egress`, whatever the clock says: that is a broken configuration the
   user has to fix, not a source that is merely early. A source whose `egress` is not a **string** at all
   is `bad-input` instead, and the difference is the point: a typo in a type is a malformed request, and
   answering it with `no-egress` would dress it up as a plausible-looking configuration problem. Rule 2
   treats a non-boolean `due` as absent rather than as an error, because an optional flag that is missing
   only means "not forced", while the field that routes the request is not optional and has no default.
   Skipped means "this source cannot be planned at
   all"; deferred means "not this round". The distinction is what the application shows a user, so it
   is part of the contract.
2. **Due.** A source is due when `due` is `true`, or when `lastRunAt` is `null` (never run), or when
   `now - lastRunAt >= minIntervalMs`. A missing `minIntervalMs` is `0`. A source that is not due is
   **deferred** with reason `interval`. `lastRunAt: 0` is a timestamp, not "never": the epoch is a
   legitimate value, and reading it as absent is the mistake this rule exists to prevent.
3. **Order.** Within one egress, due sources are ordered by `lastRunAt` ascending with `null` first
   (the ones that have waited longest go first; a source that has never run waits longest of all), then
   by `id` ascending compared as UTF-8 bytes. An implementation that leaks a hash-map order into the
   answer fails the harness's ordering check, and one that sorts by locale-aware collation fails the
   corpus: `z` sorts before `é` in UTF-8 bytes and after it in most collations.
4. **Batches.** One batch per egress, holding at most that egress's `maxConcurrent` sources; a missing
   `maxConcurrent` is `1`, and anything below `1` is `bad-input`. Egresses are emitted in ascending
   UTF-8 byte order of their names. An egress with no due sources gets no batch (not an empty one).
5. **Budget.** `budget.maxRequests` caps the total number of planned sources; `budget.maxPerEgress`
   caps per egress and is applied first. A due source that does not fit is **deferred** with reason
   `budget`. A missing budget field means no limit; a budget of `0` means nothing is planned. Because
   egresses are visited in name order, a shared budget is spent in that order - which is why that order
   is part of the contract and not an implementation detail.
6. **Counts and list order.** `counts.planned` is the number of sources across all batches, and
   `counts.deferred` and `counts.skipped` are the lengths of those lists; all three are integers. Both
   lists are emitted sorted by `id` ascending as UTF-8 bytes, so that two runs in two languages can be
   compared as reports and not only as sets. Source ids are assumed unique: duplicates are neither
   merged nor rejected.

Determinism: no clock is read (`now` is an input), no randomness, no floats, and every list has a
specified order. That is what makes a scheduler comparable across languages at all - and Go is the
first implementation planned for it, because concurrency and scheduling are what Go is for in this
project, with the JavaScript reference alongside it so the corpus has something to diff against.

## 11. Next capability, specified before it exists: `llm.parse`

The LLM and vision glue the project planned for Python is two problems wearing one name: **asking** a
model (HTTP, retries, a key, a budget) and **believing** what it answered. Only the second one is a
capability here. The asking half is I/O and stays in the application, where the mock LLM and the mock
vision server already live; the believing half is pure text work over a response that is *dirty by
nature*, which is exactly the kind of thing that several languages get subtly and silently different.

A model answers with a fenced block, or with prose around the object, or with a trailing comma, because
a trailing comma is legal in every language the model was trained on that is not JSON. It answers with
tags that are not in the vocabulary, with the same tag twice in two spellings, with a summary longer
than the field can hold. `llm.parse` turns that answer into the small, checked structure the rest of the
application is allowed to depend on, and it says what it had to throw away.

Input:

```json
{
  "raw": "Sure!\n```json\n{\"tags\": [\"Debut\", \"3d\", \"debut\"], \"summary\": \"...\"}\n```\n",
  "vocabulary": ["debut", "3d", "karaoke"],
  "maxTags": 5,
  "maxSummaryChars": 200
}
```

Output:

```json
{
  "tags": ["debut", "3d"],
  "summary": "...",
  "dropped": [{"value": "debut", "reason": "duplicate"}, {"value": "singing", "reason": "not-in-vocabulary"}],
  "repaired": true,
  "counts": {"tags": 2, "dropped": 2, "truncated": 0}
}
```

Rules, in the order they are applied:

1. **Find the payload.** If the first non-whitespace characters of `raw` are three backticks, drop the
   rest of that line (a language tag after the fence goes with it) and stop at the next line whose
   content is exactly three backticks - a trailing carriage return is not content, since model output
   arrives over HTTP with either line ending - or at the end of the input if there is none. Then take
   the first `{` and the `}` that closes it, counting depth and **ignoring braces inside JSON strings**:
   a string opens at an unescaped `"`, closes at the next unescaped `"`, and a backslash escapes exactly
   the character after it. Everything outside that slice is discarded.
2. **Repair, narrowly.** Exactly one repair is specified, because it is the one models actually
   produce: a comma followed - after whitespace only - by `}` or `]` is dropped. A comma inside a string
   is a character of that string, so the removal has to respect string state; a parser that strips one
   there is corrupting data, and precision matters more than tolerance here.
3. **Parse.** The slice is parsed as JSON, and JSON here means RFC 8259: a control character inside a
   string has to be escaped, and an implementation must not reach for a lenient parser that accepts one,
   because that returns a tag nobody asked for and calls it a success. If parsing fails - and equally
   when no complete object is found at all - an implementation must **not** attempt partial recovery: the
   answer is `tags: []`, `summary: ""`, both counts zero and `repaired: true`, because an answer that had
   to be recovered from is by definition not the answer that was sent. A parser that half-reads a broken
   answer is worse than one that reports nothing, since the application cannot tell the difference
   afterwards.
4. **`tags`** must be an array; anything else - including a string like `"debut, 3d"` - contributes no
   tags and no dropped entries, because splitting a free-form string is guessing, not parsing. An element
   that is not a string is dropped with reason `not-a-string`, and its `value` is its JSON text with no
   insignificant whitespace: integers as decimal digits, `true`/`false`/`null` as written, strings in
   their JSON form, arrays and objects compactly with their original key order. Numbers that are not
   integers are outside the corpus on purpose - serializing a float is a formatting decision that each
   language makes differently, and this capability does not need one. Each tag string is trimmed of
   leading and trailing whitespace; an empty tag is dropped with reason `empty`.
5. **Matching is ASCII case-insensitive and nothing else.** A tag matches a vocabulary entry when the
   two are equal after folding `A`-`Z` to `a`-`z`; the **output uses the vocabulary's spelling**, so a
   model that writes `Debut` cannot change the application's own labels. Folding is ASCII-only on
   purpose: a locale-aware lowercase would make the answer depend on the *interface language* of the
   machine that ran it - Turkish `I` alone is enough to prove that - and a capability whose output
   depends on the runner's locale is not a capability. No match is reason `not-in-vocabulary`, reported
   with the trimmed tag as it arrived.
6. **Duplicates** are decided on the matched, canonical form: the first occurrence wins, and every later
   one is dropped with reason `duplicate` and the canonical form as its `value`.
7. **`maxTags`** (default `0`, meaning no limit) keeps the first N tags in the model's own order after
   deduplication; the rest are dropped with reason `over-limit` and the canonical form as their `value`.
   A negative `maxTags` is `bad-input`; so is a `raw` that is not a string, and a `vocabulary` entry that
   is not a string.
8. **`summary`** that is not a string is `""` (a model that answered a list where a string was asked for
   is a prompt problem, not a parse error). It is trimmed, then truncated to `maxSummaryChars`
   **code points** (default `0`, no limit). Code points, not UTF-16 code units: truncating an emoji in
   half produces a lone surrogate, which is not text and cannot be re-encoded. `counts.truncated` is how
   many code points were removed.
9. **`repaired`** is `true` when anything had to be fixed: a fence was stripped, the payload slice is not
   the whole trimmed input, or at least one trailing comma was removed. The application uses it as a
   prompt-quality signal, so it must mean "the answer arrived malformed", not "the answer was parsed".
10. **`dropped` is sorted** by `value` then by `reason`, each compared as UTF-8 bytes, so the same answer
    produces the same report in every language. `counts` holds integers.

Determinism: no clock, no randomness, no network, no floats, and every list has a specified order. The
model call is the application's business; this is the part where two languages can be compared, and
where a wrong answer is a wrong tag in the user's face.

The first implementation of it is planned for **Python**, because that is the half of the project the
LLM glue was planned in - with the JavaScript reference beside it, as with every other capability, so
the corpus has something to diff against rather than something to trust.
