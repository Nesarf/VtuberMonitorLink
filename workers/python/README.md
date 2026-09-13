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
snapshots on **31/31 text.extract, 16/16 text.fingerprint, 20/20 text.normalize**. The single
divergence reported in that run is `go-text` on `cdata-inside-removed-element`; `python-text` is in the
largest agreeing group on every case of every capability.

A 156-input differential run against the JavaScript reference (inputs beyond the corpus, covering
unclosed tags, entity edge cases, nesting, CDATA, zero-width characters, full-width ASCII, CJK, kana,
Hangul, Cyrillic, Arabic and punctuation-only tokens) is now **156/156 identical**. The four
differences that run originally reported — CDATA re-parsing, unclosed CDATA, `<p` at end of input and a
`<title>` inside an `<a>` — were fixed in the reference and are now pinned in the corpus, which is the
one contribution of this worker to the layer that a corpus alone could not have produced.

Additional evidence gathered for this worker: 67/67 corpus inputs produce byte-identical stdout bytes
across three fresh processes; every stdout line parses as JSON; no `CR` byte appears in protocol output
(so the stream is LF-only on Windows); malformed command lines exit 2 with empty stdout; FNV-1a matches
the published 64-bit vectors (`0xcbf29ce484222325`, `a` → `0xaf63dc4c8601ec8c`,
`foobar` → `0x85944171f73967e8`); and all 20 normalize corpus cases are idempotent.

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
