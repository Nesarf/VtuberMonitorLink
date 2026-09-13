# Python text worker (`vmltext.py`)

The Python implementation of the project's three text capabilities — `text.normalize`, `text.extract`
and `text.fingerprint` — specified by `docs/WORKERS.md` sections 1–4 and diffed byte-for-byte against
the JavaScript reference and the Java, C++ and Go workers.

Standard library only. No third-party packages, nothing downloaded, no network at run time.

- **Artifact:** `workers/python/vmltext.py` (this file is the artifact — see "No build step" below)
- **Launch:** `python workers/python/vmltext.py --capability <name>`
- **Capabilities:** `text.normalize`, `text.extract`, `text.fingerprint` (one process, one capability)
- **Worker id:** `python-text`

## How to run

```bash
# from the repository root
python workers/python/vmltext.py --capability text.normalize    # stdio JSON-Lines protocol
python workers/python/vmltext.py --selfcheck                    # 31 built-in cases, no protocol traffic
node   workers/python/build.mjs                                 # interpreter check; prints the artifact path
node   tools/workers.mjs --only python-text --no-build          # the corpus against this worker
```

One request per line on stdin, one response per line on stdout, UTF-8, LF, no BOM:

```
{"id":1,"op":"describe"}
{"id":2,"op":"invoke","capability":"text.normalize","input":{"text":"..."}}
{"id":3,"op":"shutdown"}
```

Nothing but protocol lines ever reaches stdout (including the startup line, which is a human-readable
diagnostic and goes to **stderr**). `--selfcheck` prints its 31 English result lines to stdout and its
failure details to stderr, and exits non-zero on failure.

Argument handling: `--capability <name>` and `--selfcheck` are the only accepted command lines.
Anything else — no arguments, an unknown flag, an extra word, or a capability this worker does not
implement — is reported on stderr and exits **2**, so the host sees a refused start rather than a
worker that answers `unsupported` to everything.

## Interpreter

The interpreter is whatever `python` resolves to; this repository's machine has **Python 3.14.7** on
`PATH` (`python --version` → `Python 3.14.7`). The code targets Python 3.13+ (it uses
`sys.stdin.reconfigure`, `str.removeprefix`-era APIs are not needed, and no 3.14-only syntax is used),
so a plain 3.13 install works identically.

On the Windows encoding trap (contract section 1.2): `configure_stdio()` calls
`reconfigure(encoding='utf-8', newline='\n')` on stdin, stdout and stderr, **and** stdout is written
as explicit UTF-8 bytes (`sys.stdout.buffer.write(...)`), so the protocol stream ends each response
with a lone LF instead of the platform's CRLF. That byte-level write is what makes "byte-identical
output JSON" true on Windows as well as on Linux.

## No build step

Python is interpreted: `workers/python/build.mjs` compiles nothing and does not pretend to. It checks
that a usable interpreter exists (trying `python`, then `py -3`), runs `--selfcheck` to prove the
artifact starts and can read `workers/spec/*.json`, prints the interpreter command and the artifact
path as its last stdout line, and exits non-zero with an English message when no Python 3 interpreter
is present — so the host reports the worker as `[skip]` rather than as a pass.

## Strategy

**Tables, not the runtime's Unicode data.** `workers/spec/latin-lower.json` and `latin-fold.json` are
read from disk at startup and applied as data. `str.lower()`, `str.casefold()` and
`unicodedata.normalize` are **not used anywhere** in `text.normalize`. They would agree on almost
every input, and "almost" is exactly the near-miss the cross-implementation diff exists to catch.

`text.normalize` runs the contract's six steps in order, one pass each, over Unicode scalar values:
delete (C0 controls, DEL, zero-width/bidi controls, BOM, combining marks) → map one-to-one (space-like
characters, full-width ASCII, quotes, dashes, `…`, `、`, `。`) → lowercase from the lower table → fold
from the fold table → collapse runs of space/tab/LF/CR → trim. The two tables compose as **steps**, not
as alternatives: `é` lowercases to `é` (already lowercase, table miss) and is then folded to `e`;
`Æ` lowercases to `æ` and is then folded to `ae`. The derived per-code-point lookup lists are built
once at startup.

