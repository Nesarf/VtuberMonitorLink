// Normalize.cs - docs/WORKERS.md section 2, capability text.normalize.
//
// Steps, in this order, over Unicode scalar values:
//   1 delete the listed code points (C0 controls except tab/LF/CR, DEL, zero-width and bidi
//     controls, BOM, and the listed combining-mark ranges)
//   2 map the listed code points, one to one (full-width ASCII -> ASCII by subtracting 0xFEE0),
//     except U+2026 which is the one mapping that produces three characters
//   3 lowercase, exactly and only per workers/spec/latin-lower.json
//   4 fold accents, exactly and only per workers/spec/latin-fold.json, applied to each code point
//     of step 3's result
//   5 collapse runs of space, tab, LF and CR into a single space
//   6 trim leading and trailing spaces
//
// Three .NET traps are defeated here, and each has code that looks correct written the other way:
//
//   * **UTF-16 code units are not code points.** `foreach (char c in text)` walks code units, and
//     char.ConvertFromUtf32(c) THROWS on a lone surrogate - which is exactly what a surrogate pair
//     looks like when it is walked a unit at a time. The published PowerShell worker in this layer
//     shipped that bug and rejected every emoji (docs/WORKERS.md section 5). The loop below pairs
//     surrogates with char.ConvertToUtf32 before anything else happens to them.
//
//   * **Culture-sensitive defaults.** char.ToLower() and string.ToLower() use the CURRENT CULTURE,
//     so on a Turkish machine "I".ToLower() is the dotless "ı" and every ASCII "I" in the corpus
//     changes. The contract's tables are the rule and .NET's tables are never consulted, so the
//     only case mapping in this file is a lookup in workers/spec/latin-lower.json.
//
//   * **String.Trim() is not the contract's whitespace.** Trim() strips Unicode whitespace -
//     U+00A0, U+3000, U+2007 and a dozen more - while the contract's steps 5 and 6 name exactly
//     four characters (space, tab, LF, CR) AFTER the mapping step has already turned the
//     space-like code points into U+0020. Using Trim() here would also strip U+200B or U+2028 that
//     step 1 did not delete, and it would trim a string that has no trailing space at all on a
//     different runtime's whitespace table. The last pass is written out by hand.

using System;
using System.Text;

namespace Vml;

internal static class Normalize
{
    public static string Apply(string text, SpecTables tables)
    {
        var output = new StringBuilder(text.Length);
        int i = 0;
        while (i < text.Length)
        {
            int codePoint;
            char unit = text[i];
            if (char.IsHighSurrogate(unit) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]))
            {
                // One scalar value in two code units. Only a code POINT may be looked up in a table
                // or asked for case, so the pair is folded before anything else looks at it.
                codePoint = char.ConvertToUtf32(unit, text[i + 1]);
                i += 2;
            }
            else
            {
                codePoint = unit;
                i++;
            }

            if (IsDeleted(codePoint))
            {
                continue; // step 1
            }

            // Step 2: the mapping table. The result is a string because U+2026 maps to three
            // characters; every other mapping is one code point, and the fallback is the code point
            // itself (which may be two UTF-16 code units for an astral input).
            string piece = Map(codePoint);
            for (int k = 0; k < piece.Length; k++)
            {
                int piecePoint;
                if (char.IsHighSurrogate(piece[k]) && k + 1 < piece.Length && char.IsLowSurrogate(piece[k + 1]))
                {
                    piecePoint = char.ConvertToUtf32(piece[k], piece[k + 1]);
                    k++;
                }
                else
                {
                    piecePoint = piece[k];
                }

                // Steps 3 and 4 compose: a code point the lower table maps is then offered to the
                // fold table, so an uppercase accented letter is lowercased and then folded. Running
                // them as alternatives was a real bug in the JavaScript reference, which is why the
                // contract says the tables are applied "in that order" and why both are needed.
                //
                // A code point outside the table domain - every astral code point, and every BMP
                // code point above U+024F - has no entry in either table and is therefore written
                // back unchanged. That is the contract's "the tables do not mention it" rule, and it
                // is what keeps Han, kana, Hangul, Cyrillic, Arabic and emoji intact.
                int lowered = tables.Lower(piecePoint);
                string? folded = tables.Fold(lowered);
                if (folded != null)
                {
                    output.Append(folded);
                }
                else
                {
                    output.Append(char.ConvertFromUtf32(lowered));
                }
            }
        }

        return TrimAndCollapseSpaces(output.ToString());
    }

    /// <summary>Step 1: the deleted code points and ranges, exactly as the contract lists them.</summary>
    private static bool IsDeleted(int codePoint)
    {
        switch (codePoint)
        {
            case >= 0x0000 and <= 0x0008:
            case 0x000B:
            case 0x000C:
            case >= 0x000E and <= 0x001F:
            case 0x007F:
            case >= 0x0300 and <= 0x036F: // combining marks: NFD equals NFC without any Unicode normalization
            case >= 0x1AB0 and <= 0x1AFF:
            case >= 0x1DC0 and <= 0x1DFF:
            case >= 0x200B and <= 0x200F:
            case >= 0x202A and <= 0x202E:
            case >= 0x2060 and <= 0x2064:
            case >= 0x20D0 and <= 0x20FF:
            case >= 0xFE20 and <= 0xFE2F:
            case 0xFEFF:
                return true;
            default:
                return false;
        }
    }

    /// <summary>
    /// Step 2: the mapping table. Anything not listed is left alone, which is why the fallback is
    /// the code point's own character rather than an empty string.
    /// </summary>
    private static string Map(int codePoint)
    {
        switch (codePoint)
        {
            case 0x00A0:
            case >= 0x2000 and <= 0x200A:
            case 0x2028:
            case 0x2029:
            case 0x202F:
            case 0x205F:
            case 0x3000:
                return " ";
            case >= 0xFF01 and <= 0xFF5E:
                return char.ConvertFromUtf32(codePoint - 0xFEE0);
            case 0x2018:
            case 0x2019:
            case 0x201B:
            case 0x2032:
                return "'";
            case 0x201C:
            case 0x201D:
            case 0x201F:
            case 0x2033:
                return "\"";
            case 0x2010:
            case 0x2011:
            case 0x2012:
            case 0x2013:
            case 0x2014:
            case 0x2015:
            case 0x2212:
                return "-";
            case 0x2026:
                return "...";
            case 0x3001:
                return ",";
            case 0x3002:
                return ".";
            default:
                return char.ConvertFromUtf32(codePoint);
        }
    }

    /// <summary>
    /// Steps 5 and 6 in one pass: every run of space, tab, LF or CR becomes a single space, and a
    /// separator that would land at either end is dropped. The "pending space" flag is what makes
    /// the trim free - a run at the start has nothing to separate, and a run at the end never gets
    /// written because nothing follows it.
    /// </summary>
    private static string TrimAndCollapseSpaces(string text)
    {
        var output = new StringBuilder(text.Length);
        bool pendingSpace = false;
        foreach (char c in text)
        {
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r')
            {
                if (output.Length > 0)
                {
                    pendingSpace = true;
                }

                continue;
            }

            if (pendingSpace)
            {
                output.Append(' ');
                pendingSpace = false;
            }

            output.Append(c);
        }

        return output.ToString();
    }
}
