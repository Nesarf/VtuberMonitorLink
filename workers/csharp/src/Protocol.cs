// Protocol.cs - docs/WORKERS.md section 1: JSON Lines over stdio, one JSON object per line, UTF-8,
// LF, no BOM. stdout carries protocol lines and nothing else; every diagnostic is English on stderr.
//
// The four response shapes are the contract's four, and no response carries a field the contract
// does not show for it:
//
//   describe  {"id":<id>,"ok":true,"worker":{"protocol":1,"capability":"...","language":"csharp",
//                                          "impl":"table-driven","runtime":".NET x.y.z",
//                                          "deterministic":true}}
//   invoke ok {"id":<id>,"ok":true,"output":{...}}       (output order per capability, below)
//   error     {"id":<id>,"ok":false,"error":{"code":"bad-input","message":"..."}}
//   shutdown  {"id":<id>,"ok":true}                      and nothing else, then the worker exits
//
// The shutdown shape is written down here because it is the one the contract had to add after the
// fact: two implementations carried an extra "output" payload from an earlier draft of the
// reference, nothing diffs a shutdown line, and the disagreement survived four implementations.
//
// Capability output orders (the order docs/WORKERS.md lists the fields in):
//
//   text.normalize    {"text":...}
//   text.extract      {"title":...,"text":...,"links":[{"href":...,"absolute":...,"text":...}],
//                      "images":N}
//   text.fingerprint  {"simhash":"...","tokens":N,"shingles":N}
//
// Requests are parsed twice on purpose, and the two parses answer different questions:
//
//   * JsonDocument validates the line and gives typed access to `op`, `capability` and `input`. It is
//     configured to REJECT comments and trailing commas: the contract's transport is JSON, and a
//     lenient parser would turn a malformed request into a plausible-looking answer. Member lookup is
//     case-sensitive (TryGetProperty is ordinal), so `{"Text":"x"}` is a missing field rather than an
//     answer.
//
//   * A small byte scanner finds the exact slice of the raw line that holds the `id` value, which is
//     then echoed verbatim. Echoing a re-serialised id would be a place for this worker to differ
//     from the other implementations for no reason: "id is echoed unchanged" means the bytes that
//     arrived, whatever they were (a string, a number, an object).

using System;
using System.Collections.Generic;
using System.Text;
using System.Text.Json;

namespace Vml;

internal sealed class Protocol
{
    public const string Language = "csharp";
    public const string Impl = "table-driven";
    public const int ProtocolVersion = 1;

    public const string CapNormalize = "text.normalize";
    public const string CapExtract = "text.extract";
    public const string CapFingerprint = "text.fingerprint";

    private static readonly string[] Capabilities = { CapNormalize, CapExtract, CapFingerprint };

    private static readonly byte[] NullToken = Encoding.UTF8.GetBytes("null");

    private readonly SpecTables _tables;
    private readonly string _runtime;

    public Protocol(SpecTables tables, string runtime)
    {
        _tables = tables;
        _runtime = runtime;
    }

    public static bool IsKnownCapability(string name)
    {
        return name == CapNormalize || name == CapExtract || name == CapFingerprint;
    }

    public static string CapabilityList()
    {
        return string.Join(", ", Capabilities);
    }

    /// <summary>The runtime actually executing, formatted in the invariant culture.</summary>
    public static string RuntimeString()
    {
        return ".NET " + Environment.Version.ToString(3);
    }

    // ----------------------------------------------------------------------------------------
    // One request line
    // ----------------------------------------------------------------------------------------