`text.extract` is a hand-written state machine, not a parser library: one forward scan with a quote-
aware tag scanner. Comments, `<!DOCTYPE ...>` and the six removed elements (with their content) are
skipped in place; CDATA keeps its inner text; block-level tags emit a newline on open and on close;
every other tag is dropped; an incomplete tag at end of input is dropped with its name characters,
while a lone `<` is literal text. Entities are decoded inline for the body, the `<title>` text and the
link text alike. The `<title>`'s own text is captured into `title` and never enters `text`. Links are
collected from `<a href>` while their text is accumulated; nested anchors follow the browser — opening
an `<a>` while one is open reports the outer one with the text it had collected and starts the inner
one — and an anchor still open at end of input is reported with what it collected. The output object
is built with the fields inserted in the order the contract lists them.

`text.fingerprint` strips leading/trailing ASCII punctuation from each space-separated token, groups
the rest into CJK / non-CJK runs, emits single code points or overlapping bigrams, builds overlapping
3-token shingles (or the single whole-token-list shingle when there are fewer than three tokens),
hashes each shingle with FNV-1a 64-bit over its UTF-8 bytes, and reduces 64 counters to 16 lowercase
hex digits. Every multiply is masked with `& 0xFFFFFFFFFFFFFFFF` — Python integers are unbounded, so a
missing mask would be a silent, real bug rather than a wrap-around.

## JSON shape (stating the choice, because the field order and spacing are part of the diff)

`json.dumps(payload, ensure_ascii=False, separators=(",", ":"))` — **compact separators**, no spaces
after `:` or `,`, and non-ASCII characters written as their own UTF-8 bytes rather than `\uXXXX`
escapes. Key order is the order the contract lists fields in (`dict` preserves insertion order):

- response envelope: `id`, `ok`, then `output` **or** `error`
- `text.normalize` → `text`
- `text.extract` → `title`, `text`, `links`, `images`; each link → `href`, `absolute`, `text`
- `text.fingerprint` → `simhash`, `tokens`, `shingles`
- `describe` → `id`, `ok`, `worker`; `worker` → `protocol`, `capability`, `language`, `impl`,
  `runtime`, `deterministic`

`runtime` is `"Python " + sys.version.split()[0]` (e.g. `Python 3.14.7`), and `deterministic` is
`true`. `--selfcheck` verifies the field order of all three outputs plus both envelope shapes.

## Evidence

`python workers/python/vmltext.py --selfcheck` → `32/32 checks passed`, exit 0.

`node tools/workers.mjs --no-build --published-only` → `python-text` agrees with the reviewed
snapshots on **31/31 text.extract, 16/16 text.fingerprint, 22/22 text.normalize**, and the run reports
"all implementations agree".

A 156-input differential run against the JavaScript reference (inputs beyond the corpus, covering
unclosed tags, entity edge cases, nesting, CDATA, zero-width characters, full-width ASCII, CJK, kana,
Hangul, Cyrillic, Arabic and punctuation-only tokens) was **156/156 identical** at the point the four
differences it had reported — CDATA re-parsing, unclosed CDATA, `<p` at end of input and a `<title>`
inside an `<a>` — were fixed in the reference and pinned in the corpus.

**Seeded fuzz differential (`tools/workers-diff.mjs --n 60 --cap text.extract`)**: seeds 7, 11 and 23
all report **60/60 generated cases unanimous across six implementations** and "no divergence found",
with 360 repeat answers per seed identical when the same questions are asked again in the opposite
order.

Getting there required fixing three real defects in this worker that the hand-written corpus could not
see, all of them in `text.extract`:

1. **The link's text was trimmed.** Rule 4 says a link's text "obeys exactly the same rules as the main
   text", and the main text keeps its newlines, so a link containing a block element keeps the newline
   that element contributes. The cleaner now trims nothing and collapses nothing.
