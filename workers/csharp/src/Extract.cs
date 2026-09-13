// Extract.cs - docs/WORKERS.md section 3, capability text.extract.
//
// A specified state machine, not "whatever the runtime's HTML parser does". .NET does ship an HTML
// parser these days (System.Net.Http.HtmlAgilityPack is a package, and Windows has mshtml through
// COM), and using any of them would be the bug: the contract's rules are about a hand-written scanner
// - where a `<` starts a tag, where an unclosed tag ends, which anchors are reported, how entities
// decode - and a browser engine answers all of those differently.
//
// The pass order is the contract's, which is not the numbering of its rules: hide every CDATA body
// first, then remove comments and doctypes, then remove the listed elements with their content, and
// only then walk what is left. That order is why `cdata-inside-removed-element` works out: the CDATA
// body is out of the way while `<script>` is removed, so a real script element still goes, while a
// `<script>` *inside* a CDATA body is character data and survives. The Go implementation removed
// elements first and got the case wrong, which is why the contract spells the order out.
//
// Two more .NET-specific notes:
//
//   * Walking is by UTF-16 code unit, never by "character". Everything the scanner classifies is
//     ASCII (tag names, quotes, delimiters, the punctuation of the entity forms), and the only
//     non-ASCII the scanner copies is copied verbatim, one unit at a time, which reassembles a
//     surrogate pair exactly as it arrived. Nothing here calls char.ConvertFromUtf32 on a raw unit.
//
//   * No culture reaches the output. Tag names are lowercased with ToLowerInvariant (they are ASCII
//     by construction, so the culture cannot matter - but the invariant overload says so), the
//     lower-name comparisons are explicit ASCII folds, and the entity names are matched with an
//     ordinary ASCII comparison rather than a culture-aware or case-insensitive string comparison.

using System;
using System.Collections.Generic;
using System.Text;

namespace Vml;

internal sealed class LinkEntry
{
    public string Href { get; init; } = string.Empty;

    public bool Absolute { get; init; }

    public string Text { get; init; } = string.Empty;
}

internal sealed class ExtractResult
{
    public string Title { get; init; } = string.Empty;

    public string Text { get; init; } = string.Empty;

    public List<LinkEntry> Links { get; init; } = new();

    public int Images { get; init; }
}

internal static class Extract
{
    /// <summary>Step 1, matched case-insensitively: removed with their content.</summary>
    private static readonly string[] RemovedWithContentTags = { "script", "style", "noscript", "template", "svg", "iframe" };

    /// <summary>Step 3: exactly this list becomes a newline on both its opening and its closing tag.</summary>
    private static readonly HashSet<string> BlockNewlineTags = new(StringComparer.Ordinal)
    {
        "br", "p", "div", "li", "ul", "ol", "tr", "th", "td", "h1", "h2", "h3", "h4", "h5", "h6",
        "section", "article", "header", "footer", "aside", "nav", "blockquote", "pre", "table", "hr",
        "dd", "dt", "figure", "figcaption", "main", "form",
    };

    /// <summary>The contract's named entities: each decodes to its own character, never to ASCII.</summary>
    private static readonly List<KeyValuePair<string, string>> NamedEntities = new()
    {
        // Longest name first, so "&laquo;" is never read as "&laq". The list is walked in this fixed
        // order; no map is iterated and no map decides which name wins.
        new("middot", "\u00B7"),
        new("hellip", "\u2026"),
        new("mdash", "\u2014"),
        new("ndash", "\u2013"),
        new("times", "\u00D7"),
        new("trade", "\u2122"),
        new("laquo", "\u00AB"),
        new("raquo", "\u00BB"),
        new("nbsp", "\u00A0"),
        new("copy", "\u00A9"),
        new("quot", "\""),
        new("apos", "'"),
        new("amp", "&"),
        new("reg", "\u00AE"),
        new("lt", "<"),
        new("gt", ">"),
    };

