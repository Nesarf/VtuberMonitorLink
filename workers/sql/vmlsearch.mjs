// workers/sql/vmlsearch.mjs — `search.query` (docs/WORKERS.md section 9) implemented in SQL.
//
// This is the "SQL is the implementation language" entry of the multilingual worker layer, and the
// division of labour is the whole point of it:
//
//   * JavaScript does the *protocol* (JSON Lines over stdio, section 1), the *tokenizer* (section 9
//     requires the same rules as `text.fingerprint`, so this file uses the canonical `tokensOf`
//     instead of inventing a second dialect), and *loading* the request into an in-memory database.
//   * SQL does the work. The term and tag filters are WHERE/EXISTS against a token table; the integer
//     score is SUM(CASE WHEN ... THEN 1 ELSE 0 END) summed over the query's terms; the ordering is
//     ORDER BY score DESC, ts DESC, key COLLATE BINARY ASC; the page is LIMIT; and both facets are
//     GROUP BY over the same matching set the hits come from.
//
// Exactly one number is computed outside SQL: `excludedByTime`, which is the size of a set that SQL
// selects and JavaScript only counts. No score is ever computed in JavaScript — if one were, this
// would have stopped being the SQL entry. `--selfcheck` therefore asserts the weights (3/2/1/4) and
// the ordering against hand-written expectations rather than against the JavaScript reference.
//
// No third-party packages — `node:sqlite` ships with Node (stable in Node 24). No files either: the
// database is `:memory:` and is created and closed inside each `invoke`, so the worker leaves nothing
// behind on a read-only machine and two requests cannot see each other's rows.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tokensOf } from '../js/vmltext.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAPABILITY = 'search.query';

// The four weights of section 9's table, as literals in the SQL text. They are constants of the
// contract, not input, and keeping them next to the flags they multiply makes the arithmetic read as
// arithmetic instead of as a bound value.
const W_TITLE = 3;
const W_TAG = 2;
const W_TEXT = 1;
const W_WHOLE_QUERY_IN_TITLE = 4;

// "No limit" is spelled `limit = 0` by the contract and `LIMIT $limit` needs a number, so the no-limit
// case binds SQLite's largest integer. One binding path beats a second statement that could drift from
// the first.
const NO_LIMIT = 9223372036854775807n;

// The two fields whose tokens come from one string, plus the field number a tag reports as its *kind*
// in the score — a tag's tokens are not in `token`, so `FIELD_TAG` is a field kind and not a value of
// `token.field`.
const FIELD_TITLE = 0;
const FIELD_TEXT = 1;
const FIELD_TAG = 2;

// A repeated term is a second term, so the number of terms is a property of the *request*, not of the
// query tables: `qterm` holds one row per (term, token), so counting its rows counts tokens, and
// counting its distinct terms loses the terms that tokenized to nothing. The request's own term count
// is carried into the SQL as the `$terms` binding and decides both "is this query asking anything at
// all" and "did every requested term match".

// ── input validation: bad input is an answer, not a crash ────────────────────────────────────
//
// Which inputs are legal is the reference's business (workers/js/vmlsearch.js) and only the error
// `code` is ever compared across implementations, never the message text. The defaults below are the
// reference's: a missing `query`, `terms`, `tags`, `from` or `to` is not an error; `limit` below zero
// is.

const badInput = (message) => Object.assign(new Error(message), { code: 'bad-input' });
const asArray = (value) => (Array.isArray(value) ? value : []);
const asText = (value) => String(value ?? '');

function readRequest(input) {
  const src = input ?? {};
  const docs = Array.isArray(src.docs) ? src.docs : null;
  if (!docs) throw badInput('input.docs must be an array');
  const q = src.query ?? {};
  const limit = typeof src.limit === 'number' ? src.limit : 0;
  if (limit < 0) throw badInput('limit must not be negative');
  return {
    docs,
    terms: asArray(q.terms).map(asText),
    // The tag filter compares exact strings, so a document's tags stay verbatim (untokenized) and the
    // comparison is `=` under the default BINARY collation — bytes, not a case-insensitive match.
    wantTags: asArray(q.tags).map(asText),
    match: q.match === 'any' ? 'any' : 'all',
    from: typeof q.from === 'number' ? q.from : null,
    to: typeof q.to === 'number' ? q.to : null,
    limit,
  };
}

// ── the SQL ─────────────────────────────────────────────────────────────────────────────────
//
// One schema (6 CREATE TABLE), six INSERT statements that load the request, and five read statements
// (hits, total, tag facet, month facet, excluded-by-time). The read statements are assembled from
// shared fragments on purpose — a rule written twice is a rule that will disagree with itself — and the
// two modes (`match: "all"` / `"any"`) differ in exactly one predicate.