2. **Removal ran during the walk instead of as the contract's ordered pre-pass.** Section 3 states the
   observable order: hide every CDATA body, remove comments and doctypes, remove the listed elements
   with their content, and only then walk what is left. In `<p t<style>...</style>` a single-pass walk
   reads the `<style>` as attribute text, so the element survived and its CSS leaked into the text. The
   three passes now run first, on the raw text.
3. **A tag scan stopped at an inner `<`.** "`<` starts a tag only when followed by `[A-Za-z/!]`" is a
   rule about where a tag may *begin*, not a rule that a tag in progress ends early. Scanning a tag to
   the first unquoted `>` is what makes `</p</A>text</p>` a single tag, `<p t<p` a tag that never closes
   (so nothing after it is walked), and `<p t<style>` a tag at all.

The CDATA design is the reference's, and it is what makes the ordered passes work end to end: each body
is replaced by a sentinel that no rule can match or split, the walk treats it as opaque (no markup
inside it, no entity inside it), and the bodies are put back at the very end. That is why a CDATA body
inside an anchor becomes part of the link's text, while a `<script>` inside a CDATA body survives and a
CDATA section inside a `<script>` still goes with the element.

Additional evidence gathered for this worker: 69/69 corpus inputs produce byte-identical stdout bytes
across three fresh processes; every stdout line parses as JSON; no `CR` byte appears in protocol output
(so the stream is LF-only on Windows); malformed command lines exit 2 with empty stdout; FNV-1a matches
the published 64-bit vectors (`0xcbf29ce484222325`, `a` → `0xaf63dc4c8601ec8c`,
`foobar` → `0x85944171f73967e8`); and all 22 normalize corpus cases are idempotent.

## Known limits and divergences

1. **Resolved, kept here as a record** — the four cases below started as this worker's disagreements
   with the reference and are now contract rules with corpus cases; this worker's behaviour is
   unchanged and is the pinned one:
   - `<![CDATA[<b>raw</b>]]>` (`cdata-with-markup`) — CDATA content is literal and is not re-parsed,
     so the tags survive.
   - `<![CDATA[unclosed` (`cdata-unclosed-at-eof`) — an unclosed CDATA keeps everything to the end.
   - `<p` at end of input (`tag-name-only-at-eof`) — dropped with its name characters, no newline.
   - `<a href="/x"><title>T</title>t</a>` (`title-inside-anchor`) — the title text belongs to the
     title and to nothing else: not to the body, not to the link's text.
2. **JSON escapes.** Non-ASCII is emitted raw (`ensure_ascii=False`). The contract fixes the
   *encoding* (UTF-8) and the key/array order, not the escaping style; `\uXXXX` would decode to the
   same text but not to the same bytes, so if the diff turns out to be byte-level on escaped
   sequences, this is the knob to change.
3. **Lone surrogates.** Python strings can hold them; `\uD800` cannot be encoded as UTF-8. UTF-8
   encoding uses `surrogatepass` so nothing raises, but such code points cannot appear in valid JSON
   input, so this path is unreachable in practice and no language can agree about it.
4. **`--selfcheck` runs all three capabilities** from one process (cases call the functions directly,
   and `handle` is exercised for the envelope checks). The protocol mode still answers exactly one
   capability per process, as section 1 requires.
5. **Performance** is not a goal: the normalizer and the fingerprint make a few passes over the text
   with per-code-point Python loops, which is fast enough for the corpus (the largest case is a 10 KB
   document) but is not optimised for throughput.
6. **The tables are read at startup from `workers/spec/`.** If those files change, this worker's
   answers change with them, with no rebuild — which is the intent of the shared-table decision, but
   worth knowing when diffing a run that spans a table edit.

---

# Python worker for `llm.parse` (`vmlllm.py`)

