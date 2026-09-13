// workers/java/src/vml/Json.java
//
// A small JSON reader/writer, because the contract forbids third-party dependencies and JDK 17 has
// no JSON parser in its standard library. Scope is what this protocol needs and no more: objects,
// arrays, strings (with the escapes, including the backslash-U form and surrogate pairs), integers,
// doubles, booleans and null. (The escape known to Java as a backslash-u sequence is written here as
// "backslash-U", because a literal one anywhere in a source file - even inside a comment - is a
// compile error: javac processes unicode escapes before it tokenizes.)
//
// Two properties matter more than generality here:
//   * encoding is exact - key order is the insertion order of the LinkedHashMap we are given, so the
//     caller controls it and the output is byte-identical run after run;
//   * strings never carry whitespace noise - numbers are echoed from their raw source text, and
//     object/array nesting is compact, so the output is what JSON.stringify would have produced.
package vml;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

public final class Json {

    /** Thrown for both malformed requests and unencodable values. The host reads it as bad-input. */
    public static final class JsonError extends RuntimeException {
        private static final long serialVersionUID = 1L;

        public JsonError(String message) {
            super(message);
        }
    }

    /** A JSON double keeps its source spelling so that echoing it back is lossless by construction. */
    public static final class DoubleNum {
        public final double value;
        public final String raw;

        DoubleNum(double value, String raw) {
            this.value = value;
            this.raw = raw;
        }
    }

    private static final Pattern NUMBER =
            Pattern.compile("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?");
    private static final int MAX_DEPTH = 200;

    private Json() {
    }

    // -- encoding ------------------------------------------------------------------------------

    /** Compact JSON text for a value made of Map/List/String/DoubleNum/Boolean/null. */
    public static String encode(Object value) {
        StringBuilder sb = new StringBuilder(256);
        write(sb, value);
        return sb.toString();
    }

    /** An empty object with deterministic (insertion) key order. */
    public static Map<String, Object> obj() {
        return new LinkedHashMap<String, Object>();
    }

