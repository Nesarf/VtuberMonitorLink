// workers/java/src/vml/SearchWorker.java
//
// The stdio protocol of docs/WORKERS.md section 1 for the `search.query` capability (section 9):
// one JSON object per line, UTF-8, LF, `describe` / `invoke` / `shutdown`, `ok` / `error` envelopes,
// nothing but protocol lines on stdout, English diagnostics on stderr, stdout flushed after every
// response, and a bare `{"id":N,"ok":true}` for `shutdown`.
//
// It is deliberately the same shape as TextWorker.java, for the same reasons: one worker process
// handles one capability, so `--capability search.query` is the only capability this process answers,
// and an `invoke` for anything else is answered `unsupported` while the process stays alive (section
// 1.1: the host launches one worker per capability, so that field is there to catch a wiring
// mistake, and answering it is cheaper to debug than ignoring it).
//
// Unlike the text worker this one needs nothing from workers/spec/ at run time: section 9's inputs
// arrive already normalized, so there is no table to load and no data file that can go missing.
package vml;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;

public final class SearchWorker {

    static final String PROTOCOL_VERSION = "1";
    static final String LANGUAGE = "java";
    static final String IMPL = "inverted-index";
    static final String CAPABILITY = "search.query";

    /** Thrown when the run cannot even start: the arguments are wrong. */
    static final class SetupError extends RuntimeException {
        private static final long serialVersionUID = 1L;

        final int exitCode;

        SetupError(String message, int exitCode) {
            super(message);
            this.exitCode = exitCode;
        }
    }

    private final PrintStream out;
    private String pendingIdLine = null;
    private boolean shutdown = false;

    private SearchWorker(PrintStream out) {
        this.out = out;
    }

    public static void main(String[] args) {
        PrintStream out = stream(System.out);
        PrintStream err = stream(System.err);
        try {
            String capability = null;
            boolean selfcheck = false;
            for (int i = 0; i < args.length; i++) {
                String a = args[i];
                if (a.equals("--capability")) {
                    if (i + 1 >= args.length) {
                        throw new SetupError("--capability needs a capability name after it", 2);
                    }
                    capability = args[++i];
                } else if (a.equals("--selfcheck")) {
                    selfcheck = true;
                } else {
                    throw new SetupError("unexpected argument \"" + a + "\"", 2);
                }
            }

            if (selfcheck) {
                // Self-check mode writes one English line per case and nothing else; no protocol
                // traffic on stdout, and a non-zero exit as soon as one case fails.
                int failed = SearchSelfCheck.run(err);
                err.flush();
                System.exit(failed == 0 ? 0 : 1);
            }

            if (capability == null || !CAPABILITY.equals(capability)) {
                throw new SetupError(usage() + " (this worker implements " + CAPABILITY + " only)", 2);
            }

            err.println("vmlsearch: " + IMPL + ", capability " + CAPABILITY + ", JDK "
                    + System.getProperty("java.version", "unknown"));
            err.flush();
            new SearchWorker(out).loop(System.in);
            out.flush();
        } catch (SetupError e) {
            err.println("vmlsearch: " + e.getMessage());
            err.flush();
            System.exit(e.exitCode);
        } catch (Throwable t) {
            err.println("vmlsearch: fatal: " + t);
            err.flush();
            System.exit(70);
        }
    }

    static String usage() {
        return "usage: java -jar vmlsearch.jar --capability " + CAPABILITY + " | --selfcheck";
    }

    /**
     * Explicit UTF-8, because on Java 17 System.out/System.err use the platform code page: on a
     * Chinese Windows that is GBK, and every id and title in the corpus would turn into mojibake while
     * looking like it works (docs/WORKERS.md section 1.2). The launch line's -D flags do the same
     * thing; the contract says to do both, so this code does not rely on them.
     */
    private static PrintStream stream(PrintStream raw) {
        return new PrintStream(raw, true, StandardCharsets.UTF_8);
    }

