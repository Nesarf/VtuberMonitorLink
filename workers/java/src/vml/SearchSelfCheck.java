// workers/java/src/vml/SearchSelfCheck.java
//
// `--selfcheck` for the search worker: a short built-in case list, one English line per case, a
// `N/M checks passed` summary, exit non-zero on the first failure that matters, and no protocol
// traffic on stdout (docs/WORKERS.md section 1.1). The output goes to stderr on purpose: in this
// mode stdout is not a protocol stream at all, and keeping it empty is the honest way to say so.
//
// The checks are the contract's edge rules rather than more corpus: empty query, the whole-query
// bonus, a CJK term through the bigram tokenizer, `match: all` against `any`, an exact tag filter,
// a null `ts` excluded and counted, inclusive time bounds, both tie-breaks, UTF-8 facet key order,
// the limit, the negative-limit refusal, and the response envelopes of `describe`, `invoke` and
// `shutdown` as the real request path produces them.
package vml;

import java.util.List;
import java.util.Map;

public final class SearchSelfCheck {

    private SearchSelfCheck() {
    }

    private interface Check {
        boolean run();
    }

    /** One term in a tag and nothing else: section 9's tag weight, and no other weight applies. */
    private static final int SCORE_TAG_OF_ONE_TERM = 2;

    private static final class Case {
        final String name;
        final Check body;

        Case(String name, Check body) {
            this.name = name;
            this.body = body;
        }
    }

    /** One English line per case, then the summary. Returns the number of failures. */
    public static int run(java.io.PrintStream where) {
        int pass = 0;
        for (Case c : CASES) {
            boolean ok = false;
            String detail = "";
            try {
                ok = c.body.run();
            } catch (RuntimeException e) {
                detail = ": " + e;
            }
            where.println((ok ? "  [ok]  " : "  [FAIL]") + " " + c.name + detail);
            if (ok) {
                pass++;
            }
        }
        where.println(pass + "/" + CASES.length + " checks passed");
        return CASES.length - pass;
    }

    // -- small helpers ---------------------------------------------------------------------------

