// Fingerprint.cs - docs/WORKERS.md section 4, capability text.fingerprint.
//
// All integer arithmetic, on purpose: "byte-identical across languages is achievable rather than
// aspirational". The hash is FNV-1a 64-bit over the shingle's UTF-8 bytes with wraparound multiply;
// the simhash is 64 counters where a tie counts as 0.
//
// .NET specifics worth naming:
//
//   * **ulong is the right type and the only type.** The offset basis 14695981039346656037 does not
//     fit in an Int64, and the multiply must wrap modulo 2^64. In C# that is simply `ulong`
//     arithmetic with unchecked semantics (the default, and stated here so nobody "helpfully" turns
//     on a checked context): `h * 1099511628211UL` wraps exactly as the contract says. The
//     PowerShell worker had to build the same operation out of 32-bit products because its only
//     64-bit integer is signed - this is the language where the contract's arithmetic is free.
//
//   * **The bytes are UTF-8, not UTF-16.** Hashing `string`'s own units would give a different hash
//     for every non-ASCII shingle, so the string is encoded explicitly with Encoding.UTF8 (no BOM,
//     no culture, no TextWriter in sight).
//
//   * **No dictionary is iterated, and no number is formatted by a culture.** The counters are a
//     fixed array indexed 0..63, and the hex output is built from a literal digit table, so nothing
//     about the answer can depend on a hash order or on the machine's locale.

using System;
using System.Collections.Generic;
using System.Text;

namespace Vml;

internal sealed class FingerprintResult
{
    public string Simhash { get; init; } = string.Empty;

    public int Tokens { get; init; }

    public int Shingles { get; init; }
}

internal static class Fingerprint
{
    /// <summary>The contract's ASCII punctuation set, exactly as listed in section 4.</summary>
    private const string AsciiPunctuation = "!?,.;:'\"()[]{}<>-_/\\|*+=~`@#$%^&";

    private const string HexDigitsLower = "0123456789abcdef";

    private const ulong FnvOffset64 = 14695981039346656037UL;
    private const ulong FnvPrime64 = 1099511628211UL;

    public static FingerprintResult Apply(string text)
    {
        List<string> tokens = Tokenize(text);
        List<string> shingles = ShinglesOf(tokens);

        var counters = new int[64];
        foreach (string shingle in shingles)
        {
            ulong hash = Fnv1a64(shingle);
            for (int bit = 0; bit < 64; bit++)
            {
                if ((hash & (1UL << bit)) != 0)
                {
                    counters[bit]++;
                }
                else
                {
                    counters[bit]--;
                }
            }
        }

        // "Bit i of the output is 1 when its counter is > 0, and 0 on a tie." With no shingles every
        // counter is 0, so the answer is sixteen zeros rather than a special case.
        ulong output = 0;
        for (int bit = 0; bit < 64; bit++)
        {
            if (counters[bit] > 0)
            {
                output |= 1UL << bit;
            }
        }

        return new FingerprintResult
        {
            Simhash = Hex16(output),
            Tokens = tokens.Count,
            Shingles = shingles.Count,
        };
    }

    /// <summary>
    /// Splits on single spaces (the normalizer guarantees there are no runs), strips leading and
    /// trailing ASCII punctuation from each token, and turns what is left into the contract's
    /// code-point runs: a CJK run of length 1 emits itself, a CJK run of length n >= 2 emits its
    /// n-1 overlapping bigrams, an "other" run emits itself.
    ///
    /// The walk is over UTF-16 code units, and that is deliberate rather than sloppy: the edge
    /// punctation set is ASCII, and every range the contract calls CJK (U+3400-U+4DBF,
    /// U+4E00-U+9FFF, U+F900-U+FAFF, U+3040-U+30FF, U+AC00-U+D7AF) ends below U+FFFF. A surrogate
    /// pair is therefore two units that are both classified "other" and are emitted together as the
    /// one run they are - never split, because the run is a contiguous slice of the token and the
    /// emoji is never a boundary between two classes.
    /// </summary>
    public static List<string> Tokenize(string text)
    {
        var tokens = new List<string>();
        foreach (string piece in text.Split(' '))
        {
            if (piece.Length == 0)
            {
                continue;
            }

            string trimmed = TrimAsciiPunctuation(piece);
            if (trimmed.Length == 0)
            {
                continue;
            }

            // "emit nothing at all if the token ... consists only of ASCII punctuation". A token
            // that has no punctuation left after trimming cannot consist only of punctuation, so
            // this can only be reached by a token that is punctuation inside and non-punctuation at
            // both edges - which the trim already removed. The check is kept because the contract
            // states it and because it costs one pass.
            if (IsAllAsciiPunctuation(trimmed))
            {
                continue;
            }

            int runStart = 0;
            int runClass = -1; // -1 = no run yet, 0 = other, 1 = CJK
            for (int i = 0; i <= trimmed.Length; i++)
            {
                int charClass = -1;
                if (i < trimmed.Length)
                {
                    charClass = IsCjk(trimmed[i]) ? 1 : 0;
                }

                if (charClass == runClass)
                {
                    continue;
                }

                EmitRun(tokens, trimmed, runStart, i, runClass);
                runStart = i;
                runClass = charClass;
            }
        }

        return tokens;
    }

