// workers/java/src/vml/Extractor.java
//
// text.extract: the specified state machine of docs/WORKERS.md section 3, not a DOM parser.
// The JDK does have javax.swing.text.html.parser, and using it would violate the contract on two
// counts: it is not the specified state machine, and it would decode entities by its own table.
//
// Section 3 step 8 says extract never normalizes, and steps 4 and 5 go further: the title and every
// link's own text obey exactly the same rules as the main text, which is to say entity decoding and
// nothing else - no case folding and no whitespace collapsing.
package vml;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class Extractor {

    /** Step 1: removed with their content. */
    private static final String[] REMOVED_ELEMENTS = {"script", "style", "noscript", "template", "svg", "iframe"};

    /** Step 3: the tag becomes a newline, on the opening and on the closing tag. */
    private static final String NEWLINE_TAGS =
            "|br|p|div|li|ul|ol|tr|th|td|h1|h2|h3|h4|h5|h6|section|article|header|footer|aside|nav"
            + "|blockquote|pre|table|hr|dd|dt|figure|figcaption|main|form|";

    /**
     * Step 6: the named entities the contract lists, each decoded to ITS OWN character. Turning
     * U+2014 into "-" is the normalizer's job, done later by the host; doing it here would make this
     * function lie about the source text (docs/WORKERS.md section 3 step 6).
     */
    private static final Map<String, String> NAMED_ENTITIES = new LinkedHashMap<String, String>();

    static {
        NAMED_ENTITIES.put("amp", "&");
        NAMED_ENTITIES.put("lt", "<");
        NAMED_ENTITIES.put("gt", ">");
        NAMED_ENTITIES.put("quot", "\"");
        NAMED_ENTITIES.put("apos", "'");
        NAMED_ENTITIES.put("nbsp", "\u00A0");
        NAMED_ENTITIES.put("mdash", "\u2014");
        NAMED_ENTITIES.put("ndash", "\u2013");
        NAMED_ENTITIES.put("hellip", "\u2026");
        NAMED_ENTITIES.put("laquo", "\u00AB");
        NAMED_ENTITIES.put("raquo", "\u00BB");
        NAMED_ENTITIES.put("copy", "\u00A9");
        NAMED_ENTITIES.put("reg", "\u00AE");
        NAMED_ENTITIES.put("trade", "\u2122");
        NAMED_ENTITIES.put("times", "\u00D7");
        NAMED_ENTITIES.put("middot", "\u00B7");
    }

    /** `absolute` = the href starts with a scheme, `[A-Za-z][A-Za-z0-9+.-]*:`. */
    private static final Pattern SCHEME = Pattern.compile("^[A-Za-z][A-Za-z0-9+.-]*:");

    /** The contract's entity grammar, matched inside the lookahead window. */
    private static final Pattern ENTITY_HEAD = Pattern.compile("^(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,7})(;?)");

    private static final Pattern HREF = Pattern.compile("\\bhref\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))",
            Pattern.CASE_INSENSITIVE);

    private Extractor() {
    }

    /** Returns {title, text, links, images} in the field order the contract prints them in. */
    public static Map<String, Object> extract(String html) {
        String source = String.valueOf(html == null ? "" : html);

        // Order matters, and it is the order the contract lists: CDATA first, or the comment rule
        // eats the inside of a CDATA section that happens to contain "-->".
        Cdata cdata = resolveCdata(source);
        source = stripComments(cdata.source);
        source = stripDoctypes(source);
        for (String tag : REMOVED_ELEMENTS) {
            source = stripElement(source, tag);
        }
        // Compacting renumbers the CDATA sentinels so that only the fragments still present in the
        // source are kept; a fragment inside a removed element stays removed (section 3 step 1,
        // "remove with their content").
        cdata.compact(source);

        StringBuilder text = new StringBuilder(source.length());
        StringBuilder title = new StringBuilder();
        List<Object> links = new ArrayList<Object>();
        String pendingHref = null;
        StringBuilder pendingText = new StringBuilder();
        int images = 0;
        boolean titleSeen = false;
        boolean inTitle = false;
        boolean inLink = false;

        int i = 0;
        int n = source.length();
        while (i < n) {
            char ch = source.charAt(i);

            // A CDATA sentinel decodes back to the character data it stands for. It is restored here,
            // in the destination the walk is currently filling, so CDATA content can never leak into
            // the title or into an anchor's own text when it sits outside them.
            if (ch == cdata.mark) {
                int end = i + 1;
                while (end < n && Character.isDigit(source.charAt(end))) {
                    end++;
                }
                if (end > i + 1 && end < n && source.charAt(end) == ';') {
                    int number = Integer.parseInt(source.substring(i + 1, end));
                    String fragment = number < cdata.fragments.size() ? cdata.fragments.get(number) : "";
                    if (inTitle) {
                        title.append(fragment);
                    } else {
                        appendText(text, inLink ? pendingText : null, fragment);
                    }
                    i = end + 1;
                    continue;
                }
            }

            if (ch == '<' && i + 1 < n && isTagStart(source.charAt(i + 1))) {
                // Scan the tag, honouring quoted attribute values: a '>' inside them does not end it.
                int j = i + 1;
                char quote = 0;
                while (j < n) {
                    char c = source.charAt(j);
                    if (quote != 0) {
                        if (c == quote) {
                            quote = 0;
                        }
                    } else if (c == '"' || c == '\'') {
                        quote = c;
                    } else if (c == '>') {
                        break;
                    }
                    j++;
                }
                String raw = source.substring(i + 1, j); // without the angle brackets
                // An unclosed tag at end of input is dropped as a tag (section 3, bracket rules) -
                // and it contributes no newline, however much of its name was readable: the
                // incomplete tag is dropped, so the newline rule never gets to run.
                boolean complete = j < n && source.charAt(j) == '>';
                i = complete ? j + 1 : j;

                boolean closing = raw.startsWith("/");
                int at = closing ? 1 : 0;
                while (at < raw.length() && isSpace(raw.charAt(at))) {
                    at++;
                }
                int nameEnd = at;
                if (nameEnd < raw.length() && isAsciiLetter(raw.charAt(nameEnd))) {
                    nameEnd++;
                    while (nameEnd < raw.length() && isNameChar(raw.charAt(nameEnd))) {
                        nameEnd++;
                    }
                }
                String name = raw.substring(at, nameEnd).toLowerCase(Locale.ROOT);
                if (!complete) {
                    // The incomplete tag is dropped whole: no newline, no image, no link. Whatever
                    // text came before it has already been appended.
                    continue;
                }

                if (name.equals("title")) {
                    if (!closing && !titleSeen) {
                        inTitle = true;
                        titleSeen = true;
                    } else if (closing && inTitle) {
                        inTitle = false;
                    }
                    continue;
                }
                if (name.equals("img") && !closing) {
                    images++; // step 7: `<img` with the tag boundary respected
                }
                if (name.equals("a")) {
                    if (!closing) {
                        // HTML does not allow nested anchors, and a browser closes the open one and
                        // starts the new one: the outer link is reported with the text it had
                        // collected, and the inner becomes the open anchor. That is why
                        // "<a href=/one>one<a href=/two>two" reports BOTH links - the earlier rule,
                        // "ignore the inner anchor", silently dropped one.
                        if (inLink) {
                            links.add(link(pendingHref, pendingText.toString()));
                        }
                        pendingHref = hrefOf(raw);
                        pendingText.setLength(0);
                        inLink = true;
                    } else if (inLink) {
                        links.add(link(pendingHref, pendingText.toString()));
                        pendingHref = null;
                        inLink = false;
                    }
                    continue;
                }
                if (NEWLINE_TAGS.indexOf("|" + name + "|") >= 0) {
                    // Opening and closing both, so `<li>a</li><li>b</li>` is "\na\n\nb\n".
                    appendText(text, inLink ? pendingText : null, "\n");
                }
                continue;
            }

            if (ch == '&') {
                Entity decoded = decodeEntity(source, i);
                if (decoded != null) {
                    // An entity inside <title> belongs to the title, not to the body.
                    if (inTitle) {
                        title.append(decoded.text);
                    } else {
                        appendText(text, inLink ? pendingText : null, decoded.text);
                    }
                    i = decoded.next;
                    continue;
                }
            }

            if (inTitle) {
                title.append(ch);
            } else {
                appendText(text, inLink ? pendingText : null, String.valueOf(ch));
            }
            i++;
        }

        Map<String, Object> out = Json.obj();
        if (inLink) {
            // An anchor still open at the end of the input is reported with the text it collected
            // (section 3 step 4), rather than dropped.
            links.add(link(pendingHref, pendingText.toString()));
        }
        out.put("title", title.toString()); // step 5: entity-decoded, not normalized
        out.put("text", text.toString());
        out.put("links", links);
        out.put("images", Integer.valueOf(images));
        return out;
    }

    /** A link entry: href verbatim, no resolution, `absolute` from the scheme grammar. */
    private static Map<String, Object> link(String href, String ownText) {
        Map<String, Object> entry = Json.obj();
        entry.put("href", href);
        entry.put("absolute", Boolean.valueOf(SCHEME.matcher(href).find()));
        entry.put("text", ownText); // step 4: the same rules as the main text, nothing more
        return entry;
    }

    private static void appendText(StringBuilder text, StringBuilder pending, String chunk) {
        text.append(chunk);
        if (pending != null) {
            pending.append(chunk);
        }
    }

    /**
     * CDATA is **character data**: what is inside `<![CDATA[...]]>` is literal text and must not be
     * parsed as markup, which is the only reason the construct exists. So the body is lifted out
     * before every other pass runs and replaced by a sentinel no later rule can match (or corrupt);
     * the walk puts the text back where it belongs (section 3 step 2). An unclosed section keeps
     * everything to the end of the input, the same principle as a removed element with no closing
     * tag.
     *
     * The sentinel is a private-use code point chosen not to occur in this input, so it is unique by
     * construction and needs no escaping: the marker for body k is `mark + k + ';'`.
     */
    private static final class Cdata {
        /** The source with each CDATA body replaced by a sentinel. */
        String source;
        /** The bodies, in order; body k's marker is `mark + k + ';'`. */
        List<String> fragments = new ArrayList<String>();
        /** The private-use code point used as the sentinel for this extraction. */
        char mark = '\uE000';

        String marker(int number) {
            return mark + Integer.toString(number) + ';';
        }

        /** Keeps only the fragments still present in `text`, and renumbers their markers. */
        void compact(String text) {
            int[] mapping = new int[fragments.size()];
            List<String> kept = new ArrayList<String>();
            for (int k = 0; k < fragments.size(); k++) {
                mapping[k] = -1;
            }
            for (int k = 0; k < fragments.size(); k++) {
                if (text.indexOf(marker(k)) >= 0) {
                    mapping[k] = kept.size();
                    kept.add(fragments.get(k));
                }
            }
            if (kept.size() == fragments.size()) {
                this.fragments = kept;
                return; // nothing was removed, so the numbers already match
            }
            StringBuilder out = new StringBuilder(text.length());
            int i = 0;
            while (i < text.length()) {
                int at = text.indexOf(mark, i);
                if (at < 0) {
                    out.append(text, i, text.length());
                    break;
                }
                int end = at + 1;
                while (end < text.length() && Character.isDigit(text.charAt(end))) {
                    end++;
                }
                out.append(text, i, at);
                if (end > at + 1 && end < text.length() && text.charAt(end) == ';') {
                    int number = Integer.parseInt(text.substring(at + 1, end));
                    if (number >= 0 && number < mapping.length && mapping[number] >= 0) {
                        out.append(marker(mapping[number]));
                    }
                    i = end + 1;
                } else {
                    i = at + 1; // not one of our markers: keep the character as literal text
                }
            }
            this.fragments = kept;
            this.source = out.toString();
        }
    }

    /** Lifts every CDATA body out of the source, leaving a sentinel per body. */
    private static Cdata resolveCdata(String src) {
        Cdata cdata = new Cdata();
        cdata.mark = pickSentinel(src);
        StringBuilder out = new StringBuilder(src.length());
        int i = 0;
        while (i < src.length()) {
            if (src.startsWith("<![CDATA[", i)) {
                int end = src.indexOf("]]>", i + 9);
                int bodyEnd = end < 0 ? src.length() : end; // unclosed: to the end of the input
                cdata.fragments.add(src.substring(i + 9, bodyEnd));
                out.append(cdata.marker(cdata.fragments.size() - 1));
                i = end < 0 ? src.length() : end + 3;
                continue;
            }
            out.append(src.charAt(i));
            i++;
        }
        cdata.source = out.toString();
        return cdata;
    }

    /** The first private-use code point that does not occur in this input. */
    private static char pickSentinel(String src) {
        for (char c = '\uE000'; c <= '\uF8FF'; c++) {
            if (src.indexOf(c) < 0) {
                return c;
            }
        }
        return '\uE000'; // 6400 private-use code points used up: the input is pathological anyway
    }

    /** `<!-- ... -->` goes, end of input if it is never closed. */
    private static String stripComments(String src) {
        StringBuilder out = new StringBuilder(src.length());
        int i = 0;
        while (i < src.length()) {
            if (src.startsWith("<!--", i)) {
                int end = src.indexOf("-->", i + 4);
                if (end < 0) {
                    break;
                }
                i = end + 3;
                continue;
            }
            out.append(src.charAt(i));
            i++;
        }
        return out.toString();
    }

    /** `<!DOCTYPE ...>` goes, up to the first `>`; an unterminated declaration is left alone. */
    private static String stripDoctypes(String src) {
        StringBuilder out = new StringBuilder(src.length());
        int i = 0;
        while (i < src.length()) {
            if (src.regionMatches(true, i, "<!DOCTYPE", 0, 9)) {
                int end = src.indexOf('>', i + 9);
                if (end < 0) {
                    out.append(src, i, src.length());
                    break;
                }
                i = end + 1;
                continue;
            }
            out.append(src.charAt(i));
            i++;
        }
        return out.toString();
    }

    /**
     * Removes one element with its content: the tag itself through `</tag ...>`, or the tag through
     * the end of the input when the closing tag is missing. Every occurrence, left to right.
     *
     * The search for the closing tag starts AFTER the opening tag's name, so that a query string or
     * an attribute value that happens to contain "</script" cannot close the element early, and -
     * the bug this fixes - the opening tag itself is removed rather than skipped, which is what made
     * "<p>a</p><script>var x = 1;" lose the paragraph as well.
     */
    private static String stripElement(String src, String name) {
        StringBuilder out = new StringBuilder(src.length());
        int i = 0;
        while (i < src.length()) {
            int open = indexOfOpenTag(src, name, i);
            if (open < 0) {
                break;
            }
            int close = indexOfClosingTag(src, name, open + 1 + name.length());
            if (close < 0) {
                // A missing closing tag means "to end of input": everything from the tag on goes,
                // and what came before it stays.
                out.append(src, i, open);
                i = src.length();
                break;
            }
            out.append(src, i, open);
            i = close;
        }
        out.append(src, i, src.length());
        return out.toString();
    }

    private static int indexOfOpenTag(String src, String name, int from) {
        for (int i = Math.max(from, 0); i + 1 + name.length() <= src.length(); i++) {
            if (src.charAt(i) != '<' || !src.regionMatches(true, i + 1, name, 0, name.length())) {
                continue;
            }
            int after = i + 1 + name.length();
            if (after >= src.length() || isSpace(src.charAt(after)) || src.charAt(after) == '>') {
                return i;
            }
        }
        return -1;
    }

    /** The first `</name` at or after `from` whose next non-space character is `>`. */
    private static int indexOfClosingTag(String src, String name, int from) {
        String needle = "</" + name;
        for (int i = from; i + needle.length() <= src.length(); i++) {
            if (!src.regionMatches(true, i, needle, 0, needle.length())) {
                continue;
            }
            int k = i + needle.length();
            while (k < src.length() && isSpace(src.charAt(k))) {
                k++;
            }
            if (k < src.length() && src.charAt(k) == '>') {
                return k + 1;
            }
        }
        return -1;
    }

    private static boolean isTagStart(char c) {
        return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '/' || c == '!';
    }

    private static boolean isAsciiLetter(char c) {
        return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
    }

    private static boolean isNameChar(char c) {
        return isAsciiLetter(c) || (c >= '0' && c <= '9') || c == ':' || c == '-';
    }

    private static boolean isSpace(char c) {
        return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f';
    }

    private static boolean isBoundary(char c) {
        return isSpace(c) || c == '=';
    }

    /** The href attribute value verbatim; missing means the empty string, as the contract implies. */
    private static String hrefOf(String raw) {
        Matcher m = HREF.matcher(raw);
        if (!m.find()) {
            return "";
        }
        if (m.group(2) != null) {
            return m.group(2);
        }
        if (m.group(3) != null) {
            return m.group(3);
        }
        if (m.group(4) != null) {
            return m.group(4);
        }
        return "";
    }

    private static final class Entity {
        final String text;
        final int next;

        Entity(String text, int next) {
            this.text = text;
            this.next = next;
        }
    }

    /** The entity at `i` (which points at '&'), or null when the text there is not one. */
    private static Entity decodeEntity(String src, int i) {
        int semi = src.indexOf(';', i + 1);
        // The reference is looked for inside a short window starting at the '&', so that a stray '&'
        // cannot run away with the rest of the document. Named and numeric references are both
        // decoded with or without the terminating semicolon, as browsers do for this list of
        // well-known names. There is no backtracking, so `&copy2024` stays literal instead of
        // decoding `&copy` and leaving `2024` behind.
        int windowEnd = Math.min(semi == -1 ? i + 12 : semi + 1, i + 12);
        String window = src.substring(i + 1, Math.min(windowEnd, src.length()));
        Matcher m = ENTITY_HEAD.matcher(window);
        if (!m.find() || m.start() != 0) {
            return null;
        }
        String body = m.group(1);
        boolean hasSemi = m.group(2).equals(";");
        int consumed = 1 + body.length() + (hasSemi ? 1 : 0);

        if (body.charAt(0) == '#') {
            boolean hex = body.length() > 1 && (body.charAt(1) == 'x' || body.charAt(1) == 'X');
            // The digits start after the '#' (and after the 'x' when it is a hex reference): parsing
            // the 'x' itself as a digit is what makes every hex reference come out NaN.
            String digits = body.substring(hex ? 2 : 1);
            int cp;
            try {
                cp = Integer.parseInt(digits, hex ? 16 : 10);
            } catch (NumberFormatException e) {
                return null; // too large to be a code point, so it is not an entity
            }
            if (cp < 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) {
                return null; // neither out of range nor a lone surrogate is a text code point
            }
            return new Entity(new String(Character.toChars(cp)), i + consumed);
        }

        String decoded = NAMED_ENTITIES.get(body.toLowerCase(Locale.ROOT));
        if (decoded == null) {
            return null; // an unknown named entity stays verbatim
        }
        return new Entity(decoded, i + consumed);
    }
}
