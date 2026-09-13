# SQL worker: `search.query` in SQLite (`vmlsearch.mjs`)

The SQL implementation of `search.query` (`docs/WORKERS.md` section 9), a worker in the multilingual
layer like the others: it speaks the JSON-Lines protocol of section 1 and is diffed case for case
against the JavaScript reference and, later, the Java inverted index.

The point of this entry is that **the query is the implementation**. The filtering, the scoring, the
ordering and the faceting are SQL statements; JavaScript does the protocol, the tokenizer, and loading
the request into an in-memory database. If a score were computed in JavaScript, this file would have
stopped being the SQL entry.

- **Artifact:** `workers/sql/vmlsearch.mjs` (this file is the artifact — see "No build step")
- **Launch:** `node workers/sql/vmlsearch.mjs --capability search.query`
- **Capabilities:** `search.query` (one process, one capability)
- **Runtime:** Node 24 (this machine: **v24.20.0**) with the built-in `node:sqlite`, which reports
  **SQLite 3.53.4**. No third-party packages, nothing downloaded, no network at run time.
- **Worker id (for the parent to register):** `sql-search` — see "Registry entry" below.

## How to run

```bash
# from the repository root
node workers/sql/vmlsearch.mjs --capability search.query   # stdio JSON-Lines protocol
node workers/sql/vmlsearch.mjs --selfcheck                 # 23 built-in cases, no protocol traffic
node workers/sql/selfdiff.mjs                              # 456 inputs vs the JS reference (not part of the protocol)
node tools/workers.mjs --no-build --cap search.query       # the corpus against every search worker
```

One request per line on stdin, one response per line on stdout, UTF-8, LF, no BOM:

```
{"id":1,"op":"describe"}
{"id":2,"op":"invoke","capability":"search.query","input":{"docs":[…],"query":{…},"limit":0}}
{"id":3,"op":"shutdown"}
```

Nothing but protocol lines ever reaches stdout — no banner, no version line. `--selfcheck` writes its
English result lines and its summary to **stderr** and exits non-zero on a failure. `--capability
search.query` and `--selfcheck` are the only accepted command lines; anything else (no arguments, an
unknown flag, a capability this worker does not implement) is reported on stderr and exits **2**, so
the host sees a refused start rather than a worker that answers `unsupported` to everything.

Node writes UTF-8 to stdout and stdin is decoded as UTF-8 explicitly (`process.stdin.setEncoding('utf8')`),
so the section 1.2 encoding trap does not apply here: no CR byte reaches the protocol stream (verified —
see Evidence).

## Registry entry (not added by this worker)

`workers/registry.json` was deliberately left alone: two agents writing it is a lost update. The entry
this worker needs is:

```json
{
  "id": "sql-search",
  "language": "sql",
  "capabilities": ["search.query"],
  "artifact": "workers/sql/vmlsearch.mjs",
  "launch": ["node", "workers/sql/vmlsearch.mjs"],
  "notes": "search.query in SQLite through Node's built-in node:sqlite: the filters, the integer score, the ordering and the facets are SQL statements; no build step, no third-party packages."
}
```

There is no `build` key on purpose: the artifact is the source file, and `node:sqlite` is part of Node.

## What is SQL and what is not

Six tables, six INSERT statements, five read statements, and one tokenizer call per field.

| Part of the capability | Where it lives |
| --- | --- |
| Protocol: `describe`/`invoke`/`shutdown`, envelopes, codes, flush-per-response | JavaScript (`main`) |
| Tokenization of every field of every document and of every query term | `tokensOf`, imported from `workers/js/vmltext.js` — **not** re-implemented |
| Turning a document into rows (title tokens, text tokens, one token set per tag, verbatim tags) | JavaScript loader |
| Exact-string tag filter | SQL (`NOT EXISTS`/`EXISTS` per requested tag) |
| Term → field matching ("every token of the term is in that field's set") | SQL (`EXISTS` + `NOT EXISTS` over `token` / `tag_token`) |
| `match: "all"` / `"any"`, and "no terms matches everything" | SQL (one predicate, `$terms` parameter) |
| Inclusive `from`/`to`, `null` ts excluded | SQL (`WHERE` with `$from_unset`/`$to_unset`) |
| **Score** (title +3, tag +2, text +1, whole-query +4) | SQL (`SUM(CASE WHEN … THEN 1 ELSE 0 END)`, integer) |
| **Ordering** (`score DESC, ts DESC, id by UTF-8 bytes`) | SQL (`ORDER BY … COLLATE BINARY ASC`, total order) |
| **Paging** (`limit`, `limit = 0` = no limit) | SQL (`LIMIT $limit`) |
| **Facets** (tags, UTC months, keys by UTF-8 bytes) | SQL (`GROUP BY` + `ORDER BY … COLLATE BINARY`) |
| `hits`, `total`, `facets`, `excludedByTime` field order | JavaScript (object literal in contract order) |
| `excludedByTime` | **the one number JavaScript computes** — it counts the rows of the set SQL selected |

