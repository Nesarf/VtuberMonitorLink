# `workers/java` — the Java worker for `text.normalize`, `text.extract`, `text.fingerprint`

One dependency-free Java 17 program (`package vml`) that speaks the JSON-Lines stdio protocol of
`docs/WORKERS.md` and implements all three text capabilities. It is registered in
`workers/registry.json` as `java-text`.

```
workers/java/
  build.mjs                     compiles with javac -encoding UTF-8 and packs dist/vmltext.jar
  src/vml/TextWorker.java       main, argument handling, the request loop, table loading
  src/vml/Json.java             the JSON encoder/decoder (nothing third-party is allowed)
  src/vml/Normalizer.java       text.normalize
  src/vml/Extractor.java        text.extract
  src/vml/Fingerprinter.java    text.fingerprint
  src/vml/SelfCheck.java        --selfcheck
  tools/compare-reference.mjs   diffs this worker against workers/js/vmltext.js over the protocol
  tools/reference-values.mjs    prints the reference's answers for a batch of inputs
  tools/gen-selfcheck-corpus.mjs prints the corpus assertions used by SelfCheck
```

## Build

```
node workers/java/build.mjs
```

Compiles `src/**/*.java` with `-encoding UTF-8 -source 17 -target 17` into `dist/classes`, writes a
manifest whose `Main-Class` is `vml.TextWorker`, and packs `dist/vmltext.jar` with the JDK's `jar`
tool. The artifact path is the **last stdout line** (`workers/java/dist/vmltext.jar`, relative to the
working directory), as section 6 of the contract asks. The script is portable, uses no network, and
fails with one English sentence and a non-zero exit if no JDK is found — `JAVA_HOME` is consulted
first, then `javac` on `PATH`. Compiler diagnostics are forced to English
(`-J-Duser.language=en`) because the JDK otherwise localizes them to the host's language.

## Run

The launch line is the one in `workers/registry.json`:

```
java -Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8 \
     -jar workers/java/dist/vmltext.jar --capability text.normalize
```

One worker process handles **one** capability, as section 1 requires, so run one process per
capability; an `invoke` for another capability is answered
`{"ok":false,"error":{"code":"unsupported",...}}`.

Self-check (no protocol traffic on stdout, exit non-zero on any failure):

```
java -jar workers/java/dist/vmltext.jar --selfcheck
```

Anything else on the command line is an error on stderr with exit 2.

## Strategy

**The tables are read at run time.** `workers/spec/latin-lower.json` and `latin-fold.json` are loaded
from the repository at start-up, found by walking up from the working directory and from the
location of the jar (so `node workers/java/build.mjs` from the repository root, and the launch line
above, both work). Run-time reading was chosen over embedding them at build time so there is exactly
one source of truth and no generated copy that can drift behind a table edit. A run that cannot find
them fails loudly on stderr with exit 3 rather than normalizing with an empty table.

**Nothing consults the JDK's own Unicode tables.** No `String.toLowerCase`, no `toUpperCase`, no
`Normalizer`, no `java.text.Normalizer`, no locale-sensitive anything. `text.normalize` is the seven
specified steps over code points: delete, map, lowercase (table), fold (table), collapse, trim. The
steps *compose*: a code point that step 2 maps is still lowercased and folded afterwards, which is
why `ＦＵＬＬＷＩＤＴＨ` becomes `fullwidth` and `É` becomes `e` — the first is a bug the Java
implementation exposed in the reference, the second is why both tables are load-bearing.

**`text.extract` is the specified state machine**, not a DOM or a regex soup. First the CDATA bodies
are lifted out and replaced by sentinels, so that the character data they hold can never be touched
by a later rule; then comments and doctype go; then the six removed elements go with their content (a
missing closing tag runs to end of input, and the text *before* the tag is kept); then the remaining
source is walked once: tags become newlines for the 32 listed block elements, `<a>` and `<title>`
collect their own text, entities are decoded as the walk goes, `<img` is counted, and each CDATA
sentinel is restored into whatever the walk is currently filling. Three rules the corpus pins that a
hand-written parser usually gets wrong:

* **CDATA is character data.** `<![CDATA[<b>raw</b>]]>` yields the literal text `<b>raw</b>` — no tag
  is parsed, no entity is decoded, no comment is stripped inside it. An unclosed section keeps
  everything to the end of the input, like a removed element with no closing tag.
* **An incomplete tag at end of input is dropped whole**, name characters included, and contributes
  no newline: `<p` yields `""`, `abc<b` yields `"abc"`, and a lone `<` is literal text (`a<` -> `"a<"`).
* **A title's text belongs to the title and to nothing else** — not to the body, and not to an
  anchor's own text, so `<a href=/x><title>T</title>t</a>` has title `T`, body `t` and a link whose
  text is `t`.

