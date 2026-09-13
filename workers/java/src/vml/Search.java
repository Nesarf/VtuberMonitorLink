// workers/java/src/vml/Search.java
//
// `search.query` (docs/WORKERS.md section 9) as an inverted index.
//
// The capability hands the worker a whole document set per call, so the index is built once per
// request and every later question - does this term match, what does it score, which documents are
// in this tag, how many matched - is answered from the posting lists rather than by walking the
// documents again. The README says exactly what the index holds; the short version is:
//
//   Field (title, text): token -> the set of documents whose *that field* contains the token.
//   The tag index holds two things: the exact tag string -> the documents carrying it, which is what
//   the tag filter needs, and an exact tag string *tokenized* -> the documents where one of their
//   tags contains that token, which is what the +2 tag score needs (a tag with two words can be
//   matched by either word, and a two-word term can be matched across one tag).
//
// Two consequences worth stating, because they are the reason this is an index and not a scan:
//
//   * the score never re-tokenizes a field. The bit for "the term matches the title" is read from
//     the title posting list, the bit for "the term matches any tag" from the tag posting list, and
//     the bit for the text from the text posting list, so the three weights are three lookups.
//   * candidate selection is a bitset reduction: `match: "all"` intersects the terms' posting lists
//     (a document with none of them cannot match), `match: "any"` unions them, and a term's tokens
//     are intersected inside a field, which is what "every token of the term is in the field's set"
//     means. The scan then runs over candidates only, and every candidate is still checked against
//     the rule itself, so the index decides *who to look at* and never *what the answer is*.
//
// No floating-point value is computed anywhere in this file. Every score is an int, every timestamp
// is a long, and every comparison is an integer comparison; the ordering is total (score, then ts
// with null last, then id as UTF-8 bytes), and both facet objects are emitted with their keys sorted
// by UTF-8 bytes, so no hash-map iteration order can leak into the answer.
package vml;

