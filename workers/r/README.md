# workers/r — the R implementation of the three text capabilities

The R worker for the layer described in [`docs/WORKERS.md`](../../docs/WORKERS.md): it implements
`text.normalize` (§2), `text.extract` (§3) and `text.fingerprint` (§4) behind the JSON-Lines protocol
of §1 — one JSON object per line, UTF-8, `describe`/`invoke`/`shutdown`, `ok`/`error` envelopes,
stdout carrying protocol lines and nothing else, English diagnostics on stderr, and stdout flushed
after every response.

R 4.6.1, **base R only**: no package is loaded, nothing is downloaded, and no runtime's Unicode data
is consulted — the case and fold tables come from `workers/spec/*.json` through a generated file, so
this implementation cannot disagree with the others merely by being written in R.

| file | what it is |
| --- | --- |
| `vmltext.R` | the worker. Pure-ASCII source; the whole implementation |
| `build.mjs` | generates `tables.generated.R` from the two shared spec tables, then runs the worker's self-check |
| `tables.generated.R` | **generated**; the two tables as plain ASCII integers. `VML_LOWER`/`VML_FOLD`, indexed by code point + 1 |
| `../../workers/registry.local.json` | machine-local, gitignored: the launch line for this machine (see below) |

## Build and run

From the repository root:

```
node workers/r/build.mjs
```

It looks for `Rscript` (on `PATH`, in `$RSCRIPT`, in `$R_HOME/bin`, then in
`workers/registry.local.json`), refuses to continue with a clear English message if it cannot find
one, writes `workers/r/tables.generated.R`, proves the result by running the worker's own
`--selfcheck`, and prints the artifact path as its last stdout line:

```
build.mjs: Rscript: <the Rscript this machine has> (found via workers/registry.local.json (worker id "r-text"))
build.mjs: wrote workers/r/tables.generated.R (592 lower entries, 294 fold entries)
build.mjs: source hash 2226/2962 (bytes of canonical map JSON)
build.mjs: selfcheck: 31/31 checks passed
workers/r/tables.generated.R
```

Run it by hand (the host appends the capability, §1.1):

```
Rscript workers/r/vmltext.R --capability text.normalize
Rscript workers/r/vmltext.R --capability text.extract
Rscript workers/r/vmltext.R --capability text.fingerprint
Rscript workers/r/vmltext.R --selfcheck
```

Any other argument, a missing `--capability`, or an unknown capability is an error on stderr with
exit 2 (§1.1). `--vanilla` is worth passing when you invoke it yourself: it keeps `.Rprofile` and
`.Renviron` out of a protocol stream that must contain nothing but protocol lines.

Registration on this machine lives in the gitignored overlay, because `Rscript` is not on `PATH`
here and a published file may not carry an absolute path — the overlay is the one place a
machine-specific path belongs, and it is never copied into `workers/registry.json`:

```json
{ "id": "r-text", "language": "r",
  "capabilities": ["text.normalize", "text.extract", "text.fingerprint"],
  "build": ["node", "workers/r/build.mjs"],
  "artifact": "workers/r/tables.generated.R",
  "launch": ["<absolute path to this machine's Rscript>", "--vanilla", "workers/r/vmltext.R"] }
```

Conformance (this machine, all six implementations):

```
node tools/workers.mjs                     # js, java, cpp, go, python, r
node tools/workers.mjs --only r-text       # this worker alone
```

## Design notes: the four decisions that are not obvious in R

**1. The source is ASCII, and so is the generated table file.** R parses a source file with the
session's encoding, so a file that is UTF-8 on one machine is mojibake on the next. Every literal
here is ASCII; every non-ASCII code point that matters is a number.

**2. Text is an integer vector of code points, never an R string.** R strings carry an encoding mark
and are transcoded to the session's native encoding, which on a non-UTF-8 Windows machine corrupts
exactly the CJK text §2 says must pass through unchanged. So the worker decodes stdin bytes to code
points itself (hand-rolled UTF-8 decoder, so an invalid sequence becomes U+FFFD instead of aborting
the worker), works on integers, and encodes the answer back to UTF-8 bytes itself. `tolower()`,
`toupper()`, `nchar()`, `substr()`, `strsplit()` and `regexpr()` are never called: they are exactly
the locale- and encoding-sensitive tools that would make four implementations disagree. Output goes
out as an unmarked string (`rawToChar` of the encoded bytes), which R writes byte for byte without
transcoding.

