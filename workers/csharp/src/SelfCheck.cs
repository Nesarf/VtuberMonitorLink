// SelfCheck.cs - the built-in case list behind --selfcheck (docs/WORKERS.md section 1.1).
//
// "One extra argument is required of every implementation, because it is what makes the worker
// testable on its own: --selfcheck runs a short built-in case list, prints one English line per case
// plus a N/M checks passed summary, and exits non-zero on a failure (no protocol traffic on stdout in
// this mode)."
//
// The cases are chosen for two jobs. First, the contract's edge rules, so a rule that changes without
// its case changing fails: the pass order of section 3, the unclosed-tag rules, the entity window,
// the anchor rules, and the bigram tokenizer. Second, the .NET traps this worker was written around,
// each pinned by a case that would have caught it:
//
//   * **Culture-sensitive defaults.** `ToLower()`, `String.Compare` and their relatives are
//     culture-aware, so their answers depend on the machine's locale. The Turkish and German cases
//     below run under tr-TR and de-DE and expect the same answer as everywhere else, because the
//     contract's shared tables are the rule and .NET's casing is never consulted. U+0130 (dotted
//     capital I) is the demonstration: it is absent from the one-to-one lower table and folds to "i",
//     while tr-TR would lowercase an ASCII "I" to the dotless "ı".
//   * **UTF-16 code units are not code points.** `foreach (char c in text)` splits a surrogate pair,
//     and char.ConvertFromUtf32 then THROWS on the lone half - which is how a published worker in
//     this layer came to reject every emoji. The astral cases pin that an emoji survives normalize
//     unchanged, that an astral code point outside the tables passes through, and that the
//     fingerprint treats a pair as the one run it is.
//   * **String.Trim() is not the contract's whitespace.** Trim() strips Unicode whitespace; the
//     contract's steps 5 and 6 name four ASCII characters, AFTER the mapping step has turned the
//     space-like code points into U+0020. The difference is only observable through a code point the
//     mapping step does not cover, so one case pins U+2007 FIGURE SPACE (mapped, then collapsed) next
//     to U+0085 NEXT LINE (neither mapped nor whitespace, and therefore kept verbatim).
//   * **Composition and mutation.** Normalization must be idempotent, the case and fold tables must
//     compose for a character the lower table maps (U+00C9: lower, then fold), and a two-character
//     fold output must not re-enter either table on a second pass.
//   * **The wire format.** The three cases at the end assert the response envelopes themselves -
//     describe's key order, invoke's key order including the nested link keys, and the shutdown
//     envelope's exact shape - because the harness checks all three and no corpus case does.
//
// Expectations are literal JSON strings rather than values recomputed from the code, so a rule that
// changes without its case changing fails loudly. The fingerprint expectations are produced by an
// independent mini-implementation in this file (Fnv1a64BigInteger + ReferenceSimhash), which is why
// they can be written as constants even though the code under test is an implementation detail.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Numerics;
using System.Text;
using System.Text.Json;

namespace Vml;

internal sealed class SelfCheck
{
    private sealed class CheckCase
    {
        public string Name { get; init; } = string.Empty;

        public string Capability { get; init; } = string.Empty;

        /// <summary>The protocol "input" object, exactly as the host would send it.</summary>
        public string Input { get; init; } = string.Empty;

        /// <summary>The expected output object as JSON text.</summary>
        public string Expect { get; init; } = string.Empty;

        /// <summary>A culture to run THIS case under, for the cases that prove culture cannot matter.</summary>
        public string? Culture { get; init; }
    }

    private readonly Protocol _protocol;

    public SelfCheck(Protocol protocol)
    {
        _protocol = protocol;
    }