The honest way to say the last line: `SELECT COUNT(*)` is SQL, but the *decision* to report that count
as `excludedByTime` is in JavaScript. Everything that decides which documents are reported, in what
order, with what score, and how many of them are bucketed is decided by a statement.

### The statements, in order

```
SCHEMA (6):   doc, token, tag, tag_token, qterm, qtag
LOAD (6):     INSERT doc; INSERT OR IGNORE token; INSERT tag; INSERT OR IGNORE tag_token;
              INSERT OR IGNORE qterm; INSERT qtag
READ (5):     SELECT_HITS, SELECT_TOTAL, SELECT_EXCLUDED, SELECT_FACET_TAGS, SELECT_FACET_MONTHS
```

Each read statement re-states the CTE chain it needs (`WITH_CHAIN`) rather than sharing a temp table:
SQLite will not reuse one `WITH` clause across two statements, and five statements that each forgot one
step would be five ways to answer about a different set. The chain is, in dependency order:

```
term_flags → completed → matched → verdict → bonus → scored → time_rejected → kept
```

- `term_flags` — one row per (document, term, field) with that field's `hit` flag and weight. Three
  `UNION ALL` branches: title, text, tag.
- `completed` — per (document, term): did any field hold the whole term, did the title, and what the
  matched fields' weights add up to.
- `matched` — the terms that matched in full. A term whose tokens are split across two fields did not
  match either of them, so it is absent here.
- `verdict` — per document: `v` = every requested term matched, `any_hit`, `base`, `title_hits`.
- `bonus` — +4 when `title_hits = $terms`, i.e. every requested term matched the title.
- `scored` — `base + bonus`, plus `key` and `ts`, over *every* document (a `LEFT JOIN`, so a query with
  no terms needs no special branch).
- `time_rejected` / `kept` — the tag filter, then the time filter; `total`, the hits and both facets all
  read `kept`, which is why they cannot disagree.

### Why the tokenizer is imported, not copied

Section 9 requires `search.query` to tokenize "exactly as `text.fingerprint` does", and a second
tokenizer is a second dialect: the corpus would spend its time reporting the difference between two
tokenizers instead of the bugs. So this worker calls the same `tokensOf` (`workers/js/vmltext.js`) that
the reference calls. The consequence is stated plainly: **this worker depends on `workers/js/`**, and it
is a SQL implementation in the sense the task asks for — the query is SQL — not a self-contained one
that could be copied out of the tree alone.

`tokensOf` is the only thing imported. Nothing from `workers/js/vmlsearch.js` is used: the scoring,
matching, ordering and faceting here were written against section 9, and the reference is used only to
diff against.

## SQLite behaviours the contract depends on

Each of these is written out in the source with a comment, because each is the kind of thing that
changes the answer without changing the query text:

1. **`BINARY` is UTF-8 byte order.** The default collation compares the UTF-8 bytes of TEXT, which is
   exactly section 9's "id ascending by UTF-8 bytes" and its "facet keys sorted ascending by UTF-8
   bytes". `COLLATE BINARY` is written explicitly in both `ORDER BY` clauses anyway: a database created
   with `NOCASE` or a locale-aware collation as its default would otherwise change the answer silently.
   A locale collation is also what would put `émile` next to `e` instead of after `z`, which the
   corpus's `ties-break-by-ts-then-id-bytes` case pins.
2. **`NULL` sorts last under `ORDER BY ts DESC`.** SQLite sorts NULL before every value, so descending
   puts it last — which happens to be the contract's "`null` last". This is relied on **and said out
   loud**, in the source comment and in `--selfcheck` ("orders ts desc with null last"), rather than left
   as a lucky accident that a different engine's `NULLS FIRST`/`NULLS LAST` default could take away.
3. **No boolean type.** A comparison evaluates to 1 or 0 and there is no `SUM(bool)`, so the score is
   `SUM(CASE WHEN … THEN 1 ELSE 0 END)` and "complete in this field" is written the same way.