**3. 64-bit arithmetic without 64-bit integers.** `integer` is 32-bit and `double` is exact only up
to 2^53, so `(h * 1099511628211) %% 2^64` in doubles is silently wrong — the product needs 105 bits.
**The accumulator is kept as two 32-bit words (`hi`, `lo`) held in doubles, and each multiplication
splits the FNV prime into 16-bit halves**, `P = 16777216 * 2^16 + 435`, so the four limb products are
at most `65535 * 16777216 ≈ 1.1e12` — three orders of magnitude below 2^53 — and the carry chain is
exact:

```r
t0 <- d * 435; t1 <- cc * 435 + d * 16777216
t2 <- b * 435 + cc * 16777216; t3 <- a * 435 + b * 16777216
# carry t0 -> t1 -> t2 -> t3, keep the low 16 bits of each; (t4 + carry) is dropped, i.e. mod 2^64
```

XOR with a byte only touches the low byte of `lo` and uses `bitwXor` on values below 256, which is
inside R's integer range. The offset basis is carried as `hi = 3421674724`, `lo = 2216829733`
(`14695981039346656037 = hi * 2^32 + lo`). The 16 hex digits are assembled from the two words a
nibble at a time, most significant first, so nothing depends on `sprintf("%x")` and a double ≥ 2^31.
The self-check pins three published FNV-1a vectors and three shingles against the reviewed snapshot,
because "it looked right" is not evidence for this particular piece of code.

**4. JSON by hand.** Base R has no parser and no encoder, so both live in `vmltext.R`: objects,
arrays, strings with the full escape set (including `\uXXXX` with surrogate pairs joined into one
code point), numbers echoed verbatim, booleans, null. Field order is written out explicitly where the
contract fixes it (`title, text, links, images`; `href, absolute, text`; `simhash, tokens, shingles`).

**Reading is line by line, never a fixed-size read.** §1.2's second half warns that a buffered
4096-byte `fread` on a pipe blocks until its buffer fills, so a worker whose host holds stdin open
answers nothing while `echo ... | worker` looks perfect. This worker reads with
`readLines(con, n = 1L)` on a binary connection to stdin: it returns as soon as one line is
available, and because the connection is binary the UTF-8 bytes arrive untranslated (the ASCII
fast path in the decoder then hands whole runs of bytes through in one step).

## Self-check

`--selfcheck` runs 31 built-in cases — unclosed and incomplete tags, an entity without its semicolon,
decimal and hex numeric references, an unknown entity, `&copy2024`, zero-width characters, full-width
ASCII, CJK/Cyrillic/Arabic pass-through, the idempotency pair, empty input, CDATA as literal text,
anchor nesting, title-inside-anchor, FNV/SimHash vectors against the reviewed snapshot — and prints
one English line per case plus `N/M checks passed`. It exits non-zero on any failure, and writes no
protocol traffic to stdout. `npm run workers` never runs it; `build.mjs` does, on every build.

## Honest limits, and the things I had to decide

**Line endings: this worker's responses end in CR LF on Windows, not LF.** R's stdout is a
text-mode stream and the C runtime rewrites every LF written to it; base R exposes no `_setmode`,
`writeBin` refuses a terminal connection (`can only write to a binary connection`),
`file("stdout", "wb")` is not special-cased on R 4.6 and creates a file literally named `stdout`,
and calling `_setmode()` on `ucrtbase.dll` through `.C()` does not clear the translation flag of the
already-initialised FILE stream. A C or Go worker can obey §1's "LF" exactly; this one cannot. The
JSON content is byte-identical, `JSON.parse` treats the CR as trailing whitespace, and the harness
reads every case — but it is a deviation from the letter of §1, so it is written down here rather
than left for someone to discover with a hex dump. (This is the same class of platform trap as §1.2,
one level lower: §1.2 warns about the encoding, this is about the line terminator.)

**The pre-passes run in the reference's order, not in the contract's numbering.** §3 numbers the
removed elements as step 1 and comments/doctype/CDATA as step 2; the reference implementation hides
the CDATA bodies first, then removes comments and doctypes, then removes the elements. The two orders
are observably different — an element containing a comment, or a CDATA body containing a comment
opener — and the corpus pins the reference's order (`cdata-inside-removed-element`: *"removal wins
over CDATA"*, because the element removal runs on text whose CDATA is already hidden). This worker
follows the reference, and reports the difference instead of quietly picking one.

