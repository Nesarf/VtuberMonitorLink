// JsonOut.cs - the protocol's JSON writer.
//
// docs/WORKERS.md section 1: "Determinism is part of the contract. The same input must produce
// byte-identical output JSON, including key order and array order, on any machine, in any of the
// languages." Two things follow, and this file exists for both of them:
//
//   1. **Key order is written down, not inherited.** No response is produced by serialising an
//      object graph: every object here is built by appending whole "name":value pieces in the order
//      the contract lists them (title, text, links, images; simhash, tokens, shingles; href,
//      absolute, text inside a link). A Dictionary is never asked to decide an order, because it
//      does not have one.
//
//   2. **Escaping is JSON.stringify-compatible.** The host compares parsed values, so an escaping
//      difference alone is harmless - but only as long as it parses to the same value, and the
//      families of bugs here are real: System.Text.Json's default encoder escapes non-ASCII
//      (CJK becomes \uXXXX), escapes HTML-significant characters (< > & become \u003c...), and
//      refuses to write an invalid surrogate at all. The corpus is full of CJK, em dashes and
//      astral characters, so this writer emits raw UTF-8 for everything except the characters JSON
//      requires to be escaped (quote, backslash, and the C0 controls), with JSON.stringify's short
//      forms \b \f \n \r \t for the ones that have them.
//
// The bytes are the output: a List<byte> is appended to directly, and nothing between this class and
// the stream re-encodes anything. A StringBuilder would hold UTF-16 and need an encoder at the end;
// a TextWriter over the console would take the platform's encoding and line ending. Both are one
// careless line away from a BOM, a code page (GBK on a Chinese Windows) or a CR LF in the middle of
// the protocol stream.
//
// The structural characters (the quote, the colon, the comma, the braces) are written as BYTE
// constants, not as one-character strings. It reads slightly oddly for a JSON writer in C#, and it
// is deliberate: a quote in this protocol is the byte 0x22, and writing `(byte)'"'` at every site
// keeps the one thing the harness actually compares - the bytes - visible in the source.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace Vml;

/// <summary>
/// Accumulates one JSON value as UTF-8 bytes in the contract's field order and writes whole
/// protocol lines to a stream, flushed before the next request is read.
/// </summary>
internal sealed class JsonOut
{
    private const byte Quote = 0x22; // "
    private const byte Colon = 0x3A; // :
    private const byte CommaByte = 0x2C; // ,
    private const byte OpenBrace = 0x7B; // {
    private const byte CloseBrace = 0x7D; // }
    private const byte OpenBracket = 0x5B; // [
    private const byte CloseBracket = 0x5D; // ]
    private const byte Backslash = 0x5C; // \

    private const string HexDigits = "0123456789abcdef";

    private readonly List<byte> _bytes = new(4096);

    /// <summary>Starts a new value.</summary>
    public void Reset()
    {
        _bytes.Clear();
    }

    /// <summary>Appends an ASCII fragment chosen by this program (braces, keys, punctuation).</summary>
    public void Append(string ascii)
    {
        for (int i = 0; i < ascii.Length; i++)
        {
            _bytes.Add((byte)ascii[i]);
        }
    }

    /// <summary>Writes an already-encoded JSON fragment verbatim.</summary>
    public void Raw(string json)
    {
        Append(json);
    }

    /// <summary>Writes an already-encoded JSON token verbatim (used to echo the request's id).</summary>
    public void Raw(ReadOnlySpan<byte> utf8)
    {
        foreach (byte b in utf8)
        {
            _bytes.Add(b);
        }
    }

    public void Token(ReadOnlySpan<byte> utf8)
    {
        Raw(utf8);
    }

    public void BeginObject()
    {
        _bytes.Add(OpenBrace);
    }

    public void EndObject()
    {
        _bytes.Add(CloseBrace);
    }

    public void BeginArray()
    {
        _bytes.Add(OpenBracket);
    }

    public void EndArray()
    {
        _bytes.Add(CloseBracket);
    }

    public void Comma()
    {
        _bytes.Add(CommaByte);
    }

    /// <summary>Writes "name": - the name is always an ASCII key chosen by this program.</summary>
    public void Key(string name)
    {
        _bytes.Add(Quote);
        Append(name);
        _bytes.Add(Quote);
        _bytes.Add(Colon);
    }

    public void KeyValue(string name, string value)
    {
        Key(name);
        Str(value);
    }

    public void KeyValue(string name, bool value)
    {
        Key(name);
        Bool(value);
    }

    public void KeyValue(string name, long value)
    {
        Key(name);
        Int(value);
    }

    /// <summary>Writes a JSON string: the opening quote, the escaped content, the closing quote.</summary>
    public void Str(string value)
    {
        _bytes.Add(Quote);
        AppendStringContent(value);
        _bytes.Add(Quote);
    }

    public void Bool(bool value)
    {
        Append(value ? "true" : "false");
    }

    /// <summary>
    /// An integer, appended digit by digit. No number formatter is involved, so no culture and no
    /// grouping separator can reach the protocol: the contract says "never format a number with a
    /// locale", and the surest way to obey that is not to call a formatter at all.
    /// </summary>
    public void Int(long value)
    {
        if (value < 0)
        {
            Append("-");

            // Negated in unsigned arithmetic, so long.MinValue cannot overflow.
            AppendUnsigned((ulong)(-(value + 1)) + 1UL);
            return;
        }

        AppendUnsigned((ulong)value);
    }

