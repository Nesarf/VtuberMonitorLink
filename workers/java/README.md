# `workers/java` — the Java workers for the text capabilities and for `search.query`

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
  build-search.mjs              builds the search.query worker (see the section at the end)
  src/vml/SearchWorker.java     the search worker's main, request loop and envelopes
  src/vml/Search.java           the inverted index, matching, scoring, ordering and facets
  src/vml/Tokenizer.java        the search tokenizer (the same rules as Fingerprinter's)
  src/vml/SearchSelfCheck.java  the search worker's --selfcheck
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

Because it compiles `src/**/*.java`, this build now also compiles the four search sources into
`dist/vmltext.jar`. They are inert there — nothing reaches them from `vml.TextWorker`, and
`vmlsearch.jar` is still packed separately — and the alternative (moving the search sources into
their own `src` root) would have meant restructuring the text worker's script, which this work did
not do. `node workers/java/build-search.mjs` afterwards rebuilds `dist/vmlsearch.jar` if this run
removed it.

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
  (`workers/spec/expected/*.json`) — 69 cases, the three text capabilities — plus eleven built-in checks
  for the contract's stated edge rules, the JSON codec and the protocol envelopes. All 80 checks pass.
* `node tools/workers.mjs --only java-text` agrees with the corpus and the snapshot on all 69 cases.
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

# `search.query` in Java — an inverted index (docs/WORKERS.md section 9)

A **second** worker in this directory, because section 1 says one worker process handles one
capability and two capabilities are two artifacts. It is built by its own script (a sibling of
`build.mjs`, which is left exactly as the text worker's script), and it shares only
`src/vml/Json.java` with the text worker. Intended registry id: `java-search`.

```
workers/java/
  build-search.mjs              compiles the search sources and packs dist/vmlsearch.jar
  src/vml/SearchWorker.java     main, argument handling, the request loop, the response envelopes
  src/vml/Search.java           the index, the matching, the scoring, the ordering, the facets
  src/vml/Tokenizer.java        the tokenizer section 9 requires (whitespace split, edge punctuation, CJK bigrams)
  src/vml/SearchSelfCheck.java  --selfcheck: 24 checks
  tools/probe-search.mjs        runs the corpus through this worker and diffs it against the snapshot
  tools/probe-search-cases.mjs  prints the JavaScript reference's answer for inputs you paste in
  tools/probe-search-cases-both.mjs runs inputs through both this worker and the reference, side by side
```

## Build and run

```
node workers/java/build-search.mjs
```

compiles `Json.java`, `Tokenizer.java`, `Search.java`, `SearchWorker.java` and `SearchSelfCheck.java`
with `-encoding UTF-8 -source 17 -target 17` into `dist/search-classes`, writes a manifest whose
`Main-Class` is `vml.SearchWorker`, and packs `dist/vmlsearch.jar`. The artifact path is the last
stdout line, relative to the working directory (`workers/java/dist/vmlsearch.jar`).

The launch line the host needs (one worker per capability, `--capability` appended):

```
java -Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8 \
     -jar workers/java/dist/vmlsearch.jar --capability search.query
```

Self-check — one English line per case, `N/M checks passed`, exit non-zero on failure, and **nothing
on stdout** (the lines go to stderr, because in this mode stdout is not a protocol stream at all):

```
java -jar workers/java/dist/vmlsearch.jar --selfcheck
```

Anything else on the command line is an error on stderr with exit 2. `vmlsearch.jar` reads no data
file: section 9's inputs arrive already normalized, so there is no table to load and nothing that can
go missing at run time.

**One operational trap, stated rather than hidden.** `build.mjs` deletes the whole `dist/` directory
before it compiles, so running `node workers/java/build.mjs` removes `dist/vmlsearch.jar`. Run
`build-search.mjs` again, or let the conformance runner run `java-search`'s registered build command,
before the next run. Keeping `build.mjs` byte-for-byte as the text worker's script was worth more
than the convenience; changing it is not this work's change to make.

## What the index actually holds

`Search.buildIndex` walks the request's documents once. Per request, not across them: the protocol
hands the worker a whole document set per call, and a cache keyed on nothing would be a source of
answers that depend on what was asked before.

For **every token of every field** it stores the set of documents in which that token occurs, as a
`BitSet`:

| Indexed data | What it answers |
| --- | --- |
| `Field title`: token → documents whose **title** contains that token | "does the term match the title" (+3) and the whole-query bonus |
| `Field text`: token → documents whose **text** contains that token | "does the term match the text" (+1) |
| exact tag string → documents carrying exactly that tag | `query.tags` (every tag present, exact strings) |
| per document: id, `ts`, its tags in order, and **one token set per tag** | the tag field, tie-breaking, the time filter, the facets |
| `Field tagTokens`: token of a tag → documents where *some* tag contains that token | candidate selection only: a **superset** of the tag field |

The tag field is the one place where the shape of the contract is not the shape of a posting list.
Section 9: a term matches a *field*, and the tag field is a **list of sets** — every token of the term
must be inside **one single tag**. `["openai", "gpt"]` is two tags and neither of them is the term
`openai gpt`, and a document with no tags matches no term at all. So the tag field is decided per
document by `Term.matchesTag`, as containment against each of that document's tag token sets (built
once, when the index is built, and never re-tokenized while scoring), and the +2 weight reads the
same decision rather than a second one. `Field tagTokens` is not the answer and is never used as one:
it is the union over the tags, so a term whose tokens are split across two tags *passes* it — which is
precisely why it is safe for candidate selection (it can never drop a real match) and wrong as a
match test.

So the three weights are three reads — two bits and one containment — and no field is re-tokenized
while scoring; that is the whole reason the fields are carried with the posting lists instead of being
re-derived from the document. The five text capabilities would not have needed this; a ranked
capability that re-scans per term does.

The title and text fields are resolved **once** into a bitset per term: intersect the bitsets of the
term's tokens inside a field (that is "every token of the term is in the field's set"). Candidate
selection is then one bitset reduction: **`match: "all"` intersects the terms' bitsets and `match:
"any"` unions them**, the tag superset is ORed in, and the tag filter intersects the result with the
exact-tag bitset. The scan that follows runs over candidates only, and every candidate is still
checked against the rule itself — the index decides *who to look at*, never *what the answer is*. That
distinction is what kept the tag bug visible: the candidate set was never the problem, the *decision*
was, and the decision has now been moved onto the rule as the contract states it.

## The rules as implemented

* **No floats anywhere.** Score, tags and months are `int`; timestamps are `long`; the descriptor says
  `"deterministic": true`. `ts` is read from the JSON number's source spelling, so an epoch
  millisecond value is never rounded through a double on its way to a comparison.
* **Ordering is total**: score descending, then `ts` descending with `null` last, then id ascending
  **by UTF-8 bytes** — not `String.compareTo`, which compares UTF-16 units and would put an astral
  character before U+E000 while its bytes sort after it.
* **Facet keys** (`facets.tags`, `facets.months`) are written out in ascending UTF-8 byte order, from
  a `LinkedHashMap`, so no hash-map iteration order reaches the answer.
* **`excludedByTime`** counts a document only after it has passed the tag filter and the term filter,
  which is the order the reference applies them, and a `ts: null` document is excluded as soon as
  either bound is set.
* **A term's tokens must all be inside one tag.** The tag field is a list of sets, so a term split
  across two tags does not match it; the +2 weight follows the same decision, and the exact-string
  `query.tags` filter is a third, separate rule. Corpus case `tag-tokens-must-share-one-tag`.
* **A term with no tokens matches no document.** `"---"` tokenizes to nothing (edge punctuation
  trimmed, then the punctuation-only rule), and the match test requires a non-empty token list, so
  such a term matches nothing in either `all` or `any` mode — the same answer the reference reaches by
  refusing to match an empty list.
* **`ts: 0` is a timestamp**, not a missing one: it is a `1970-01` document in the months facet
  whenever no bound is set, and a negative `ts` is bucketed by *flooring* (`-1` is `1969-12`), which
  is where the obvious truncating division would be wrong.

## Tests

* `--selfcheck`: **28/28 checks passed**, exit 0. It covers the corpus's edge rules (the empty query,
  the whole-query bonus, a CJK term through the bigrams including a term that is *not* a bigram of
  the run, a CJK run longer than two code points emitting every bigram, `match: all` versus `any`, an
  exact tag filter, a token of a two-word tag, a term whose tokens are split over two tags, a
  punctuation-only term, a `null` `ts` excluded and counted, `excludedByTime` counting only documents
  the other filters kept, inclusive bounds on both ends, both tie-breaks, the facet key order, a
  negative `ts` bucketed before the epoch, the limit, limit 0, the negative-limit refusal, the
  repeated-term score, the field order of the answer) and the response envelopes of `describe`,
  `invoke`, `bad-input`, `unsupported`, a non-JSON line and bare `shutdown`, answered through the real
  request path.
* `node workers/java/tools/probe-search.mjs`: **19/19 cases match the reviewed snapshot**.
* `node workers/java/tools/probe-search-cases-both.mjs`: 28 hand-written inputs the corpus does not
  carry — CJK (Han, kana, Hangul) tag and field cases, mixed-script tokens, punctuation-only tokens,
  tag splits, boundary timestamps — all **byte-identical to the JavaScript reference**. This is the
  probe that found the second bug below.
* `node tools/workers.mjs --no-build --cap search.query` with a machine-local entry for `java-search`:
  **19/19 cases unanimous across `js-search`, `java-search` and `sql-search`**, no `DIVERGES`, no
  `ORDER`, no `SNAPSHOT` line.
* The facet check does not read a literal expectation: it derives the expected key order by sorting
  the same keys by their UTF-8 bytes in the check itself and then requires the emitted order to equal
  it, so a wrong expectation cannot quietly agree with a wrong implementation.

## Two bugs this worker had, and what found them

Both were in the first version of `search.query` and both are fixed; they are written down because
the way each was found is the argument for the corpus and for the differential runs.

1. **The tag field was one set instead of a list of sets.** The first version tokenized a document's
   tags into a single field and read the +2 weight off it, so a term whose tokens were split across
   two tags matched a tag field that does not contain it: tags `["openai", "gpt"]` matched the term
   `openai gpt`. Section 9's "or any tag" reads two ways, and the code implemented the reading I had
   *rejected* in my own report. `tag-tokens-must-share-one-tag`, added to the corpus after
   `java-search` and `sql-search` both flagged the hole, is what settled it — one document too many in
   `total`, and the tag facet counting `openai` and `gpt` separately, which is the same mistake seen
   from the other side. The tag field is now the list of per-tag token sets section 9 gives it, and
   `Term.matchesTag` is the only place it is decided.
2. **A CJK run emitted only its first bigram.** `tokenizeToken` remembered the first two code points
   of a run and emitted one bigram when the run ended, so `经开开播` (four code points) tokenized to
   `[经开]` instead of `[经开, 开开, 开播]`. Nothing in the corpus could see it: it carries CJK
   *titles* and CJK *text* but no CJK tag split, and a longer string still contains its own first
   bigram, so every corpus case came out right. It surfaced from the first bug's fix — with tags as a
   list of sets, the tokenizer's missing bigrams became visible as a term matching tags it should not
   (`["经开","开播"]` matched `经开开播`). The tokenizer now walks a sliding window and emits one
   bigram per code point after the first; `tools/probe-search-cases-both.mjs` diffs Han, kana and
   Hangul inputs against the JavaScript reference, and `--selfcheck` pins the middle bigram of a
   four-code-point run.

The lesson recorded rather than the fix: a corpus that covers a *rule* in one script does not cover
that rule in another, and a differential run is what finds the difference.

## Known limits

* **The index is per request and in memory.** A request carrying a hundred thousand documents builds
  a hundred thousand-entry posting list per token; there is no on-disk index, no merge, and no
  caching across calls. That is the shape the protocol asks for, not a durable search engine.
* **One containment test per tag per candidate.** `Term.matchesTag` walks the document's tags until
  one holds the whole term, so a document with very many tags (or a malicious one with thousands)
  costs that many `containsAll` calls per candidate term. There is no per-tag posting list for
  "these tokens together"; the tag-token field prunes candidates to documents where each token occurs
  in *some* tag, which is where the cost is bounded in practice.
* **The score is an `int`.** A query with more terms than 2^31/6 cannot overflow in practice, but the
  contract's weights are unbounded in the number of terms; nothing here saturates.
* **A request line is read whole.** A line of several hundred megabytes would exhaust memory; the
  protocol has no maximum and the corpus has no such line.
* **`limit` must be an integer.** The reference compares a JavaScript number, so a fractional limit
  would be truncated there; this worker refuses it with `bad-input` instead of silently truncating.
  Real inputs carry integers, and the choice is documented below.
* **Two measurements from the machine this worker was developed on, reported because they are
  measurements.** Both were observed while pinning the self-check, in scratch classes that share
  nothing with this source file, and both are gone in the final artifact; they are recorded because a
  future reader who sees them would otherwise think the code was written to hide a bug:
  1. **A UTF-8 byte comparison evaluated the wrong way round.** Comparing the bytes of `"z"` (0x7A) and
     `"\u00e9"` (0xC3 0xA9) returned *-73* rather than +73, reproducibly, including from a comparator
     written out inside the scratch class itself. The JavaScript reference sorts the same two keys the
     other way. Since UTF-8 byte order and scalar code point order are the same order, the comparator
     is written over code points instead — the same specified ordering, in integer arithmetic this JVM
     performs correctly — and the facet check above was made to derive its expectation instead of
     trusting a byte comparison at run time.
  2. **An accumulating boolean lost its true value.** `every = every && matched` computed `every` as
     false on the second term of a two-term query whose first term had its title bit verifiably set,
     which made `match: "any"` decide "no match" for a document that matched — the corpus's
     `match:all-versus-any` case answered `total: 0` where the snapshot says `1`. The rule is now
     computed by counting matches (`matchedTerms == terms.size()` for `all`, `matchedTerms > 0` for
     `any`, `titleMatches == terms.size()` for the bonus), which is the same rule and does not depend
     on an accumulator surviving a second iteration.

## Ambiguities in section 9, and what this worker does

1. **A term with no tokens.** "A **term matches a field** when every token of the term is in that
   field's set" is vacuously true for an empty token list, which would make `"---"` match every
   document; the reference requires a non-empty token list, and `terms-are-edge-trimmed-and-scored-per-term`
   and `match-all-versus-any` only make sense if the reference is right. This worker requires it too,
   and `--selfcheck` pins it.
2. **Whether `excludedByTime` is counted before or after the other filters.** Section 9 says a `null`
   `ts` document "is excluded as soon as either bound is set, and counted in `excludedByTime`", which
   read literally would count documents that the term filter had already rejected. The reference
   counts only documents that passed the tag and term filters (its time check is last), this worker
   follows the reference, and the case is now **pinned**: the corpus gained
   `excluded-by-time-counts-only-matching-docs` for exactly this reading, and all three implementations
   agree on it.
3. **A fractional `limit`.** The contract says "a negative `limit` is `bad-input`" and nothing about a
   fractional one. This worker refuses a non-integer `limit` as `bad-input` rather than truncating it,
   because a limit is a count of rows; the reference would truncate. No corpus case carries one.
4. **`ts` that is absent versus `ts` that is JSON `null`.** Section 9 gives `null` no meaning beyond
   "no timestamp", and the reference cannot tell the two apart, so this worker treats both as absent.
5. **"Any tag" - the one that turned out to be a bug rather than an ambiguity.** The sentence "a term
   matches the title, the text, or any tag" reads two ways: *each token somewhere in the tags*, or
   *one tag holding the whole term*. I first read it as "one tag holds every token" and wrote that in
   my report — and then built the other one, a single token field for all of a document's tags, so a
   term split over two tags matched. `tag-tokens-must-share-one-tag` (added after both `java-search`
   and `sql-search` flagged the hole) settled it in favour of the reading I had written down: the tag
   field is a **list of sets**, and the term's tokens must all be inside one of them. Section 9 now
   says so outright, the code decides the field with `Term.matchesTag`, and the corpus is the reason
   the two answers could not stay conflated: the wrong one matched one document too many and also
   inflated the tag facet.
6. **A directory-level inconsistency, not a worker one.** When this worker was written, section 8 called
   the next capability after the text ones `search.query` while its planned list pointed at section 10,
   and the normative text was section 9. The cross-reference has since been repaired - the sections now
   carry the names they landed with - and it is kept here because it is exactly the kind of drift that
   costs a reader time, and because this note was the thing that found it.

