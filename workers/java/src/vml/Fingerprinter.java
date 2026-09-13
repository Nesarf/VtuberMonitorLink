// workers/java/src/vml/Fingerprinter.java
//
// text.fingerprint: docs/WORKERS.md section 4, all integer arithmetic so that agreement across
// languages is achievable rather than aspirational. FNV-1a 64-bit over UTF-8 bytes, SimHash with 64
// counters, ties to 0, printed as 16 lowercase hex characters.
package vml;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public final class Fingerprinter {

    /** CJK for this capability's purpose: Han, kana, Hangul. */
    private static final int[][] CJK_RANGES = {
        {0x3400, 0x4DBF},
        {0x4E00, 0x9FFF},
        {0xF900, 0xFAFF},
        {0x3040, 0x30FF},
        {0xAC00, 0xD7AF},
    };

    /**
     * ASCII punctuation for this capability: trimmed from both ends of every token, and a token
     * that is nothing but these emits no tokens at all.
     */
    private static final String ASCII_PUNCT = "!?,.;:'\"()[]{}<>-_/\\|*+=~`@#$%^&";

    private static final long FNV_OFFSET_BASIS = 0xCBF29CE484222325L; // 14695981039346656037
    private static final long FNV_PRIME = 0x100000001B3L;            // 1099511628211

    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private Fingerprinter() {
    }

    /** Returns {simhash, tokens, shingles} in the contract's field order. */
    public static Map<String, Object> fingerprint(String text) {
        List<String> tokens = tokensOf(text == null ? "" : text);
        List<String> shingles = shinglesOf(tokens);

        long[] counters = new long[64];
        for (String shingle : shingles) {
            long h = fnv1a64(shingle);
            for (int bit = 0; bit < 64; bit++) {
                // Unsigned shift: bit 63 is a bit like any other, and counters are small.
                counters[bit] += ((h >>> bit) & 1L) == 1L ? 1L : -1L;
            }
        }
        long simhash = 0L;
        for (int bit = 0; bit < 64; bit++) {
            if (counters[bit] > 0) {
                simhash |= (1L << bit); // a tie (0) stays 0
            }
        }

        Map<String, Object> out = Json.obj();
        out.put("simhash", toHex16(simhash));
        out.put("tokens", Integer.valueOf(tokens.size()));
        out.put("shingles", Integer.valueOf(shingles.size()));
        return out;
    }

    /** 16 lowercase hex characters, zero-padded. */
    static String toHex16(long value) {
        char[] buf = new char[16];
        for (int i = 0; i < 16; i++) {
            buf[15 - i] = HEX[(int) ((value >>> (i * 4)) & 0xFL)];
        }
        return new String(buf);
    }

    /** Tokenize on single spaces; the normalizer guarantees there are no runs, but be tolerant. */
    static List<String> tokensOf(String text) {
        List<String> out = new ArrayList<String>();
        for (String piece : text.split(" ", -1)) {
            if (piece.isEmpty()) {
                continue;
            }
            tokenizeToken(piece, out);
        }
        return out;
    }

    /** Groups one token's code points into runs by class and emits per the contract's rule. */
    private static void tokenizeToken(String token, List<String> out) {
        // Leading and trailing ASCII punctuation goes first, so "hello," and "hello" emit the same
        // token: otherwise every title ending in a full stop is its own duplicate as far as the
        // fingerprint is concerned. A token that is empty after trimming emits nothing.
        String trimmed = trimPunctuation(token);
        if (trimmed.isEmpty()) {
            return;
        }
        int[] cps = codePoints(trimmed);
        if (cps.length == 0) {
            return;
        }
        boolean allPunct = true;
        for (int cp : cps) {
            if (cp > 0x7F || ASCII_PUNCT.indexOf(cp) < 0) {
                allPunct = false;
                break;
            }
        }
        if (allPunct) {
            return; // a token of ASCII punctuation only emits nothing
        }

        int start = 0;
        boolean runCjk = isCjk(cps[0]);
        for (int k = 1; k <= cps.length; k++) {
            boolean nextCjk = k < cps.length && isCjk(cps[k]);
            if (k == cps.length || nextCjk != runCjk) {
                flushRun(cps, start, k, runCjk, out);
                if (k < cps.length) {
                    start = k;
                    runCjk = nextCjk;
                }
            }
        }
    }

    /** Drops ASCII punctuation from both ends; interior punctuation is left alone. */
    static String trimPunctuation(String token) {
        int start = 0;
        int end = token.length();
        while (start < end && isAsciiPunct(token.charAt(start))) {
            start++;
        }
        while (end > start && isAsciiPunct(token.charAt(end - 1))) {
            end--;
        }
        return start == 0 && end == token.length() ? token : token.substring(start, end);
    }

    private static boolean isAsciiPunct(char c) {
        return c <= 0x7F && ASCII_PUNCT.indexOf(c) >= 0;
    }

    private static void flushRun(int[] cps, int from, int to, boolean cjk, List<String> out) {
        if (to - from <= 0) {
            return;
        }
        if (cjk) {
            if (to - from == 1) {
                out.add(new String(Character.toChars(cps[from])));
            } else {
                // Overlapping bigrams: a run of n emits n-1 of them.
                for (int k = from; k + 1 < to; k++) {
                    out.add(new String(Character.toChars(cps[k])) + new String(Character.toChars(cps[k + 1])));
                }
            }
        } else {
            StringBuilder sb = new StringBuilder(to - from);
            for (int k = from; k < to; k++) {
                sb.appendCodePoint(cps[k]);
            }
            out.add(sb.toString());
        }
    }

    private static int[] codePoints(String s) {
        int[] tmp = new int[s.length()];
        int n = 0;
        for (int i = 0; i < s.length(); ) {
            int cp = s.codePointAt(i);
            i += Character.charCount(cp);
            tmp[n++] = cp;
        }
        int[] out = new int[n];
        System.arraycopy(tmp, 0, out, 0, n);
        return out;
    }

    /** Overlapping runs of 3 consecutive emitted tokens; fewer than 3 means one joined shingle. */
    static List<String> shinglesOf(List<String> tokens) {
        List<String> out = new ArrayList<String>();
        if (tokens.isEmpty()) {
            return out;
        }
        if (tokens.size() < 3) {
            out.add(String.join(" ", tokens));
            return out;
        }
        for (int i = 0; i + 3 <= tokens.size(); i++) {
            out.add(tokens.get(i) + " " + tokens.get(i + 1) + " " + tokens.get(i + 2));
        }
        return out;
    }

    /** FNV-1a 64-bit over the UTF-8 bytes; Java's long arithmetic wraps at 2^64 by definition. */
    static long fnv1a64(String s) {
        long h = FNV_OFFSET_BASIS;
        for (byte b : s.getBytes(StandardCharsets.UTF_8)) {
            h ^= (b & 0xFFL);
            h *= FNV_PRIME;
        }
        return h;
    }

    private static boolean isCjk(int cp) {
        for (int[] r : CJK_RANGES) {
            if (cp >= r[0] && cp <= r[1]) {
                return true;
            }
        }
        return false;
    }
}