    /// <summary>
    /// How far past the '&' a reference may end. The contract's longest form is "&#xHHHHHH;" or an
    /// eight-character name plus its semicolon, so 12 characters cover the whole closed set and pin
    /// the no-backtracking rule that keeps "&copy2024" literal.
    /// </summary>
    private const int EntityWindow = 12;

    /// <summary>
    /// The sentinel a lifted CDATA body leaves behind. U+0001 cannot occur in markup meaningfully,
    /// cannot be produced by any other pass, and is a code point the normalizer deletes - so a
    /// placeholder that somehow escaped could not reach a caller as convincing garbage.
    /// </summary>
    private const char CdataMarker = '\u0001';

    private const string CdataOpen = "<![CDATA[";
    private const string CdataClose = "]]>";

    public static ExtractResult Apply(string html, string? baseUrl)
    {
        // baseUrl is accepted and deliberately unused: contract step 4 keeps hrefs verbatim and says
        // resolving URLs is out of scope for a text function. Naming it here is the point - the field
        // is validated by the protocol layer and then does nothing.
        _ = baseUrl;

        string source = LiftCdata(html, out List<string> cdataBodies);
        source = StripComments(source);
        source = StripDoctype(source);
        foreach (string tag in RemovedWithContentTags)
        {
            source = RemoveElement(source, tag);
        }

        return Walk(source, cdataBodies);
    }

    // ----------------------------------------------------------------------------------------
    // Passes 1 and 2: CDATA, comments, doctypes, removed elements
    // ----------------------------------------------------------------------------------------

    /// <summary>
    /// The first pass: every CDATA body is lifted out and replaced by a one-character sentinel.
    /// CDATA is character data - `<![CDATA[<b>raw</b>]]>` keeps its tags - and lifting it before the
    /// comment and removed-element passes is what makes both halves of the rule come out right.
    /// An unclosed section keeps everything to the end of the input, like a removed element with no
    /// closing tag.
    /// </summary>
    private static string LiftCdata(string source, out List<string> bodies)
    {
        bodies = new List<string>();
        if (source.IndexOf(CdataOpen, StringComparison.Ordinal) < 0)
        {
            return source;
        }

        var output = new StringBuilder(source.Length);
        int i = 0;
        while (i < source.Length)
        {
            if (!HasPrefixOrdinal(source, i, CdataOpen))
            {
                output.Append(source[i]);
                i++;
                continue;
            }

            int inner = i + CdataOpen.Length;
            int end = source.IndexOf(CdataClose, inner, StringComparison.Ordinal);
            string body;
            if (end < 0)
            {
                body = source[inner..];
                i = source.Length;
            }
            else
            {
                body = source[inner..end];
                i = end + CdataClose.Length;
            }

            output.Append(CdataMarker);
            bodies.Add(body);
        }

        return output.ToString();
    }

    private static string StripComments(string source)
    {
        while (true)
        {
            int start = source.IndexOf("<!--", StringComparison.Ordinal);
            if (start < 0)
            {
                return source;
            }

            int end = source.IndexOf("-->", start + 4, StringComparison.Ordinal);
            if (end < 0)
            {
                return source[..start]; // an unterminated comment runs to the end of the input
            }

            source = source[..start] + source[(end + 3)..];
        }
    }

    private static string StripDoctype(string source)
    {
        int i = 0;
        while (i < source.Length)
        {
            if (source[i] == '<' && HasPrefixFold(source, i, "<!doctype"))
            {
                int end = source.IndexOf('>', i);
                if (end >= 0)
                {
                    source = source[..i] + source[(end + 1)..];
                }
                else
                {
                    source = source[..i]; // no '>': removed to the end of the input
                }

                continue;
            }

            i++;
        }

        return source;
    }