// A field's tokens are a *set*: order does not matter and duplicates collapse, which is exactly
// INSERT OR IGNORE plus the primary key. `field` is TITLE or TEXT; a tag is a set of its own, so tags
// live in their own pair of tables rather than in this one.
const SCHEMA = [
  `CREATE TABLE doc (id INTEGER PRIMARY KEY, key TEXT NOT NULL, ts INTEGER)`,
  `CREATE TABLE token (doc_id INTEGER NOT NULL, field INTEGER NOT NULL, token TEXT NOT NULL, PRIMARY KEY (doc_id, field, token)) WITHOUT ROWID`,
  // Tags are stored twice on purpose: verbatim in `tag`, for the exact-string filter and the tag facet,
  // and tokenized in `tag_token` (one row per tag, per token) for term matching. The two cannot share
  // one table: "a term matches a tag" is about one tag's own token set.
  `CREATE TABLE tag (doc_id INTEGER NOT NULL, seq INTEGER NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (doc_id, seq)) WITHOUT ROWID`,
  `CREATE TABLE tag_token (doc_id INTEGER NOT NULL, tag_seq INTEGER NOT NULL, token TEXT NOT NULL, PRIMARY KEY (doc_id, tag_seq, token)) WITHOUT ROWID`,
  // One row per (term, token), so a term is a token list and the term index is what keeps a repeated
  // term a separate term (the corpus pins that it scores twice).
  `CREATE TABLE qterm (term INTEGER NOT NULL, token TEXT NOT NULL, PRIMARY KEY (term, token)) WITHOUT ROWID`,
  // Every requested tag must be present: one row per requested tag, and the filter is an EXISTS per row.
  // `seq` only exists so that two identical requested tags stay two rows.
  `CREATE TABLE qtag (seq INTEGER PRIMARY KEY, tag TEXT NOT NULL)`,
];

// A term has at least one token, and none of its tokens is missing: that is "every token of the term is
// in this field's set", written as two EXISTS because SQL has no "for all". Without the first half a
// term that tokenizes to nothing (`"???"`) vacuously matches every field, because every one of its zero
// tokens is present.
const TERM_TOKENS_IN = (field) =>
  `(EXISTS (SELECT 1 FROM qterm q WHERE q.term = i.term)`
  + ` AND NOT EXISTS (SELECT 1 FROM qterm q WHERE q.term = i.term`
  + ` AND NOT EXISTS (SELECT 1 FROM token t WHERE t.doc_id = d.id AND t.field = ${field} AND t.token = q.token)))`;

const TITLE_MATCHES = TERM_TOKENS_IN(FIELD_TITLE);
const TEXT_MATCHES = TERM_TOKENS_IN(FIELD_TEXT);

// The tag field is not one token set: a document's tags are a *list of sets*, and "a term matches a tag"
// means one of those sets holds every token of the term — not that the term's tokens are scattered
// across two tags. `["openai", "gpt"]` is two tags and neither of them is the term `openai gpt`, and a
// `SUM(CASE ...)` over the tags (the SQL-shaped move, again) answers yes to exactly that.
//
// So the relation is an EXISTS over the tags of that one document, and the three nesting levels are the
// three quantifiers of the rule: the term has a token, every token of it is in one tag, and the document
// has a tag at all — that last one because "every token is in some tag" is vacuously true of a document
// with no tags, which would make every term match every untagged document.
const TAG_MATCHES = `(EXISTS (SELECT 1 FROM qterm q WHERE q.term = i.term)`
  + ` AND EXISTS (SELECT 1 FROM tag g WHERE g.doc_id = d.id)`
  + ` AND EXISTS (SELECT 1 FROM tag g WHERE g.doc_id = d.id AND NOT EXISTS (`
  + `SELECT 1 FROM qterm q2 WHERE q2.term = i.term AND NOT EXISTS (`
  + `SELECT 1 FROM tag_token tt WHERE tt.doc_id = g.doc_id AND tt.tag_seq = g.seq AND tt.token = q2.token`
  + `))))`;


// The tag filter is an exact string comparison against the verbatim tags, not a token match. It is
// applied to a row set that already carries the document id, so the column comes in as a parameter
// rather than an alias being assumed to be in scope.
const TAG_FILTER = (docId) => `NOT EXISTS (SELECT 1 FROM qtag`
  + ` WHERE NOT EXISTS (SELECT 1 FROM tag g WHERE g.doc_id = ${docId} AND g.tag = qtag.tag))`;

// The time filter is inclusive on both bounds, and a NULL ts is excluded the moment either bound is
// set. `$from_unset`/`$to_unset` make the two bounds independent: a query with only `from` set must
// not compare against a NULL `to`. (SQLite would answer NULL for that comparison, and a NULL WHERE is
// false — right by accident here, and not something to rely on silently.) The timestamp column is a
// parameter because the filter is applied twice: once while the document row is in scope, once over
// the CTE that already carries `ts`.
const TIME_FILTER = (column) => `(($from_unset = 1 OR (${column} IS NOT NULL AND ${column} >= $from))`
  + ` AND ($to_unset = 1 OR (${column} IS NOT NULL AND ${column} <= $to)))`;