    /// <summary>Runs every case. Returns the process exit code: 0 when all pass, 1 otherwise.</summary>
    public int Run(Stream stdout)
    {
        List<CheckCase> cases = Cases();
        int passed = 0;
        int total = cases.Count;
        foreach (CheckCase checkCase in cases)
        {
            string? failure = RunOne(checkCase);
            if (failure == null)
            {
                passed++;
                WriteLine(stdout, "ok   " + checkCase.Name);
            }
            else
            {
                WriteLine(stdout, "FAIL " + checkCase.Name);
                WriteLine(stdout, "       " + failure);
            }
        }

        foreach ((string name, Func<bool> run) in ProtocolChecks())
        {
            total++;
            bool ok;
            string detail;
            try
            {
                ok = run();
                detail = string.Empty;
            }
            catch (Exception error) when (error is JsonException or InvalidOperationException or ArgumentException)
            {
                ok = false;
                detail = error.GetType().Name + ": " + error.Message;
            }

            if (ok)
            {
                passed++;
                WriteLine(stdout, "ok   " + name);
            }
            else
            {
                WriteLine(stdout, "FAIL " + name);
                if (detail.Length > 0)
                {
                    WriteLine(stdout, "       " + detail);
                }
            }
        }

        WriteLine(stdout, Invariant(passed) + "/" + Invariant(total) + " checks passed");
        return passed == total ? 0 : 1;
    }

    private string? RunOne(CheckCase checkCase)
    {
        CultureInfo? previous = null;
        bool cultureSwapped = false;
        if (checkCase.Culture != null)
        {
            previous = CultureInfo.CurrentCulture;
            CultureInfo.CurrentCulture = new CultureInfo(checkCase.Culture);
            cultureSwapped = true;
        }

        try
        {
            using var document = JsonDocument.Parse(checkCase.Input);
            byte[] output = _protocol.BuildOutput(checkCase.Capability, document.RootElement);
            string actual = Encoding.UTF8.GetString(output);
            if (!string.Equals(actual, checkCase.Expect, StringComparison.Ordinal))
            {
                return "expected " + checkCase.Expect + " but got " + actual;
            }

            return null;
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or BadInputException or ArgumentException)
        {
            return "the case could not be run: " + error.GetType().Name + ": " + error.Message;
        }
        finally
        {
            if (cultureSwapped && previous != null)
            {
                CultureInfo.CurrentCulture = previous;
            }
        }
    }

    // ----------------------------------------------------------------------------------------
    // Protocol checks: these exercise the response envelopes, not the capabilities
    // ----------------------------------------------------------------------------------------

    private List<(string Name, Func<bool> Run)> ProtocolChecks()
    {
        return new List<(string, Func<bool>)>
        {
            ("protocol/a describe answer keeps the contract's key order", CheckDescribeEnvelope),
            ("protocol/an invoke answer keeps the contract's key order, links included", CheckInvokeEnvelope),
            ("protocol/a shutdown answer is the bare envelope and nothing else", CheckShutdownEnvelope),
            ("protocol/an op that is not a string is refused and its id is still echoed", CheckBadOpEnvelope),
            ("protocol/an invoke naming another capability is refused as unsupported", CheckMismatchedCapabilityIsUnsupported),
        };
    }

    private bool CheckDescribeEnvelope()
    {
        byte[] line = Encoding.UTF8.GetBytes("{\"id\":\"describe\",\"op\":\"describe\"}");
        Protocol.RequestShape? request = Protocol.ParseLine(line, out _);
        if (request == null)
        {
            return false;
        }

        var writer = new JsonOut();
        _protocol.WriteDescribe(writer, request.Value.IdToken, Protocol.CapNormalize);
        string text = writer.ToUtf8String();
        string want = "{\"id\":\"describe\",\"ok\":true,\"worker\":{\"protocol\":1,\"capability\":\"text.normalize\","
            + "\"language\":\"csharp\",\"impl\":\"table-driven\",\"runtime\":\"" + Protocol.RuntimeString() + "\",\"deterministic\":true}}";
        if (!string.Equals(text, want, StringComparison.Ordinal))
        {
            WriteLine(Console.OpenStandardError(), "       describe envelope: " + text);
            return false;
        }

        return true;
    }

    private bool CheckInvokeEnvelope()
    {
        byte[] line = Encoding.UTF8.GetBytes("{\"id\":\"c0\",\"op\":\"invoke\",\"capability\":\"text.extract\","
            + "\"input\":{\"html\":\"<a href=\\\"x>y\\\">z</a>\",\"baseUrl\":null}}");
        Protocol.RequestShape? request = Protocol.ParseLine(line, out _);
        if (request == null || request.Value.Input == null)
        {
            return false;
        }

        var writer = new JsonOut();
        _protocol.WriteInvoke(
            writer,
            request.Value.IdToken,
            Protocol.CapExtract,
            request.Value.HasCapability,
            request.Value.RequestedCapability,
            request.Value.Input);
        string text = writer.ToUtf8String();
        const string want = "{\"id\":\"c0\",\"ok\":true,\"output\":{\"title\":\"\",\"text\":\"z\","
            + "\"links\":[{\"href\":\"x>y\",\"absolute\":false,\"text\":\"z\"}],\"images\":0}}";
        if (!string.Equals(text, want, StringComparison.Ordinal))
        {
            WriteLine(Console.OpenStandardError(), "       invoke envelope: " + text);
            return false;
        }

        return true;
    }