    /// <summary>
    /// Removes every `<tag ...> ... </tag>` occurrence with its content. A missing closing tag means
    /// "to the end of input". The name must end at a word boundary, so `&lt;scripted&gt;` is not a
    /// script element.
    /// </summary>
    private static string RemoveElement(string source, string tag)
    {
        string open = "<" + tag;
        var output = new StringBuilder(source.Length);
        int i = 0;
        while (i < source.Length)
        {
            if (source[i] != '<' || !HasPrefixFold(source, i, open))
            {
                output.Append(source[i]);
                i++;
                continue;
            }

            int boundary = i + open.Length;
            if (boundary < source.Length && IsNameCharacter(source[boundary]))
            {
                output.Append(source[i]);
                i++;
                continue;
            }

            (_, string name, bool ok, _) = ScanTag(source, i);
            if (!ok || !string.Equals(name, tag, StringComparison.Ordinal))
            {
                output.Append(source[i]);
                i++;
                continue;
            }

            string close = "</" + tag;
            int end = source.Length; // "to the end of input" when the closing tag is missing
            for (int j = boundary; j < source.Length; j++)
            {
                if (source[j] != '<' || !HasPrefixFold(source, j, close))
                {
                    continue;
                }

                int after = j + close.Length;
                if (after < source.Length && IsNameCharacter(source[after]))
                {
                    continue; // "</scripted>" is not the closing tag
                }

                int c = after;
                while (c < source.Length && IsSpaceCharacter(source[c]))
                {
                    c++;
                }

                end = c < source.Length && source[c] == '>' ? c + 1 : after;
                break;
            }

            i = end;
        }

        return output.ToString();
    }

    // ----------------------------------------------------------------------------------------
    // Pass 3: one walk over the survivors
    // ----------------------------------------------------------------------------------------

    private sealed class AnchorFrame
    {
        public string Href { get; init; } = string.Empty;

        public StringBuilder Text { get; } = new();

        public LinkEntry Report()
        {
            return new LinkEntry
            {
                Href = Href,
                Absolute = HrefHasScheme(Href),
                Text = Text.ToString(),
            };
        }
    }

    private sealed class WalkState
    {
        public StringBuilder Text { get; } = new();

        public StringBuilder Title { get; } = new();

        public List<LinkEntry> Links { get; } = new();

        public AnchorFrame? Pending { get; set; }

        public int Images { get; set; }

        public bool TitleSeen { get; set; }

        public bool InTitle { get; set; }

        public int CdataNext { get; set; }
    }