4. **Integer division truncates toward zero, the epoch floors.** `-5 / 1000` is `0` in SQLite and `-1`
   as seconds since the epoch, so the UTC month bucket needs an explicit floor correction. Without it,
   a timestamp one millisecond before the epoch buckets into `1970-01` instead of `1969-12`. There is no
   corpus case for a negative `ts`; a differential run against the reference (which buckets with
   JavaScript's `getUTCFullYear`) is what found it.
5. **`strftime(…, 'unixepoch')` is UTC**, independent of the machine's timezone — the same thing the
   reference gets from `getUTCFullYear`/`getUTCMonth`, and the reason `SQLITE_UTC`-style settings are
   not a risk here.
6. **A named parameter the statement does not mention is an error** (`Unknown named parameter`). Each
   statement therefore gets exactly the bindings it uses, which is why the bindings are grouped as
   `shapeParams` and `limitParams` rather than passed as one object.
7. **`ORDER BY` on a computed column is not the same as `GROUP BY` on it** (`GROUP BY month` groups the
   facet rows by the printed `YYYY-MM` string, which is also what makes `ORDER BY month COLLATE BINARY`
   order the groups). Both are inside the SQL; the objects in JavaScript are built from the row order,
   so the map cannot decide it.
8. **`WITHOUT ROWID`, `INSERT OR IGNORE` and a primary key are the set semantics.** Section 9 says a
   field's tokens form a *set*: order does not matter and duplicates collapse. That is exactly
   `PRIMARY KEY (doc_id, field, token)` plus `INSERT OR IGNORE`, so the collapse is the schema's job
   rather than a `DISTINCT` somebody has to remember.

## Where SQL's natural answer was *not* the contract's answer

This was the interesting part of the task, and there is more than one. The first one is the one worth
reading, because it is the only place where the ordinary SQL formulation of the rule is wrong.

### 1. `SUM` over the fields of a term is the wrong shape three times over

The contract's rules are about a *term matching a field*:

> A **term matches a field** when every token of the term is in that field's set.

The field has a token set; a term has tokens; the rule is a relation between one term and one field. The
natural SQL move is to flatten "one term, three fields" into rows with a flag per field and a
`SUM(CASE WHEN flag THEN weight ELSE 0 END)` over them. That formulation is wrong in three separate
ways, and each one produced a real, corpus-visible wrong answer here:

- **The tag field is not one token set.** A document's tags are a *list* of sets. `SUM` over tags
  answers "the term's tokens appear somewhere among the tags", so `tags: ["openai", "gpt"]` matched the
  term `openai gpt` — where the contract wants "some tag holds every token", which that document does
  not have. The reference scores it `total: 0`; the summed version scored it 6.
- **The weights are per term per field, not per token.** With one flag per (term, field), a field that
  matched contributes its weight once. Summing token counts instead let `openai` matching in the text
  alone collect 3 + 2 + 1: the title flag had been computed as "does the title contain *a* token of the
  term", which for a one-token term is 1 even when the token is not in the title. The corpus case
  `score-text-only` is exactly this, and it is the case that caught it.
- **A term with no tokens is a term that matches nothing, not a term that matches everything.** "Every
  token of the term is in the set" is *vacuously true* for a term that tokenizes to nothing (`"???"`).
  Written as `NOT EXISTS (missing token)` this matches every field of every document, with the
  whole-query bonus; the corpus's own `--selfcheck` sibling case wants `total: 0`. SQL has no "for all",
  so the rule needs two quantifiers — "the term has a token" *and* "no token of it is missing" — and the
  first one is the half that is easy to leave out.

The tag one needs its own tables (`tag`, `tag_token`) rather than a third value in `token`'s `field`
column; the other two need the per-request term count `$terms` (see below) and the two-quantifier
version of "every token is present". The corpus's `long-mixed-corpus` case, whose expected score is 3
per hit, is what a `SUM`-shaped implementation gets wrong by 4.

### 2. `COUNT(*) FROM qterm` counts tokens, not terms

`qterm` holds one row per (term, token), because a term is a token list. `match: "all"` means "every
term matched", and the first version compared the number of matched terms against the number of *rows*
in `qterm` — so the two-token term `openai gpt` required a document to match it twice and matched
nothing at all. The corpus case is `multi-token-term-requires-both`. The count has to be a property of
the request (`$terms`, bound from JavaScript) and not something derivable from the query tables, because
a term that tokenized to nothing genuinely has no rows anywhere — and that is also why `$terms = 0` is
the test for "this query asks nothing" rather than "this document matched nothing".

### 3. `LIKE` is case-insensitive by default; the tag filter is not

SQLite's `LIKE` is ASCII-case-insensitive unless `case_sensitive_like` is on, so the obvious SQL for
"a tag filter is exact" (`tag LIKE '%' || ? || '%'`) accepts `Nijisanji` for the requested `nijisanji`.
Here SQL's default is *looser* than the contract, which wants bytes to be equal: the corpus case
`tag-filter-is-exact` expects `total: 0` and a `LIKE` version returns 1. This implementation uses `=`
under the default `BINARY` collation, so no `PRAGMA case_sensitive_like` is needed (and none is set — the
answer should not depend on a pragma somebody might flip).

### 4. Two smaller ones

- **A term does not match "the tags of a document" as one set**, which is a different statement of (1):
  the tag *filter* is exact-string and the tag *matching* is per-tag token sets, and the two must not
  share a table shape.
- **`ts` must survive the score.** The output object is `{"id", "score"}` only, but the ordering is
  `score DESC, ts DESC, id ASC`, so `ts` has to be carried through the chain to the `ORDER BY` and then
  dropped. `SCORED` carries `key` and `ts` for exactly that reason; they are not in the response.

## `--selfcheck`

23 cases, all passing, covering the corpus's edge rules: empty query; the whole-query-in-title bonus
(and that it needs *every* term, and is not doubled by a repeated term); a CJK term through bigrams;
`match: all` versus `any`; a multi-token term in one field versus split across two; a term that
tokenizes to nothing; a document with no tags; the exact tag filter; a null `ts` excluded and counted;
the inclusive bounds; the tie-breaks (ts descending, then id by UTF-8 bytes); facet key order; the UTC
month buckets including a millisecond before January and the epoch; the limit (and `limit: 0` = no
limit); that the ordering is total (the same corpus in reverse gives the same hits); and the
`bad-input` refusals (negative limit, non-array `docs`).

`--selfcheck` asserts the *contract* — the weights 3/2/1/4 from section 9's table, hand-written — and
not the reference implementation's output. A selfcheck that said "the reference agrees" would pass even
if both were wrong.

## `selfdiff.mjs`: why it is kept

The corpus is a floor, not a ceiling. Every bug this implementation had that mattered was found by
running it against the reference over inputs the corpus does not contain, not by reading section 9 again:

| What was wrong | What found it |
| --- | --- |
| the tag field treated as one token set (a term matching across two tags) | `tags: ["openai", "gpt"]` vs the term `openai gpt` |
| `COUNT(*) FROM qterm` used as the term count, so a multi-token term matched nothing | `multi-token-term-requires-both` (corpus) plus generated variants |
| the whole-query bonus compared against *matched* terms instead of requested ones | a generated case with three terms where one matched |
| the per-field flags not gated on completeness, so a text-only match scored 5 | `score-text-only` (corpus) |
| `ts / 1000` truncating toward zero, so a pre-epoch timestamp bucketed into the wrong month | `ts: -5` (no corpus case has a negative `ts`) |

`selfdiff.mjs` is that harness, kept as a file so the next person can do the same after a change. It
compares semantically (key order does not decide the diff, values do) and exits non-zero when anything
differs. It is not part of the protocol, the harness does not call it, and it is not a second
implementation of anything.

## Evidence

```
$ node --version
v24.20.0

$ node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(':memory:'); const v = db.prepare('SELECT sqlite_version() AS v').get().v; db.close(); process.stdout.write('node:sqlite available, SQLite ' + v + '\n');"
node:sqlite available, SQLite 3.53.4

$ node workers/sql/vmlsearch.mjs --selfcheck
23/23 checks passed                        # exit 0; the 23 case lines and the summary go to stderr

$ node workers/sql/selfdiff.mjs            # 16 corpus inputs + 440 generated and hand-written ones
differential: 456/456 identical

$ node tools/workers.mjs --no-build --cap search.query     # with a temporary registry.local.json entry
  overlay    : workers/registry.local.json (2 machine-local entries)
workers: multilingual conformance run
  repository : E:\VtuberMonitorLink
  corpus     : search.query(16)
  workers    : js-text, js-search, java-text, cpp-text, go-text, python-text, pwsh-text, r-text, sql-search

== search.query  (16 cases x 2 implementation(s): js-search, sql-search)
   agreement  : 16/16 cases unanimous across 2 answering implementation(s)
   note       : js-search produced no usable answer for 1/16 case(s) (and said nothing on stderr)
   note       : sql-search produced no usable answer for 1/16 case(s) (and said nothing on stderr)

== summary
   search.query       16/16 unanimous, 2 implementation(s)
   all implementations agree
   reference: js-text (present)
```

No `DIVERGES`, `ORDER` or `SNAPSHOT` line names `sql-search`. The "no usable answer for 1/16" notes are
both implementations refusing `negative-limit-is-bad-input` with `ok: false, code: bad-input`, which is
the contract's answer for that case and is compared by code (the notes are the harness counting
`ok: false` as "no usable answer", not a failure — the case itself is unanimous).