// One row per (document, term, field), with the field's weight attached. A term earns each field's
// weight once, however many tokens it needed to earn it, so the weights are per (term, field) and never
// per token. Getting that wrong is what turned a text-only match into 5 points: a title flag of 1 for a
// term with no token in the title at all collects 3 + 2 + 1 for being present in one field.
const TERM_FLAGS = `
  SELECT d.id AS doc_id, i.term AS term, ${FIELD_TITLE} AS field,
         CASE WHEN ${TITLE_MATCHES} THEN 1 ELSE 0 END AS hit, ${W_TITLE} AS w
    FROM doc d JOIN (SELECT DISTINCT term FROM qterm) AS i
   UNION ALL
  SELECT d.id, i.term, ${FIELD_TEXT}, CASE WHEN ${TEXT_MATCHES} THEN 1 ELSE 0 END, ${W_TEXT}
    FROM doc d JOIN (SELECT DISTINCT term FROM qterm) AS i
   UNION ALL
  SELECT d.id, i.term, ${FIELD_TAG}, CASE WHEN ${TAG_MATCHES} THEN 1 ELSE 0 END, ${W_TAG}
    FROM doc d JOIN (SELECT DISTINCT term FROM qterm) AS i`;

// The three fields then compose in two ways, and both of them matter:
//
//   * `complete` is "some field held the whole term", and `title` is "the title held the whole term" —
//     these are what the match filter and the whole-query bonus read.
//   * `base` sums the weights of the fields that held it, because section 9's table says a term "can earn
//     all three": a term in the title, in a tag and in the text is 3 + 2 + 1.
const COMPLETED = `
  SELECT doc_id, term,
         MAX(hit) AS complete,
         MAX(CASE WHEN field = ${FIELD_TITLE} THEN hit ELSE 0 END) AS title,
         SUM(CASE WHEN hit = 1 THEN w ELSE 0 END) AS base
    FROM term_flags
   GROUP BY doc_id, term`;

// One row per requested term that the document matched, in full, in at least one field. A term whose
// tokens are split across two fields is not here at all, which is the point of the rule: it matched
// neither field, so it earns nothing and does not count towards "every term matched".
const MATCHED = `SELECT doc_id, term, base, title FROM completed WHERE complete = 1`;

// Two booleans, because the two modes ask different questions: `v` is "every requested term matched" and
// `any_hit` is "some term matched", which is what `"any"` needs — and which is *not* the same as `v >= 1`
// once "all" and "any" are allowed to differ, so the two are carried separately.
//
// Both are compared against `$terms`, the number of terms the *request* named, rather than against the
// number of terms this document happened to match. That distinction is the whole of two rules: `match:
// "all"` on a query whose terms tokenize to nothing must match nothing (zero would otherwise equal zero),
// and a document matching one of three terms must not collect the whole-query bonus. It is also why the
// term count is a binding and not something derivable from `qterm`, which has no rows for a term that
// tokenized to nothing.
const VERDICT = `
  SELECT doc_id,
         CASE WHEN COUNT(*) > 0 AND COUNT(*) = $terms THEN 1 ELSE 0 END AS v,
         1 AS any_hit,
         SUM(base) AS base,
         SUM(title) AS title_hits,
         COUNT(*) AS matched_terms
    FROM matched
   GROUP BY doc_id`;

// The whole-query bonus: every term the query asked for matched the title. The comparison is against
// `$terms` — the request's own term count — and not against the terms this document happened to match,
// which is the difference between "all of the query is in the title" and "all of what this document
// matched is in the title". The second reading awards the bonus to a document that matched one term of
// three, and it was a real bug here: the fix is one word, and the two readings agree in every corpus
// case where every term matches something, which is most of them.
const BONUS = `
  SELECT doc_id, CASE WHEN $terms > 0 AND title_hits = $terms THEN ${W_WHOLE_QUERY_IN_TITLE} ELSE 0 END AS extra
    FROM verdict`;

// The score, as one expression, in SQL: base + whole-query bonus. `v` and `any_hit` ride along so the
// reading statements do not have to recompute what "matched" means — the filter, the score and the
// facets all read the same row. A document that matched no term (which happens when there are no terms)
// is worth zero, and `SCORED` starts from the documents themselves rather than from an aggregate of the
// query, which is what makes the no-terms case need no special branch at all.
const SCORED = `
  SELECT d.id AS doc_id,
         COALESCE(a.base, 0) + COALESCE(b.extra, 0) AS score,
         COALESCE(a.v, 0) AS v,
         COALESCE(a.any_hit, 0) AS any_hit,
         d.key AS key,
         d.ts AS ts
    FROM doc d
    LEFT JOIN verdict a ON a.doc_id = d.id
    LEFT JOIN bonus b ON b.doc_id = d.id`;

// `match: "all"` requires every term to be matched by the document, `"any"` requires one, and a query
// with no terms matches everything (that is how a filter-only browse works: nothing is asked of any
// document). Written against the two booleans `scored` carries, so the mode is decided in exactly one
// place and the filter cannot disagree with the score about what "matched" means. Note that the
// no-terms case is `$terms = 0` — the number of terms the request named — and not "this document
// matched nothing", which is also true of a document that matched none of the terms it was asked for.
const matchPredicate = (match) =>
  (match === 'any'
    ? `($terms = 0 OR k.any_hit = 1)`
    : `($terms = 0 OR k.v = 1)`);