    private static ExtractResult Walk(string source, List<string> cdataBodies)
    {
        var state = new WalkState();
        int i = 0;
        while (i < source.Length)
        {
            char c = source[i];

            if (c == CdataMarker)
            {
                // Restore a lifted CDATA body, in order. The tag pass never saw its content, so
                // nothing inside it is re-parsed and its entities stay inert.
                if (state.CdataNext < cdataBodies.Count)
                {
                    PushCharData(state, cdataBodies[state.CdataNext]);
                    state.CdataNext++;
                }

                i++;
                continue;
            }

            if (c == '<' && i + 1 < source.Length && StartsTag(source[i + 1]))
            {
                (int end, string name, _, bool closed) = ScanTag(source, i);
                string raw = closed ? source[(i + 1)..(end - 1)] : source[(i + 1)..];
                i = end;

                // A tag that is never closed before the end of the input is dropped as a tag and
                // contributes nothing at all - not a newline either. "<p" at end of input is not a
                // paragraph, and neither is "<p title=\"x</div>", whose last '>' belongs to a quoted
                // value.
                if (!closed)
                {
                    continue;
                }

                bool closing = raw.StartsWith('/');

                if (name == "title")
                {
                    if (!closing && !state.TitleSeen)
                    {
                        state.InTitle = true;
                        state.TitleSeen = true;
                    }
                    else if (closing && state.InTitle)
                    {
                        state.InTitle = false;
                    }

                    continue;
                }

                if (name == "img" && !closing)
                {
                    state.Images++;
                    continue;
                }

                if (name == "a")
                {
                    if (!closing)
                    {
                        // HTML does not allow nested anchors: a browser closes the open one and starts
                        // the new one, so the outer is reported with the text it collected up to here
                        // and the inner becomes the open anchor. Ignoring the inner - and thereby
                        // dropping its href - was a real divergence shared by several implementations
                        // until the Go worker flagged it.
                        if (state.Pending != null)
                        {
                            state.Links.Add(state.Pending.Report());
                            state.Pending = null;
                        }

                        bool selfClosing = end - 2 >= i && source[end - 2] != '<' && source[end - 1] == '/';
                        if (!selfClosing)
                        {
                            // No href attribute means an entry with an empty href, not no entry.
                            state.Pending = new AnchorFrame { Href = AttributeValue(raw, "href") };
                        }
                    }
                    else if (state.Pending != null)
                    {
                        state.Links.Add(state.Pending.Report());
                        state.Pending = null;
                    }

                    continue;
                }

                if (BlockNewlineTags.Contains(name))
                {
                    PushText(state, "\n");
                }

                continue;
            }

            if (c == '&' && DecodeEntity(source, i, out string decoded, out int next))
            {
                // Entities are decoded before the title/body split, so a title decodes exactly like
                // the body text does - and while a title is open, the decoded text belongs to the
                // title and to nothing else.
                PushText(state, decoded);
                i = next;
                continue;
            }

            if (state.InTitle)
            {
                state.Title.Append(c);
            }
            else
            {
                PushText(state, source[i].ToString());
            }

            i++;
        }

        // An anchor still open at the end of the input is reported with the text it collected.
        if (state.Pending != null)
        {
            state.Links.Add(state.Pending.Report());
        }

        return new ExtractResult
        {
            Title = state.Title.ToString(),
            Text = state.Text.ToString(),
            Links = state.Links,
            Images = state.Images,
        };
    }

    /// <summary>
    /// Adds body text. While a title is open the chunk belongs to the title instead, and to no open
    /// anchor: a title's text is not rendered as body text and is not part of a link's text.
    /// </summary>
    private static void PushText(WalkState state, string chunk)
    {
        if (chunk.Length == 0)
        {
            return;
        }

        if (state.InTitle)
        {
            state.Title.Append(chunk);
            return;
        }

        state.Text.Append(chunk);
        state.Pending?.Text.Append(chunk);
    }

    /// <summary>
    /// Restores a lifted CDATA body. It is character data: routed exactly like body text - into the
    /// body and into any open anchor - except inside a title, whose text belongs to the title alone.
    /// </summary>
    private static void PushCharData(WalkState state, string chunk)
    {
        if (chunk.Length == 0)
        {
            return;
        }

        if (state.InTitle)
        {
            state.Title.Append(chunk);
            return;
        }

        state.Text.Append(chunk);
        state.Pending?.Text.Append(chunk);
    }

    /// <summary>&lt; starts a tag only when followed by [A-Za-z/!]; otherwise it is literal text.</summary>
    private static bool StartsTag(char c)
    {
        return c == '/' || c == '!' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
    }