The registry entry used for that run was added to the machine-local, gitignored
`workers/registry.local.json` and **restored immediately afterwards**; the file is back to its single
`r-text` entry.

Also verified: an unparsable request line answers `{"id":null,"ok":false,…}` and the worker stays
alive; an `invoke` for another capability answers `unsupported`; an unknown `op` answers `unsupported`;
`shutdown` answers the bare envelope and nothing else, exit 0; three bad command lines exit 2 with
stdout empty; the protocol stream is LF-only (2 responses out of a 2-request session, 0 `CR` bytes);
`--selfcheck` writes nothing at all to stdout (0 bytes); and the whole 16-case corpus pipelined as 18
request lines through three fresh processes produces byte-identical output each time (18 responses,
2908 characters, one distinct SHA-256 over the three runs).

## Known limits

1. **The tokenizer is imported from `workers/js/vmltext.js`** (see above). This is the intended
   division of labour — one tokenizer, per section 9 — but it does mean this worker is not
   self-contained, and a change to `vmltext.js` changes this worker's answers with no rebuild.
2. **No FTS5, no inverted index, no persistence.** Every `invoke` builds a fresh `:memory:` database,
   loads the whole document set and runs five statements. That is what the protocol asks for (the host
   hands over the whole set per call, so there is nothing to persist) and it is why the worker leaves no
   files behind on a read-only machine — but it is a scan-and-sort, not an index, so it is not the
   implementation to point at a large corpus. The Java inverted index is the intended answer to that
   question; this is the SQL-language answer.