// The UTC calendar month of an epoch-milliseconds value, or NULL. `strftime` with the `unixepoch`
// modifier is SQLite's own month arithmetic and runs in UTC regardless of the machine's timezone.
//
// The division is explicit floor division, because SQLite's `/` on integers truncates toward *zero*
// while the epoch's own arithmetic floors: `-5 / 1000` is 0 in SQLite and -1 as a number of seconds
// since the epoch. The difference is the whole month of December 1969 for a millisecond before the
// epoch, and the corpus has no negative timestamp to catch it — this was found by a differential run
// against the reference, which buckets with JavaScript's `getUTCFullYear`. `CAST(x AS INTEGER)` is
// itself a truncation, so the operand is the exact quotient first and the correction is applied to it.
const MONTH_OF = (alias) =>
  `CASE WHEN ${alias}.ts IS NULL THEN NULL`
  + ` ELSE strftime('%Y-%m', ${alias}.ts / 1000 + CASE WHEN ${alias}.ts < 0 AND ${alias}.ts % 1000 <> 0 THEN -1 ELSE 0 END, 'unixepoch') END`;

// The whole matching set, in one body. `time_rejected` is every document that passed the tag filter
// and was then dropped by the time filter — exactly what "excluded by time" counts, and nothing else
// (a document that never matched the query is not "excluded by time"). `kept` is the set `total`, the
// hits and both facets are all computed from, so they cannot answer about different sets.
const SETS = `
  time_rejected AS (SELECT s.doc_id AS doc_id, s.score AS score, s.v AS v, s.any_hit AS any_hit, s.key AS key, s.ts AS ts
                      FROM scored s WHERE ${TAG_FILTER('s.doc_id')}),
  kept AS (SELECT s.doc_id AS doc_id, s.score AS score, s.v AS v, s.any_hit AS any_hit, s.key AS key, s.ts AS ts
             FROM time_rejected s WHERE ${TIME_FILTER('s.ts')})`;

// The CTE chain every read statement opens with, in dependency order. Written once because five
// statements sharing a prefix is five chances to forget a step, and a statement that forgot `kept`
// would silently be answering about a different set.
const WITH_CHAIN = `WITH term_flags AS (${TERM_FLAGS}), completed AS (${COMPLETED}), matched AS (${MATCHED}), verdict AS (${VERDICT}), bonus AS (${BONUS}), scored AS (${SCORED}), ${SETS}`;

/**
 * The hits: the contract's ordering, which is complete so that no two implementations may disagree.
 *
 * `ORDER BY score DESC, ts DESC, key COLLATE BINARY ASC` is load-bearing in three ways:
 *   * `COLLATE BINARY` is SQLite's default collation and compares the UTF-8 bytes of TEXT, which is
 *     exactly section 9's "id ascending by UTF-8 bytes". It is written out anyway: a database created
 *     with a different default (NOCASE, or a user-defined locale collation) would otherwise change
 *     the answer without changing this file.
 *   * `ts DESC` puts NULL last in SQLite, because NULL sorts before every value and the sort is
 *     descending — which happens to be the contract's "null last". Said out loud in the README and
 *     asserted in --selfcheck rather than relied on silently.
 *   * the three keys together are a total order, so the answer does not depend on scan order.
 */
const SELECT_HITS = (match) => `
  ${WITH_CHAIN}
  SELECT k.key AS id, k.score AS score
    FROM kept k
   WHERE ${matchPredicate(match)}
   ORDER BY k.score DESC, k.ts DESC, k.key COLLATE BINARY ASC
   LIMIT $limit`;

const SELECT_TOTAL = (match) => `
  ${WITH_CHAIN}
  SELECT COUNT(*) AS n
    FROM kept k
   WHERE ${matchPredicate(match)}`;

// The documents dropped by the time filter, the one number the product reports separately instead of
// losing. It is counted *after* the term and tag filters — a document that never matched the query is
// not "excluded by time" — and it is the only output value JavaScript computes, where all it does is
// count the rows of a set that SQL selected.
const SELECT_EXCLUDED = (match) => `
  ${WITH_CHAIN}
  SELECT COUNT(*) AS n
    FROM time_rejected k
   WHERE ${matchPredicate(match)}
     AND ($from_unset = 0 OR $to_unset = 0)
     AND (k.ts IS NULL OR ($from_unset = 0 AND k.ts < $from) OR ($to_unset = 0 AND k.ts > $to))`;

// Both facets count the matching set *before* the limit, and both are ordered in SQL: the tag facet by
// the tag, the month facet by the month, each under BINARY collation. Emitting the rows in that order
// is what satisfies "keys sorted ascending by UTF-8 bytes" — the ORDER BY decides, not the hash map
// the object happens to be built from.
const SELECT_FACET_TAGS = (match) => `
  ${WITH_CHAIN}
  SELECT g.tag AS tag, COUNT(*) AS n
    FROM tag g JOIN kept k ON k.doc_id = g.doc_id
   WHERE ${matchPredicate(match)}
   GROUP BY g.tag
   ORDER BY g.tag COLLATE BINARY ASC`;

const SELECT_FACET_MONTHS = (match) => `
  ${WITH_CHAIN}
  SELECT ${MONTH_OF('k')} AS month, COUNT(*) AS n
    FROM kept k
   WHERE ${matchPredicate(match)} AND k.ts IS NOT NULL
   GROUP BY month
   ORDER BY month COLLATE BINARY ASC`;