An `<a>` opened while another is open follows the browser rather than the earlier draft's "ignore the
inner anchor": the outer link is reported with the text it had collected and the inner becomes the
open anchor, so `<a href=/one>one<a href=/two>two` reports both links.
`javax.swing.text.html.parser` is deliberately not used: it is not the specified machine and it would
decode entities by its own table. `extract` never normalizes — case, accents, newlines and spacing
are preserved verbatim, and so is a link's own text.

**The protocol is answered as section 1 writes it**, not as the reference happens to behave: every
response carries the `id` unchanged, `describe` returns the descriptor, `invoke` returns `output`,
failures return `error` with a code from the closed set, a malformed request line answers
`{"id":null,"ok":false,...}`, and `shutdown` answers the **bare** envelope `{"id":N,"ok":true}` with
no extra payload. Nothing in the corpus diffs a shutdown line, so that envelope is pinned by
`--selfcheck` instead.

**`text.fingerprint` is all integer arithmetic**: ASCII punctuation trimmed from each token's edges,
CJK runs turned into overlapping bigrams, shingles of 3 tokens, FNV-1a 64-bit over UTF-8 bytes using
Java's `long` (which wraps at 2^64 by definition, so no manual masking is needed for the multiply),
and a 64-counter SimHash printed as 16 lowercase hex characters.

**The JSON codec is hand-written** because JDK 17 has no JSON parser and the contract forbids
third-party dependencies. It handles the escapes, `\uXXXX` with surrogate pairs, integers and
doubles, nesting and depth limits. Key order is the insertion order of a `LinkedHashMap`, so every
response is byte-identical run after run, and a numeric `id` is echoed by its source spelling so it
survives a round trip exactly.

**Encoding is explicit, not assumed.** `System.out` uses the platform code page on Java 17 (UTF-8
only from Java 18), so on a Chinese Windows a Java worker that trusts it turns the corpus into
mojibake while looking like it works (`docs/WORKERS.md` section 1.2). This worker wraps stdin,
stdout and stderr in explicit UTF-8 streams in code *as well as* being launched with the `-D` flags,
and writes `\n` itself rather than relying on the platform line separator.

**Determinism.** No hash-map iteration order, no locale-dependent formatting, no time or random
sources; the descriptor declares `"deterministic": true`.

## Tests

* `--selfcheck` runs the shipped corpus (`workers/spec/cases/*.json`) against the reviewed snapshot
  (`workers/spec/expected/*.json`) — 65 cases — plus sixteen built-in checks for the contract's stated
  edge rules, the JSON codec and the protocol envelopes. All 65 corpus cases and all 76 checks pass.
* `node tools/workers.mjs --only java-text` agrees with the corpus and the snapshot on all 65 cases.
* `node workers/java/tools/compare-reference.mjs` runs 101 inputs through both this worker (piped
  through the real protocol on stdin/stdout, one process per capability) and the JavaScript
  reference, and checks seven protocol edges. Result: 101/101 byte-identical, 7/7 edges as specified.
  It covers the corpus's edges plus synthetic inputs the corpus does not have — nested anchors, CDATA
  with markup and entities, unclosed CDATA, end-of-input inside a tag, titles inside anchors, control
  characters, lone surrogates and out-of-range numeric references.
* `node workers/java/tools/probe-reference-cdata.mjs` prints the reference's answer for a batch of
  CDATA/tag-boundary inputs, which is how the behaviour above was pinned.

## Known limits

* **The jar needs the repository's tables.** `workers/spec/*.json` must be reachable from the working
  directory or an ancestor, otherwise the worker exits 3. That is the price of run-time reading;
  embedding the tables at build time would make the jar standalone.
* **`--selfcheck` needs `workers/spec/cases/` and `workers/spec/expected/`** for the same reason, and
  fails one check if they are absent rather than silently checking less.
* **Only < 10 KB-scale efficiency.** `text.extract` removes elements with `indexOf` scans per element
  and builds the output with `StringBuilder`; it is linear enough for the corpus (including its 10 KB
  document) but it is not a streaming parser. `Normalizer.trim`/`collapseSpaces` allocate one extra
  string per call.
* **Surrogate handling.** The normalizer works on code points and appends astral characters whole; a
  lone unpaired surrogate is passed through as-is, exactly as the reference does, because the contract
  says "over Unicode scalar values" without saying what to do with malformed UTF-16. Invalid UTF-8 on
  stdin is decoded with replacement characters rather than refused.
* **A total line limit is not enforced.** A request line of several hundred megabytes would exhaust
  memory; the protocol has no maximum and the corpus has no such case.
* **`baseUrl` is accepted and ignored.** Section 3 step 4 forbids resolving URLs, so there is nothing
  to resolve with it.
* **CDATA uses a sentinel.** Each CDATA body is replaced by a private-use code point chosen not to
  occur in the input, so no later rule can match it and the body is restored verbatim. A fragment
  inside a removed element is dropped with that element, which is what "remove with their content"
  means; if the input somehow used all 6400 private-use code points, the fallback is U+E000 (the
  input would already be pathological).