    /// <summary>
    /// Parses one line. Returns null when the line is not a JSON object, which is the one case the
    /// caller answers with id null. An `op` that is missing or not a string is not a parse failure
    /// here: the line is a request only after the caller has decided, so the shape carries what was
    /// found and the caller answers accordingly.
    /// </summary>
    public static RequestShape? ParseLine(byte[] line, out string? failure)
    {
        failure = null;
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(line, new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 64,
            });
        }
        catch (JsonException error)
        {
            failure = "request is not a JSON object: " + error.Message;
            return null;
        }

        using (document)
        {
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                failure = "request must be a JSON object";
                return null;
            }

            bool hasOp = root.TryGetProperty("op", out JsonElement opElement) && opElement.ValueKind == JsonValueKind.String;
            string op = hasOp ? opElement.GetString() ?? string.Empty : string.Empty;

            string? input = null;
            if (root.TryGetProperty("input", out JsonElement inputElement))
            {
                input = inputElement.GetRawText();
            }

            bool hasCapability = root.TryGetProperty("capability", out JsonElement capabilityElement)
                && capabilityElement.ValueKind == JsonValueKind.String;
            string requested = hasCapability ? capabilityElement.GetString() ?? string.Empty : string.Empty;

            byte[] idToken = FindRawMemberValue(line, "id") ?? NullToken;
            return new RequestShape(hasOp, op, hasCapability, requested, idToken, input);
        }
    }

    /// <summary>The request fields this worker uses, with the id already sliced from the raw line.</summary>
    public readonly record struct RequestShape(
        bool HasOp,
        string Op,
        bool HasCapability,
        string RequestedCapability,
        byte[] IdToken,
        string? Input);

    /// <summary>
    /// Finds the raw bytes of a top-level member's value, or null when the member is absent or the
    /// line is malformed. The scan is byte-wise and tracks string state and nesting, because a JSON
    /// object in the value would otherwise end the slice at its first brace.
    /// </summary>
    private static byte[]? FindRawMemberValue(byte[] line, string member)
    {
        byte[] name = Encoding.UTF8.GetBytes("\"" + member + "\"");
        int i = 0;
        while (i < line.Length && IsJsonWhitespace(line[i]))
        {
            i++;
        }

        if (i >= line.Length || line[i] != (byte)'{')
        {
            return null;
        }

        i++;
        while (i < line.Length)
        {
            while (i < line.Length && (IsJsonWhitespace(line[i]) || line[i] == (byte)','))
            {
                i++;
            }

            if (i >= line.Length || line[i] == (byte)'}')
            {
                return null;
            }

            if (line[i] != (byte)'"')
            {
                return null;
            }

            int nameStart = i;
            if (!ScanString(line, ref i))
            {
                return null;
            }

            bool isWanted = i - nameStart == name.Length;
            if (isWanted)
            {
                for (int k = 0; k < name.Length; k++)
                {
                    if (line[nameStart + k] != name[k])
                    {
                        isWanted = false;
                        break;
                    }
                }
            }

            while (i < line.Length && IsJsonWhitespace(line[i]))
            {
                i++;
            }

            if (i >= line.Length || line[i] != (byte)':')
            {
                return null;
            }

            i++;
            while (i < line.Length && IsJsonWhitespace(line[i]))
            {
                i++;
            }

            int valueStart = i;
            if (!SkipJsonValue(line, ref i))
            {
                return null;
            }

            if (isWanted)
            {
                byte[] slice = new byte[i - valueStart];
                Array.Copy(line, valueStart, slice, 0, slice.Length);
                return slice;
            }
        }

        return null;
    }

    /// <summary>Skips a complete JSON string, leaving i just past the closing quote.</summary>
    private static bool ScanString(byte[] line, ref int i)
    {
        if (i >= line.Length || line[i] != (byte)'"')
        {
            return false;
        }

        i++;
        while (i < line.Length)
        {
            byte b = line[i];
            if (b == (byte)'\\')
            {
                i += 2;
                continue;
            }

            if (b == (byte)'"')
            {
                i++;
                return true;
            }

            i++;
        }

        return false;
    }

    /// <summary>Skips any JSON value, leaving i just past its last byte.</summary>
    private static bool SkipJsonValue(byte[] line, ref int i)
    {
        if (i >= line.Length)
        {
            return false;
        }

        int depth = 0;
        while (i < line.Length)
        {
            byte b = line[i];
            if (b == (byte)'"' )
            {
                if (!ScanString(line, ref i))
                {
                    return false;
                }

                continue;
            }

            if (b == (byte)'{' || b == (byte)'[')
            {
                depth++;
                i++;
                continue;
            }

            if (b == (byte)'}' || b == (byte)']')
            {
                if (depth == 0)
                {
                    return true; // the enclosing object's brace: this value has ended
                }

                depth--;
                i++;
                if (depth == 0)
                {
                    return true;
                }

                continue;
            }

            if (depth == 0 && (b == (byte)',' || IsJsonWhitespace(b)))
            {
                return true;
            }

            i++;
        }

        return depth == 0;
    }

    private static bool IsJsonWhitespace(byte b)
    {
        return b == (byte)' ' || b == (byte)'\t' || b == (byte)'\n' || b == (byte)'\r';
    }

    // ----------------------------------------------------------------------------------------
    // Responses
    // ----------------------------------------------------------------------------------------

    public void WriteDescribe(JsonOut writer, ReadOnlySpan<byte> id, string capability)
    {
        writer.Reset();
        writer.BeginObject();
        writer.Key("id");
        writer.Token(id);
        writer.Comma();
        writer.KeyValue("ok", true);
        writer.Comma();
        writer.Key("worker");
        writer.BeginObject();
        writer.KeyValue("protocol", ProtocolVersion);
        writer.Comma();
        writer.KeyValue("capability", capability);
        writer.Comma();
        writer.KeyValue("language", Language);
        writer.Comma();
        writer.KeyValue("impl", Impl);
        writer.Comma();
        writer.KeyValue("runtime", _runtime);
        writer.Comma();
        writer.KeyValue("deterministic", true);
        writer.EndObject();
        writer.EndObject();
    }

    public static void WriteShutdownAck(JsonOut writer, ReadOnlySpan<byte> id)
    {
        writer.Reset();
        writer.BeginObject();
        writer.Key("id");
        writer.Token(id);
        writer.Comma();
        writer.KeyValue("ok", true);
        writer.EndObject();
    }

    public static void WriteError(JsonOut writer, ReadOnlySpan<byte> id, string code, string message)
    {
        writer.Reset();
        writer.BeginObject();
        writer.Key("id");
        writer.Token(id);
        writer.Comma();
        writer.KeyValue("ok", false);
        writer.Comma();
        writer.Key("error");
        writer.BeginObject();
        writer.KeyValue("code", code);
        writer.Comma();
        writer.KeyValue("message", message);
        writer.EndObject();
        writer.EndObject();
    }

    public static void WriteNullIdError(JsonOut writer, string code, string message)
    {
        WriteError(writer, NullToken, code, message);
    }

    // ----------------------------------------------------------------------------------------
    // Capabilities
    // ----------------------------------------------------------------------------------------

    /// <summary>
    /// Runs one invoke and writes the response. A malformed input is a normal answer (bad-input); an
    /// unexpected exception is reported as internal rather than killing the worker, so one bad case
    /// cannot take down a whole corpus run.
    ///
    /// The invoke's own `capability` is checked against the one this process was launched with. The
    /// contract: "A worker that is asked to invoke a capability other than the one it was started
    /// with answers unsupported and stays alive: the host launches one worker per capability, so the
    /// field is only there to catch a wiring mistake, and answering it is cheaper to debug than
    /// ignoring it." Ignoring it is worse than it sounds - this worker was launched for
    /// `text.normalize`, so an `invoke` naming `text.extract` would run the NORMALIZER over an input
    /// that has no `text` field and answer `bad-input`, which reads as a corpus problem rather than
    /// as the mis-wiring it is.
    /// </summary>
    public void WriteInvoke(
        JsonOut writer,
        ReadOnlySpan<byte> id,
        string capability,
        bool hasRequestedCapability,
        string requestedCapability,
        string? input)
    {
        if (hasRequestedCapability && !string.Equals(requestedCapability, capability, StringComparison.Ordinal))
        {
            WriteError(writer, id, "unsupported", "this worker implements " + capability + ", not " + requestedCapability);
            return;
        }

        if (input == null)
        {
            WriteError(writer, id, "bad-input", "invoke.input must be an object");
            return;
        }

        try
        {
            using var document = JsonDocument.Parse(input, new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 64,
            });

            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                WriteError(writer, id, "bad-input", "invoke.input must be an object");
                return;
            }

            byte[] output = BuildOutput(capability, root);
            writer.Reset();
            writer.BeginObject();
            writer.Key("id");
            writer.Token(id);
            writer.Comma();
            writer.KeyValue("ok", true);
            writer.Comma();
            writer.Key("output");
            writer.Raw(output);
            writer.EndObject();
        }
        catch (BadInputException error)
        {
            WriteError(writer, id, "bad-input", error.Message);
        }
        catch (JsonException error)
        {
            WriteError(writer, id, "bad-input", "input is not a JSON object: " + error.Message);
        }
        catch (Exception error) when (error is InvalidOperationException or ArgumentException or FormatException or OverflowException)
        {
            WriteError(writer, id, "internal", error.GetType().Name + ": " + error.Message);
        }
    }

    /// <summary>
    /// Builds the output object for one capability, in the contract's field order, into a fresh
    /// writer (so the envelope can be assembled around it).
    /// </summary>
    public byte[] BuildOutput(string capability, JsonElement root)
    {
        var writer = new JsonOut();
        switch (capability)
        {
            case CapNormalize:
                {
                    string text = RequireString(root, "text");
                    writer.BeginObject();
                    writer.KeyValue("text", Normalize.Apply(text, _tables));
                    writer.EndObject();
                    return writer.ToBytes();
                }

            case CapExtract:
                {
                    string html = RequireString(root, "html");
                    RequireOptionalStringOrNull(root, "baseUrl");
                    ExtractResult result = Extract.Apply(html, null);
                    writer.BeginObject();
                    writer.KeyValue("title", result.Title);
                    writer.Comma();
                    writer.KeyValue("text", result.Text);
                    writer.Comma();
                    writer.Key("links");
                    writer.BeginArray();
                    for (int i = 0; i < result.Links.Count; i++)
                    {
                        if (i > 0)
                        {
                            writer.Comma();
                        }

                        LinkEntry link = result.Links[i];
                        writer.BeginObject();
                        writer.KeyValue("href", link.Href);
                        writer.Comma();
                        writer.KeyValue("absolute", link.Absolute);
                        writer.Comma();
                        writer.KeyValue("text", link.Text);
                        writer.EndObject();
                    }

                    writer.EndArray();
                    writer.Comma();
                    writer.KeyValue("images", result.Images);
                    writer.EndObject();
                    return writer.ToBytes();
                }

            case CapFingerprint:
                {
                    string text = RequireString(root, "text");
                    FingerprintResult result = Fingerprint.Apply(text);
                    writer.BeginObject();
                    writer.KeyValue("simhash", result.Simhash);
                    writer.Comma();
                    writer.KeyValue("tokens", result.Tokens);
                    writer.Comma();
                    writer.KeyValue("shingles", result.Shingles);
                    writer.EndObject();
                    return writer.ToBytes();
                }

            default:
                throw new BadInputException("this worker does not implement " + capability);
        }
    }

    private static string RequireString(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out JsonElement value) || value.ValueKind != JsonValueKind.String)
        {
            throw new BadInputException("input." + name + " must be a string");
        }

        return value.GetString() ?? string.Empty;
    }

    private static void RequireOptionalStringOrNull(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out JsonElement value))
        {
            return;
        }

        if (value.ValueKind != JsonValueKind.String && value.ValueKind != JsonValueKind.Null)
        {
            throw new BadInputException("input." + name + " must be a string or null");
        }
    }
}

/// <summary>A bad request: the answer is ok:false with code "bad-input".</summary>
internal sealed class BadInputException : Exception
{
    public BadInputException(string message)
        : base(message)
    {
    }
}