The Python implementation of the fourth capability, `llm.parse`, specified by `docs/WORKERS.md`
section 11: the **believing half** of the LLM glue. Asking a model — HTTP, retries, a key, a budget —
is I/O and stays in the application; turning the answer into a small, checked structure and saying
what had to be thrown away is pure text work, and that is the part several languages get subtly and
silently different. This is a second worker in this directory rather than three more capabilities
added to `vmltext.py`, for the same reason `workers/js` has one file per capability and Java has a
second build script: one worker process implements one capability, and a contract section is a unit
of work.

- **Artifact:** `workers/python/vmlllm.py` (the source file *is* the artifact — see "No build step")
- **Launch:** `python workers/python/vmlllm.py --capability llm.parse`
- **Capabilities:** `llm.parse` (one process, one capability)
- **Worker id:** `python-llm`

## How to run

```bash
# from the repository root
python workers/python/vmlllm.py --capability llm.parse    # stdio JSON-Lines protocol
python workers/python/vmlllm.py --selfcheck                # 46 built-in checks, no protocol traffic
node   workers/python/build-llm.mjs                        # interpreter check; prints the artifact path
node   tools/workers.mjs --published-only --only python-llm --no-build
node   tools/workers-diff.mjs --cap llm.parse --n 200 --seed 7
```

The protocol, the encoding rules, the error-code rule, the one-argument command line and the exit
codes are exactly those of the section above. `build-llm.mjs` exists because `build.mjs` checks
`vmltext.py`: a build script that validated the wrong artifact would report this worker as `[skip]`
or as a pass for reasons that belong to another file. `build-llm.mjs` checks `vmlllm.py --selfcheck`
and nothing else.

## Strategy

**The contract's sets, not the runtime's defaults.** Five rules of section 11 are traps in Python
specifically, because the obvious call is one that almost agrees:

- `ASCII_WHITESPACE = " \t\n\r"` trims tags (rule 4) and summaries (rule 8). `str.strip()` is **not**
  this function: it strips the whole Unicode whitespace property, so a tag of `U+00A0` followed by
  `debut` would become a vocabulary match that the contract says it is not. `U+3000` is the same trap
  with a wider space, and the corpus pins both by name (`nbsp-is-not-whitespace`).
- `fold_ascii` maps `A`–`Z` with `str.translate` and nothing else. `str.lower()` is **not** this
  function: it folds the Kelvin sign `U+212A` to `k` and `U+0130` to `i` + `U+0307`, either of which
  returns a tag the application never defined (`ascii-folding-only`, `turkish-i-is-not-a-locale-question`).
- `parse_payload` calls `json.loads(..., parse_constant=_reject_constant)`. `json.loads` accepts the
  bare tokens `NaN`, `Infinity` and `-Infinity` by default, which are not JSON; raising in the hook
  turns them into a parse failure with no payload, which is what rule 3 asks for (`not-really-json`).
  `strict=True` (the default) already rejects an unescaped control character inside a string — the
  other half of "JSON here means RFC 8259" (`unescaped-control-character-in-a-string`).
- Truncation uses `len()` and slicing on a Python `str`, which is already counted in code points, so
  an astral character is one unit and `counts.truncated` is code points removed. A bytes- or
  UTF-16-based implementation cuts an emoji in half here (`truncation-never-splits-an-emoji`).
- Order is part of the answer: the output dict is built as `tags`, `summary`, `dropped`, `repaired`,
  `counts`; every `dropped[]` element is built as `value`, `reason`; and the report is sorted with
  `key=(utf8(value), utf8(reason))` — the UTF-8 byte comparison rule 10 asks for, written as an
  explicit encoding rather than left to Python's default string order.