## Divergences and contract findings

These are reported rather than silently resolved, because the cross-implementation diff is the point
of the exercise.

1. **Step order in `text.normalize` (resolved, was a reference bug).** Section 2 step 3 says folding
   happens *after* lowercasing, but an earlier reference treated the two tables as alternatives, so
   `É` stayed `é` where the contract requires `e`, and `normalize` was not idempotent. The Java
   implementation was written from the contract and exposed this; the contract wording and the
   reference were both fixed. This worker implements map → lowercase → fold, and all five
   implementations now agree.

2. **`&hellip` without a semicolon.** The reference is looked for inside a 12-character window
   starting at the `&`. `&hellip` is 11 characters, so it decodes without its semicolon, which is
   what section 3 step 6 now specifies. The window is reproduced exactly, so `&copy2024` stays literal
   (no backtracking) as the same step requires.

3. **End of input inside a tag (resolved by this work).** This worker read section 3's bracket rules
   as "the incomplete tag is dropped including its name characters, and text before it stays" — so
   `extract("abc<b").text` is `"abc"` and `extract("a<").text` is `"a<"`. The reference instead lost
   one character past the tag, and the difference was invisible to the corpus because the only
   unclosed-tag case contained a `>`. Section 3 now pins the rule and the corpus has
   `unclosed-tag-exactly-at-eof` and `lone-lt-at-eof`; all five implementations agree, and no code
   changed here.

4. **Nested anchors (resolved against the reference).** HTML does not allow nested anchors and a
   browser closes the open one and starts the new one, so an `<a>` opened while another is open
   reports the outer with the text it had collected and makes the inner the open anchor. An earlier
   draft said "ignore the inner anchor", which silently dropped a link; the Go implementation flagged
   it and all implementations changed. `<a href=/one>one<a href=/two>two` now reports **both** links
   (`/one` with text `one`, `/two` with text `two`) and the body text is `onetwo`.

5. **`shutdown` answers the bare envelope.** Section 1's response block shows `{"id":3,"ok":true}`
   with no payload, and the document now says the reference is not the contract where the two differ.
   This worker answers `{"id":N,"ok":true}`, and `--selfcheck` pins it, because nothing in the corpus
   diffs a shutdown line — which is exactly how the split survived four implementations.

6. **`...` and `U+2026`.** Step 2 maps `U+2026` to the three-character string `...`, which this
   worker writes out directly. The reference re-enters its own step 2 for each character of a mapped
   result, so its `...` is re-mapped to `U+2026` and then back to `...` on the next pass — same
   output, one extra round trip. No observable difference, noted because a language that follows the
   composition rule mechanically (as the reference does) and one that writes the replacement (as this
   one does) must not drift on some later multi-character table entry.

7. **`text.extract` version-1 reference bugs.** Four were reported by this work and fixed upstream:
   ASCII approximations for `&mdash;`/`&copy;` (the contract wants each entity's own character), a
   hex reference parsed including its `x` (every `&#xHHHH;` stayed literal), entities inside
   `<title>` routed to the body, and a dropped unclosed `<a>`. All are covered by the corpus and this
   worker passes all 29 `text.extract` cases.

8. **CDATA is character data (this worker was wrong).** An earlier version of this file stripped the
   `<![CDATA[` and `]]>` delimiters and let the body be re-parsed, so `<![CDATA[<b>raw</b>]]>` came out
   as `raw text` — the opposite of what CDATA is for. The contract's "keeps its inner text" was too
   thin to settle it and the corpus had no case; the Python implementation's differential found it,
   and section 3 now says the body is literal and must not be parsed as markup. This worker lifts each
   body out before every other pass and restores it in the walk, so no rule can touch it and it never
   leaks into a title or an anchor's text. `cdata-with-markup` and `cdata-unclosed-at-eof` pin it.

9. **An incomplete tag contributes no newline (this worker was wrong).** `extract("<p")` answered
   `"\n"` because the newline rule ran on a name the scanner had managed to read, even though the tag
   was incomplete and therefore dropped. The contract's bracket rules imply the whole tag goes and
   nothing of it takes effect; `tag-name-only-at-eof` pins it and the walk now checks that the tag was
   actually terminated before applying any tag rule.

10. **Behaviours left as the contract implies rather than invented.** `<br/>` contributes one newline
    (not two), `</br>` one, a self-closing `<p/>` one; a closing tag with no opener still contributes
    its newline (`extract("a</p>").text` is `"a\n"`); attribute values may be unquoted; a `<` inside a
    quoted attribute value does not end a tag; an unterminated comment or doctype swallows the rest of
    the input.

11. **One doc-level observation.** Error text for a request line that is not JSON embeds the parser's
    own wording (`"request is not JSON: unterminated JSON string"`), so the message's parenthetical
    differs between languages while the envelope and code now agree (`{"id":null,...}`, which section
    1.1 records). If a malformed-line case is ever diffed byte for byte, the contract will need
    canonical wording.
