// workers/java/src/vml/Normalizer.java
//
// text.normalize: the contract's seven steps, in order, over Unicode scalar values.
//
// The whole point of this capability is that implementations must *not* use their runtime's Unicode
// tables: Java would happily do a real toLowerCase(Locale.ROOT) and a real NFD/NFKC, both of which
// the contract forbids by name. So the case and fold tables are read at run time from
// workers/spec/latin-lower.json and workers/spec/latin-fold.json, and the only transformations that
// happen are the ones written down in docs/WORKERS.md section 2.
package vml;

import java.util.Map;

public final class Normalizer {

    /** Delete these code points outright (step 1). Tab, LF and CR are deliberately absent. */
    private static final int[][] DELETE_RANGES = {
        {0x0000, 0x0008},
        {0x000B, 0x000C},
        {0x000E, 0x001F},
        {0x007F, 0x007F},
        {0x200B, 0x200F},
        {0x202A, 0x202E},
        {0x2060, 0x2064},
        {0xFEFF, 0xFEFF},
        // Combining marks, so a decomposed "e" + U+0301 compares equal to a composed one without
        // anyone reaching for NFKC (which the contract forbids by name).
        {0x0300, 0x036F},
        {0x1AB0, 0x1AFF},
        {0x1DC0, 0x1DFF},
        {0x20D0, 0x20FF},
        {0xFE20, 0xFE2F},
    };

    /** Step 2: code points that map one-to-one to U+0020. */
    private static final int[] SPACE_LIKE = {
        0x00A0, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
        0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000,
    };

    private static final int[] QUOTES_SINGLE = {0x2018, 0x2019, 0x201B, 0x2032};
    private static final int[] QUOTES_DOUBLE = {0x201C, 0x201D, 0x201F, 0x2033};
    private static final int[] DASHES = {0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212};

    /** Step 3: code point -> code point, read from workers/spec/latin-lower.json. */
    private final int[] lowerTo = new int[0x250];
    /** Step 4: code point -> ASCII string of one or two characters, from workers/spec/latin-fold.json. */
    private final String[] foldTo = new String[0x250];

    public Normalizer(Map<String, Object> lowerTable, Map<String, Object> foldTable) {
        for (Map.Entry<String, Object> e : lowerTable.entrySet()) {
            int cp = Integer.parseInt(e.getKey());
            if (cp >= 0 && cp < lowerTo.length) {
                lowerTo[cp] = intOf(e.getValue(), "latin-lower.json");
            }
        }
        for (Map.Entry<String, Object> e : foldTable.entrySet()) {
            int cp = Integer.parseInt(e.getKey());
            if (cp >= 0 && cp < foldTo.length) {
                Object v = e.getValue();
                if (!(v instanceof String)) {
                    throw new IllegalArgumentException("latin-fold.json value for " + e.getKey() + " is not a string");
                }
                foldTo[cp] = (String) v;
            }
        }
    }

    private static int intOf(Object value, String table) {
        if (value instanceof Json.DoubleNum) {
            return (int) ((Json.DoubleNum) value).value;
        }
        if (value instanceof Number) {
            return ((Number) value).intValue();
        }
        throw new IllegalArgumentException(table + " maps to a non-number");
    }

    /**
     * Steps 1-4 of docs/WORKERS.md section 2, then the whitespace steps 5 and 6.
     *
     * The steps compose: a code point that step 2 maps is still lowercased by step 3 and folded by
     * step 4, because the mapped code point is what the later steps see. Full-width "A" proves the
     * point: step 2 makes it "A", step 3 makes that "a". Treating the tables as alternatives instead
     * of steps was a real bug in the reference implementation.
     */
    public String normalize(String text) {
        StringBuilder out = new StringBuilder(text.length() + 16);
        for (int i = 0; i < text.length(); ) {
            int cp = text.codePointAt(i);
            i += Character.charCount(cp);

            if (isDeleted(cp)) {
                continue;
            }
            // Step 2, one-to-one, or the code point itself when the table lists nothing for it.
            // U+2026 is the single multi-character entry ("..."), written out here because the rest
            // of the mapping table is one code point to one code point; its replacement is ASCII with
            // no lower or fold entry, so it composes exactly like the mapped code points below.
            if (cp == 0x2026) {
                out.append("...");
                continue;
            }
            int mapped = mapOne(cp);
            int afterMap = mapped == 0 ? cp : mapped;

            // Step 3: lowercase exactly what latin-lower.json says, and nothing else. The mapped
            // code point is what this step sees, so the bounds check is against it, not the source.
            int afterLower = afterMap;
            if (afterMap < lowerTo.length && lowerTo[afterMap] != 0) {
                afterLower = lowerTo[afterMap];
            }
            // Step 4: fold, which is why 'É' -> 'é' (step 3) -> 'e' (step 4) and 'Ż' -> 'ż' -> 'z'.
            // The fold table also maps a few code points the lower table cannot carry, U+0130 among
            // them, so 'İ' -> 'I' -> (fold) 'i' in one pass.
            if (afterLower < foldTo.length && foldTo[afterLower] != null) {
                out.append(foldTo[afterLower]);
            } else {
                out.appendCodePoint(afterLower);
            }
        }
        return trim(collapseSpaces(out));
    }

    /** Step 5: runs of space, tab, LF and CR become a single space. */
    static String collapseSpaces(CharSequence s) {
        StringBuilder sb = new StringBuilder(s.length());
        boolean inRun = false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                if (!inRun) {
                    sb.append(' ');
                    inRun = true;
                }
            } else {
                sb.append(c);
                inRun = false;
            }
        }
        return sb.toString();
    }

    /** Step 6: drop leading and trailing spaces. */
    static String trim(String s) {
        int start = 0;
        int end = s.length();
        while (start < end && s.charAt(start) == ' ') {
            start++;
        }
        while (end > start && s.charAt(end - 1) == ' ') {
            end--;
        }
        return start == 0 && end == s.length() ? s : s.substring(start, end);
    }

    private static boolean isDeleted(int cp) {
        for (int[] r : DELETE_RANGES) {
            if (cp >= r[0] && cp <= r[1]) {
                return true;
            }
        }
        return false;
    }

    /** Step 2's one-to-one map; 0 means "the table lists nothing for it, keep the code point". */
    private static int mapOne(int cp) {
        if (contains(SPACE_LIKE, cp)) {
            return ' ';
        }
        if (cp >= 0xFF01 && cp <= 0xFF5E) {
            return cp - 0xFEE0;
        }
        if (contains(QUOTES_SINGLE, cp)) {
            return '\'';
        }
        if (contains(QUOTES_DOUBLE, cp)) {
            return '"';
        }
        if (contains(DASHES, cp)) {
            return '-';
        }
        if (cp == 0x3001) {
            return ',';
        }
        if (cp == 0x3002) {
            return '.';
        }
        return 0;
    }

    private static boolean contains(int[] set, int cp) {
        for (int v : set) {
            if (v == cp) {
                return true;
            }
        }
        return false;
    }
}