const INSERT_DOC = `INSERT INTO doc (id, key, ts) VALUES (?, ?, ?)`;
const INSERT_TOKEN = `INSERT OR IGNORE INTO token (doc_id, field, token) VALUES (?, ?, ?)`;
const INSERT_TAG = `INSERT INTO tag (doc_id, seq, tag) VALUES (?, ?, ?)`;
const INSERT_TAG_TOKEN = `INSERT OR IGNORE INTO tag_token (doc_id, tag_seq, token) VALUES (?, ?, ?)`;
const INSERT_QTERM = `INSERT OR IGNORE INTO qterm (term, token) VALUES (?, ?)`;
const INSERT_QTAG = `INSERT INTO qtag (seq, tag) VALUES (?, ?)`;

/**
 * The whole capability. The SQL is the implementation: this function only loads the request, runs the
 * statements, and assembles the output object in the contract's field order.
 */
export function search(input) {
  const req = readRequest(input);
  const db = new DatabaseSync(':memory:');
  try {
    for (const statement of SCHEMA) db.exec(statement);

    // The one place a JavaScript loop touches the data: turning each document into rows. What those
    // rows mean is decided entirely by the statements below.
    const insDoc = db.prepare(INSERT_DOC);
    const insToken = db.prepare(INSERT_TOKEN);
    const insTag = db.prepare(INSERT_TAG);
    const insTagToken = db.prepare(INSERT_TAG_TOKEN);
    req.docs.forEach((doc, index) => {
      const id = index + 1;
      // `ts` is epoch milliseconds or null. Only a number is a timestamp: a string, a missing field and
      // an explicit null all mean "no time", exactly as in the reference.
      const ts = typeof doc?.ts === 'number' ? doc.ts : null;
      insDoc.run(id, asText(doc?.id), ts);
      // A field's tokens are a set, and the loader is where the set is made: INSERT OR IGNORE against
      // the primary key is the duplicate collapse, for title, text and each tag's own token set alike.
      for (const token of new Set(tokensOf(asText(doc?.title)))) insToken.run(id, FIELD_TITLE, token);
      for (const token of new Set(tokensOf(asText(doc?.text)))) insToken.run(id, FIELD_TEXT, token);
      // Each tag keeps its own token set (`seq`) as well as its verbatim text: the filter and the facet
      // need the string, the term matching needs the set, and nothing may mix two tags' tokens.
      asArray(doc?.tags).map(asText).forEach((tag, seq) => {
        insTag.run(id, seq, tag);
        for (const token of new Set(tokensOf(tag))) insTagToken.run(id, seq, token);
      });
    });

    // A term is a list of tokens; its rows carry the term's index, because a repeated term scores
    // twice and "all"/"any" is decided per term, not per token.
    const insQterm = db.prepare(INSERT_QTERM);
    req.terms.forEach((term, t) => {
      for (const token of tokensOf(term)) insQterm.run(t, token);
    });
    const insQtag = db.prepare(INSERT_QTAG);
    req.wantTags.forEach((tag, seq) => insQtag.run(seq, tag));

    // `node:sqlite` refuses a named parameter the statement does not mention ("Unknown named
    // parameter"), so each statement gets exactly the bindings it uses. That is also the reason the
    // statements were written to share one set of names for the same concepts: `$from` means the same
    // thing everywhere it appears.
    const shapeParams = {
      terms: req.terms.length,
      from: req.from === null ? 0 : req.from,
      to: req.to === null ? 0 : req.to,
      from_unset: req.from === null ? 1 : 0,
      to_unset: req.to === null ? 1 : 0,
    };
    // "No limit" (limit = 0) binds SQLite's largest integer instead of growing a second statement.
    // A negative limit never reaches here: readRequest refuses it as bad input.
    const limitParams = { limit: req.limit > 0 ? BigInt(Math.trunc(req.limit)) : NO_LIMIT };

    const hits = db.prepare(SELECT_HITS(req.match)).all({ ...shapeParams, ...limitParams })
      .map((row) => ({ id: String(row.id), score: Number(row.score) }));
    const total = Number(db.prepare(SELECT_TOTAL(req.match)).get(shapeParams).n);
    const excludedByTime = Number(db.prepare(SELECT_EXCLUDED(req.match)).get(shapeParams).n);

    // Facets are emitted with their keys sorted ascending by UTF-8 bytes. The SQL says
    // `ORDER BY ... COLLATE BINARY`; preserving that row order into the object is what stops a hash
    // map from deciding, and the harness fails a worker whose facet keys come out unsorted.
    const tags = {};
    for (const row of db.prepare(SELECT_FACET_TAGS(req.match)).all(shapeParams)) tags[String(row.tag)] = Number(row.n);
    const months = {};
    for (const row of db.prepare(SELECT_FACET_MONTHS(req.match)).all(shapeParams)) months[String(row.month)] = Number(row.n);

    return { hits, total, facets: { tags, months }, excludedByTime };
  } finally {
    db.close();
  }
}

// ── the protocol (docs/WORKERS.md section 1) ────────────────────────────────────────────────

export const CAPABILITIES = { [CAPABILITY]: (input) => search(input) };

