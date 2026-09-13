// SpecTables.cs - the two shared tables of docs/WORKERS.md section 2.
//
// "The case and fold tables are shared data, not per-language library behaviour: every
// implementation reads them (or embeds them at build time); nobody consults their own runtime's
// tables. A language whose standard library would do more is expected to do exactly what the tables
// say and no more."
//
// .NET is emphatically a language whose standard library would do more: char.ToLowerInvariant,
// string.ToLower, StringComparer and CultureInfo all ship Unicode case behaviour, and every one of
// them is *close enough to look right* on the corpus' easy cases. This worker therefore never calls
// any of them: the file below is the only source of case and fold data in the program, exactly as
// the contract requires. (The one place this file does use char.IsSurrogate is classification, not
// case mapping - a surrogate pair has to be recognised as one code point before any table can be
// consulted for it, and the table simply has no entry for an astral code point.)
//
// Loaded at run time from workers/spec/*.json rather than embedded at build time: the file is
// already UTF-8 JSON with no non-ASCII string values in either table, System.Text.Json is part of
// the BCL, and reading it at startup means the artifact records the working tree instead of the
// revision that built it. A missing or malformed table is a startup error (exit 2), never a silent
// fallback to the runtime's own tables - a worker that answered with .NET's Unicode data would look
// right on almost every case and be wrong on exactly the ones this layer exists to find.

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;

namespace Vml;

internal sealed class SpecTables
{
    /// <summary>Code point -> lowercase code point, or -1. One code point to one code point.</summary>
    private readonly int[] _lower;

    /// <summary>Code point -> ASCII fold string, or null. One or two characters.</summary>
    private readonly string?[] _fold;

    private SpecTables(int[] lower, string?[] fold)
    {
        _lower = lower;
        _fold = fold;
    }

    public int LowerCount { get; private init; }

    public int FoldCount { get; private init; }

    /// <summary>The path the tables were read from, for diagnostics and describe.</summary>
    public string Directory { get; private init; } = string.Empty;

    /// <summary>The contract's table domain: U+0000-U+024F.</summary>
    private const int DomainMax = 0x024F;

    /// <summary>U+0130 LATIN CAPITAL LETTER I WITH DOT ABOVE: deliberately absent from the table.</summary>
    private const int DotlessDecision = 0x0130;

    public static SpecTables Load(string directory)
    {
        string lowerPath = Path.Combine(directory, "latin-lower.json");
        string foldPath = Path.Combine(directory, "latin-fold.json");

        List<KeyValuePair<int, int>> lower = LoadIntegerTable(lowerPath);
        List<KeyValuePair<int, string>> fold = LoadStringTable(foldPath);

        int lowerMax = 0;
        foreach (KeyValuePair<int, int> entry in lower)
        {
            if (entry.Key > DomainMax)
            {
                throw new SpecTableException($"latin-lower.json: key {entry.Key} is outside the contract domain U+0000-U+024F");
            }

            if (entry.Key == DotlessDecision)
            {
                throw new SpecTableException("latin-lower.json: U+0130 is present, but the contract says it is deliberately absent");
            }

            if (entry.Value < 0 || entry.Value > 0x10FFFF)
            {
                throw new SpecTableException($"latin-lower.json: key {entry.Key} maps to {entry.Value}, which is not a code point");
            }

            if (entry.Key > lowerMax)
            {
                lowerMax = entry.Key;
            }
        }

        int foldMax = 0;
        foreach (KeyValuePair<int, string> entry in fold)
        {
            if (entry.Key > DomainMax)
            {
                throw new SpecTableException($"latin-fold.json: key {entry.Key} is outside the contract domain U+0000-U+024F");
            }

            if (entry.Value.Length == 0)
            {
                throw new SpecTableException($"latin-fold.json: key {entry.Key} folds to the empty string");
            }

            foreach (char c in entry.Value)
            {
                if (c > 0x7F)
                {
                    throw new SpecTableException($"latin-fold.json: key {entry.Key} folds to a non-ASCII string");
                }
            }

            if (entry.Key > foldMax)
            {
                foldMax = entry.Key;
            }
        }

        int[] lowerArray = new int[lowerMax + 1];
        Array.Fill(lowerArray, -1);
        foreach (KeyValuePair<int, int> entry in lower)
        {
            if (lowerArray[entry.Key] != -1)
            {
                throw new SpecTableException($"latin-lower.json: duplicate key {entry.Key}");
            }

            lowerArray[entry.Key] = entry.Value;
        }

        string?[] foldArray = new string?[foldMax + 1];
        foreach (KeyValuePair<int, string> entry in fold)
        {
            if (foldArray[entry.Key] != null)
            {
                throw new SpecTableException($"latin-fold.json: duplicate key {entry.Key}");
            }

            foldArray[entry.Key] = entry.Value;
        }

        return new SpecTables(lowerArray, foldArray)
        {
            LowerCount = lower.Count,
            FoldCount = fold.Count,
            Directory = directory,
        };
    }