    private static void EmitRun(List<string> tokens, string token, int start, int end, int runClass)
    {
        if (runClass < 0)
        {
            return;
        }

        int length = end - start;
        if (length <= 0)
        {
            return;
        }

        if (runClass == 0 || length == 1)
        {
            tokens.Add(token.Substring(start, length));
            return;
        }

        for (int i = start; i + 1 < end; i++)
        {
            tokens.Add(token.Substring(i, 2));
        }
    }

    /// <summary>
    /// Removes leading and trailing characters of the contract's ASCII punctuation set. The walk is
    /// over code units, which is safe because the whole set is ASCII and no UTF-8 or UTF-16 unit of
    /// a non-ASCII character can be mistaken for one of its members.
    /// </summary>
    public static string TrimAsciiPunctuation(string token)
    {
        int start = 0;
        while (start < token.Length && IsAsciiPunctuation(token[start]))
        {
            start++;
        }

        int end = token.Length;
        while (end > start && IsAsciiPunctuation(token[end - 1]))
        {
            end--;
        }

        return token[start..end];
    }

    private static bool IsAllAsciiPunctuation(string token)
    {
        foreach (char c in token)
        {
            if (!IsAsciiPunctuation(c))
            {
                return false;
            }
        }

        return token.Length > 0;
    }

    private static bool IsAsciiPunctuation(char c)
    {
        return AsciiPunctuation.IndexOf(c) >= 0;
    }

    /// <summary>Section 4's CJK ranges: Han, kana and Hangul syllables, and nothing else.</summary>
    private static bool IsCjk(char c)
    {
        return (c >= '\u3400' && c <= '\u4DBF')
            || (c >= '\u4E00' && c <= '\u9FFF')
            || (c >= '\uF900' && c <= '\uFAFF')
            || (c >= '\u3040' && c <= '\u30FF')
            || (c >= '\uAC00' && c <= '\uD7AF');
    }

    /// <summary>
    /// Overlapping runs of 3 consecutive emitted tokens; fewer than 3 tokens make the whole token
    /// list joined by a space the single shingle; no tokens make none.
    /// </summary>
    public static List<string> ShinglesOf(List<string> tokens)
    {
        var shingles = new List<string>();
        if (tokens.Count == 0)
        {
            return shingles;
        }

        if (tokens.Count < 3)
        {
            shingles.Add(string.Join(' ', tokens));
            return shingles;
        }

        for (int i = 0; i + 3 <= tokens.Count; i++)
        {
            shingles.Add(tokens[i] + " " + tokens[i + 1] + " " + tokens[i + 2]);
        }

        return shingles;
    }

    /// <summary>
    /// Exactly the loop the contract gives, over the shingle's UTF-8 bytes. The multiplication is
    /// modulo 2^64 by the type itself: ulong arithmetic in C# is unchecked by default, and this
    /// method states that rather than relying on a project-wide setting.
    /// </summary>
    public static ulong Fnv1a64(string shingle)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(shingle);
        ulong hash = FnvOffset64;
        unchecked
        {
            foreach (byte b in bytes)
            {
                hash ^= b;
                hash *= FnvPrime64;
            }
        }

        return hash;
    }

    /// <summary>Sixteen lowercase hex characters, zero padded, built without any number formatting.</summary>
    public static string Hex16(ulong value)
    {
        var buffer = new char[16];
        for (int i = 15; i >= 0; i--)
        {
            buffer[i] = HexDigitsLower[(int)(value & 0xF)];
            value >>= 4;
        }

        return new string(buffer);
    }
}
