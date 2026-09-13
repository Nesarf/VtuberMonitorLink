// workers/java/src/vml/TextWorker.java
//
// The stdio protocol of docs/WORKERS.md section 1: JSON Lines over stdio, one request per line, one
// response per line, LF, UTF-8, nothing but protocol lines on stdout and free-form English
// diagnostics on stderr.
//
// It also declares how the two tables are obtained, because the contract leaves that open: they are
// read at RUN TIME from <repository root>/workers/spec/*.json, so there is one source of truth and
// no generated copy that can drift. See README.md.
package vml;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public final class TextWorker {

    static final String PROTOCOL_VERSION = "1";
    static final String LANGUAGE = "java";
    static final String IMPL = "table-driven";
    static final String[] CAPABILITIES = {"text.normalize", "text.extract", "text.fingerprint"};

    private static final String[] TABLE_FILES = {"latin-lower.json", "latin-fold.json"};

    /** Thrown when the run cannot even start: the tables are missing, or the arguments are wrong. */
    static final class SetupError extends RuntimeException {
        private static final long serialVersionUID = 1L;

        final int exitCode;

        SetupError(String message, int exitCode) {
            super(message);
            this.exitCode = exitCode;
        }
    }

    private final String capability;
    private final Normalizer normalizer;
    private final PrintStream out;
    private String pendingIdLine = null;
    private boolean shutdown = false;

    private TextWorker(String capability, Normalizer normalizer, PrintStream out) {
        this.capability = capability;
        this.normalizer = normalizer;
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
                int failed = SelfCheck.run(out);
                out.flush();
                System.exit(failed == 0 ? 0 : 1);
            }

            if (capability == null || !isKnownCapability(capability)) {
                throw new SetupError(usage(), 2);
            }

            Normalizer normalizer = loadNormalizer();
            new TextWorker(capability, normalizer, out).loop(System.in);
            out.flush();
        } catch (SetupError e) {
            err.println("vmltext: " + e.getMessage());
            err.flush();
            System.exit(e.exitCode);
        } catch (Throwable t) {
            err.println("vmltext: fatal: " + t);
            err.flush();
            System.exit(70);
        }
    }

    static String usage() {
        return "usage: java -jar vmltext.jar --capability <" + String.join("|", CAPABILITIES)
                + "> | --selfcheck";
    }

    private static boolean isKnownCapability(String name) {
        for (String c : CAPABILITIES) {
            if (c.equals(name)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Explicit UTF-8, because on Java 17 System.out/System.err use the platform code page: on a
     * Chinese Windows that is GBK, and the whole corpus would turn into mojibake while looking like
     * it works (docs/WORKERS.md section 1.2). The -D flags on the launch line do the same thing; the
     * contract says to do both, so this code does not rely on them.
     */
    private static PrintStream stream(PrintStream raw) {
        return new PrintStream(raw, true, StandardCharsets.UTF_8);
    }

    /** Reads the request loop. Lines are decoded as UTF-8 explicitly, never via the platform default. */
    private void loop(java.io.InputStream in) throws IOException {
        Charset utf8 = StandardCharsets.UTF_8;
        BufferedReader reader = new BufferedReader(new InputStreamReader(in, utf8));
        String line;
        while (!shutdown && (line = reader.readLine()) != null) {
            if (line.trim().isEmpty()) {
                continue;
            }
            String answer = answerFor(line);
            if (answer != null) {
                out.print(answer);
                out.print('\n'); // LF, always, on every platform
                out.flush();
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

        pendingIdLine = stringOfId(request.get("id"));
        Object id = request.get("id");
        Object op = request.get("op");

        if ("shutdown".equals(op)) {
            shutdown = true;
            // The bare envelope and nothing else (docs/WORKERS.md section 1). An extra "output"
            // payload here is what an earlier draft of the reference carried; because no corpus case
            // diffs a shutdown line, that split survived four implementations.
            return okLine(id, null, null);
        }
        if ("describe".equals(op)) {
            return okLine(id, "worker", describe());
        }
        if (!"invoke".equals(op)) {
            return errorLine(id, "unsupported", "unknown op " + render(op));
        }

        String requested = request.get("capability") instanceof String ? (String) request.get("capability") : capability;
        if (!requested.equals(capability)) {
            return errorLine(id, "unsupported", "this worker implements " + capability + ", not " + render(requested));
        }

        Object input = request.get("input");
        try {
            return okLine(id, "output", invoke(capability, input));
        } catch (BadInput e) {
            return errorLine(id, "bad-input", e.getMessage());
        } catch (Throwable t) {
            return errorLine(id, "internal", t.toString());
        }
    }

    private Map<String, Object> describe() {
        Map<String, Object> worker = Json.obj();
        worker.put("protocol", Integer.valueOf(Integer.parseInt(PROTOCOL_VERSION)));
        worker.put("capability", capability);
        worker.put("language", LANGUAGE);
        worker.put("impl", IMPL);
        worker.put("runtime", "JDK " + System.getProperty("java.version", "unknown"));
        worker.put("deterministic", Boolean.TRUE);
        return worker;
    }

    private Map<String, Object> invoke(String capability, Object input) {
        Map<String, Object> map = input instanceof Map ? castMap(input) : Json.obj();

        if (capability.equals("text.normalize")) {
            Map<String, Object> out = Json.obj();
            out.put("text", normalizer.normalize(textOf(map, "text")));
            return out;
        }
        if (capability.equals("text.extract")) {
            // baseUrl is accepted and deliberately unused: section 3 step 4 forbids resolution.
            return Extractor.extract(textOf(map, "html"));
        }
        return Fingerprinter.fingerprint(textOf(map, "text"));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }

    /** Thrown for an input the capability refuses; becomes the `bad-input` error code. */
    static final class BadInput extends RuntimeException {
        private static final long serialVersionUID = 1L;

        BadInput(String message) {
            super(message);
        }
    }

    private static String textOf(Map<String, Object> input, String field) {
        Object value = input.get(field);
        if (!(value instanceof String)) {
            throw new BadInput("input." + field + " must be a string");
        }
        return (String) value;
    }

    /** `id` is echoed unchanged, including when it is absent, null or not an integer. */
    private static Object idOf(Object rawId) {
        if (rawId instanceof Json.DoubleNum || rawId instanceof Number || rawId instanceof String) {
            return rawId;
        }
        return null;
    }

    private String stringOfId(Object rawId) {
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
            StringBuilder sb = new StringBuilder();
            sb.append("{\"id\":").append(pendingIdLine == null ? "null" : pendingIdLine)
              .append(",\"ok\":false,\"error\":{\"code\":\"internal\",\"message\":")
              .append(Json.encode("cannot encode the response: " + e.getMessage())).append("}}");
            return sb.toString();
        }
    }

    private static String render(Object value) {
        if (value == null) {
            return "null";
        }
        return value instanceof String ? (String) value : Json.encode(value);
    }

    // -- locating and loading the shared tables -------------------------------------------------

    /**
     * Loads workers/spec/latin-lower.json and latin-fold.json from the repository root, found by
     * walking up from the working directory and from the location of this jar.
     */
    static Normalizer loadNormalizer() {
        Path spec = findSpecDir();
        Object lowerRaw = readJson(spec.resolve("latin-lower.json"));
        Object foldRaw = readJson(spec.resolve("latin-fold.json"));
        return new Normalizer(tableOf(lowerRaw, "latin-lower.json"), tableOf(foldRaw, "latin-fold.json"));
    }

    /** The tables are small and immutable, so load them once per process. */
    static synchronized Normalizer loadNormalizerForCheck() {
        if (cachedNormalizer == null) {
            cachedNormalizer = loadNormalizer();
        }
        return cachedNormalizer;
    }

    /**
     * Runs one request line through the real request path and returns the response line, without
     * touching stdin or stdout. Used by --selfcheck to pin the response envelopes; the protocol loop
     * itself is unchanged.
     */
    static String answerForCheck(String line) {
        TextWorker worker = new TextWorker("text.normalize", loadNormalizerForCheck(), null);
        String answer = worker.answerFor(line);
        return answer == null ? "" : answer;
    }

    private static Normalizer cachedNormalizer;

    private static Map<String, Object> tableOf(Object document, String file) {
        if (!(document instanceof Map)) {
            throw new SetupError(file + " must contain a JSON object", 3);
        }
        Object map = castMap(document).get("map");
        if (!(map instanceof Map)) {
            throw new SetupError(file + " must contain a \"map\" object", 3);
        }
        return castMap(map);
    }

    private static Object readJson(Path file) {
        try {
            return Json.parse(new String(Files.readAllBytes(file), StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new SetupError("cannot read the share table " + file + ": " + e.getMessage(), 3);
        } catch (RuntimeException e) {
            throw new SetupError("cannot parse the share table " + file + ": " + e.getMessage(), 3);
        }
    }

    static Path findSpecDir() {
        List<Path> starts = new ArrayList<Path>();
        addStart(starts, Paths.get(System.getProperty("user.dir", ".")));
        try {
            Path jar = Paths.get(TextWorker.class.getProtectionDomain().getCodeSource().getLocation().toURI());
            addStart(starts, jar.getParent());
        } catch (Exception ignored) {
            // The code source is not always a file URL; the other starting points still apply.
        }
        addStart(starts, Paths.get(System.getProperty("user.home", ".")));

        List<String> tried = new ArrayList<String>();
        for (Path start : starts) {
            Path dir = toDirectory(start);
            while (dir != null) {
                Path spec = dir.resolve("workers").resolve("spec");
                if (looksLikeSpec(spec)) {
                    return spec;
                }
                Path fallback = dir.resolve("VtuberMonitorLink").resolve("workers").resolve("spec");
                if (looksLikeSpec(fallback)) {
                    return fallback; // a checkout that sits directly under an unrelated parent
                }
                tried.add(spec.toString());
                dir = dir.getParent();
            }
        }
        throw new SetupError("cannot find workers/spec/*.json: looked in " + tried, 3);
    }

    private static void addStart(List<Path> starts, Path path) {
        if (path != null) {
            starts.add(path);
        }
    }

    private static Path toDirectory(Path path) {
        Path p = path.toAbsolutePath().normalize();
        return Files.isDirectory(p) ? p : p.getParent();
    }

    private static boolean looksLikeSpec(Path dir) {
        for (String file : TABLE_FILES) {
            if (!Files.isRegularFile(dir.resolve(file))) {
                return false;
            }
        }
        return true;
    }
}