    /// <summary>
    /// Inspects the '&lt;' at <paramref name="start"/> and returns the index just past the tag, its
    /// lowercased name, whether this '&lt;' starts a tag at all, and whether the tag was closed by a
    /// '&gt;' before the end of the input. A '&gt;' inside a quoted attribute value does not end the
    /// tag.
    ///
    /// The closed flag is returned rather than inferred from "the raw text ends with '&gt;'": that
    /// inference is wrong exactly when the input ends with a '&gt;' belonging to an inner quoted
    /// value, as in &lt;p title="unclosed&lt;/div&gt;.
    /// </summary>
    private static (int End, string Name, bool Ok, bool Closed) ScanTag(string source, int start)
    {
        if (start + 1 >= source.Length || source[start] != '<' || !StartsTag(source[start + 1]))
        {
            return (start + 1, string.Empty, false, false);
        }

        int nameStart = start + 1;
        if (source[nameStart] == '/')
        {
            nameStart++;
        }

        while (nameStart < source.Length && IsSpaceCharacter(source[nameStart]))
        {
            nameStart++;
        }

        int i = nameStart;
        if (i < source.Length && ((source[i] >= 'A' && source[i] <= 'Z') || (source[i] >= 'a' && source[i] <= 'z')))
        {
            i++;
            while (i < source.Length && IsTagNameCharacter(source[i]))
            {
                i++;
            }
        }

        // Tag names are ASCII by construction: the character range above admits nothing else, which
        // is why the invariant lowercase below cannot be culture-dependent on any input that reaches it.
        string name = source[nameStart..i].ToLowerInvariant();

        int j = start + 1;
        while (j < source.Length)
        {
            char c = source[j];
            if (c == '"' || c == '\'')
            {
                j++;
                while (j < source.Length && source[j] != c)
                {
                    j++;
                }

                if (j < source.Length)
                {
                    j++;
                }

                continue;
            }

            if (c == '>')
            {
                return (j + 1, name, true, true);
            }

            j++;
        }

        return (source.Length, name, true, false); // unclosed: runs to the end of the input
    }

    private static bool IsNameCharacter(char c)
    {
        return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
    }

    private static bool IsTagNameCharacter(char c)
    {
        return IsNameCharacter(c) || c == ':' || c == '-';
    }

    private static bool IsSpaceCharacter(char c)
    {
        return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v';
    }

    /// <summary>
    /// An attribute's value from a tag's raw inner text (everything between the angle brackets). The
    /// value is verbatim: no entity decoding, no resolution. The attribute name must have a word
    /// boundary in front of it, so "data-href" does not answer for "href".
    /// </summary>
    private static string AttributeValue(string raw, string attribute)
    {
        int i = 0;
        while (i < raw.Length)
        {
            if (!HasPrefixFold(raw, i, attribute))
            {
                i++;
                continue;
            }

            if (i > 0 && IsTagNameCharacter(raw[i - 1]))
            {
                i++;
                continue;
            }

            int j = i + attribute.Length;
            while (j < raw.Length && IsSpaceCharacter(raw[j]))
            {
                j++;
            }

            if (j >= raw.Length || raw[j] != '=')
            {
                i++;
                continue;
            }

            j++;
            while (j < raw.Length && IsSpaceCharacter(raw[j]))
            {
                j++;
            }

            if (j >= raw.Length)
            {
                return string.Empty;
            }

            if (raw[j] == '"' || raw[j] == '\'')
            {
                char quote = raw[j];
                j++;
                int start = j;
                while (j < raw.Length && raw[j] != quote)
                {
                    j++;
                }

                return raw[start..j];
            }

            int bareStart = j;
            while (j < raw.Length && !IsSpaceCharacter(raw[j]) && raw[j] != '>')
            {
                j++;
            }

            return raw[bareStart..j];
        }

        return string.Empty;
    }

    /// <summary>
    /// Contract step 4: "starts with a scheme" - [A-Za-z][A-Za-z0-9+.-]*: at the beginning. Nothing
    /// is resolved and no URL is validated beyond that, so "//cdn.example/x" is not absolute.
    /// </summary>
    private static bool HrefHasScheme(string href)
    {
        if (href.Length == 0)
        {
            return false;
        }

        char c = href[0];
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')))
        {
            return false;
        }

        for (int i = 1; i < href.Length; i++)
        {
            c = href[i];
            bool alphanumeric = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
            if (alphanumeric || c == '+' || c == '.' || c == '-')
            {
                continue;
            }

            return c == ':';
        }

        return false;
    }