    /// <summary>
    /// An invoke naming a capability this process was not launched with is refused with `unsupported`,
    /// which is the contract's rule and also the difference between a loud mis-wiring and a quiet one:
    /// ignoring the field would run this worker's own capability over another capability's input and
    /// answer `bad-input`, which looks like a corpus problem instead of a launch mistake.
    /// </summary>
    private bool CheckMismatchedCapabilityIsUnsupported()
    {
        byte[] line = Encoding.UTF8.GetBytes("{\"id\":\"c9\",\"op\":\"invoke\",\"capability\":\"text.extract\","
            + "\"input\":{\"html\":\"<p>x</p>\",\"baseUrl\":null}}");
        Protocol.RequestShape? request = Protocol.ParseLine(line, out _);
        if (request == null)
        {
            return false;
        }

        var writer = new JsonOut();
        _protocol.WriteInvoke(
            writer,
            request.Value.IdToken,
            Protocol.CapNormalize,
            request.Value.HasCapability,
            request.Value.RequestedCapability,
            request.Value.Input);
        string text = writer.ToUtf8String();
        const string want = "{\"id\":\"c9\",\"ok\":false,\"error\":{\"code\":\"unsupported\","
            + "\"message\":\"this worker implements text.normalize, not text.extract\"}}";
        if (!string.Equals(text, want, StringComparison.Ordinal))
        {
            WriteLine(Console.OpenStandardError(), "       mismatched capability: " + text);
            return false;
        }

        return true;
    }

    private static bool CheckShutdownEnvelope()
    {
        byte[] line = Encoding.UTF8.GetBytes("{\"id\":\"shutdown\",\"op\":\"shutdown\"}");
        Protocol.RequestShape? request = Protocol.ParseLine(line, out _);
        if (request == null)
        {
            return false;
        }

        var writer = new JsonOut();
        Protocol.WriteShutdownAck(writer, request.Value.IdToken);
        string text = writer.ToUtf8String();
        if (!string.Equals(text, "{\"id\":\"shutdown\",\"ok\":true}", StringComparison.Ordinal))
        {
            WriteLine(Console.OpenStandardError(), "       shutdown envelope: " + text);
            return false;
        }

        return true;
    }

    private static bool CheckBadOpEnvelope()
    {
        byte[] line = Encoding.UTF8.GetBytes("{\"id\":3,\"op\":3,\"input\":{\"text\":\"a\"}}");
        Protocol.RequestShape? request = Protocol.ParseLine(line, out _);
        if (request == null)
        {
            return false;
        }

        if (request.Value.HasOp)
        {
            return false; // a numeric op is not an op
        }

        var writer = new JsonOut();
        Protocol.WriteError(writer, request.Value.IdToken, "bad-input", "request.op must be a string");
        string text = writer.ToUtf8String();
        const string want = "{\"id\":3,\"ok\":false,\"error\":{\"code\":\"bad-input\",\"message\":\"request.op must be a string\"}}";
        if (!string.Equals(text, want, StringComparison.Ordinal))
        {
            WriteLine(Console.OpenStandardError(), "       bad-op envelope: " + text);
            return false;
        }

        return true;
    }

    // ----------------------------------------------------------------------------------------
    // The capability cases
    // ----------------------------------------------------------------------------------------