    /** Reads the request loop. Lines are decoded as UTF-8 explicitly, never via the platform default. */
    private void loop(java.io.InputStream in) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        String line;
        while (!shutdown && (line = reader.readLine()) != null) {
            if (line.trim().isEmpty()) {
                continue;
            }
            String answer = answerFor(line);
            if (answer != null) {
                out.print(answer);
                out.print('\n'); // LF, always, on every platform
                out.flush(); // before reading the next request, as section 1 requires
            }
        }
    }

    private String answerFor(String line) {
        Object parsed;
        try {
            parsed = Json.parse(line);
        } catch (RuntimeException e) {
            pendingIdLine = null;
            return errorLine(null, "bad-input", "request is not JSON: " + e.getMessage());
        }
        if (!(parsed instanceof Map)) {
            pendingIdLine = null;
            return errorLine(null, "bad-input", "a request must be a JSON object");
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> request = (Map<String, Object>) parsed;

        Object id = request.get("id");
        pendingIdLine = idLineOf(id);
        Object op = request.get("op");

        if ("shutdown".equals(op)) {
            shutdown = true;
            // The bare envelope and nothing else (section 1). An extra payload here is what an
            // earlier draft of the reference carried, and because nothing diffs a shutdown line the
            // split survived four implementations.
            return okLine(id, null, null);
        }
        if ("describe".equals(op)) {
            return okLine(id, "worker", describe());
        }
        if (!"invoke".equals(op)) {
            return errorLine(id, "unsupported", "unknown op " + render(op));
        }

        String requested = request.get("capability") instanceof String ? (String) request.get("capability") : CAPABILITY;
        if (!CAPABILITY.equals(requested)) {
            return errorLine(id, "unsupported",
                    "this worker implements " + CAPABILITY + ", not " + render(requested));
        }

        try {
            return okLine(id, "output", Search.query(request.get("input")));
        } catch (Search.BadInput e) {
            return errorLine(id, "bad-input", e.getMessage());
        } catch (Throwable t) {
            return errorLine(id, "internal", t.toString());
        }
    }

    /**
     * Section 1's example field order: protocol, capability, language, impl, runtime, deterministic.
     */
    private Map<String, Object> describe() {
        Map<String, Object> worker = Json.obj();
        worker.put("protocol", Integer.valueOf(Integer.parseInt(PROTOCOL_VERSION)));
        worker.put("capability", CAPABILITY);
        worker.put("language", LANGUAGE);
        worker.put("impl", IMPL);
        worker.put("runtime", "JDK " + System.getProperty("java.version", "unknown"));
        worker.put("deterministic", Boolean.TRUE);
        return worker;
    }

    /** `id` is echoed unchanged, including when it is absent, null or not an integer. */
    private static Object idOf(Object rawId) {
        if (rawId instanceof Json.DoubleNum || rawId instanceof Number || rawId instanceof String) {
            return rawId;
        }
        return null;
    }

    private static String idLineOf(Object rawId) {
        Object id = idOf(rawId);
        return id == null ? "null" : Json.encode(id);
    }

    private String okLine(Object id, String key, Object value) {
        Map<String, Object> response = Json.obj();
        response.put("id", idOf(id));
        response.put("ok", Boolean.TRUE);
        if (key != null) {
            // `shutdown` passes null for both, which is how it gets the bare envelope.
            response.put(key, value);
        }
        return encode(response);
    }

    private String errorLine(Object id, String code, String message) {
        Map<String, Object> error = Json.obj();
        error.put("code", code);
        error.put("message", message);
        Map<String, Object> response = Json.obj();
        response.put("id", idOf(id));
        response.put("ok", Boolean.FALSE);
        response.put("error", error);
        return encode(response);
    }

    /** A failed encode is still answered, with `internal`, instead of dropping the response. */
    private String encode(Map<String, Object> response) {
        try {
            return Json.encode(response);
        } catch (RuntimeException e) {
            return "{\"id\":" + (pendingIdLine == null ? "null" : pendingIdLine)
                    + ",\"ok\":false,\"error\":{\"code\":\"internal\",\"message\":"
                    + Json.encode("cannot encode the response: " + e.getMessage()) + "}}";
        }
    }

    private static String render(Object value) {
        if (value == null) {
            return "null";
        }
        return value instanceof String ? (String) value : Json.encode(value);
    }

    /**
     * Runs one request line through the real request path and returns the response line, without
     * touching stdin or stdout. Used by --selfcheck to pin the response envelopes; the protocol loop
     * itself is unchanged.
     */
    static String answerForCheck(String line) {
        String answer = new SearchWorker(null).answerFor(line);
        return answer == null ? "" : answer;
    }
}