    private static void write(StringBuilder sb, Object value) {
        if (value == null) {
            sb.append("null");
        } else if (value instanceof String) {
            writeString(sb, (String) value);
        } else if (value instanceof Boolean) {
            sb.append(((Boolean) value).booleanValue() ? "true" : "false");
        } else if (value instanceof DoubleNum) {
            DoubleNum d = (DoubleNum) value;
            if (Double.isNaN(d.value) || Double.isInfinite(d.value)) {
                // Not representable as JSON; the caller turns this into an `internal` error answer.
                throw new JsonError("cannot encode a non-finite number");
            }
            sb.append(d.raw);
        } else if (value instanceof Number) {
            sb.append(value.toString());
        } else if (value instanceof Map) {
            Map<?, ?> map = (Map<?, ?>) value;
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : map.entrySet()) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                writeString(sb, String.valueOf(e.getKey()));
                sb.append(':');
                write(sb, e.getValue());
            }
            sb.append('}');
        } else if (value instanceof List) {
            List<?> list = (List<?>) value;
            sb.append('[');
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) {
                    sb.append(',');
                }
                write(sb, list.get(i));
            }
            sb.append(']');
        } else {
            throw new JsonError("cannot encode a value of type " + value.getClass().getName());
        }
    }

    private static void writeString(StringBuilder sb, String s) {
        sb.append('"');
        int n = s.length();
        for (int i = 0; i < n; i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\t':
                    sb.append("\\t");
                    break;
                case '\b':
                    sb.append("\\b");
                    break;
                case '\f':
                    sb.append("\\f");
                    break;
                default:
                    if (c < 0x20) {
                        hex4(sb, c);
                    } else {
                        sb.append(c); // any other character, including non-ASCII, goes out as UTF-8
                    }
            }
        }
        sb.append('"');
    }

    private static void hex4(StringBuilder sb, char c) {
        sb.append("\\u");
        for (int shift = 12; shift >= 0; shift -= 4) {
            sb.append("0123456789abcdef".charAt((c >> shift) & 0xF));
        }
    }

    // -- decoding ------------------------------------------------------------------------------

    /** Parses one JSON value; trailing non-whitespace is an error. */
    public static Object parse(String text) {
        Parser p = new Parser(text);
        p.skipWs();
        Object v = p.value(0);
        p.skipWs();
        if (!p.atEnd()) {
            throw new JsonError("trailing characters after the JSON value");
        }
        return v;
    }

    private static final class Parser {
        private final String s;
        private int i;

        Parser(String s) {
            this.s = s;
        }

        boolean atEnd() {
            return i >= s.length();
        }

        void skipWs() {
            while (i < s.length()) {
                char c = s.charAt(i);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                    i++;
                } else {
                    break;
                }
            }
        }

        Object value(int depth) {
            if (depth > MAX_DEPTH) {
                throw new JsonError("JSON nesting is too deep");
            }
            if (atEnd()) {
                throw new JsonError("unexpected end of input");
            }
            char c = s.charAt(i);
            switch (c) {
                case '{':
                    return object(depth);
                case '[':
                    return array(depth);
                case '"':
                    return string();
                case 't':
                    expect("true");
                    return Boolean.TRUE;
                case 'f':
                    expect("false");
                    return Boolean.FALSE;
                case 'n':
                    expect("null");
                    return null;
                default:
                    if (c == '-' || (c >= '0' && c <= '9')) {
                        return number();
                    }
                    throw new JsonError("unexpected character '" + c + "' in JSON");
            }
        }

        Map<String, Object> object(int depth) {
            Map<String, Object> map = new LinkedHashMap<String, Object>();
            i++; // '{'
            skipWs();
            if (!atEnd() && s.charAt(i) == '}') {
                i++;
                return map;
            }
            while (true) {
                skipWs();
                if (atEnd() || s.charAt(i) != '"') {
                    throw new JsonError("expected a member name in a JSON object");
                }
                String key = string();
                skipWs();
                if (atEnd() || s.charAt(i) != ':') {
                    throw new JsonError("expected ':' after the member name \"" + key + "\"");
                }
                i++;
                skipWs();
                map.put(key, value(depth + 1));
                skipWs();
                if (atEnd()) {
                    throw new JsonError("unterminated JSON object");
                }
                char c = s.charAt(i);
                if (c == ',') {
                    i++;
                    continue;
                }
                if (c == '}') {
                    i++;
                    return map;
                }
                throw new JsonError("expected ',' or '}' in a JSON object");
            }
        }

        List<Object> array(int depth) {
            List<Object> list = new ArrayList<Object>();
            i++; // '['
            skipWs();
            if (!atEnd() && s.charAt(i) == ']') {
                i++;
                return list;
            }
            while (true) {
                skipWs();
                list.add(value(depth + 1));
                skipWs();
                if (atEnd()) {
                    throw new JsonError("unterminated JSON array");
                }
                char c = s.charAt(i);
                if (c == ',') {
                    i++;
                    continue;
                }
                if (c == ']') {
                    i++;
                    return list;
                }
                throw new JsonError("expected ',' or ']' in a JSON array");
            }
        }

        String string() {
            i++; // opening quote
            StringBuilder sb = new StringBuilder();
            while (true) {
                if (atEnd()) {
                    throw new JsonError("unterminated JSON string");
                }
                char c = s.charAt(i++);
                if (c == '"') {
                    return sb.toString();
                }
                if (c == '\\') {
                    if (atEnd()) {
                        throw new JsonError("unterminated escape sequence");
                    }
                    char e = s.charAt(i++);
                    switch (e) {
                        case '"':
                            sb.append('"');
                            break;
                        case '\\':
                            sb.append('\\');
                            break;
                        case '/':
                            sb.append('/');
                            break;
                        case 'b':
                            sb.append('\b');
                            break;
                        case 'f':
                            sb.append('\f');
                            break;
                        case 'n':
                            sb.append('\n');
                            break;
                        case 'r':
                            sb.append('\r');
                            break;
                        case 't':
                            sb.append('\t');
                            break;
                        case 'u':
                            if (i + 4 > s.length()) {
                                throw new JsonError("truncated \\u escape sequence");
                            }
                            int cp = 0;
                            for (int k = 0; k < 4; k++) {
                                int d = Character.digit(s.charAt(i + k), 16);
                                if (d < 0) {
                                    throw new JsonError("malformed \\u escape sequence");
                                }
                                cp = (cp << 4) | d;
                            }
                            i += 4;
                            sb.append((char) cp); // a surrogate half is joined with its partner in place
                            break;
                        default:
                            throw new JsonError("unknown escape sequence \\" + e);
                    }
                    continue;
                }
                if (c < 0x20) {
                    throw new JsonError("an unescaped control character is not allowed inside a JSON string");
                }
                sb.append(c);
            }
        }

        DoubleNum number() {
            int start = i;
            if (!atEnd() && s.charAt(i) == '-') {
                i++;
            }
            while (!atEnd() && s.charAt(i) >= '0' && s.charAt(i) <= '9') {
                i++;
            }
            if (!atEnd() && s.charAt(i) == '.') {
                i++;
                while (!atEnd() && s.charAt(i) >= '0' && s.charAt(i) <= '9') {
                    i++;
                }
            }
            if (!atEnd() && (s.charAt(i) == 'e' || s.charAt(i) == 'E')) {
                i++;
                if (!atEnd() && (s.charAt(i) == '+' || s.charAt(i) == '-')) {
                    i++;
                }
                while (!atEnd() && s.charAt(i) >= '0' && s.charAt(i) <= '9') {
                    i++;
                }
            }
            String raw = s.substring(start, i);
            if (!NUMBER.matcher(raw).matches()) {
                throw new JsonError("malformed JSON number");
            }
            // Parsed as a double, echoed from `raw`, so an id survives a round trip unchanged.
            return new DoubleNum(Double.parseDouble(raw), raw);
        }

        void expect(String literal) {
            if (!s.startsWith(literal, i)) {
                throw new JsonError("expected '" + literal + "' in JSON");
            }
            i += literal.length();
        }
    }
}