    private static List<CheckCase> Cases()
    {
        // 𝐀𐐀 𐐨 (U+1D400, U+10400, U+10428) and 😀 🇯🇵 are written literally here: they are what
        // the corpus uses, and a code-point escape would hide whether an editor mangled them.
        const string astral = "\U0001D400\U00010400 \U00010428";
        const string emoji = "cat \U0001F600 tail \U0001F1EF\U0001F1F5";

        return new List<CheckCase>
        {
            Case("normalize/empty input stays empty", Protocol.CapNormalize, "{\"text\":\"\"}", "{\"text\":\"\"}"),
            Case(
                "normalize/full-width ASCII, ideographic space, em dash, apostrophe, ellipsis",
                Protocol.CapNormalize,
                "{\"text\":\"" + Utf8("\uFF23\uFF41\uFF46\uFF45\u3000\u2014\u3000L\u2019\uFF25T\uFF25\u2026") + "\"}",
                "{\"text\":\"cafe - l'ete...\"}"),
            Case(
                "normalize/steps compose: E-acute is lowercased and then folded",
                Protocol.CapNormalize,
                "{\"text\":\"" + Utf8("L'\u00C9T\u00C9 \u00C9") + "\"}",
                "{\"text\":\"l'ete e\"}"),
            Case(
                "normalize/mapping before lowercasing: a full-width capital is lowered after the map",
                Protocol.CapNormalize,
                "{\"text\":\"" + Utf8("\uFF21\uFF22\uFF23") + "\"}",
                "{\"text\":\"abc\"}"),
            Case(
                "normalize/decomposed equals composed: combining marks are deleted",
                Protocol.CapNormalize,
                "{\"text\":\"e\u0301 caf\u00E9\"}",
                "{\"text\":\"e cafe\"}"),
            Case(
                "normalize/zero-width and BOM are deleted, tab and newlines collapse",
                Protocol.CapNormalize,
                "{\"text\":\"" + Utf8("a\u200Bb\uFEFF\tc\n\nd") + "\"}",
                "{\"text\":\"ab c d\"}"),
            Case(
                "normalize/C0 controls and DEL are deleted",
                Protocol.CapNormalize,
                "{\"text\":\"" + Utf8("a\u0001b\u0007c\u001Fd\u007Fe") + "\"}",
                "{\"text\":\"abcde\"}"),
            Case(
                "normalize/only whitespace trims to the empty string",
                Protocol.CapNormalize,
                "{\"text\":\"" + Utf8("   \t\n ") + "\"}",
                "{\"text\":\"\"}"),
            Case(
                "normalize/whitespace is the contract's four characters, not String.Trim()",
                Protocol.CapNormalize,
                "{\"text\":\"" + Utf8("\u2007a\u2007 b\u0085c") + "\"}",
                "{\"text\":\"" + Utf8("a b\u0085c") + "\"}"),
            Case(
                "normalize/U+0130 is absent from the lower table and folds to i",
                Protocol.CapNormalize,
                "{\"text\":\"I\u0130\u0131i\"}",
                "{\"text\":\"iiii\"}"),
            Case(
                "normalize/culture trap: ASCII capital I reads the same under tr-TR",
                Protocol.CapNormalize,
                "{\"text\":\"Istanbul\"}",
                "{\"text\":\"istanbul\"}",
                culture: "tr-TR"),
            Case(
                "normalize/culture trap: sharp s folds to ss under de-DE, never to the capital form",
                Protocol.CapNormalize,
                "{\"text\":\"" + Utf8("STRA\u00DFE") + "\"}",
                "{\"text\":\"strasse\"}",
                culture: "de-DE"),
            Case(
                "normalize/fold output is not re-entered: a two-character fold is idempotent",
                Protocol.CapNormalize,
                "{\"text\":\"" + Utf8("\u00DF \u00C6 \u00D8 \u00DE") + "\"}",
                "{\"text\":\"ss ae o th\"}"),
            Case(
                "normalize/astral emoji survive: a surrogate pair is one code point, not two units",
                Protocol.CapNormalize,
                "{\"text\":\"" + emoji + "\"}",
                "{\"text\":\"" + emoji + "\"}"),
            Case(
                "normalize/astral code points are outside both tables and pass through",
                Protocol.CapNormalize,
                "{\"text\":\"" + astral + " A\"}",
                "{\"text\":\"" + astral + " a\"}"),
            Case(
                "normalize/Han, kana and Cyrillic pass through unchanged",
                Protocol.CapNormalize,
                "{\"text\":\"" + Utf8("\u5DF2\u7ECF\u5F00\u64AD \u30C6\u30B9\u30C8 \u041F\u0440\u0438\u0432\u0435\u0442") + "\"}",
                "{\"text\":\"" + Utf8("\u5DF2\u7ECF\u5F00\u64AD \u30C6\u30B9\u30C8 \u041F\u0440\u0438\u0432\u0435\u0442") + "\"}"),
            Case(
                "normalize/typographic quotes, dashes and CJK punctuation map one to one",
                Protocol.CapNormalize,
                "{\"text\":\"" + Utf8("\u2018a\u2019 \u201Cb\u201D \u2014 \u3001 \u3002 a\u3001b") + "\"}",
                "{\"text\":\"'a' \\\"b\\\" - , . a,b\"}"),

            Case(
                "extract/empty input yields the empty document",
                Protocol.CapExtract,
                "{\"html\":\"\",\"baseUrl\":null}",
                "{\"title\":\"\",\"text\":\"\",\"links\":[],\"images\":0}"),
            Case(
                "extract/a removed element goes with its content and contributes no newline",
                Protocol.CapExtract,
                "{\"html\":\"<p>x</p><script>var a=1;</script>\",\"baseUrl\":null}",
                "{\"title\":\"\",\"text\":\"\\nx\\n\",\"links\":[],\"images\":0}"),
            Case(
                "extract/newline is emitted for both tags of the block list",
                Protocol.CapExtract,
                "{\"html\":\"<p>a</p><div>b</div>\",\"baseUrl\":null}",
                "{\"title\":\"\",\"text\":\"\\na\\n\\nb\\n\",\"links\":[],\"images\":0}"),
            Case(
                "extract/entities decode with and without a semicolon, and never backtrack",
                Protocol.CapExtract,
                "{\"html\":\"a &amp b &amp; &copy2024 &#65 &#x42;\",\"baseUrl\":null}",
                "{\"title\":\"\",\"text\":\"a & b & &copy2024 A B\",\"links\":[],\"images\":0}"),
            Case(
                "extract/a numeric reference keeps its own character (U+2014, not a dash)",
                Protocol.CapExtract,
                "{\"html\":\"a &#x2014; b &mdash;\",\"baseUrl\":null}",
                "{\"title\":\"\",\"text\":\"" + Utf8("a \u2014 b \u2014") + "\",\"links\":[],\"images\":0}"),
            Case(
                "extract/an unclosed tag at the end of input is dropped with its name",
                Protocol.CapExtract,
                "{\"html\":\"abc<p\",\"baseUrl\":null}",
                "{\"title\":\"\",\"text\":\"abc\",\"links\":[],\"images\":0}"),
            Case(
                "extract/a lone < at the end of input is literal text",
                Protocol.CapExtract,
                "{\"html\":\"a<\",\"baseUrl\":null}",
                "{\"title\":\"\",\"text\":\"a<\",\"links\":[],\"images\":0}"),
            Case(
                "extract/a > inside a quoted attribute does not end the tag",
                Protocol.CapExtract,
                "{\"html\":\"<a href=\\\"x>y\\\">z</a>\",\"baseUrl\":null}",
                "{\"title\":\"\",\"text\":\"z\",\"links\":[{\"href\":\"x>y\",\"absolute\":false,\"text\":\"z\"}],\"images\":0}"),
            Case(
                "extract/nested anchors are both reported, the outer with the text it collected",
                Protocol.CapExtract,
                "{\"html\":\"<a href=\\\"/one\\\">one<a href=\\\"/two\\\">two</a>\",\"baseUrl\":null}",
                "{\"title\":\"\",\"text\":\"onetwo\",\"links\":[{\"href\":\"/one\",\"absolute\":false,\"text\":\"one\"},"
                    + "{\"href\":\"/two\",\"absolute\":false,\"text\":\"two\"}],\"images\":0}"),
            Case(
                "extract/unclosed anchors at the end of input are still reported",
                Protocol.CapExtract,
                "{\"html\":\"<a href=\\\"/x\\\">text\",\"baseUrl\":null}",
                "{\"title\":\"\",\"text\":\"text\",\"links\":[{\"href\":\"/x\",\"absolute\":false,\"text\":\"text\"}],\"images\":0}"),
            Case(
                "extract/CDATA is character data: its tags are not re-parsed",
                Protocol.CapExtract,
                "{\"html\":\"<![CDATA[<b>x</b>]]>\",\"baseUrl\":null}",
                "{\"title\":\"\",\"text\":\"<b>x</b>\",\"links\":[],\"images\":0}"),
            Case(
                "extract/removal wins over CDATA: a CDATA body inside a real script element goes with it",
                Protocol.CapExtract,
                "{\"html\":\"<script><![CDATA[gone]]></script>keep\",\"baseUrl\":null}",
                "{\"title\":\"\",\"text\":\"keep\",\"links\":[],\"images\":0}"),
            Case(
                "extract/a script inside a CDATA body is text and survives the removal pass",
                Protocol.CapExtract,
                "{\"html\":\"<![CDATA[<script>x</script>]]>\",\"baseUrl\":null}",
                "{\"title\":\"\",\"text\":\"<script>x</script>\",\"links\":[],\"images\":0}"),
            Case(
                "extract/the title's text is not part of the body text",
                Protocol.CapExtract,
                "{\"html\":\"<title>A &amp; B</title><p>x</p>\",\"baseUrl\":null}",
                "{\"title\":\"A & B\",\"text\":\"\\nx\\n\",\"links\":[],\"images\":0}"),
            Case(
                "extract/images counts img tags and ignores a commented-out one",
                Protocol.CapExtract,
                "{\"html\":\"<img src=a><!-- <img src=b> --><IMG src=c>\",\"baseUrl\":null}",
                "{\"title\":\"\",\"text\":\"\",\"links\":[],\"images\":2}"),
            Case(
                "extract/an href is verbatim and absoluteness is the scheme test alone",
                Protocol.CapExtract,
                "{\"html\":\"<a href=\\\"//cdn.example/x\\\">r</a><a href=\\\"mailto:a@b\\\">m</a>\",\"baseUrl\":null}",
                "{\"title\":\"\",\"text\":\"rm\",\"links\":[{\"href\":\"//cdn.example/x\",\"absolute\":false,\"text\":\"r\"},"
                    + "{\"href\":\"mailto:a@b\",\"absolute\":true,\"text\":\"m\"}],\"images\":0}"),
            Case(
                "extract/an anchor without href still produces an entry with an empty href",
                Protocol.CapExtract,
                "{\"html\":\"<a name=\\\"x\\\">text</a>\",\"baseUrl\":null}",
                "{\"title\":\"\",\"text\":\"text\",\"links\":[{\"href\":\"\",\"absolute\":false,\"text\":\"text\"}],\"images\":0}"),
            Case(
                "extract/astral text in the body survives extraction byte for byte",
                Protocol.CapExtract,
                "{\"html\":\"<p>" + emoji + "</p>\",\"baseUrl\":null}",
                "{\"title\":\"\",\"text\":\"\\n" + emoji + "\\n\",\"links\":[],\"images\":0}"),

            Case("fingerprint/a single token is the single shingle and hashes alone", Protocol.CapFingerprint, "{\"text\":\"x\"}", SimhashCase(new[] { "x" })),
            Case("fingerprint/empty text has no tokens and no shingles", Protocol.CapFingerprint, "{\"text\":\"\"}", SimhashCase(Array.Empty<string>())),
            Case("fingerprint/punctuation-only tokens emit nothing", Protocol.CapFingerprint, "{\"text\":\"-- !! ???\"}", SimhashCase(Array.Empty<string>())),
            Case("fingerprint/a CJK run of two emits one bigram", Protocol.CapFingerprint, "{\"text\":\"" + Utf8("\u5DF2\u7ECF") + "\"}", SimhashCase(new[] { "\u5DF2\u7ECF" })),
            Case("fingerprint/a CJK run of three emits two overlapping bigrams", Protocol.CapFingerprint, "{\"text\":\"" + Utf8("\u5DF2\u7ECF\u5F00") + "\"}", SimhashCase(new[] { "\u5DF2\u7ECF", "\u7ECF\u5F00" })),
            Case("fingerprint/a CJK run of four emits three bigrams", Protocol.CapFingerprint, "{\"text\":\"" + Utf8("\u5DF2\u7ECF\u5F00\u64AD") + "\"}", SimhashCase(new[] { "\u5DF2\u7ECF", "\u7ECF\u5F00", "\u5F00\u64AD" })),
            Case(
                "fingerprint/culture trap: the fingerprint of ASCII text does not move under tr-TR",
                Protocol.CapFingerprint,
                "{\"text\":\"Istanbul I\"}",
                SimhashCase(new[] { "Istanbul", "I" }),
                culture: "tr-TR"),
            Case(
                "fingerprint/a surrogate pair stays inside one run",
                Protocol.CapFingerprint,
                "{\"text\":\"" + emoji + "\"}",
                SimhashCase(new[] { "cat", "\U0001F600", "tail", "\U0001F1EF\U0001F1F5" })),
            Case(
                "fingerprint/edge punctuation is stripped before the run rule",
                Protocol.CapFingerprint,
                "{\"text\":\"hello, world.\"}",
                SimhashCase(new[] { "hello", "world" })),
        };
    }