export const describeWith = (capability) => ({
  protocol: 1,
  capability,
  language: 'sql',
  impl: 'sqlite-query',
  runtime: `node:sqlite (SQLite ${sqliteVersion()})`,
  deterministic: true,
});

/** The SQLite version the answer was produced by; asking the database is the only honest source. */
let SQLITE_VERSION = null;
function sqliteVersion() {
  if (SQLITE_VERSION === null) {
    const db = new DatabaseSync(':memory:');
    try {
      SQLITE_VERSION = String(db.prepare('SELECT sqlite_version() AS v').get().v);
    } finally {
      db.close();
    }
  }
  return SQLITE_VERSION;
}

// ── --selfcheck ─────────────────────────────────────────────────────────────────────────────
//
// The cases assert the *contract*, not the reference implementation: the weights from section 9's
// table, the ordering rules, the boundary rules and the shapes. Where a rule has a SQLite-specific
// trap in it, the case names the trap.

const SELFCHECK = [
  ['empty query matches everything, scores 0, orders ts desc with null last', () => {
    const r = search({ docs: [
      { id: 'b', title: 'second', text: '', tags: [], ts: 200 },
      { id: 'a', title: 'first', text: '', tags: [], ts: null },
    ], query: {} });
    return r.hits.map((h) => h.id).join(',') === 'b,a'
      && r.hits.every((h) => h.score === 0) && r.total === 2 && r.excludedByTime === 0;
  }],
  ['whole-query-in-title bonus is +4 and the three field weights are 3/2/1', () => {
    const r = search({ docs: [{ id: 'a', title: 'openai news', text: 'openai again', tags: ['openai'], ts: null }], query: { terms: ['openai'] } });
    return r.hits[0].score === 3 + 2 + 1 + 4; // = 10, and never 9 or 11
  }],
  ['the bonus needs every term in the title, not just one', () => {
    const both = search({ docs: [{ id: 'a', title: 'openai gpt', text: '', tags: [], ts: null }], query: { terms: ['openai', 'gpt'] } });
    const one = search({ docs: [{ id: 'a', title: 'openai gpt', text: '', tags: [], ts: null }], query: { terms: ['openai', 'gpt', 'absent'] } });
    // both titles matched: 3+3 per term plus 4; the second query fails the bonus AND the all-match
    return both.hits[0].score === 3 + 3 + 4 && one.total === 0;
  }],
  ['a CJK term matches a longer run through the bigram tokenizer', () => {
    const r = search({ docs: [{ id: 'a', title: '已经开播了', text: '', tags: [], ts: null }], query: { terms: ['已经'] } });
    return r.total === 1 && r.hits[0].score === 3 + 4;
  }],
  ['match all requires every term; match any requires one', () => {
    const docs = [{ id: 'a', title: 'alpha', text: '', tags: [], ts: null }];
    return search({ docs, query: { terms: ['alpha', 'beta'], match: 'all' } }).total === 0
      && search({ docs, query: { terms: ['alpha', 'beta'], match: 'any' } }).total === 1;
  }],
  ['a multi-token term requires all of its tokens in one field', () => {
    const docs = [
      { id: 'both', title: 'openai gpt', text: '', tags: [], ts: null },
      { id: 'half', title: 'openai only', text: '', tags: [], ts: null },
      { id: 'split', title: 'openai', text: 'gpt', tags: [], ts: null },
    ];
    const r = search({ docs, query: { terms: ['openai gpt'] } });
    // 'split' is the interesting one: both tokens are somewhere in the document, but not in the same
    // field, and a term matches a *field*, so it must not match. The score is 3 (one term, in the
    // title) + 4 (every term is in the title), not 6: the weights are per term, not per token.
    return r.total === 1 && r.hits.length === 1 && r.hits[0].id === 'both' && r.hits[0].score === 7;
  }],
  ['a term matches the title, the text or a tag, and nothing else scores', () => {
    const docs = [
      { id: 'title', title: 'openai', text: '', tags: [], ts: null },
      { id: 'text', title: 'unrelated', text: 'openai', tags: [], ts: null },
      { id: 'tag', title: 'unrelated', text: '', tags: ['openai'], ts: null },
      { id: 'none', title: 'unrelated', text: '', tags: [], ts: null },
    ];
    const byId = Object.fromEntries(search({ docs, query: { terms: ['openai'] } }).hits.map((h) => [h.id, h.score]));
    // one term, so a full match in one field is also the whole query in the title (only for 'title')
    return byId.title === 3 + 4 && byId.text === 1 && byId.tag === 2 && byId.none === undefined;
  }],
  ['a term that tokenizes to nothing matches nothing', () => {
    const docs = [{ id: 'a', title: 'x', text: '???', tags: [], ts: null }];
    return search({ docs, query: { terms: ['???'] } }).total === 0
      && search({ docs, query: { terms: ['???', 'x'], match: 'any' } }).total === 1
      && search({ docs, query: { terms: ['???', 'x'], match: 'all' } }).total === 0;
  }],
  ['a term never matches across two tags or two fields', () => {
    const docs = [
      { id: 'one-tag', title: 'x', text: '', tags: ['openai gpt'], ts: null },
      { id: 'two-tags', title: 'x', text: '', tags: ['openai', 'gpt'], ts: null },
      { id: 'two-fields', title: 'openai', text: 'gpt', tags: [], ts: null },
    ];
    const ids = search({ docs, query: { terms: ['openai gpt'] } }).hits.map((h) => h.id);
    return ids.join(',') === 'one-tag';
  }],
  ['a document with no tags does not match every term', () => {
    const docs = [{ id: 'a', title: 'x', text: '', tags: [], ts: null }];
    return search({ docs, query: { terms: ['anything'] } }).total === 0;
  }],
  ['the tag filter is exact: a case difference is a different tag', () => {
    const docs = [{ id: 'a', title: 'x', text: '', tags: ['Nijisanji'], ts: null }];
    // LIKE would match here (SQLite's LIKE is ASCII-case-insensitive); `=` must not
    return search({ docs, query: { tags: ['nijisanji'] } }).total === 0
      && search({ docs, query: { tags: ['Nijisanji'] } }).total === 1;
  }],
  ['a null ts is excluded by a range and counted in excludedByTime', () => {
    const docs = [
      { id: 'no-ts', title: 'x', text: '', tags: [], ts: null },
      { id: 'old', title: 'x', text: '', tags: [], ts: 100 },
      { id: 'new', title: 'x', text: '', tags: [], ts: 300 },
    ];
    const r = search({ docs, query: { from: 200, to: 400 } });
    return r.total === 1 && r.hits[0].id === 'new' && r.excludedByTime === 2;
  }],
  ['a null ts is not "excluded by time" when no bound is set', () => {
    const docs = [{ id: 'a', title: 'x', text: '', tags: [], ts: null }, { id: 'b', title: 'x', text: '', tags: [], ts: 100 }];
    return search({ docs, query: {} }).excludedByTime === 0;
  }],
  ['from and to are inclusive bounds', () => {
    const docs = [{ id: 'edge', title: 'x', text: '', tags: [], ts: 200 }, { id: 'out', title: 'x', text: '', tags: [], ts: 201 }];
    const r = search({ docs, query: { from: 200, to: 200 } });
    return r.total === 1 && r.hits[0].id === 'edge' && r.excludedByTime === 1;
  }],
  ['ties break by ts descending, then id by UTF-8 bytes', () => {
    const docs = [
      { id: '\u00e9mile', title: 'x', text: '', tags: [], ts: 100 },
      { id: 'zoe', title: 'x', text: '', tags: [], ts: 100 },
      { id: 'older', title: 'x', text: '', tags: [], ts: 50 },
      { id: 'undated', title: 'x', text: '', tags: [], ts: null },
    ];
    // "zoe" before "émile" is the rule that a locale collation would flip: 0xc3a9 is above 0x7a in
    // bytes, and a locale-aware comparison puts é with e.
    return search({ docs, query: { terms: ['x'] } }).hits.map((h) => h.id).join(',') === 'zoe,\u00e9mile,older,undated';
  }],
  ['facet keys are sorted by UTF-8 bytes and count the matching set before the limit', () => {
    const docs = [
      { id: 'a', title: 'x', text: '', tags: ['zeta', 'alpha'], ts: 1735689600000 },
      { id: 'b', title: 'x', text: '', tags: ['alpha'], ts: 1738368000000 },
      { id: 'c', title: 'x', text: '', tags: [], ts: null },
    ];
    const r = search({ docs, query: { terms: ['x'] } });
    return Object.keys(r.facets.tags).join(',') === 'alpha,zeta'
      && Object.keys(r.facets.months).join(',') === '2025-01,2025-02'
      && r.facets.tags.alpha === 2 && r.facets.months['2025-02'] === 1;
  }],
  ['months bisect by UTC month and a timestamp before the epoch floors', () => {
    // 1735689600000 = 2025-01-01T00:00:00Z, 1738368000000 = 2025-02-01T00:00:00Z,
    // 1735689599999 = one millisecond before January (so 2024-12, a non-obvious boundary), and
    // 0 = the epoch month. The bucket is UTC, like the reference's getUTCFullYear/getUTCMonth.
    const docs = [
      { id: 'jan', title: 'x', text: '', tags: [], ts: 1735689600000 },
      { id: 'dec', title: 'x', text: '', tags: [], ts: 1735689599999 },
      { id: 'feb', title: 'x', text: '', tags: [], ts: 1738368000000 },
      { id: 'epoch', title: 'x', text: '', tags: [], ts: 0 },
      { id: 'none', title: 'x', text: '', tags: [], ts: null },
    ];
    const r = search({ docs, query: {} });
    // -5 ms is one millisecond before the epoch, so 1969-12 and not 1970-01; -31536000000 ms is minus
    // 365 days, which is 1969-01 (-365 days lands on 1969-01-01, a leap year having one more day than
    // the count assumes). Both are cases where SQLite's `/` — truncating toward zero — and the epoch's
    // own floor division disagree, and the corpus has no negative `ts` at all to catch it.
    const before = search({ docs: [
      { id: 'a', title: 'x', text: '', tags: [], ts: -5 },
      { id: 'b', title: 'x', text: '', tags: [], ts: -31536000000 },
    ], query: {} });
    return Object.keys(r.facets.months).join(',') === '1970-01,2024-12,2025-01,2025-02'
      && Object.values(r.facets.months).reduce((a, b) => a + b, 0) === 4
      && Object.keys(before.facets.months).join(',') === '1969-01,1969-12';
  }],
  ['the limit truncates hits but not total, and limit 0 means no limit', () => {
    const docs = [1, 2, 3].map((n) => ({ id: 'd' + n, title: 'x', text: '', tags: [], ts: 400 - n }));
    const r = search({ docs, query: { terms: ['x'] }, limit: 2 });
    const all = search({ docs, query: { terms: ['x'] }, limit: 0 });
    return r.hits.length === 2 && r.total === 3 && all.hits.length === 3;
  }],
  ['the ordering is total: the same corpus in any order gives the same hits', () => {
    const docs = [
      { id: 'b', title: 'x', text: '', tags: [], ts: 10 },
      { id: 'a', title: 'x', text: '', tags: [], ts: 10 },
      { id: 'c', title: 'x', text: '', tags: [], ts: null },
    ];
    const one = search({ docs, query: { terms: ['x'] } }).hits.map((h) => h.id).join(',');
    const two = search({ docs: [...docs].reverse(), query: { terms: ['x'] } }).hits.map((h) => h.id).join(',');
    return one === 'a,b,c' && two === one;
  }],
  ['a repeated term scores twice', () => {
    const docs = [{ id: 'a', title: 'openai', text: '', tags: [], ts: null }];
    // "openai," tokenizes to the same token as "openai". Two terms, each 3 in the title, plus the
    // whole-query bonus once (both terms matched the title) = 10. The bonus is not doubled: it is a
    // property of the query, not of a term.
    return search({ docs, query: { terms: ['openai,', 'openai'] } }).hits[0].score === 3 + 3 + 4;
  }],
  ['a negative limit is bad input', () => {
    try {
      search({ docs: [], query: {}, limit: -1 });
      return false;
    } catch (e) {
      return e.code === 'bad-input';
    }
  }],
  ['docs that are not an array are bad input', () => {
    try {
      search({ query: {} });
      return false;
    } catch (e) {
      return e.code === 'bad-input';
    }
  }],
  ['the output field order is the contract order', () => {
    const r = search({ docs: [{ id: 'a', title: 'x', text: '', tags: ['t'], ts: 0 }], query: { terms: ['x'] } });
    return Object.keys(r).join(',') === 'hits,total,facets,excludedByTime'
      && Object.keys(r.facets).join(',') === 'tags,months'
      && Object.keys(r.hits[0]).join(',') === 'id,score';
  }],
];