    /// <summary>
    /// Finds workers/spec by walking up from the working directory, so the worker runs both in the
    /// contract's launch form (from the repository root) and directly from workers/csharp/dist.
    /// </summary>
    public static string FindSpecDirectory()
    {
        string? overrideDirectory = Environment.GetEnvironmentVariable("VML_SPEC_DIR");
        if (!string.IsNullOrEmpty(overrideDirectory) && HasBothTables(overrideDirectory))
        {
            return Path.GetFullPath(overrideDirectory);
        }

        DirectoryInfo? directory = null;
        try
        {
            // Fully qualified on purpose: this class has a property called Directory, which shadows
            // the type name inside its own scope.
            directory = new DirectoryInfo(System.IO.Directory.GetCurrentDirectory());
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException)
        {
            directory = null;
        }

        var tried = new List<string>();
        while (directory != null)
        {
            string candidate = Path.Combine(directory.FullName, "workers", "spec");
            if (HasBothTables(candidate))
            {
                return candidate;
            }

            tried.Add(candidate);
            directory = directory.Parent;
        }

        // The executable's own location as a second guess: workers/csharp/dist/vmltext.exe sits two
        // levels below the worker directory, so ../../spec is workers/spec in an unmodified tree.
        string? exeDirectory = Path.GetDirectoryName(Environment.ProcessPath);
        if (!string.IsNullOrEmpty(exeDirectory))
        {
            string candidate = Path.GetFullPath(Path.Combine(exeDirectory, "..", "..", "spec"));
            if (HasBothTables(candidate))
            {
                return candidate;
            }

            tried.Add(candidate);
        }

        throw new SpecTableException(
            "cannot find the shared tables (latin-lower.json, latin-fold.json); tried: " + string.Join(", ", tried));
    }

    private static bool HasBothTables(string directory)
    {
        foreach (string name in new[] { "latin-lower.json", "latin-fold.json" })
        {
            string path = Path.Combine(directory, name);
            if (!File.Exists(path))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>Step 3: the lower table, one code point to one code point, or the input unchanged.</summary>
    public int Lower(int codePoint)
    {
        if (codePoint >= 0 && codePoint < _lower.Length)
        {
            int target = _lower[codePoint];
            if (target >= 0)
            {
                return target;
            }
        }

        return codePoint;
    }

    /// <summary>Step 4: the fold table, or null when the code point is not in it.</summary>
    public string? Fold(int codePoint)
    {
        if (codePoint >= 0 && codePoint < _fold.Length)
        {
            return _fold[codePoint];
        }

        return null;
    }

    private static List<KeyValuePair<int, int>> LoadIntegerTable(string path)
    {
        var result = new List<KeyValuePair<int, int>>();
        foreach (KeyValuePair<string, JsonElement> entry in LoadMap(path))
        {
            int codePoint = ParseKey(path, entry.Key);
            if (entry.Value.ValueKind != JsonValueKind.Number || !entry.Value.TryGetInt32(out int target))
            {
                throw new SpecTableException($"{Path.GetFileName(path)}: value for key {entry.Key} is not an integer");
            }

            result.Add(new KeyValuePair<int, int>(codePoint, target));
        }

        result.Sort((a, b) => a.Key.CompareTo(b.Key));
        return result;
    }

    private static List<KeyValuePair<int, string>> LoadStringTable(string path)
    {
        var result = new List<KeyValuePair<int, string>>();
        foreach (KeyValuePair<string, JsonElement> entry in LoadMap(path))
        {
            int codePoint = ParseKey(path, entry.Key);
            if (entry.Value.ValueKind != JsonValueKind.String)
            {
                throw new SpecTableException($"{Path.GetFileName(path)}: value for key {entry.Key} is not a string");
            }

            result.Add(new KeyValuePair<int, string>(codePoint, entry.Value.GetString() ?? string.Empty));
        }

        result.Sort((a, b) => a.Key.CompareTo(b.Key));
        return result;
    }

    private static List<KeyValuePair<string, JsonElement>> LoadMap(string path)
    {
        if (!File.Exists(path))
        {
            throw new SpecTableException($"cannot read the shared table {path}: it does not exist");
        }

        byte[] raw;
        try
        {
            raw = File.ReadAllBytes(path);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new SpecTableException($"cannot read the shared table {path}: {error.Message}");
        }

        if (raw.Length >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF)
        {
            raw = raw[3..];
        }

        var result = new List<KeyValuePair<string, JsonElement>>();
        try
        {
            using var document = JsonDocument.Parse(raw);
            if (!document.RootElement.TryGetProperty("map", out JsonElement map) || map.ValueKind != JsonValueKind.Object)
            {
                throw new SpecTableException($"{Path.GetFileName(path)}: no \"map\" object");
            }

            foreach (JsonProperty property in map.EnumerateObject())
            {
                // EnumerateObject yields the document's order, which for these files is ascending.
                // The order does not reach the output - both callers sort - but nothing here ever
                // iterates a Dictionary, so a table read cannot become a table order.
                result.Add(new KeyValuePair<string, JsonElement>(property.Name, property.Value.Clone()));
            }
        }
        catch (JsonException error)
        {
            throw new SpecTableException($"{Path.GetFileName(path)}: not valid JSON: {error.Message}");
        }

        return result;
    }

    private static int ParseKey(string path, string key)
    {
        if (key.Length == 0)
        {
            throw new SpecTableException($"{Path.GetFileName(path)}: empty table key");
        }

        int value = 0;
        foreach (char c in key)
        {
            // Parsed by hand rather than with int.Parse: a table key is a decimal code point in
            // ASCII, and int.Parse would accept a leading sign, whitespace or a group separator
            // according to the current culture.
            if (c < '0' || c > '9')
            {
                throw new SpecTableException($"{Path.GetFileName(path)}: table key \"{key}\" is not a decimal code point");
            }

            value = (value * 10) + (c - '0');
            if (value > 0x10FFFF)
            {
                throw new SpecTableException($"{Path.GetFileName(path)}: table key \"{key}\" is out of range");
            }
        }

        return value;
    }
}

/// <summary>A startup failure that makes the worker unusable: reported on stderr, exit 2.</summary>
internal sealed class SpecTableException : Exception
{
    public SpecTableException(string message)
        : base(message)
    {
    }
}