    /// <summary>An ASCII-case-insensitive prefix test that cannot reach a culture or a collation.</summary>
    private static bool HasPrefixFold(string source, int start, string prefix)
    {
        if (source.Length - start < prefix.Length)
        {
            return false;
        }

        for (int i = 0; i < prefix.Length; i++)
        {
            char c = source[start + i];
            if (c >= 'A' && c <= 'Z')
            {
                c = (char)(c + ('a' - 'A'));
            }

            if (c != prefix[i])
            {
                return false;
            }
        }

        return true;
    }

    private static bool HasPrefixOrdinal(string source, int start, string prefix)
    {
        return source.Length - start >= prefix.Length && string.CompareOrdinal(source, start, prefix, 0, prefix.Length) == 0;
    }

    // ----------------------------------------------------------------------------------------
    // Entities - contract step 6
    // ----------------------------------------------------------------------------------------

    /// <summary>
    /// Decodes the entity at <paramref name="i"/>, which points at '&amp;'. A named reference is
    /// recognised only when a name of the closed set matches immediately after the '&amp;' AND does
    /// not run on into further name characters - which is what keeps "&amp;copy2024" and
    /// "&amp;ampersand" literal, with no backtracking. A numeric reference is "&amp;#" with 1-7
    /// decimal digits or "&amp;#x"/"&amp;#X" with 1-6 hex digits; both forms decode with or without a
    /// trailing semicolon, as browsers do.
    /// </summary>
    private static bool DecodeEntity(string source, int i, out string decoded, out int next)
    {
        decoded = string.Empty;
        next = i;
        if (i + 1 >= source.Length || source[i] != '&')
        {
            return false;
        }

        if (source[i + 1] == '#')
        {
            return DecodeNumericEntity(source, i, out decoded, out next);
        }

        int limit = Math.Min(source.Length, i + EntityWindow);
        foreach (KeyValuePair<string, string> entity in NamedEntities)
        {
            int end = i + 1 + entity.Key.Length;
            if (end > limit || end > source.Length)
            {
                continue;
            }

            if (!HasPrefixFold(source, i + 1, entity.Key))
            {
                continue;
            }

            if (end < source.Length && IsNameCharacter(source[end]))
            {
                return false; // the name runs on: this is not a reference
            }

            int after = end;
            if (after < source.Length && source[after] == ';')
            {
                after++;
            }

            decoded = entity.Value;
            next = after;
            return true;
        }

        return false;
    }

    private static bool DecodeNumericEntity(string source, int i, out string decoded, out int next)
    {
        decoded = string.Empty;
        next = i;

        int j = i + 2;
        int radix = 10;
        int limit = 7;
        if (j < source.Length && (source[j] == 'x' || source[j] == 'X'))
        {
            radix = 16;
            limit = 6;
            j++;
        }

        int digits = 0;
        long value = 0;
        while (j < source.Length && digits < limit)
        {
            int digit = DigitValue(source[j], radix);
            if (digit < 0)
            {
                break;
            }

            if (value <= 0x10FFFF)
            {
                value = (value * radix) + digit;
            }

            digits++;
            j++;
        }

        if (digits == 0)
        {
            return false;
        }

        if (j < source.Length && source[j] == ';')
        {
            j++;
        }

        // U+0000 is a legal scalar value and decodes to NUL; only a value outside the scalar range
        // or a surrogate half is refused, and then the whole reference stays verbatim.
        if (value > 0x10FFFF || (value >= 0xD800 && value <= 0xDFFF))
        {
            return false;
        }

        decoded = char.ConvertFromUtf32((int)value);
        next = j;
        return true;
    }

    private static int DigitValue(char c, int radix)
    {
        if (c >= '0' && c <= '9')
        {
            return c - '0';
        }

        if (radix == 16 && c >= 'a' && c <= 'f')
        {
            return (c - 'a') + 10;
        }

        if (radix == 16 && c >= 'A' && c <= 'F')
        {
            return (c - 'A') + 10;
        }

        return -1;
    }
}