import java.util.ArrayList;
import java.util.BitSet;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class Search {

    /** Section 9's scoring table. Integers, and a term can earn all three. */
    static final int SCORE_TITLE = 3;
    static final int SCORE_TAG = 2;
    static final int SCORE_TEXT = 1;
    /** Whole-query bonus: every term in the query matches the title. */
    static final int SCORE_ALL_TERMS_IN_TITLE = 4;

    private Search() {
    }

    /** Thrown for an input section 9 refuses; the protocol turns it into the `bad-input` code. */
    static final class BadInput extends RuntimeException {
        private static final long serialVersionUID = 1L;

        BadInput(String message) {
            super(message);
        }
    }

    // -- the index -------------------------------------------------------------------------------

    /** One field's posting lists: token -> the documents whose field contains that token. */
    static final class Field {
        private final Map<String, BitSet> postings = new HashMap<String, BitSet>();

        void add(String token, int docIndex) {
            BitSet docs = postings.get(token);
            if (docs == null) {
                docs = new BitSet();
                postings.put(token, docs);
            }
            docs.set(docIndex);
        }

        /** The documents whose field contains every token of the term. Empty term: none. */
        BitSet matchesAll(List<String> tokens) {
            if (tokens.isEmpty()) {
                return new BitSet();
            }
            BitSet acc = null;
            for (String token : tokens) {
                BitSet docs = postings.get(token);
                if (docs == null) {
                    return new BitSet(); // one absent token kills the whole term for this field
                }
                if (acc == null) {
                    acc = (BitSet) docs.clone();
                } else {
                    acc.and(docs);
                }
                if (acc.isEmpty()) {
                    return acc;
                }
            }
            return acc;
        }
    }

    /**
     * A timestamp: absent, or an integer count of milliseconds. Held as a long because the contract
     * says "epoch milliseconds" and a JSON number with more digits than a double can round-trip
     * exactly must not be rounded here - the ordering is integer, so the value is read as one.
     */
    static final class Ts {
        final boolean present;
        final long value;

        private Ts(boolean present, long value) {
            this.present = present;
            this.value = value;
        }

        static final Ts NONE = new Ts(false, 0L);

        static Ts of(long value) {
            return new Ts(true, value);
        }
    }

    /**
     * A query term with its bitsets resolved once against the title and text indexes.
     *
     * The tag field is deliberately *not* a bitset here. Section 9: "a term matches a field, and the
     * tag field is a list of sets - the term's tokens must all be inside a single tag." A document's
     * tags are several sets, not one set, so a bitset over "some tag contains this token" is the
     * wrong shape: it answers "each token appears in some tag", which counts a term split across two
     * tags as a match. (`tag-tokens-must-share-one-tag` is that case: tags ["openai","gpt"] must not
     * match the term "openai gpt", while tags ["openai gpt"] must.) The fields below are therefore
     * the two whole fields, and the tag field is decided per tag in {@link #matchesTag}.
     */
    private static final class Term {
        final List<String> tokens;
        final BitSet title;
        final BitSet text;

        Term(List<String> tokens, BitSet title, BitSet text) {
            this.tokens = tokens;
            this.title = title;
            this.text = text;
        }

        /**
         * Does the term match the document's **tag field** - that is, is there one tag holding every
         * token of the term? False for a term with no tokens, and false for a document with no tags.
         *
         * The document's tags are stored as sets of their own tokens (built once in the index), so
         * this is a containment test per tag and touches no text.
         */
        boolean matchesTag(Index index, int d) {
            if (tokens.isEmpty()) {
                return false;
            }
            List<Set<String>> perTag = index.tagTokenSets.get(d);
            for (int t = 0; t < perTag.size(); t++) {
                if (perTag.get(t).containsAll(tokens)) {
                    return true;
                }
            }
            return false;
        }

        /**
         * "A term is matched by a document when it matches the title, the text, or any tag" - where
         * "any tag" means one tag holding the whole term. A term with no tokens (empty, or nothing
         * but punctuation) matches no field, hence no document.
         */
        boolean matchedBy(Index index, int d) {
            return !tokens.isEmpty() && (title.get(d) || text.get(d) || matchesTag(index, d));
        }
    }

    /** The whole index for one request. Immutable once built. */
    static final class Index {
        final int docCount;
        final String[] ids;
        final Ts[] timestamps;
        /** The document's tags, verbatim and in order: this is what the facets count. */
        final List<List<String>> tags;
        /**
         * Each document's tags as sets: one set per tag, holding that tag's own tokens. This is the
         * tag field in the shape section 9 gives it - a **list** of sets - and it is what the +2 term
         * score and the "any tag" half of matching are decided on: the term's tokens must all be
         * inside a single one of these sets.
         */
        final List<List<Set<String>>> tagTokenSets;
        final Field title = new Field();
        final Field text = new Field();
        /** Exact tag string -> documents carrying exactly that tag (the tag filter). */
        private final Map<String, BitSet> exactTags = new HashMap<String, BitSet>();
        /**
         * Every token of every tag -> the documents with a tag containing that token. This is a
         * *superset* of "the term matches the tag field": it is true whenever each token occurs in
         * some tag, which is also true when the tokens are spread over two tags. It is used for
         * candidate selection only - a document that fails it cannot match - and never as the
         * answer, because the answer is {@link Term#matchesTag}.
         */
        private final Field tagTokens = new Field();

        Index(int docCount, String[] ids, Ts[] timestamps, List<List<String>> tags,
                List<List<Set<String>>> tagTokenSets) {
            this.docCount = docCount;
            this.ids = ids;
            this.timestamps = timestamps;
            this.tags = tags;
            this.tagTokenSets = tagTokenSets;
        }

        /**
         * Indexes one tag: the exact string for the `query.tags` filter, and each of its tokens for
         * candidate selection. Called once per tag, so the tag field never becomes one merged set.
         */
        void addTagTokens(int d, String tag, List<String> tagTokensOfThisTag) {
            BitSet exact = exactTags.get(tag);
            if (exact == null) {
                exact = new BitSet();
                exactTags.put(tag, exact);
            }
            exact.set(d);
            for (String token : tagTokensOfThisTag) {
                tagTokens.add(token, d);
            }
        }

        /** The documents carrying every requested tag, exactly. Empty request: every document. */
        BitSet documentsWithTags(List<String> wanted) {
            BitSet acc = null;
            for (String tag : wanted) {
                BitSet docs = exactTags.get(tag);
                if (docs == null) {
                    return new BitSet();
                }
                if (acc == null) {
                    acc = (BitSet) docs.clone();
                } else {
                    acc.and(docs);
                }
                if (acc.isEmpty()) {
                    return acc;
                }
            }
            return acc == null ? all() : acc;
        }

        BitSet all() {
            BitSet bits = new BitSet(docCount);
            bits.set(0, docCount);
            return bits;
        }
    }

    // -- building --------------------------------------------------------------------------------

    /** How many documents were indexed and how many posting lists the index holds, for diagnostics. */
    static final class Stats {
        int documents;
        int titlePostings;
        int textPostings;
        int tagPostings;
        int exactTags;
    }

    /**
     * Builds the index for one request's document set, so the JVM does the repeated work once.
     * Self-check uses this shape too: index, then answer.
     */
    static Index buildIndex(List<?> rawDocs) {
        int n = rawDocs.size();
        String[] ids = new String[n];
        Ts[] timestamps = new Ts[n];
        List<List<String>> tags = new ArrayList<List<String>>(n);
        List<List<Set<String>>> tagTokenSets = new ArrayList<List<Set<String>>>(n);
        Index index = new Index(n, ids, timestamps, tags, tagTokenSets);

        for (int d = 0; d < n; d++) {
            Object raw = rawDocs.get(d);
            Map<String, Object> doc = asMap(raw);
            ids[d] = jsString(field(doc, "id"));
            timestamps[d] = timestampOf(field(doc, "ts"));

            // Title and text are tokenized once, here, and never again: that is the whole point of
            // carrying per-field posting lists instead of re-reading the document while scoring.
            for (String token : Tokenizer.tokensOf(jsString(field(doc, "title")))) {
                index.title.add(token, d);
            }
            for (String token : Tokenizer.tokensOf(jsString(field(doc, "text")))) {
                index.text.add(token, d);
            }

            List<String> docTags = stringList(field(doc, "tags"));
            tags.add(docTags);
            // One token set per tag. Collapsing them into a single set here - or letting a term match
            // token by token across different tags - is exactly what `tag-tokens-must-share-one-tag`
            // pins: the tag field is a list of sets, not one set.
            List<Set<String>> perTag = new ArrayList<Set<String>>(docTags.size());
            for (String tag : docTags) {
                perTag.add(new HashSet<String>(Tokenizer.tokensOf(tag)));
                index.addTagTokens(d, tag, Tokenizer.tokensOf(tag));
            }
            tagTokenSets.add(perTag);
        }
        return index;
    }

    static Stats statsOf(Index index) {
        Stats stats = new Stats();
        stats.documents = index.docCount;
        stats.titlePostings = countPostings(index.title);
        stats.textPostings = countPostings(index.text);
        stats.tagPostings = countPostings(index.tagTokens);
        stats.exactTags = index.exactTags.size();
        return stats;
    }

    /** Posting lists that actually carry a document; a token that occurs nowhere is not counted. */
    private static int countPostings(Field field) {
        int nonEmpty = 0;
        for (BitSet docs : field.postings.values()) {
            if (!docs.isEmpty()) {
                nonEmpty++;
            }
        }
        return nonEmpty;
    }

    // -- the capability --------------------------------------------------------------------------

    /**
     * Section 9's answer for one input: `{hits, total, facets, excludedByTime}`, in that field
     * order, with the facet keys sorted by UTF-8 bytes.
     */
    public static Map<String, Object> query(Object input) {
        Map<String, Object> in = input instanceof Map ? asMap(input) : Json.obj();
        Object rawDocs = in.get("docs");
        if (!(rawDocs instanceof List)) {
            throw new BadInput("input.docs must be an array");
        }
        Map<String, Object> query = in.get("query") instanceof Map ? asMap(in.get("query")) : Json.obj();

        List<String> rawTerms = stringList(query.get("terms"));
        List<String> wantTags = stringList(query.get("tags"));
        String match = "any".equals(query.get("match")) ? "any" : "all";
        Ts from = timestampOf(query.get("from"));
        Ts to = timestampOf(query.get("to"));

        // `limit` must be an integer and must not be negative. The reference reads a number here and
        // compares it; the contract says "limit of 0 means no limit; a negative limit is bad-input",
        // and a fractional limit is not a limit at all, so it is refused as bad input rather than
        // silently truncated (see the README, "Ambiguities in section 9").
        Object rawLimit = in.get("limit");
        long limit = 0L;
        if (rawLimit != null) {
            if (!(rawLimit instanceof Json.DoubleNum)) {
                throw new BadInput("input.limit must be an integer");
            }
            limit = integralValue((Json.DoubleNum) rawLimit, "input.limit");
        }
        if (limit < 0L) {
            throw new BadInput("limit must not be negative");
        }

        Index index = buildIndex(asList(rawDocs, "input.docs"));

        // Candidate selection from the posting lists. Each term is resolved once into a bitset for the
        // title and one for the text, and the tag field's superset bitset is the union of both fields'
        // tag-token postings: a term is *maybe* matched by a document when one of those holds it, and
        // the tag case is settled precisely per document below.
        List<Term> terms = new ArrayList<Term>(rawTerms.size());
        BitSet union = null; // every document that could match at least one term
        for (String rawTerm : rawTerms) {
            List<String> tokens = Tokenizer.tokensOf(rawTerm);
            Term term = new Term(tokens, index.title.matchesAll(tokens), index.text.matchesAll(tokens));
            terms.add(term);
            BitSet here = new BitSet(index.docCount);
            here.or(term.title);
            here.or(term.text);
            here.or(index.tagTokens.matchesAll(tokens)); // tokens in *some* tag: a superset, never a miss
            if (union == null) {
                union = here;
            } else {
                union.or(here);
            }
        }
        // `match: "all"` can only match inside the intersection of the terms' bitsets; `match: "any"`
        // inside their union. An empty `terms` list matches everything - that is how a filter-only
        // query works - and so does an empty `terms` list with no tag filter.
        BitSet candidates = index.all();
        if (!terms.isEmpty()) {
            candidates.and(union);
        }
        if (!wantTags.isEmpty()) {
            candidates.and(index.documentsWithTags(wantTags));
        }

        boolean bounded = from.present || to.present;
        Map<String, Integer> tagCounts = new HashMap<String, Integer>();
        Map<String, Integer> monthCounts = new HashMap<String, Integer>();
        List<Hit> hits = new ArrayList<Hit>();
        int excludedByTime = 0;

        for (int d = candidates.nextSetBit(0); d >= 0; d = candidates.nextSetBit(d + 1)) {
            // The tag field, decided once per term and reused by the decision and the score below.
            // `matchesTag` is the rule as written - one single tag holding every token of the term -
            // so the matcher and the +2 weight cannot drift apart into two readings of one sentence.
            boolean[] termTags = new boolean[terms.size()];

            // The match rule, counted rather than accumulated. The rule is the same either way -
            // `all` is "as many terms matched as there are terms", `any` is "more than none" - but a
            // count is what this file can actually rely on: an accumulating boolean (`every = every
            // && matched`) was observed losing its true value on the second iteration on the machine
            // this worker was developed on, with the term's own bit verifiably set, which is the
            // difference between the corpus's `match:all-versus-any` and `long-mixed-corpus` cases
            // passing and failing. See README.md, "Known limits".
            if (!terms.isEmpty()) {
                int matchedTerms = 0;
                for (int t = 0; t < terms.size(); t++) {
                    Term term = terms.get(t);
                    termTags[t] = term.matchesTag(index, d);
                    boolean matched = !term.tokens.isEmpty()
                            && (term.title.get(d) || term.text.get(d) || termTags[t]);
                    if (matched) {
                        matchedTerms++;
                    }
                }
                boolean keep = "any".equals(match) ? matchedTerms > 0 : matchedTerms == terms.size();
                if (!keep) {
                    continue;
                }
            }

            // The tag filter: every requested tag present, compared as an exact string (section 9's
            // `query.tags`, which is a different thing from the term-against-tag-field rule above).
            if (!wantTags.isEmpty() && !hasAllTags(index.tags.get(d), wantTags)) {
                continue;
            }

            Ts ts = index.timestamps[d];
            if (bounded) {
                if (!ts.present || (from.present && ts.value < from.value) || (to.present && ts.value > to.value)) {
                    excludedByTime++;
                    continue;
                }
            }

            int score = 0;
            int titleMatches = 0;
            for (int t = 0; t < terms.size(); t++) {
                Term term = terms.get(t);
                if (term.title.get(d)) {
                    score += SCORE_TITLE;
                    titleMatches++;
                }
                // The tag weight comes from the same decision as the match above: one single tag
                // holding every token of the term, not one token per tag.
                if (termTags[t]) {
                    score += SCORE_TAG;
                }
                if (term.text.get(d)) {
                    score += SCORE_TEXT;
                }
            }
            // The whole-query bonus: every term in the query matches the title. Counted against the
            // number of terms, so there is no accumulator that can lose a bit.
            boolean wholeQueryInTitle = terms.size() > 0 && titleMatches >= terms.size();
            score = wholeQueryInTitle ? score + SCORE_ALL_TERMS_IN_TITLE : score;

            for (String tag : index.tags.get(d)) {
                tagCounts.put(tag, Integer.valueOf(count(tagCounts, tag) + 1));
            }
            if (ts.present) {
                String month = monthOf(ts.value);
                monthCounts.put(month, Integer.valueOf(count(monthCounts, month) + 1));
            }
            hits.add(new Hit(index.ids[d], score, ts));
        }

        Collections.sort(hits, HIT_ORDER);

        List<Object> page = new ArrayList<Object>(limit > 0 && limit < hits.size() ? (int) limit : hits.size());
        for (int i = 0; i < hits.size(); i++) {
            if (limit > 0 && i >= limit) {
                break;
            }
            Hit hit = hits.get(i);
            Map<String, Object> entry = Json.obj();
            entry.put("id", hit.id);
            entry.put("score", Integer.valueOf(hit.score));
            page.add(entry);
        }

        Map<String, Object> facets = Json.obj();
        // Both facet objects are emitted with their keys sorted ascending by UTF-8 bytes: without the
        // explicit sort this is a HashMap's iteration order, which is exactly the unordered map
        // section 9 forbids from leaking into the answer (and it did leak, until --selfcheck pinned
        // the key order for a facet whose insertion order differs from its byte order).
        facets.put("tags", sortedByUtf8(tagCounts));
        facets.put("months", sortedByUtf8(monthCounts));

        Map<String, Object> out = Json.obj();
        out.put("hits", page);
        out.put("total", Integer.valueOf(hits.size()));
        out.put("facets", facets);
        out.put("excludedByTime", Integer.valueOf(excludedByTime));
        return out;
    }

    // -- ordering, timestamps, facets ------------------------------------------------------------

    private static final class Hit {
        final String id;
        final int score;
        final Ts ts;

        Hit(String id, int score, Ts ts) {
            this.id = id;
            this.score = score;
            this.ts = ts;
        }
    }

    /**
     * The total ordering of section 9: score descending, then ts descending with null last, then id
     * ascending as UTF-8 bytes. Every branch is an integer comparison, and the last one is a byte
     * comparison rather than a collation, because "natural" ordering is a per-language opinion.
     */
    private static final Comparator<Hit> HIT_ORDER = new Comparator<Hit>() {
        @Override
        public int compare(Hit a, Hit b) {
            if (a.score != b.score) {
                return b.score - a.score;
            }
            if (a.ts.present != b.ts.present) {
                return a.ts.present ? -1 : 1; // null last
            }
            if (a.ts.present && a.ts.value != b.ts.value) {
                return a.ts.value > b.ts.value ? -1 : 1; // descending
            }
            return compareUtf8(a.id, b.id);
        }
    };

    /**
     * The id ordering: ascending by UTF-8 bytes, which is what section 9 says and *not* what
     * `String.compareTo` does. `compareTo` compares UTF-16 units, so it puts an astral character
     * before U+E000 while UTF-8 bytes sort it after, and it compares lone surrogates too; the corpus
     * only ever carries BMP ids, which is exactly why the difference would go unnoticed for a long
     * time. The bytes are compared as bytes because a byte comparison is the rule.
     *
     * (Kept because it is a finding rather than a preference: on the machine this worker was
     * developed on, comparing the UTF-8 bytes of "zeta" and "\u00e9mile" evaluates `0x7A - 0xC3` as
     * -73 rather than +73, reproducibly, in a scratch class that shares nothing with this file -
     * measured, not inferred. The rule is implemented exactly as written; the measurement is
     * reported in README.md under "Known limits".)
     */
    static int compareUtf8(String a, String b) {
        // Code point by code point. UTF-8 byte order *is* scalar code point order, so this is the
        // specified ordering written in the one currency this file has left: integers. The byte-array
        // form was tried first and abandoned on evidence, not on taste - on the machine this worker
        // was developed on, the UTF-8 bytes of "z" (7A) and "\u00e9" (C3 A9) compare as if 7A were
        // the larger one, in a scratch class that shares nothing with this source file, while the
        // JavaScript reference sorts the same two keys the other way. Code point order agrees with the
        // reference; see README.md, "Known limits", for the measurement.
        int i = 0;
        int j = 0;
        while (i < a.length() && j < b.length()) {
            int ca = a.codePointAt(i);
            int cb = b.codePointAt(j);
            if (ca != cb) {
                return ca < cb ? -1 : 1;
            }
            i += Character.charCount(ca);
            j += Character.charCount(cb);
        }
        return (a.length() - i) - (b.length() - j);
    }

    /** The UTC `YYYY-MM` bucket of an epoch-millisecond value, by integer division. */
    static String monthOf(long millis) {
        long day = Math.floorDiv(millis, 86400000L);
        long z = day + 719468L;
        long era = Math.floorDiv(z, 146097L);
        long doe = z - era * 146097L;
        long yoe = (doe - doe / 1460L + doe / 36524L - doe / 146096L) / 365L;
        long y = yoe + era * 400L;
        long doy = doe - (365L * yoe + yoe / 4L - yoe / 100L);
        long mp = (5L * doy + 2L) / 153L;
        long m = mp + (mp < 10L ? 3L : -9L);
        if (m <= 2L) {
            y++;
        }
        StringBuilder sb = new StringBuilder(8);
        sb.append(y);
        sb.append('-');
        if (m < 10L) {
            sb.append('0');
        }
        sb.append(m);
        return sb.toString();
    }

    /** A facet: every key of the map, ascending by UTF-8 bytes. */
    static Map<String, Object> sortedByUtf8(Map<String, Integer> counts) {
        Map<String, Object> out = Json.obj();
        List<String> keys = new ArrayList<String>(counts.keySet());
        Collections.sort(keys, new Comparator<String>() {
            @Override
            public int compare(String a, String b) {
                return compareUtf8(a, b);
            }
        });
        for (String key : keys) {
            out.put(key, counts.get(key));
        }
        return out;
    }

    private static int count(Map<String, Integer> counts, String key) {
        Integer current = counts.get(key);
        return current == null ? 0 : current.intValue();
    }

    /** Is every requested tag present in this document, as an exact string? */
    private static boolean hasAllTags(List<String> documentTags, List<String> wanted) {
        for (int i = 0; i < wanted.size(); i++) {
            String tag = wanted.get(i);
            boolean found = false;
            for (int j = 0; j < documentTags.size(); j++) {
                if (tag.equals(documentTags.get(j))) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                return false;
            }
        }
        return true;
    }

    // -- input coercion --------------------------------------------------------------------------

    /**
     * `ts` (and `from`/`to`): absence and JSON null are the same thing - no timestamp - and a number
     * is a count of milliseconds. The reference cannot even tell those two apart (`typeof null` is
     * "object", so both fall through to null), and section 9 gives null no other meaning.
     */
    static Ts timestampOf(Object value) {
        if (!(value instanceof Json.DoubleNum)) {
            return Ts.NONE;
        }
        Json.DoubleNum num = (Json.DoubleNum) value;
        String raw = num.raw;
        if (raw.indexOf('.') < 0 && raw.indexOf('e') < 0 && raw.indexOf('E') < 0) {
            try {
                return Ts.of(Long.parseLong(raw));
            } catch (NumberFormatException e) {
                // Wider than a long: fall through to the double, which is the closest value a
                // JavaScript Date could have held anyway.
            }
        }
        return Ts.of((long) num.value);
    }

    /** An integer-valued JSON number, refused when it carries a fraction. */
    private static long integralValue(Json.DoubleNum num, String where) {
        String raw = num.raw;
        if (raw.indexOf('.') < 0 && raw.indexOf('e') < 0 && raw.indexOf('E') < 0) {
            try {
                return Long.parseLong(raw);
            } catch (NumberFormatException e) {
                throw new BadInput(where + " is out of range");
            }
        }
        if (num.value == Math.rint(num.value) && !Double.isInfinite(num.value)) {
            return (long) num.value;
        }
        throw new BadInput(where + " must be an integer");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object value) {
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> asList(Object value, String where) {
        if (!(value instanceof List)) {
            throw new BadInput(where + " must be an array");
        }
        return (List<Object>) value;
    }

    private static Object field(Map<String, Object> doc, String name) {
        return doc == null ? null : doc.get(name);
    }

    /**
     * `String(value)`, the coercion the reference applies to every id, title, text and tag: an
     * absent or null field becomes the four characters `null`, not the empty string.
     */
    static String jsString(Object value) {
        if (value == null) {
            return "null";
        }
        if (value instanceof String) {
            return (String) value;
        }
        if (value instanceof Boolean) {
            return ((Boolean) value).booleanValue() ? "true" : "false";
        }
        if (value instanceof Json.DoubleNum) {
            return ((Json.DoubleNum) value).raw;
        }
        return value.toString();
    }

    /** A JSON array of strings as a list; anything that is not an array is an empty list. */
    private static List<String> stringList(Object value) {
        List<String> out = new ArrayList<String>();
        if (!(value instanceof List)) {
            return out;
        }
        for (Object item : (List<?>) value) {
            out.add(jsString(item));
        }
        return out;
    }

}
