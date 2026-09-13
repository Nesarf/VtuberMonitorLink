// workers/java/src/vml/SelfCheck.java
//
// --selfcheck: the built-in case list of docs/WORKERS.md section 1.1. One English line per case, a
// "N/M checks passed" summary, non-zero exit on any failure, and no protocol traffic on stdout in
// this mode.
//
// The cases are the shipped corpus itself, read from workers/spec/cases/*.json and compared against
// the reviewed snapshot in workers/spec/expected/*.json. That is deliberately data-driven: the
// edge rules the contract cares about (unclosed tags, entities without a semicolon, numeric
// references, zero-width characters, full-width ASCII, a CJK string that must pass through
// untouched, idempotency, empty input) are exactly the corpus, and pinning the self-check to the
// snapshot means it cannot drift from the contract the way a hand-copied expectation list does.
package vml;

import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public final class SelfCheck {

    private interface Body {
        void run() throws Exception;
    }

    private static final class Case {
        final String name;
        final Body body;

        Case(String name, Body body) {
            this.name = name;
            this.body = body;
        }
    }

    private SelfCheck() {
    }

    /** Runs every case; returns the number of failures. */
    public static int run(PrintStream out) {
        List<Case> cases = new ArrayList<Case>();
        Path spec = null;
        try {
            spec = TextWorker.findSpecDir();
            cases.addAll(corpusCases(spec));
        } catch (RuntimeException e) {
            out.println("  [FAIL] cannot load the corpus from workers/spec: " + e.getMessage());
            out.println("0/1 checks passed");
            return 1;
        }
        cases.addAll(contractCases(TextWorker.loadNormalizer()));

        int passed = 0;
        for (Case c : cases) {
            String failure = null;
            try {
                c.body.run();
            } catch (AssertionError e) {
                failure = e.getMessage();
            } catch (Throwable t) {
                failure = t.toString();
            }
            if (failure == null) {
                passed++;
                out.println("  [ok]   " + c.name);
            } else {
                out.println("  [FAIL] " + c.name + ": " + failure);
            }
        }
        out.println(passed + "/" + cases.size() + " checks passed");
        return cases.size() - passed;
    }

    // -- the shipped corpus, compared against the reviewed snapshot ------------------------------

    private static List<Case> corpusCases(Path spec) {
        List<Case> cases = new ArrayList<Case>();
        addCorpus(cases, spec, "text.normalize");
        addCorpus(cases, spec, "text.extract");
        addCorpus(cases, spec, "text.fingerprint");
        return cases;
    }

    private static void addCorpus(List<Case> into, Path spec, String capability) {
        Map<String, Object> caseFile = readJson(spec.resolve("cases").resolve(capability + ".json"));
        Map<String, Object> expectedFile = readJson(spec.resolve("expected").resolve(capability + ".json"));
        Map<String, Object> expected = castMap(expectedFile.get("cases"));
        for (Object entry : asList(caseFile.get("cases"))) {
            Map<String, Object> c = castMap(entry);
            final String id = (String) c.get("id");
            final Map<String, Object> input = castMap(c.get("input"));
            final Map<String, Object> want = castMap(expected.get(id));
            final String capabilityName = capability;
            String note = c.get("note") instanceof String ? (String) c.get("note") : "";
            into.add(new Case(capability + " / " + id + (note.isEmpty() ? "" : " (" + shortNote(note) + ")"),
                    new Body() {
                        public void run() {
                            if (want == null) {
                                throw new AssertionError("the snapshot has no entry for " + id);
                            }
                            runCorpusCase(capabilityName, input, want);
                        }
                    }));
        }
    }

    private static void runCorpusCase(String capability, Map<String, Object> input, Map<String, Object> want) {
        if (capability.equals("text.normalize")) {
            Map<String, Object> got = Json.obj();
            got.put("text", TextWorker.loadNormalizerForCheck().normalize((String) input.get("text")));
            equalJson(want, got);        } else if (capability.equals("text.extract")) {
            equalJson(want, Extractor.extract((String) input.get("html")));
        } else {
            equalJson(want, Fingerprinter.fingerprint((String) input.get("text")));
        }
    }

    private static void equalJson(Map<String, Object> want, Map<String, Object> got) {
        String a = Json.encode(want);
        String b = Json.encode(got);
        if (!a.equals(b)) {
            throw new AssertionError("expected " + a + " but got " + b);
        }
    }

    private static String shortNote(String note) {
        int cut = note.length() > 46 ? 46 : note.length();
        return note.substring(0, cut);
    }

    // -- the contract's edge rules, stated directly --------------------------------------------

    private static List<Case> contractCases(final Normalizer normalizer) {
        List<Case> cases = new ArrayList<Case>();

        // The four "pass through untouched" scripts are asserted again here, in the shape the
        // contract states them, so a corpus that drifts cannot hide a mangled script.
        cases.add(new Case("contract / Han, kana, Hangul, Cyrillic and Arabic pass through unchanged", new Body() {
            public void run() {
                equal("\u5DF2\u7ECF\u5F00\u64AD\u4E86", normalizer.normalize("\u5DF2\u7ECF\u5F00\u64AD\u4E86"), "Han");
                equal("\u30C6\u30B9\u30C8", normalizer.normalize("\u30C6\u30B9\u30C8"), "katakana");
                equal("\uD55C\uAD6D\uC5B4", normalizer.normalize("\uD55C\uAD6D\uC5B4"), "Hangul");
                equal("\u041F\u0440\u0438\u0432\u0435\u0442", normalizer.normalize("\u041F\u0440\u0438\u0432\u0435\u0442"), "Cyrillic");
                equal("\u0645\u0631\u062D\u0628\u0627", normalizer.normalize("\u0645\u0631\u062D\u0628\u0627"), "Arabic");
            }
        }));
        cases.add(new Case("contract / the steps compose: map, then lowercase, then fold", new Body() {
            public void run() {
                // Full-width 'A' is mapped to 'A' by step 2 and must still be lowercased by step 3.
                equal("a", normalizer.normalize("\uFF21"), "mapped code point is still lowercased");
                equal("abc123!@#", normalizer.normalize("\uFF21\uFF22\uFF23\uFF11\uFF12\uFF13\uFF01\uFF20\uFF03"), "mapped and lowercased");
                equal("cafe", normalizer.normalize("Caf\u00E9"), "lowercased then folded");
                equal("lodz zolc", normalizer.normalize("\u0141\u00F3d\u017A   \u017B\u00D3\u0141\u0106"), "fold after lowercase");
            }
        }));
        cases.add(new Case("contract / the invariant holds: idempotent, no double space, no edge space", new Body() {
            public void run() {
                String[] inputs = {"  \u00C9  ", "\uFF21\uFF22\uFF23\u3000\uFF11", "\u0141\u00F3d\u017A",
                        "a\u200Bb \u2014 c", "\u30103D\u62AB\u9732\u3011 \u2018x\u2019  \u00A0 y "};
                for (String input : inputs) {
                    String once = normalizer.normalize(input);
                    equal(once, normalizer.normalize(once), "idempotency of " + quote(input));
                    if (once.contains("  ")) {
                        throw new AssertionError("a run of two spaces survived in " + quote(once));
                    }
                    if (once.startsWith(" ") || once.endsWith(" ")) {
                        throw new AssertionError("an edge space survived in " + quote(once));
                    }
                }
            }
        }));
        cases.add(new Case("contract / empty and whitespace-only input normalize to empty", new Body() {
            public void run() {
                equal("", normalizer.normalize(""), "empty");
                equal("", normalizer.normalize("   \t\n "), "whitespace only");
            }
        }));
        cases.add(new Case("contract / a decomposed string equals its composed form", new Body() {
            public void run() {
                equal(normalizer.normalize("Caf\u00E9"), normalizer.normalize("Cafe\u0301"), "NFC versus NFD, without NFKC");
            }
        }));
        cases.add(new Case("contract / extract never normalizes", new Body() {
            public void run() {
                Map<String, Object> r = Extractor.extract("<p>Caf\u00E9 \u5DF2\u7ECF</p>");
                equal("\nCaf\u00E9 \u5DF2\u7ECF\n", str(r, "text"), "case and accents are kept");
                Map<String, Object> a = Extractor.extract("<a href=\"/x\">Caf\u00E9 </a>");
                Object first = ((List<?>) a.get("links")).get(0);
                equal("Caf\u00E9 ", str(first, "text"), "a link's text keeps its spacing verbatim");
            }
        }));
        cases.add(new Case("contract / an unclosed tag at end of input is dropped as a tag", new Body() {
            public void run() {
                equal("a\n", str(Extractor.extract("a</p>"), "text"), "a closing tag alone still contributes its newline");
                equal("ab", str(Extractor.extract("<b>a</b>b"), "text"), "paired inline tags leave the text alone");
                equal("a", str(Extractor.extract("a<b"), "text"), "the unclosed tag and the character after it go");
            }
        }));
        cases.add(new Case("contract / a < not followed by a letter, / or ! is literal text", new Body() {
            public void run() {
                equal("5<6", str(Extractor.extract("5<6"), "text"), "a digit is not a tag start");
                equal("a < b", str(Extractor.extract("a < b"), "text"), "a space is not a tag start");
            }
        }));
        cases.add(new Case("contract / JSON codec round-trips quotes, backslashes, controls and astral text", new Body() {
            public void run() {
                String original = "q\"b\\s\n\t\u0001 \u5DF2 \uD83D\uDE00";
                equal(original, (String) Json.parse(Json.encode(original)), "round trip");
                equal("{\"id\":1}", Json.encode(Json.parse("{\"id\":1}")), "member encoding");
                equal("{\"a\":[1,{\"b\":null}]}", Json.encode(Json.parse("{\"a\":[1,{\"b\":null}]}")), "nesting");
                equal("{}", Json.encode(Json.parse("{ }")), "empty object");
                equal("[1,2]", Json.encode(Json.parse("[1, 2]")), "array");
                equal("2.5", Json.encode(Json.parse("2.5")), "a double keeps its source spelling");
                equal("1", Json.encode(castMap(Json.parse("{\"id\":1}")).get("id")), "a request id round-trips as 1");
            }
        }));
        cases.add(new Case("contract / a malformed request line is refused, not guessed", new Body() {
            public void run() {
                refused("{\"id\":1,\"op\":");
                refused("{\"a\":}");
                refused("{\"a\":1,}");
                refused("{'a':1}");
                refused("{\"a\":1} trailing");
            }
        }));
        cases.add(new Case("contract / the response envelopes are canonical, byte for byte", new Body() {
            public void run() {
                // Section 1's envelopes. `shutdown` answers the bare envelope and nothing else: an
                // extra "output" payload is what an earlier draft of the reference carried, and no
                // corpus case diffs a shutdown line, so it has to be pinned here or it drifts again.
                equal("{\"id\":1,\"ok\":true}", TextWorker.answerForCheck("{\"id\":1,\"op\":\"shutdown\"}"), "shutdown");
                equal("{\"id\":2,\"ok\":true,\"output\":{\"text\":\"\"}}", TextWorker.answerForCheck(
                        "{\"id\":2,\"op\":\"invoke\",\"capability\":\"text.normalize\",\"input\":{\"text\":\"\"}}"),
                        "invoke: id, ok, then the capability's own field order");
                equal("{\"id\":3,\"ok\":false,\"error\":{\"code\":\"bad-input\",\"message\":\"input.text must be a string\"}}",
                        TextWorker.answerForCheck("{\"id\":3,\"op\":\"invoke\",\"capability\":\"text.normalize\",\"input\":{\"text\":1}}"),
                        "bad input");
                equal("{\"id\":4,\"ok\":false,\"error\":{\"code\":\"unsupported\",\"message\":\"unknown op nonsense\"}}",
                        TextWorker.answerForCheck("{\"id\":4,\"op\":\"nonsense\"}"), "unknown op");
                equal("{\"id\":5,\"ok\":false,\"error\":{\"code\":\"unsupported\",\"message\":\"this worker implements text.normalize, not text.extract\"}}",
                        TextWorker.answerForCheck("{\"id\":5,\"op\":\"invoke\",\"capability\":\"text.extract\",\"input\":{\"html\":\"\"}}"),
                        "a capability this process does not implement");
                equal("{\"id\":6.5,\"ok\":true}", TextWorker.answerForCheck("{\"id\":6.5,\"op\":\"shutdown\"}"), "an id is echoed unchanged");
            }
        }));

        return cases;
    }

    private static void refused(String line) {
        try {
            Json.parse(line);
            throw new AssertionError("accepted malformed JSON: " + quote(line));
        } catch (Json.JsonError expected) {
            // The request loop turns this into {"ok":false,"error":{"code":"bad-input",...}}.
        }
    }

    // -- small helpers -------------------------------------------------------------------------

    private static Map<String, Object> readJson(Path file) {
        try {
            return castMap(Json.parse(new String(Files.readAllBytes(file), StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException("cannot read " + file + ": " + e.getMessage(), e);
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        if (!(value instanceof Map)) {
            throw new IllegalStateException("expected a JSON object but got " + value);
        }
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> asList(Object value) {
        if (!(value instanceof List)) {
            throw new IllegalStateException("expected a JSON array but got " + value);
        }
        return (List<Object>) value;
    }

    private static void equal(String expected, String actual, String what) {
        if (!expected.equals(actual)) {
            throw new AssertionError(what + ": expected " + quote(expected) + " but got " + quote(actual));
        }
    }

    private static String str(Object value, String key) {
        Object found = castMap(value).get(key);
        if (!(found instanceof String)) {
            throw new AssertionError("expected a string at " + key + " but got " + found);
        }
        return (String) found;
    }

    private static String quote(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\n') {
                sb.append("\\n");
            } else if (c == '\r') {
                sb.append("\\r");
            } else if (c == '\t') {
                sb.append("\\t");
            } else if (c < 0x20) {
                sb.append("\\u").append(Integer.toHexString(0x10000 | c).substring(1));
            } else {
                sb.append(c);
            }
        }
        return sb.append('"').toString();
    }
}