**`repaired` uses a second whitespace set on purpose.** Rule 9 compares the slice with "the whole
trimmed input", and the reference implements "trimmed" with JavaScript's `String.prototype.trim`,
which is *wider* than the ASCII set: it also strips `U+00A0`, `U+1680`, `U+2000`–`U+200A`, `U+2028`,
`U+2029`, `U+202F`, `U+205F`, `U+3000` and `U+FEFF`. The two sets are kept apart as
`ASCII_WHITESPACE` (rules 4 and 8) and `JS_TRIM_CHARS` (rule 9), because the difference is
observable: an answer whose object is followed by a non-breaking space, an en quad or an ogham space
is `repaired: false` under the reference. The reference also does *not* trim `U+001C`–`U+001F` or
`U+0085` — measured against Node rather than assumed, because that is the same near-miss as
`str.strip()` — so a trailing `U+001C` is `repaired: true` there and here. Both directions are pinned
in the self-check. One footnote about the reference's own code, because it decides an answer:
JavaScript's `WHITESPACE.includes(c)` test in that file compares UTF-16 **code units**, so the low
surrogate half of an astral character would look like whitespace to it. No astral character is
whitespace, so the only way to reach that is a raw answer containing a lone surrogate, which is not
encodable and which rule 3 refuses as input anyway; this worker compares whole characters, so the
`repaired` flag is identical everywhere the case is reachable. **And the two-set split above is a
reference-shaped inconsistency in the contract, not a bug in this worker;** the honest fix is
chapter-wide agreement on one whitespace set for `repaired`, and that is a contract decision rather
than an implementation one.