3. **Performance is not a goal.** Every term/field pair is evaluated per document with nested `EXISTS`
   subqueries, so the cost grows with (documents × terms) and each of the five read statements re-does
   the matching rather than sharing a materialised temp table. The corpus is tiny; a corpus an order of
   magnitude larger would want the chain materialised once (or an index on `token(doc_id, field,
   token)`, which the `WITHOUT ROWID` primary key already provides).
4. **`limit` binds SQLite's largest integer (2^63-1) for `limit = 0`**, rather than building a second
   statement without `LIMIT`. One binding path beats two statements that could drift; the cost is that a
   corpus of 2^63 documents would be silently truncated, which is not a real cost.
5. **`ts` must be an integer to be exact.** The column is INTEGER and JavaScript numbers are inserted
   directly. Epoch milliseconds stay exact well past `Number.MAX_SAFE_INTEGER` for any real date, but a
   timestamp beyond 2^53 would be rounded by JavaScript before SQLite ever saw it — the reference has
   the same limit, since it is a JavaScript number there too.
6. **Contradiction in the spec, implemented the corpus's way.** Section 9 says a field's tokens form a
   set ("duplicates collapse") and also that "a repeated term scores twice". The corpus case
   `terms-are-edge-trimmed-and-scored-per-term` pins the second reading with `terms: ["openai,", "openai"]`
   → score 10, and the reference agrees. Both readings coincide here because a repeated *term* is two
   terms while the field's duplicate *tokens* are one set — but the sentence "a repeated term scores
   twice" would be false if the score were computed per matching token in the field, which is another
   way to read "each field's weight" × "matches". This implementation counts terms, which is the only
   reading consistent with the snapshot and with the reference. Reported rather than bent.
7. **No normalization, deliberately.** Section 9 says documents and queries arrive already normalized
   (the host composes `text.normalize`) and that a worker which normalizes again will differ on the
   combining-mark cases. This worker never normalizes; it tokenizes exactly what it is given, and it does
   not read `workers/spec/latin-*.json`.
8. **Facet counts count duplicate tags once per occurrence.** A document with `tags: ["t", "t"]`
   contributes 2 to the tag facet for `t`, because the facet is a join against the stored tags. The
   reference does the same (`tagCounts[tag]++` per tag in the array), so this is the shared reading and
   not a divergence — recorded because it is the other place where "counts the matching set" could be
   read as "counts the matching documents".