    private void AppendUnsigned(ulong value)
    {
        if (value == 0)
        {
            _bytes.Add((byte)'0');
            return;
        }

        Span<byte> digits = stackalloc byte[20];
        int count = 0;
        while (value > 0)
        {
            digits[count] = (byte)('0' + (int)(value % 10));
            value /= 10;
            count++;
        }

        for (int i = count - 1; i >= 0; i--)
        {
            _bytes.Add(digits[i]);
        }
    }

    /// <summary>
    /// The escaped content of a JSON string, without the surrounding quotes: JSON.stringify's rules,
    /// so this worker's bytes match the other implementations' bytes.
    /// </summary>
    private void AppendStringContent(string value)
    {
        int i = 0;
        while (i < value.Length)
        {
            char c = value[i];
            i++;

            switch (c)
            {
                case '"':
                    _bytes.Add(Backslash);
                    _bytes.Add(Quote);
                    continue;
                case '\\':
                    _bytes.Add(Backslash);
                    _bytes.Add(Backslash);
                    continue;
                case '\b':
                    _bytes.Add(Backslash);
                    _bytes.Add((byte)'b');
                    continue;
                case '\f':
                    _bytes.Add(Backslash);
                    _bytes.Add((byte)'f');
                    continue;
                case '\n':
                    _bytes.Add(Backslash);
                    _bytes.Add((byte)'n');
                    continue;
                case '\r':
                    _bytes.Add(Backslash);
                    _bytes.Add((byte)'r');
                    continue;
                case '\t':
                    _bytes.Add(Backslash);
                    _bytes.Add((byte)'t');
                    continue;
            }

            if (c < 0x20)
            {
                // The remaining C0 controls: \u00XX. (DEL, U+007F, is written raw, as
                // JSON.stringify does - it is a legal character in a JSON string.)
                _bytes.Add(Backslash);
                _bytes.Add((byte)'u');
                _bytes.Add((byte)'0');
                _bytes.Add((byte)'0');
                _bytes.Add((byte)HexDigits[(c >> 4) & 0xF]);
                _bytes.Add((byte)HexDigits[c & 0xF]);
                continue;
            }

            if (c < 0x80)
            {
                _bytes.Add((byte)c);
                continue;
            }

            if (char.IsHighSurrogate(c) && i < value.Length && char.IsLowSurrogate(value[i]))
            {
                // A surrogate pair is one astral code point: its four UTF-8 bytes, built from the
                // code point rather than from either half of the pair.
                int codePoint = char.ConvertToUtf32(c, value[i]);
                i++;
                AppendUtf8(codePoint);
                continue;
            }

            if (char.IsSurrogate(c))
            {
                // A lone surrogate cannot be encoded at all - Encoding.UTF8 would substitute U+FFFD,
                // and char.ConvertFromUtf32 would throw. Neither is acceptable in a normalizer whose
                // subject matter is emoji, so it is written as \uXXXX, which keeps the code unit
                // visible and the line parseable instead of failing the whole response.
                _bytes.Add(Backslash);
                _bytes.Add((byte)'u');
                _bytes.Add((byte)HexDigits[(c >> 12) & 0xF]);
                _bytes.Add((byte)HexDigits[(c >> 8) & 0xF]);
                _bytes.Add((byte)HexDigits[(c >> 4) & 0xF]);
                _bytes.Add((byte)HexDigits[c & 0xF]);
                continue;
            }

            AppendUtf8(c);
        }
    }

    /// <summary>Appends one code point as raw UTF-8. No BOM, no substitution, no culture.</summary>
    private void AppendUtf8(int codePoint)
    {
        if (codePoint < 0x800)
        {
            _bytes.Add((byte)(0xC0 | (codePoint >> 6)));
            _bytes.Add((byte)(0x80 | (codePoint & 0x3F)));
            return;
        }

        if (codePoint < 0x10000)
        {
            _bytes.Add((byte)(0xE0 | (codePoint >> 12)));
            _bytes.Add((byte)(0x80 | ((codePoint >> 6) & 0x3F)));
            _bytes.Add((byte)(0x80 | (codePoint & 0x3F)));
            return;
        }

        _bytes.Add((byte)(0xF0 | (codePoint >> 18)));
        _bytes.Add((byte)(0x80 | ((codePoint >> 12) & 0x3F)));
        _bytes.Add((byte)(0x80 | ((codePoint >> 6) & 0x3F)));
        _bytes.Add((byte)(0x80 | (codePoint & 0x3F)));
    }

    /// <summary>Appends one LF and flushes, so a response is on the wire before the next read.</summary>
    public void WriteLineTo(Stream stdout)
    {
        byte[] line = _bytes.ToArray();
        stdout.Write(line, 0, line.Length);
        stdout.WriteByte((byte)'\n');
        stdout.Flush();
    }

    public byte[] ToBytes()
    {
        return _bytes.ToArray();
    }

    public string ToUtf8String()
    {
        return Encoding.UTF8.GetString(_bytes.ToArray());
    }

    /// <summary>The JSON text of one string, for building expectations in the self-check.</summary>
    public static string StringLiteral(string value)
    {
        var writer = new JsonOut();
        writer.Str(value);
        return writer.ToUtf8String();
    }

    /// <summary>An integer rendered in the invariant culture, for English diagnostic lines.</summary>
    public static string Invariant(long value)
    {
        return value.ToString(CultureInfo.InvariantCulture);
    }
}