**The number path.** Rule 4 keeps non-integer numbers out of the capability on purpose ("serializing a
float is a formatting decision that each language makes differently"), and the corpus carries none.
Integers go through `_json_number_text`, which writes decimal digits; `-0` is normalised to `0`
because `JSON.stringify(-0)` is `0` (JavaScript has one zero, Python keeps the sign). `true`/`false`
are handled before the integer branch, because `isinstance(True, int)` is true in Python and would
otherwise be reported as `1` — the same class of runtime default as the other four.

## JSON shape

The same choice as `vmltext.py`: `json.dumps(payload, ensure_ascii=False, separators=(",", ":"))`,
written as explicit UTF-8 bytes with one LF per protocol line, so every byte of the answer is the same
on Windows and on Linux.

- response envelope: `id`, `ok`, then `output` **or** `error`
- `llm.parse` → `tags`, `summary`, `dropped`, `repaired`, `counts`; each `dropped[]` → `value`, `reason`
- `counts` → `tags`, `dropped`, `truncated`
- `describe` → `id`, `ok`, `worker`; `worker` → `protocol`, `capability`, `language`, `impl`,
  `runtime`, `deterministic` (`impl` is `scan-and-check`)

## What `--selfcheck` pins

46 checks, all of them edges rather than happy paths:

- `str.strip()` versus the ASCII set: a tag padded with `U+00A0` or `U+3000` is *not* trimmed into a
  match; a tag padded with tab/newline *is*; a summary padded with `U+00A0` keeps it; a trailing
  `U+00A0` around the object is not a repair, a trailing `U+001C` or `U+0085` is one.
- `str.lower()` versus ASCII folding: the Kelvin sign and the dotted capital I match nothing; the
  vocabulary's own spelling comes back for `DEBUT`, and the first spelling wins when a vocabulary
  lists the same word twice.
- `json.loads` leniency: a bare `NaN`, a bare `Infinity`/`-Infinity` and an unescaped control
  character inside a string each yield no payload and `repaired: true`, with no partial recovery.
- Code points: two emoji and two letters truncated to three keeps two emoji and one letter;
  `maxSummaryChars: 2` over `ab` plus an emoji never emits half a character; a paired surrogate
  escape decodes to the astral character it encodes.
- The one repair: a trailing comma in an object and in an array is dropped; a comma inside a string —
  including one followed by `}` or `]` — is data and is not touched; a string `tags` field
  contributes nothing and is not split; an array is not the payload.
- Order: the output field order, the `dropped[]` key order, the report sorted by `value` then
  `reason` as UTF-8 bytes, and the envelope and descriptor key orders.
- Every `bad-input` rule (missing `raw`, a non-string `raw`, a negative limit, a non-integer limit, a
  boolean `maxTags`, a vocabulary that is not an array, a vocabulary entry that is not a string), and
  `unsupported` for another capability.

## Evidence

- `python workers/python/vmlllm.py --selfcheck` → `46/46 checks passed`, exit 0.
- `node workers/python/build-llm.mjs` → prints the interpreter, the self-check summary and
  `workers/python/vmlllm.py` as its last stdout line, exit 0 (with forward slashes, so the line is the
  same on every platform).
- `node tools/workers.mjs --published-only` → `llm.parse 34/34 cases unanimous across 2
  implementation(s)` (`js-llm`, `python-llm`); the whole published run ends `all implementations
  agree`, exit 0. The narrower `--only python-llm` run prints the same `34/34` line but **exits 1**:
  `--only` filters the JavaScript reference out of the run, and the runner's closing check — "every
  capability has a JavaScript implementation that answered" — then correctly reports `reference :
  MISSING for …` for all six capabilities. That is the check doing its job, not a verdict on this
  worker; the unfiltered run above is the one that decides.
- `node tools/workers-diff.mjs --cap llm.parse --n 200 --seed 7`, `--seed 11` and `--n 600 --seed 3`
  → `200/200`, `200/200` and `600/600 generated cases unanimous across 2 implementations`, with
  `400`, `400` and `1200 repeat answer(s) identical when asked again in the opposite order`, and
  `no divergence found` in all three, exit 0.
- `python workers/python/_llm_probe.py` (a scratch differ, covered by the `workers/*/_*` convention
  for machine-local probes) asks both implementations over the real protocol for 89 hand-picked
  adversarial inputs — the whitespace sets in both directions, the folding, bare `NaN`/`Infinity`,
  `1e999`, unescaped control characters, an unbalanced `{{`, `{a}{b}`, a comma before `}`, a
  comma-before-bracket inside a string, astral tags, every non-string element kind, and the whole
  bad-input set — and reports `89/89 inputs identical`.

## Known limits and divergences

1. **A JSON integer larger than 2^53 is reported with its own digits here and rounded by the
   reference.** For `{"tags": [9007199254740993]}` this worker answers `9007199254740993`;
   `workers/js/vmlllm.js` answers `9007199254740992`, because the value has already been rounded to a
   JavaScript `Number` before the report is built. Rule 4 says "integers as decimal digits", which is
   what this worker does. Nothing in the corpus or the fuzzer produces such a value, the difference is
   confined to `dropped[].value` for a non-string element, and it is pinned by a self-check case so a
   future corpus case has to make the choice explicitly instead of meeting it as a surprise.
2. **Non-integer numbers are outside the capability and outside the corpus** (rule 4), so
   `_json_number_text` does not promise `JSON.stringify`'s float formatting. Where it was measured the
   two agree (`-1.5e-3` → `-0.0015`, `1e21` → `1e+21`); `1e999` is the interesting one and they do
   not: the reference answers `null`, because `JSON.stringify(Infinity)` is `"null"`, while this
   worker answers `Infinity`. No implementation may depend on either.
3. **A lone surrogate escape is not text and the two languages disagree about it.** For an input
   whose raw field is `{"tags": ["` + `\uD83D` + `debut"]}` (written, inside the raw answer, as a
   JSON escape naming a high surrogate on its own), the reference reports one `U+FFFD` where this
   worker reports three: Python applies JSON's own escape decoding and Node decodes a lone surrogate
   at the UTF-8 boundary. The transport is UTF-8, which cannot carry a lone surrogate, so a host
   cannot put this input on the wire — the case is reachable only by calling the function directly,
   and no language can be asked to agree about text that cannot be encoded.
4. **Performance** is not a goal: the payload scan, the comma repair and the JSON text builder are
   per-code-point Python loops, which is fast enough for a model answer and is not optimised for
   throughput.
5. **`--selfcheck` exercises `handle` as well as the capability**, so the envelopes and the capability
   guard are checked in the same run; protocol mode still answers exactly one capability per process,
   as section 1 requires.