    private static Map<String, Object> query(String inputJson) {
        @SuppressWarnings("unchecked")
        Map<String, Object> input = (Map<String, Object>) Json.parse(inputJson);
        return Search.query(input);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> mapField(Object value) {
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> listField(Map<String, Object> container, String key) {
        return (List<Object>) container.get(key);
    }

    private static int intField(Map<String, Object> container, String key) {
        return ((Number) container.get(key)).intValue();
    }

    private static String hitId(Map<String, Object> result, int index) {
        return String.valueOf(mapField(listField(result, "hits").get(index)).get("id"));
    }

    private static int hitScore(Map<String, Object> result, int index) {
        return intField(mapField(listField(result, "hits").get(index)), "score");
    }

    /** The joined hit ids, which is how the ordering checks read. */
    private static String hitIds(Map<String, Object> result) {
        StringBuilder sb = new StringBuilder();
        for (Object hit : listField(result, "hits")) {
            if (sb.length() > 0) {
                sb.append(',');
            }
            sb.append(mapField(hit).get("id"));
        }
        return sb.toString();
    }

    private static String joinedKeys(Map<String, Object> facet) {
        StringBuilder sb = new StringBuilder();
        for (String key : facet.keySet()) {
            if (sb.length() > 0) {
                sb.append(',');
            }
            sb.append(key);
        }
        return sb.toString();
    }

    /** Carried out of the facet check so a failure can say what was seen and what was wanted. */
    private static String expectedOrderSeen = "";
    private static String expectedOrderWanted = "";

    /**
     * "alpha,\u00e9mile,zeta", derived by sorting the keys by their UTF-8 bytes in this file rather
     * than written as a literal, so the expectation comes from the rule and not from a character that
     * a correction in another file could silently move. The derivation is itself asserted: if the
     * computed order is not ascending by bytes, the check fails on that instead of passing quietly.
     */
    private static String expectedKeyOrder() {
        String[] keys = {"zeta", "alpha", "\u00e9mile"};
        String[] sorted = keys.clone();
        java.util.Arrays.sort(sorted, (a, b) -> compareBytes(a, b));
        for (int i = 0; i + 1 < sorted.length; i++) {
            if (compareBytes(sorted[i], sorted[i + 1]) > 0) {
                return "<derived-order-is-not-byte-ascending>";
            }
        }
        return String.join(",", sorted);
    }

    /** Ascending by UTF-8 bytes, written out here so the expectation does not borrow the answer. */
    private static int compareBytes(String a, String b) {
        byte[] first = a.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        byte[] second = b.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        int n = Math.min(first.length, second.length);
        for (int j = 0; j < n; j++) {
            int x = first[j] & 0xFF;
            int y = second[j] & 0xFF;
            if (x != y) {
                return x < y ? -1 : 1;
            }
        }
        return first.length - second.length;
    }

    // -- the cases -------------------------------------------------------------------------------

    private static final String TIE_DOCS =
            "\"docs\":["
            + "{\"id\":\"\\u00e9mile\",\"title\":\"x\",\"text\":\"\",\"tags\":[],\"ts\":100},"
            + "{\"id\":\"zoe\",\"title\":\"x\",\"text\":\"\",\"tags\":[],\"ts\":100},"
            + "{\"id\":\"older\",\"title\":\"x\",\"text\":\"\",\"tags\":[],\"ts\":50},"
            + "{\"id\":\"undated\",\"title\":\"x\",\"text\":\"\",\"tags\":[],\"ts\":null}]";

    private static final Case[] CASES = {
        new Case("an empty query matches everything and scores it 0",
                () -> {
                    Map<String, Object> r = query("{\"docs\":[{\"id\":\"b\",\"title\":\"second\",\"text\":\"\",\"tags\":[],\"ts\":200},"
                            + "{\"id\":\"a\",\"title\":\"first\",\"text\":\"\",\"tags\":[],\"ts\":null}],\"query\":{},\"limit\":0}");
                    return intField(r, "total") == 2 && intField(r, "excludedByTime") == 0
                            && hitScore(r, 0) == 0 && hitScore(r, 1) == 0
                            && "b,a".equals(hitIds(r)); // ts 200 first, the null ts last
                }),

        new Case("the whole-query bonus is paid when every term matches the title",
                () -> {
                    // one term in title, tag and text: 3 + 2 + 1, plus the +4 bonus
                    Map<String, Object> r = query("{\"docs\":[{\"id\":\"a\",\"title\":\"openai\",\"text\":\"openai\","
                            + "\"tags\":[\"openai\"],\"ts\":null}],\"query\":{\"terms\":[\"openai\"]},\"limit\":0}");
                    // two terms, both in the title: 3 + 3 + the bonus, and no tag or text credit
                    Map<String, Object> both = query("{\"docs\":[{\"id\":\"a\",\"title\":\"openai gpt\",\"text\":\"\","
                            + "\"tags\":[],\"ts\":null}],\"query\":{\"terms\":[\"openai\",\"gpt\"]},\"limit\":0}");
                    // the bonus needs *every* term in the title: 3 (title) + 1 (text) and no bonus
                    Map<String, Object> half = query("{\"docs\":[{\"id\":\"a\",\"title\":\"openai\",\"text\":\"gpt\","
                            + "\"tags\":[],\"ts\":null}],\"query\":{\"terms\":[\"openai\",\"gpt\"]},\"limit\":0}");
                    return hitScore(r, 0) == 10 && hitScore(both, 0) == 10 && hitScore(half, 0) == 4;
                }),

        new Case("a CJK term matches a longer CJK run through the bigrams",
                () -> {
                    // "已经开播了" tokenizes to the bigrams 已经 经开 开播 播了, so a term of one, three
                    // or five characters all match it: 3 for the title and the +4 whole-query bonus.
                    Map<String, Object> r = query("{\"docs\":[{\"id\":\"a\",\"title\":\"\\u5df2\\u7ecf\\u5f00\\u64ad\\u4e86\","
                            + "\"text\":\"\",\"tags\":[],\"ts\":null}],\"query\":{\"terms\":[\"\\u5df2\\u7ecf\"]},\"limit\":0}");
                    Map<String, Object> whole = query("{\"docs\":[{\"id\":\"a\",\"title\":\"\\u5df2\\u7ecf\\u5f00\\u64ad\\u4e86\","
                            + "\"text\":\"\",\"tags\":[],\"ts\":null}],\"query\":{\"terms\":[\"\\u5df2\\u7ecf\\u5f00\\u64ad\\u4e86\"]},\"limit\":0}");
                    // 已经 is a bigram of the run; 经已 is not any bigram of it, so it matches nothing
                    Map<String, Object> no = query("{\"docs\":[{\"id\":\"a\",\"title\":\"\\u5df2\\u7ecf\\u5f00\\u64ad\\u4e86\","
                            + "\"text\":\"\",\"tags\":[],\"ts\":null}],\"query\":{\"terms\":[\"\\u7ecf\\u5df2\"]},\"limit\":0}");
                    return intField(r, "total") == 1 && hitScore(r, 0) == 7 && hitScore(whole, 0) == 7
                            && intField(no, "total") == 0;
                }),

        new Case("match:all requires every term, match:any requires one",
                () -> {
                    Map<String, Object> all = query("{\"docs\":[{\"id\":\"a\",\"title\":\"alpha\",\"text\":\"\","
                            + "\"tags\":[],\"ts\":null}],\"query\":{\"terms\":[\"alpha\",\"beta\"],\"match\":\"all\"},\"limit\":0}");
                    Map<String, Object> any = query("{\"docs\":[{\"id\":\"a\",\"title\":\"alpha\",\"text\":\"\","
                            + "\"tags\":[],\"ts\":null}],\"query\":{\"terms\":[\"alpha\",\"beta\"],\"match\":\"any\"},\"limit\":0}");
                    // 3 for the title match only: the +4 bonus needs *every* term in the title, and
                    // "beta" is nowhere, so the whole-query bonus is not paid (the reviewed snapshot
                    // for match-all-versus-any says the same).
                    return intField(all, "total") == 0 && intField(any, "total") == 1 && hitScore(any, 0) == 3;
                }),

        new Case("an empty terms list is a filter-only query, not an empty answer",
                () -> {
                    Map<String, Object> r = query("{\"docs\":[{\"id\":\"a\",\"title\":\"x\",\"text\":\"\",\"tags\":[\"t\"],\"ts\":1},"
                            + "{\"id\":\"b\",\"title\":\"y\",\"text\":\"\",\"tags\":[],\"ts\":1}],"
                            + "\"query\":{\"terms\":[],\"tags\":[\"t\"]},\"limit\":0}");
                    return intField(r, "total") == 1 && "a".equals(hitId(r, 0)) && hitScore(r, 0) == 0;
                }),

        new Case("a tag filter compares exact strings, and the tag score is token-level",
                () -> {
                    Map<String, Object> exact = query("{\"docs\":[{\"id\":\"a\",\"title\":\"x\",\"text\":\"\","
                            + "\"tags\":[\"Nijisanji\"],\"ts\":null}],\"query\":{\"tags\":[\"nijisanji\"]},\"limit\":0}");
                    // a two-word tag is matched by a term whose two tokens are in it, for the tag's
                    // +2 - and the title "x" gives nothing, so the score is 2, not 3+2
                    Map<String, Object> token = query("{\"docs\":[{\"id\":\"a\",\"title\":\"x\",\"text\":\"\","
                            + "\"tags\":[\"hololive en\"],\"ts\":null}],\"query\":{\"terms\":[\"hololive en\"]},\"limit\":0}");
                    return intField(exact, "total") == 0 && intField(token, "total") == 1
                            && hitScore(token, 0) == SCORE_TAG_OF_ONE_TERM;
                }),

        new Case("the term's tokens must all be inside ONE tag", () -> {
            // The tag field is a list of sets: ["openai","gpt"] must NOT match the term "openai gpt"
            // even though each token is in some tag, while ["openai gpt"] must, for the +2 tag weight
            // and nothing else (title and text are empty). This is `tag-tokens-must-share-one-tag`.
            Map<String, Object> r = query("{\"docs\":["
                    + "{\"id\":\"split\",\"title\":\"\",\"text\":\"\",\"tags\":[\"openai\",\"gpt\"],\"ts\":null},"
                    + "{\"id\":\"together\",\"title\":\"\",\"text\":\"\",\"tags\":[\"openai gpt\"],\"ts\":null}],"
                    + "\"query\":{\"terms\":[\"openai gpt\"]},\"limit\":0}");
            Map<String, Object> tags = mapField(mapField(r.get("facets")).get("tags"));
            // the facet shows the same rule from the other side: "openai" and "gpt" are never counted
            return intField(r, "total") == 1 && "together".equals(hitId(r, 0))
                    && hitScore(r, 0) == SCORE_TAG_OF_ONE_TERM
                    && intField(tags, "openai gpt") == 1 && tags.size() == 1;
        }),

        new Case("a term with no tokens matches nothing", () -> {
            // The tokenizer trims edge punctuation and drops a token that is only punctuation, so
            // this term is empty - and an empty term matches no field, hence no document.
            Map<String, Object> r = query("{\"docs\":[{\"id\":\"a\",\"title\":\"x\",\"text\":\"-\",\"tags\":[],\"ts\":null}],"
                    + "\"query\":{\"terms\":[\"---\"]},\"limit\":0}");
            return intField(r, "total") == 0;
        }),

        new Case("a null ts is excluded by a range and counted, not dropped",
                () -> {
                    Map<String, Object> r = query("{\"docs\":[{\"id\":\"no-ts\",\"title\":\"x\",\"text\":\"\",\"tags\":[],\"ts\":null},"
                            + "{\"id\":\"old\",\"title\":\"x\",\"text\":\"\",\"tags\":[],\"ts\":100},"
                            + "{\"id\":\"new\",\"title\":\"x\",\"text\":\"\",\"tags\":[],\"ts\":300}],"
                            + "\"query\":{\"from\":200,\"to\":400},\"limit\":0}");
                    // no bounds at all: the null ts is a normal document
                    Map<String, Object> unbounded = query("{\"docs\":[{\"id\":\"no-ts\",\"title\":\"x\",\"text\":\"\","
                            + "\"tags\":[],\"ts\":null}],\"query\":{},\"limit\":0}");
                    return intField(r, "total") == 1 && intField(r, "excludedByTime") == 2
                            && "new".equals(hitId(r, 0)) && intField(unbounded, "total") == 1
                            && intField(unbounded, "excludedByTime") == 0;
                }),

        new Case("excludedByTime counts only documents the other filters kept", () -> {
            // A bounded query over three documents: one passes the term filter and has no ts (counted),
            // one never passes the term filter (excluded, but NOT counted - it was dropped before the
            // range was ever consulted), one passes and is dated. Pinned by the corpus case
            // `excluded-by-time-counts-only-matching-docs`.
            Map<String, Object> r = query("{\"docs\":["
                    + "{\"id\":\"matches-but-undated\",\"title\":\"x\",\"text\":\"\",\"tags\":[],\"ts\":null},"
                    + "{\"id\":\"does-not-match\",\"title\":\"y\",\"text\":\"\",\"tags\":[],\"ts\":null},"
                    + "{\"id\":\"matches-and-dated\",\"title\":\"x\",\"text\":\"\",\"tags\":[],\"ts\":300}],"
                    + "\"query\":{\"terms\":[\"x\"],\"from\":200},\"limit\":0}");
            return intField(r, "total") == 1 && intField(r, "excludedByTime") == 1
                    && "matches-and-dated".equals(hitId(r, 0));
        }),

        new Case("a negative ts is a real instant, bucketed by flooring", () -> {
            // -1 is one millisecond before the epoch: 1969-12, not 1970-01. Truncating division gets
            // this wrong, which is why the month comes from floor division. Corpus: the same.
            Map<String, Object> r = query("{\"docs\":[{\"id\":\"just-before\",\"title\":\"x\",\"text\":\"\","
                    + "\"tags\":[],\"ts\":-1}],\"query\":{\"terms\":[\"x\"]},\"limit\":0}");
            Map<String, Object> months = mapField(mapField(r.get("facets")).get("months"));
            return intField(months, "1969-12") == 1 && !months.containsKey("1970-01");
        }),

        new Case("from and to are inclusive bounds on ts", () -> {
            Map<String, Object> r = query("{\"docs\":[{\"id\":\"edge\",\"title\":\"x\",\"text\":\"\",\"tags\":[],\"ts\":200}],"
                    + "\"query\":{\"from\":200,\"to\":200},\"limit\":0}");
            Map<String, Object> above = query("{\"docs\":[{\"id\":\"edge\",\"title\":\"x\",\"text\":\"\",\"tags\":[],\"ts\":200}],"
                    + "\"query\":{\"from\":201},\"limit\":0}");
            Map<String, Object> below = query("{\"docs\":[{\"id\":\"edge\",\"title\":\"x\",\"text\":\"\",\"tags\":[],\"ts\":200}],"
                    + "\"query\":{\"to\":199},\"limit\":0}");
            return intField(r, "total") == 1 && intField(r, "excludedByTime") == 0
                    && intField(above, "excludedByTime") == 1 && intField(below, "excludedByTime") == 1;
        }),

        new Case("ties break by ts descending and then by id as UTF-8 bytes",
                () -> {
                    Map<String, Object> r = query("{" + TIE_DOCS + ",\"query\":{\"terms\":[\"x\"]},\"limit\":0}");
                    // "zoe" before "émile": U+00E9 encodes as C3 A9, which sorts after "z" (7A)
                    return "zoe,\u00e9mile,older,undated".equals(hitIds(r)) && intField(r, "total") == 4;
                }),

        new Case("the score decides the order before the timestamp does",
                () -> {
                    Map<String, Object> r = query("{\"docs\":["
                            + "{\"id\":\"low\",\"title\":\"\",\"text\":\"openai\",\"tags\":[],\"ts\":999},"
                            + "{\"id\":\"high\",\"title\":\"openai\",\"text\":\"\",\"tags\":[],\"ts\":1}],"
                            + "\"query\":{\"terms\":[\"openai\"]},\"limit\":0}");
                    return "high,low".equals(hitIds(r)) && hitScore(r, 0) == 7 && hitScore(r, 1) == 1;
                }),

        new Case("both facet objects count the matching set with keys sorted by UTF-8 bytes",
                () -> {
                    Map<String, Object> r = query("{\"docs\":["
                            + "{\"id\":\"a\",\"title\":\"x\",\"text\":\"\",\"tags\":[\"zeta\",\"alpha\"],\"ts\":1735689600000},"
                            + "{\"id\":\"b\",\"title\":\"x\",\"text\":\"\",\"tags\":[\"alpha\",\"\\u00e9mile\"],\"ts\":1738368000000},"
                            + "{\"id\":\"c\",\"title\":\"x\",\"text\":\"\",\"tags\":[],\"ts\":null}],"
                            + "\"query\":{\"terms\":[\"x\"]},\"limit\":0}");
                    Map<String, Object> facets = mapField(r.get("facets"));
                    Map<String, Object> tagFacet = mapField(facets.get("tags"));
                    Map<String, Object> monthFacet = mapField(facets.get("months"));
                    // The expected order is built from the UTF-8 bytes themselves: "alpha", then
                    // "\u00e9mile" (C3 A9, which sorts after every ASCII byte), then "zeta". The
                    // check reads the emitted keys and requires them to be exactly that, byte by
                    // byte, and reports what it saw when they are not.
                    String expected = expectedKeyOrder();
                    String actual = joinedKeys(tagFacet);
                    expectedOrderSeen = actual;
                    expectedOrderWanted = expected;
                    return intField(tagFacet, "alpha") == 2 && intField(tagFacet, "zeta") == 1
                            && intField(tagFacet, "\u00e9mile") == 1
                            && expected.equals(actual)
                            && "2025-01,2025-02".equals(joinedKeys(monthFacet))
                            && intField(monthFacet, "2025-01") == 1;
                }),

        new Case("a null ts contributes to no month facet", () -> {
            Map<String, Object> r = query("{\"docs\":[{\"id\":\"a\",\"title\":\"x\",\"text\":\"\",\"tags\":[],\"ts\":null}],"
                    + "\"query\":{},\"limit\":0}");
            Map<String, Object> months = mapField(mapField(r.get("facets")).get("months"));
            return intField(r, "total") == 1 && months.isEmpty();
        }),

        new Case("a timestamp of 0 is a real timestamp, in 1970-01", () -> {
            Map<String, Object> r = query("{\"docs\":[{\"id\":\"a\",\"title\":\"x\",\"text\":\"\",\"tags\":[],\"ts\":0}],"
                    + "\"query\":{},\"limit\":0}");
            Map<String, Object> months = mapField(mapField(r.get("facets")).get("months"));
            return intField(months, "1970-01") == 1;
        }),

        new Case("limit truncates hits but not total or the facets", () -> {
            Map<String, Object> r = query("{\"docs\":["
                    + "{\"id\":\"a\",\"title\":\"x\",\"text\":\"\",\"tags\":[\"t\"],\"ts\":300},"
                    + "{\"id\":\"b\",\"title\":\"x\",\"text\":\"\",\"tags\":[],\"ts\":200},"
                    + "{\"id\":\"c\",\"title\":\"x\",\"text\":\"\",\"tags\":[],\"ts\":100}],"
                    + "\"query\":{\"terms\":[\"x\"]},\"limit\":2}");
            Map<String, Object> tags = mapField(mapField(r.get("facets")).get("tags"));
            return listField(r, "hits").size() == 2 && intField(r, "total") == 3
                    && intField(tags, "t") == 1 && "a,b".equals(hitIds(r));
        }),

        new Case("limit 0 means no limit", () -> {
            Map<String, Object> r = query("{\"docs\":["
                    + "{\"id\":\"a\",\"title\":\"x\",\"text\":\"\",\"tags\":[],\"ts\":3},"
                    + "{\"id\":\"b\",\"title\":\"x\",\"text\":\"\",\"tags\":[],\"ts\":2},"
                    + "{\"id\":\"c\",\"title\":\"x\",\"text\":\"\",\"tags\":[],\"ts\":1}],"
                    + "\"query\":{\"terms\":[\"x\"]},\"limit\":0}");
            return listField(r, "hits").size() == 3 && intField(r, "total") == 3;
        }),

        new Case("a negative limit is refused as bad-input", () -> {
            try {
                query("{\"docs\":[],\"query\":{},\"limit\":-1}");
                return false;
            } catch (Search.BadInput e) {
                return true;
            } catch (RuntimeException e) {
                return false;
            }
        }),

        new Case("a missing docs array is refused as bad-input", () -> {
            try {
                query("{\"query\":{}}");
                return false;
            } catch (Search.BadInput e) {
                return true;
            } catch (RuntimeException e) {
                return false;
            }
        }),

        new Case("a repeated term scores once per occurrence", () -> {
            // The corpus pins this: the host dedupes if it cares, and "openai," tokenizes to the
            // same term as "openai", so the score is 3 + 3 + 4 - the bonus is paid once.
            Map<String, Object> r = query("{\"docs\":[{\"id\":\"a\",\"title\":\"openai\",\"text\":\"\",\"tags\":[],\"ts\":null}],"
                    + "\"query\":{\"terms\":[\"openai,\",\"openai\"]},\"limit\":0}");
            return hitScore(r, 0) == 10 && intField(r, "total") == 1;
        }),

        new Case("the field order of the answer is hits, total, facets, excludedByTime",
                () -> {
                    Map<String, Object> r = query("{\"docs\":[],\"query\":{},\"limit\":0}");
                    StringBuilder order = new StringBuilder();
                    for (String key : r.keySet()) {
                        if (order.length() > 0) {
                            order.append(',');
                        }
                        order.append(key);
                    }
                    Map<String, Object> facets = mapField(r.get("facets"));
                    StringBuilder facetOrder = new StringBuilder();
                    for (String key : facets.keySet()) {
                        if (facetOrder.length() > 0) {
                            facetOrder.append(',');
                        }
                        facetOrder.append(key);
                    }
                    return "hits,total,facets,excludedByTime".contentEquals(order)
                            && "tags,months".contentEquals(facetOrder);
                }),

        new Case("an empty corpus is an answer, not an error", () -> {
            Map<String, Object> r = query("{\"docs\":[],\"query\":{\"terms\":[\"x\"]},\"limit\":0}");
            return intField(r, "total") == 0 && listField(r, "hits").isEmpty()
                    && intField(r, "excludedByTime") == 0;
        }),

        new Case("describe answers the descriptor with the search capability", () -> {
            String line = SearchWorker.answerForCheck("{\"id\":1,\"op\":\"describe\"}");
            return line.equals("{\"id\":1,\"ok\":true,\"worker\":{\"protocol\":1,\"capability\":\"search.query\","
                    + "\"language\":\"java\",\"impl\":\"inverted-index\",\"runtime\":\"JDK "
                    + System.getProperty("java.version", "unknown") + "\",\"deterministic\":true}}");
        }),

        new Case("invoke answers an output envelope and a bad input answers the bad-input code", () -> {
            String ok = SearchWorker.answerForCheck(
                    "{\"id\":\"a\",\"op\":\"invoke\",\"capability\":\"search.query\",\"input\":{\"docs\":[],\"query\":{},\"limit\":0}}");
            String bad = SearchWorker.answerForCheck("{\"id\":2,\"op\":\"invoke\",\"input\":{\"docs\":[],\"limit\":-1}}");
            String other = SearchWorker.answerForCheck("{\"id\":3,\"op\":\"invoke\",\"capability\":\"text.normalize\",\"input\":{}}");
            String notJson = SearchWorker.answerForCheck("this is not JSON");
            return ok.equals("{\"id\":\"a\",\"ok\":true,\"output\":{\"hits\":[],\"total\":0,"
                    + "\"facets\":{\"tags\":{},\"months\":{}},\"excludedByTime\":0}}")
                    && bad.startsWith("{\"id\":2,\"ok\":false,\"error\":{\"code\":\"bad-input\",")
                    && other.contains("{\"code\":\"unsupported\",")
                    && notJson.startsWith("{\"id\":null,\"ok\":false,\"error\":{\"code\":\"bad-input\",");
        }),

        new Case("shutdown answers the bare envelope", () -> {
            String line = SearchWorker.answerForCheck("{\"id\":3,\"op\":\"shutdown\"}");
            return "{\"id\":3,\"ok\":true}".equals(line);
        }),
    };
}