    private static CheckCase Case(string name, string capability, string input, string expect, string? culture = null)
    {
        return new CheckCase
        {
            Name = name,
            Capability = capability,
            Input = input,
            Expect = expect,
            Culture = culture,
        };
    }

    /// <summary>
    /// Builds the expected fingerprint output for a known token list, using the independent
    /// BigInteger implementation below rather than the code under test. The shingles are formed by the
    /// same rule the contract states, which is the part of this expectation that is not independent -
    /// a case that gets the shingle rule wrong would agree with a worker that got it wrong the same
    /// way, which is exactly what the cross-implementation diff is for.
    /// </summary>
    private static string SimhashCase(string[] tokens)
    {
        var shingles = new List<string>();
        if (tokens.Length == 1 || tokens.Length == 2)
        {
            shingles.Add(string.Join(' ', tokens));
        }
        else if (tokens.Length >= 3)
        {
            for (int i = 0; i + 3 <= tokens.Length; i++)
            {
                shingles.Add(tokens[i] + " " + tokens[i + 1] + " " + tokens[i + 2]);
            }
        }

        var counters = new int[64];
        foreach (string shingle in shingles)
        {
            BigInteger hash = Fnv1a64BigInteger(shingle);
            for (int bit = 0; bit < 64; bit++)
            {
                counters[bit] += ((hash >> bit) & BigInteger.One) == BigInteger.One ? 1 : -1;
            }
        }

        ulong value = 0;
        for (int bit = 0; bit < 64; bit++)
        {
            if (counters[bit] > 0)
            {
                value |= 1UL << bit;
            }
        }

        return "{\"simhash\":\"" + Hex16(value) + "\",\"tokens\":" + Invariant(tokens.Length)
            + ",\"shingles\":" + Invariant(shingles.Count) + "}";
    }