async function selfcheck() {
  let pass = 0;
  for (const [name, fn] of SELFCHECK) {
    let ok = false;
    let detail = '';
    try {
      ok = fn() === true;
    } catch (e) {
      detail = ': ' + e.message;
    }
    process.stderr.write(`${ok ? '  [ok]  ' : '  [FAIL]'} ${name}${detail}\n`);
    if (ok) pass++;
  }
  process.stderr.write(`${pass}/${SELFCHECK.length} checks passed\n`);
  process.exit(pass === SELFCHECK.length ? 0 : 1);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selfcheck')) return selfcheck();
  const capIndex = argv.indexOf('--capability');
  const capability = capIndex === -1 ? null : argv[capIndex + 1];
  if (!capability || capability !== CAPABILITY || argv.length !== 2) {
    process.stderr.write('usage: vmlsearch.mjs --capability search.query | --selfcheck\n');
    process.exit(2);
  }

  // No banner on stdout, ever (section 1): the host counts answers by id, so an unsolicited line
  // looks like a lost case rather than like a chatty worker.
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify({ id: null, ok: false, error: { code: 'bad-input', message: 'request is not JSON' } }) + '\n');
        continue;
      }
      if (req.op === 'shutdown') {
        // The bare envelope and nothing else: no output payload, as section 1 now states explicitly.
        process.stdout.write(JSON.stringify({ id: req.id ?? null, ok: true }) + '\n');
        process.exit(0);
      }
      if (req.op === 'describe') {
        process.stdout.write(JSON.stringify({ id: req.id ?? null, ok: true, worker: describeWith(capability) }) + '\n');
        continue;
      }
      if (req.op !== 'invoke') {
        process.stdout.write(JSON.stringify({ id: req.id ?? null, ok: false, error: { code: 'unsupported', message: `unknown op ${req.op}` } }) + '\n');
        continue;
      }
      if (req.capability && req.capability !== capability) {
        process.stdout.write(JSON.stringify({ id: req.id ?? null, ok: false, error: { code: 'unsupported', message: `this worker implements ${capability}` } }) + '\n');
        continue;
      }
      try {
        process.stdout.write(JSON.stringify({ id: req.id ?? null, ok: true, output: search(req.input ?? {}) }) + '\n');
      } catch (e) {
        process.stdout.write(JSON.stringify({ id: req.id ?? null, ok: false, error: { code: e.code ?? 'internal', message: e.message } }) + '\n');
      }
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
void HERE;
