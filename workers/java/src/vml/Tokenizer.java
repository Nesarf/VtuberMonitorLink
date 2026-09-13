// workers/java/src/vml/Tokenizer.java
//
// The tokenizer `search.query` is specified to reuse: docs/WORKERS.md section 9 says "Tokenize a
// field exactly as text.fingerprint does - whitespace split, edge punctuation trimmed, CJK runs as
// bigrams", and section 4 step 1-3 is the rule. It is written here, in the search worker's own
// source tree, as a deliberate copy of Fingerprinter's private tokenizer rather than a refactor of
// it: TextWorker.java and Fingerprinter.java are other work's files, and a shared helper extracted
// from them would make the text worker's behaviour depend on a file the search work owns. The copy
// is small, and the two are pinned against each other by --selfcheck and by the corpus, which is a
// better guarantee than a shared method would be.
//
// The rules, in the order they apply:
//
//   1. whitespace split - which in this project means a split on a single U+0020, because
//      text.normalize has already collapsed every run of space, tab, LF and CR into one space. A
//      split on any Unicode whitespace would therefore be a *different* split for the inputs this
//      contract actually carries, and a tab is not a separator here: it is an ordinary character
//      inside a token.
//   2. trim ASCII punctuation from both edges (the set in section 4 step 3).
//   3. an empty token, or one made only of that punctuation, emits nothing at all.
//   4. group what is left into runs by class; a CJK run of length 1 emits its code point, a CJK run
//      of length n >= 2 emits its n-1 overlapping bigrams, and an "other" run emits itself.
//
// Everything works on code points, not on UTF-16 units, so an astral character outside the CJK
// blocks is one unit of an "other" run - the same grouping the JavaScript reference gets from
// iterating `[...string]`.
package vml;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public final class Tokenizer {

    private Tokenizer() {
    }

    /**
     * The ASCII punctuation of section 4 step 3. A `Set<Character>` in the reference, and the set is
     * exactly the BMP characters below, so membership by code point is the same test.
     */
    private static final Set<Character> PUNCT_ONLY = new HashSet<Character>(Arrays.asList(
            '!', '?', ',', '.', ';', ':', '\'', '"', '(', ')', '[', ']', '{', '}', '<', '>', '-', '_',
            '/', '\\', '|', '*', '+', '=', '~', '`', '@', '#', '$', '%', '^', '&'));

    /** CJK for this contract: Han, kana and Hangul (section 4 step 2). */
    static boolean isCjk(int cp) {
        return (cp >= 0x3400 && cp <= 0x4DBF)
                || (cp >= 0x4E00 && cp <= 0x9FFF)
                || (cp >= 0xF900 && cp <= 0xFAFF)
                || (cp >= 0x3040 && cp <= 0x30FF)
                || (cp >= 0xAC00 && cp <= 0xD7AF);
    }

    /**
     * The emitted tokens of one space-free piece: edge punctuation trimmed, then runs and bigrams.
     */
    public static List<String> tokenizeToken(String piece) {
        String trimmed = trimPunctuation(piece);
        List<String> out = new ArrayList<String>();
        if (trimmed.isEmpty()) {
            return out;
        }
        int[] cps = trimmed.codePoints().toArray();
        boolean punctuationOnly = true;
        for (int cp : cps) {
            // A code point above the BMP is never in the punctuation set, and the cast below is the
            // same test the reference makes with `PUNCT_ONLY.has(codePointCharacter)`.
            if (cp > 0xFFFF || !PUNCT_ONLY.contains(Character.valueOf((char) cp))) {
                punctuationOnly = false;
                break;
            }
        }
        if (punctuationOnly) {
            return out;
        }
        StringBuilder run = new StringBuilder();
        int runLength = 0;
        boolean runIsCjk = false;
        int runFirst = -1;
        int runSecond = -1;
        for (int cp : cps) {
            boolean cjk = isCjk(cp);
            if (runLength > 0 && cjk != runIsCjk) {
                flush(out, run, runLength, runIsCjk, runFirst, runSecond);
                run.setLength(0);
                runLength = 0;
            }
            if (runLength == 0) {
                runIsCjk = cjk;
                runFirst = cp;
                runSecond = -1;
            } else if (runIsCjk && runLength == 1) {
                runSecond = cp;
            }
            run.appendCodePoint(cp);
            runLength++;
        }
        flush(out, run, runLength, runIsCjk, runFirst, runSecond);
        return out;
    }

    private static void flush(List<String> out, StringBuilder run, int length, boolean cjk, int first, int second) {
        if (length == 0) {
            return;
        }
        if (!cjk) {
            out.add(run.toString());
        } else if (length == 1) {
            out.add(new String(Character.toChars(first)));
        } else {
            out.add(new String(Character.toChars(first)) + new String(Character.toChars(second)));
        }
    }

    /** The whole rule, over a field's text. */
    public static List<String> tokensOf(String text) {
        List<String> out = new ArrayList<String>();
        if (text == null) {
            return out;
        }
        int start = 0;
        while (start <= text.length()) {
            int space = text.indexOf(' ', start);
            String piece = space == -1 ? text.substring(start) : text.substring(start, space);
            if (!piece.isEmpty()) {
                out.addAll(tokenizeToken(piece));
            }
            if (space == -1) {
                break;
            }
            start = space + 1;
        }
        return out;
    }

    // -- the punctuation set ---------------------------------------------------------------------

    private static boolean isEdgePunctuation(int cp) {
        return cp <= 0xFFFF && PUNCT_ONLY.contains(Character.valueOf((char) cp));
    }

    static String trimPunctuation(String piece) {
        int[] cps = piece.codePoints().toArray();
        int from = 0;
        int to = cps.length;
        while (from < to && isEdgePunctuation(cps[from])) {
            from++;
        }
        while (to > from && isEdgePunctuation(cps[to - 1])) {
            to--;
        }
        if (from == 0 && to == cps.length) {
            return piece;
        }
        return new String(cps, from, to - from);
    }
}