    /// <summary>
    /// FNV-1a 64-bit in BigInteger, the way the contract writes it: an offset basis and a multiply
    /// that is explicitly taken modulo 2^64. Deliberately NOT the worker's ulong loop, so the two
    /// agree only if both are the contract's algorithm.
    /// </summary>
    private static BigInteger Fnv1a64BigInteger(string text)
    {
        BigInteger mask = BigInteger.Pow(2, 64) - 1;
        BigInteger hash = BigInteger.Parse("14695981039346656037", CultureInfo.InvariantCulture);
        BigInteger prime = BigInteger.Parse("1099511628211", CultureInfo.InvariantCulture);
        byte[] bytes = Encoding.UTF8.GetBytes(text);
        foreach (byte b in bytes)
        {
            hash ^= b;
            hash = (hash * prime) & mask;
        }

        return hash;
    }

    private static string Hex16(ulong value)
    {
        const string digits = "0123456789abcdef";
        var buffer = new char[16];
        for (int i = 15; i >= 0; i--)
        {
            buffer[i] = digits[(int)(value & 0xF)];
            value >>= 4;
        }

        return new string(buffer);
    }

    private static string Invariant(long value)
    {
        return value.ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// Escapes the characters that must not appear literally in a JSON input string built in this
    /// source file, so a case can name a control character or a quote without the C# literal having
    /// to carry it.
    /// </summary>
    private static string Utf8(string text)
    {
        var builder = new StringBuilder(text.Length);
        foreach (char c in text)
        {
            switch (c)
            {
                case '"':
                    builder.Append("\\\"");
                    break;
                case '\\':
                    builder.Append("\\\\");
                    break;
                case '\t':
                    builder.Append("\\t");
                    break;
                case '\n':
                    builder.Append("\\n");
                    break;
                case '\r':
                    builder.Append("\\r");
                    break;
                default:
                    if (c < 0x20)
                    {
                        builder.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        builder.Append(c);
                    }

                    break;
            }
        }

        return builder.ToString();
    }

    private static void WriteLine(Stream stream, string text)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(text + "\n");
        stream.Write(bytes, 0, bytes.Length);
        stream.Flush();
    }
}