**Nothing is written to stdout but protocol lines — including no startup banner.** The JavaScript
reference emits one extra `{"id":null,...}` banner line at startup for humans piping it by hand,
which §1 forbids in two places ("stdout carries protocol messages and nothing else", "Nothing is
logged to stdout, ever — not a banner, not a version line, not a progress dot"). This worker does not
copy it. It is a finding about the reference, not a behaviour I needed.

**`shutdown` is answered with `{"id":<id>,"ok":true}` and nothing else.** §1 now says so in as many
words ("`shutdown` answers that bare envelope and nothing else … the reference is not the contract;
when the two differ, this document wins"), because two implementations had carried an extra
`"output"` payload from an earlier draft. This worker answers the bare envelope. Likewise an `invoke`
naming a capability this process was not started with answers `unsupported` and stays alive, and a
request line that is not JSON answers `{"id":null,"ok":false,"error":{"code":"bad-input",...}}` —
all three rules are in §1.1 and all three are implemented as written.

**An `id` is echoed verbatim.** A JSON number is kept as its source text, so `{"id":1.0}` comes back
as `1.0`, where the reference — which re-serialises the parsed number — would answer `1`. The
protocol's own examples use integers and the harness uses strings, so this cannot be observed from
the corpus; it is noted because it is a real (if unreachable) difference.

**`baseUrl` is accepted and ignored.** §3 says `href` is reported verbatim and that resolution is
deliberately not done, so the value is validated as JSON and then never used. A non-string,
non-null `baseUrl` is not rejected, matching the reference.

**`text.extract` is not a browser.** The removed-element and comment passes are the contract's
regular-expression-style rules, not a tokenizer: `<script src="a>b">` ends its open tag at the first
`>` even inside an attribute value, whereas the tag scanner in the main loop does honour quotes. The
contract specifies quoted attributes for the *tag scanner* and does not restate it for the removal
pass, and no corpus case covers the inside-a-quote form, so this worker matches the reference exactly
rather than inventing a stricter reading.

**Performance is R-shaped, and stated so nobody is surprised.** The fingerprint hashing loop is
per-byte and per-bit in R. Measured on this machine, after the process is already running: 7.5 KB of
mixed-script text takes 191 ms to normalize, 429 ms to fingerprint, and 7.7 KB of HTML takes 514 ms
to extract, so §5's 10 KB document is comfortably inside the harness's 30 s budget; process startup
(R 4.6.1 on Windows) costs about 1.0 s on top of that. This is not a throughput worker: the
alternative — packing counters into integers and using `bitwAnd`/`bitwShiftL` throughout — buys a
constant factor and loses the direct correspondence between the code and §4, and exactness was the
requirement.

**Lone surrogates.** A `\uD800` escape with no pair is carried as a code point and encoded to U+FFFD
on output (what Node's UTF-8 encoder does with it); valid surrogate pairs are joined into one code
point on input. The contract's input is well-formed, so this only keeps malformed bytes out of the
output instead of producing invalid UTF-8.

## What was verified

* `node workers/r/build.mjs` → tables written, `31/31 checks passed`, artifact path last.
* `Rscript workers/r/vmltext.R --selfcheck` → 31/31, exit 0, no protocol traffic on stdout.
* `node tools/workers.mjs --only r-text --no-build` → 31/31 extract, 16/16 fingerprint, 20/20
  normalize, no DIVERGES.
* `node tools/workers.mjs` (all six implementations, 67 cases) → **every capability unanimous**:
  31/31, 16/16 and 20/20 across js-text, java-text, cpp-text, go-text, python-text and r-text, exit
  0, no `DIVERGES`, no `ORDER` and no `SNAPSHOT` lines. (An earlier run of the same command had one
  disagreement, `cdata-inside-removed-element`, where `r-text` sat with js/java/cpp/python and
  `go-text` was the outlier; that worker has since been fixed.)
* Determinism and locale independence, checked by re-running each capability twice and once with
  `LC_ALL=C`: the raw response bytes are identical in all three runs for all three capabilities, and
  every stdout line parses as JSON — 21, 32 and 17 protocol lines for normalize, extract and
  fingerprint.
* Argument handling: no arguments, an unknown argument, an unknown capability and a valueless
  `--capability` all exit 2 with an English message on stderr and nothing on stdout. A `shutdown`
  request is answered with `{"id":9,"ok":true}` and exits 0; an `invoke` naming a capability this
  process does not implement answers `{"ok":false,"error":{"code":"unsupported",...}}`.
