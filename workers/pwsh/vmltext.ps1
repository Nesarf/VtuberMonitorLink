#Requires -Version 7.0
<#
  workers/pwsh/vmltext.ps1 - the PowerShell 7 worker of the multilingual text layer.

  Implements the three capabilities of docs/WORKERS.md sections 2-4 -- `text.normalize`,
  `text.extract`, `text.fingerprint` -- behind the stdio JSON-Lines protocol of section 1.

  Usage:
      pwsh -NoProfile -File workers/pwsh/vmltext.ps1 --capability text.normalize
      pwsh -NoProfile -File workers/pwsh/vmltext.ps1 --selfcheck

  Three PowerShell-specific traps this file is built around, all of them documented in the README:

    * stdout. PowerShell makes it very easy to put a line on stdout by accident -- Write-Output, a
      bare expression, a cmdlet that emits a value, an unexpected Write-Host. Any of those becomes
      protocol traffic, and the host counts lines by id, so one stray line looks like a lost case.
      Nothing here is written to stdout except through Write-ProtocolLine, which writes raw UTF-8
      bytes to the standard output stream and flushes.
    * encoding. [Console]::OutputEncoding and [Console]::InputEncoding are set to UTF-8 without a
      BOM, and every byte of the protocol is written and read explicitly as UTF-8. The default input
      encoding on this machine is GBK.
    * code points. .NET strings are UTF-16, so a naive per-character walk yields surrogate halves for
      astral text. text.normalize walks code points with [char]::ConvertToUtf32 /
      [char]::IsHighSurrogate. text.extract and text.fingerprint stay on UTF-16 code units on purpose:
      every code point they classify is inside the BMP (tag names and delimiters are ASCII, and the
      Han/kana/Hangul ranges the contract lists all end below U+FFFF), so a conversion would change
      nothing.

  No modules, no packages, no network, no build step (the artifact IS this file). The case and fold
  tables come from workers/spec/*.json; PowerShell's own culture-aware rules are never consulted --
  this contract wants none of what PowerShell culture would happily do: no normalisation, no
  set-culture comparison, no sorting, no stringification of numbers.
#>

$ErrorActionPreference = 'Stop'

# --------------------------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------------------------
#
# `$args` is read HERE, at script scope, and handed to the entry point. It cannot be read inside a
# function: inside a function `$args` is that function's own leftover-argument list, which is empty,
# so a worker that parsed `$args` in a function would see no arguments, reject the `--capability` it
# was started with and exit 2 without a word. That is exactly what this file did before a file trace
# found it.
$script:Argv = @($args)

# --------------------------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------------------------

$script:CAPABILITIES = @('text.normalize', 'text.extract', 'text.fingerprint')
$script:PROTOCOL_VERSION = 1
$script:LANGUAGE = 'pwsh'
$script:IMPL = 'table-driven'
$script:USAGE = 'usage: vmltext.ps1 --capability <text.normalize|text.extract|text.fingerprint> | --selfcheck'

$script:UTF8_NO_BOM = [System.Text.UTF8Encoding]::new($false)

# --------------------------------------------------------------------------------------------
# Section 1.2: the Windows encoding trap
# --------------------------------------------------------------------------------------------

function Initialize-Encoding {
    # The transport is UTF-8 bytes on all three streams. On a Chinese Windows the defaults are
    # GBK/936, which turns the contract's `text` into mojibake while still looking like it works.
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
}

function Write-ProtocolLine {
    <#
      One protocol line: compact UTF-8 JSON, one LF, nothing else -- and flushed immediately.

      Written as bytes rather than through Write-Output / Write-Host / [Console]::WriteLine for two
      reasons. (1) Nothing else may reach stdout, and a cmdlet is one typo away from sending a string
      there. (2) It guarantees a lone LF on every platform: [Console]::WriteLine uses the host's
      newline, and PowerShell's own output stream is text-mode.
    #>
    param([Parameter(Mandatory)][AllowNull()][object]$Value)
    $json = ConvertTo-ProtocolJson -Value $Value
    $bytes = $script:UTF8_NO_BOM.GetBytes($json + "`n")
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

function Write-TextLine {
    # --selfcheck's English lines. Same stream discipline, different content: that mode is documented
    # as printing one line per case plus a summary and producing no protocol traffic, so the two can
    # never be confused.
    param([string]$Text)
    $bytes = $script:UTF8_NO_BOM.GetBytes($Text + "`n")
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

function Write-Diag {
    # Free-form English diagnostics go to stderr and are flushed, so a crash report cannot arrive
    # after the crash that mattered (docs/WORKERS.md section 1).
    param([string]$Message)
    [Console]::Error.WriteLine($Message)
    [Console]::Error.Flush()
}

# --------------------------------------------------------------------------------------------
# JSON output: serialised by hand
# --------------------------------------------------------------------------------------------
#
# ConvertFrom-Json is fine for input (probed: \uXXXX escapes, surrogate pairs and inline non-ASCII
# all survive it). ConvertTo-Json is NOT used for output, for two reasons that are both contract
# violations waiting to happen:
#
#   * field order. ConvertTo-Json on an [ordered] hashtable does keep insertion order (probed on
#     7.6.6), but key order there is an incidental behaviour of a serializer whose documented knobs
#     are about escaping, not ordering. tools/workers.mjs checks key order explicitly
#     (`keyOrderIssues`), so the order is written down in this emitter rather than inherited.
#   * escaping. ConvertTo-Json escapes non-ASCII to \uXXXX, while JSON.stringify -- the other
#     implementations -- leaves CJK, em dashes and Cyrillic as raw UTF-8. The corpus is full of those,
#     and "byte-identical output JSON" is the point of the exercise.
#
# So the emitter is explicit: JSON.stringify-style escaping (only `"`, `\` and the C0 controls),
# compact separators, integers only.

$script:ESCAPE_RE = [regex]'[\x00-\x1F"\\]'

function ConvertTo-JsonStringLiteral {
    param([string]$Text)
    $literal = $script:ESCAPE_RE.Replace($Text, {
            param($m)
            $c = $m.Value
            switch ($c) {
                '"' { return '\"' }
                '\' { return '\\' }
                "`b" { return '\b' }
                "`f" { return '\f' }
                "`n" { return '\n' }
                "`r" { return '\r' }
                "`t" { return '\t' }
                default { return '\u' + ([int][char]$c).ToString('x4') }
            }
        })
    return '"' + $literal + '"'
}

function ConvertTo-ProtocolJson {
    <#
      Serialise one protocol value. Only the shapes this worker produces are supported: string,
      int/long, bool, ordered dictionary (object, in its own key order), and any enumerable (array).
      Anything else is an `internal` error -- a double cannot be formatted by this emitter, and
      docs/WORKERS.md forbids locale-dependent number formatting, so it is reported rather than
      stringified.
    #>
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) { return 'null' }
    if ($Value -is [string]) { return (ConvertTo-JsonStringLiteral -Text $Value) }
    if ($Value -is [bool]) { if ($Value) { return 'true' } else { return 'false' } }
    if ($Value -is [int] -or $Value -is [long]) {
        return ([System.Convert]::ToString($Value, [System.Globalization.CultureInfo]::InvariantCulture))
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $parts = [System.Collections.Generic.List[string]]::new()
        foreach ($key in $Value.Keys) {
            $parts.Add((ConvertTo-JsonStringLiteral -Text ([string]$key)) + ':' + (ConvertTo-ProtocolJson -Value $Value[$key]))
        }
        return '{' + ($parts -join ',') + '}'
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $parts = [System.Collections.Generic.List[string]]::new()
        foreach ($item in $Value) { $parts.Add((ConvertTo-ProtocolJson -Value $item)) }
        return '[' + ($parts -join ',') + ']'
    }
    throw [System.InvalidOperationException]::new('cannot serialise a value of type ' + $Value.GetType().FullName)
}

function Get-NewList {
    <#
      A fresh List of the given element type.

      The unary comma is load-bearing: PowerShell unrolls an IEnumerable returned from a function, so
      returning an *empty* List would hand the caller $null and the first Add() would fail with "you
      cannot call a method on a null-valued expression".
    #>
    param([string]$ElementType)
    if ($ElementType -eq 'object') { return , ([System.Collections.Generic.List[object]]::new()) }
    if ($ElementType -eq 'string') { return , ([System.Collections.Generic.List[string]]::new()) }
    throw [System.InvalidOperationException]::new('unsupported list element type ' + $ElementType)
}

# --------------------------------------------------------------------------------------------
# The shared tables (workers/spec/*.json). Section 2: nobody consults their own runtime's tables.
# --------------------------------------------------------------------------------------------

$script:LOWER = $null
$script:FOLD = $null
$script:DIRECT = $null       # steps 1+2: code point -> replacement string ('' means delete)
$script:LOWER_CHAR = $null   # step 3: code point -> lowercase code point, as a one-char string
$script:FOLD_CHAR = $null    # step 4: code point -> ASCII string of one or two characters
$script:SPEC_DIR = ''

function Get-MapTable {
    param([string]$FileName)
    $path = Join-Path $script:SPEC_DIR $FileName
    $raw = Get-Content -LiteralPath $path -Raw -Encoding utf8
    $parsed = ConvertFrom-Json $raw
    $map = [System.Collections.Generic.Dictionary[int, object]]::new()
    foreach ($prop in $parsed.map.psobject.Properties) {
        $map[[int]$prop.Name] = $prop.Value
    }
    return , $map
}

function Initialize-Tables {
    <#
      Steps 1 and 2 collapse into one lookup (`$DIRECT`: code point -> replacement string, where the
      empty string means "delete"), because both are per-code-point and neither feeds the other.
      Steps 3 and 4 stay as their own tables and are applied in order to the code points of the step-2
      result.

      Fusing steps 3 and 4 into `$DIRECT` as well -- "source code point -> final string" -- is the
      obvious optimisation and it is wrong: it folds characters that only exist because the map table
      produced them, so a chain runs twice through a table the contract says runs once. That bug was
      caught here by the cross-implementation diff: `fullwidth-ascii` came out "ABC" instead of "abc",
      because the full-width A mapped to 'A' and the fused table had already spent step 3 on the
      source before step 4 saw the result. Two tables, applied in order, is what "in this order" means.
    #>
    $script:LOWER = Get-MapTable -FileName 'latin-lower.json'
    $script:FOLD = Get-MapTable -FileName 'latin-fold.json'

    $direct = [System.Collections.Generic.Dictionary[int, string]]::new()

    # Step 2, one shape at a time.
    foreach ($cp in @(0x00A0, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
            0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000)) {
        $direct[$cp] = ' '
    }
    for ($cp = 0xFF01; $cp -le 0xFF5E; $cp++) { $direct[$cp] = [string][char]($cp - 0xFEE0) }
    foreach ($cp in @(0x2018, 0x2019, 0x201B, 0x2032)) { $direct[$cp] = "'" }
    foreach ($cp in @(0x201C, 0x201D, 0x201F, 0x2033)) { $direct[$cp] = '"' }
    foreach ($cp in @(0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212)) { $direct[$cp] = '-' }
    $direct[0x2026] = '...'
    $direct[0x3001] = ','
    $direct[0x3002] = '.'

    # Step 1: deletions. "No entry" is not enough, because a code point with no mapping must be left
    # alone rather than dropped, so deletions are recorded as the empty string.
    foreach ($range in @(
            @(0x0000, 0x0008), @(0x000B, 0x000C), @(0x000E, 0x001F), @(0x007F, 0x007F),
            @(0x0300, 0x036F), @(0x1AB0, 0x1AFF), @(0x1DC0, 0x1DFF), @(0x200B, 0x200F),
            @(0x202A, 0x202E), @(0x2060, 0x2064), @(0x20D0, 0x20FF), @(0xFE20, 0xFE2F),
            @(0xFEFF, 0xFEFF))) {
        for ($cp = [int]$range[0]; $cp -le [int]$range[1]; $cp++) { $direct[$cp] = '' }
    }
    $script:DIRECT = $direct

    $script:LOWER_CHAR = [System.Collections.Generic.Dictionary[int, string]]::new()
    foreach ($key in $script:LOWER.Keys) {
        $script:LOWER_CHAR[[int]$key] = [string][char]([int]$script:LOWER[$key])
    }
    $script:FOLD_CHAR = [System.Collections.Generic.Dictionary[int, string]]::new()
    foreach ($key in $script:FOLD.Keys) {
        $script:FOLD_CHAR[[int]$key] = [string]$script:FOLD[$key]
    }
}

# --------------------------------------------------------------------------------------------
# Capability text.normalize (docs/WORKERS.md section 2)
# --------------------------------------------------------------------------------------------

function Get-CodePoints {
    <#
      UTF-16 string -> its code points, as a List[int].

      .NET strings are UTF-16, so a string built from an astral code point is a surrogate PAIR. Walking
      such a string by index and treating every unit as a code point hands a lone surrogate to
      [char]::ConvertFromUtf32, which rejects it -- that is not a wrong answer, it is an exception, and
      the whole request turns into `bad-input`. Surrogate pairs are therefore folded with
      [char]::ConvertToUtf32 / [char]::IsHighSurrogate here.

      The unary comma is load-bearing (PowerShell unrolls a returned enumerable; an empty List would
      arrive as $null, and a one-element List as its element).
    #>
    param([string]$Text)
    $points = [System.Collections.Generic.List[int]]::new($Text.Length)
    $n = $Text.Length
    $i = 0
    while ($i -lt $n) {
        $ch = $Text[$i]
        if ([char]::IsHighSurrogate($ch) -and ($i + 1) -lt $n -and [char]::IsLowSurrogate($Text[$i + 1])) {
            $points.Add([char]::ConvertToUtf32($ch, $Text[$i + 1]))
            $i += 2
            continue
        }
        $points.Add([int]$ch)
        $i++
    }
    return , $points
}

function ConvertTo-Normalized {
    <#
      Steps 1-6 in the contract's order, over Unicode scalar values.
    #>
    param([string]$Text)

    $direct = $script:DIRECT
    $lowered = $script:LOWER_CHAR
    $folded = $script:FOLD_CHAR
    $mapped = [System.Text.StringBuilder]::new($Text.Length)
    $n = $Text.Length
    $i = 0
    while ($i -lt $n) {
        $ch = $Text[$i]
        if ([char]::IsHighSurrogate($ch) -and ($i + 1) -lt $n -and [char]::IsLowSurrogate($Text[$i + 1])) {
            $cp = [char]::ConvertToUtf32($ch, $Text[$i + 1])
            $i += 2
        }
        else {
            $cp = [int]$ch
            $i++
        }

        $piece = $null
        if ($direct.TryGetValue($cp, [ref]$piece)) {
            if ($piece.Length -eq 0) { continue }   # step 1: this code point is deleted
        }
        else {
            $piece = [char]::ConvertFromUtf32($cp)
        }

        # Steps 3 and 4, applied to each CODE POINT of the step-2 replacement, each exactly once.
        #
        # A replacement for an astral code point is a surrogate pair, so walking the string by index
        # would feed step 3 a lone surrogate (a table miss, harmless) and then step 4 a
        # [char]::ConvertFromUtf32 call on that surrogate -- which throws, and the whole request turns
        # into `bad-input`. This is the bug tools/workers-diff.mjs found on "\u{1F600}". BMP
        # replacements (every entry in the map table) are one code unit and keep the straight-line
        # path, which is what keeps the 10 KB corpus case fast.
        if ($piece.Length -eq 1 -and -not [char]::IsHighSurrogate($piece[0])) {
            $pcp = [int]$piece[0]
            $lowerChar = $null
            if ($lowered.TryGetValue($pcp, [ref]$lowerChar)) { $pcp = [int][char]$lowerChar }
            $foldChar = $null
            if ($folded.TryGetValue($pcp, [ref]$foldChar)) { [void]$mapped.Append($foldChar) }
            else { [void]$mapped.Append([char]::ConvertFromUtf32($pcp)) }
            continue
        }
        foreach ($pcp in (Get-CodePoints -Text $piece)) {
            $lowerChar = $null
            if ($lowered.TryGetValue($pcp, [ref]$lowerChar)) { $pcp = [int][char]$lowerChar }
            $foldChar = $null
            if ($folded.TryGetValue($pcp, [ref]$foldChar)) { [void]$mapped.Append($foldChar) }
            else { [void]$mapped.Append([char]::ConvertFromUtf32($pcp)) }
        }
    }

    # Steps 5 and 6 in one pass: a run of space/tab/LF/CR becomes one space, and a separator that would
    # land at either end is dropped, so leading and trailing runs need no second pass.
    #
    # Indexed rather than `foreach ($ch in $source)`: in PowerShell 7.6 `foreach` over a [string]
    # enumerates the string as ONE item, so the loop body would see the whole text and `[char]$ch`
    # would fail with "String must be exactly one character long". `for` with an index is the only
    # reliable per-character walk.
    $source = $mapped.ToString()
    $out = [System.Text.StringBuilder]::new($source.Length)
    $pendingSpace = $false
    for ($k = 0; $k -lt $source.Length; $k++) {
        $ch = $source[$k]
        if ($ch -eq ' ' -or $ch -eq "`t" -or $ch -eq "`n" -or $ch -eq "`r") {
            if ($out.Length -gt 0) { $pendingSpace = $true }
            continue
        }
        if ($pendingSpace) {
            [void]$out.Append(' ')
            $pendingSpace = $false
        }
        [void]$out.Append($ch)
    }
    return $out.ToString()
}

# --------------------------------------------------------------------------------------------
# Capability text.extract (docs/WORKERS.md section 3)
# --------------------------------------------------------------------------------------------

$script:REMOVED_ELEMENTS = @('script', 'style', 'noscript', 'template', 'svg', 'iframe')
$script:NEWLINE_ELEMENTS = [System.Collections.Generic.HashSet[string]]::new([string[]]@(
        'br', 'p', 'div', 'li', 'ul', 'ol', 'tr', 'th', 'td', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'section', 'article', 'header', 'footer', 'aside', 'nav', 'blockquote', 'pre', 'table', 'hr',
        'dd', 'dt', 'figure', 'figcaption', 'main', 'form'), [System.StringComparer]::Ordinal)

$script:NAMED_ENTITIES = [System.Collections.Generic.Dictionary[string, string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($pair in @(
        @('amp', '&'), @('lt', '<'), @('gt', '>'), @('quot', '"'), @('apos', "'"),
        @('nbsp', [string][char]0x00A0), @('mdash', [string][char]0x2014), @('ndash', [string][char]0x2013),
        @('hellip', [string][char]0x2026), @('laquo', [string][char]0x00AB), @('raquo', [string][char]0x00BB),
        @('copy', [string][char]0x00A9), @('reg', [string][char]0x00AE), @('trade', [string][char]0x2122),
        @('times', [string][char]0x00D7), @('middot', [string][char]0x00B7))) {
    $script:NAMED_ENTITIES[$pair[0]] = $pair[1]
}

# `#DDD` (1-7 decimal) | `#xHHH` (1-6 hex) | a name (1-8 alphanumerics, starting with a letter),
# optionally followed by the terminating semicolon. Same shape as the reference's regex, and it is why
# `&copy2024` stays literal: the name run is maximal and is not backtracked.
$script:ENTITY_RE = [regex]'^(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,7})(;?)'
$script:SCHEME_RE = [regex]'^[A-Za-z][A-Za-z0-9+.-]*:'
# IgnoreCase, and it matters: the reference regex has the `i` flag, while a PowerShell `[regex]'...'`
# literal is case-SENSITIVE by default (PowerShell's own -match is not, which makes this a trap). Without
# it, `<A HREF="C">` loses its href entirely -- found by tools/workers-diff.mjs, which generates
# uppercase attribute names that the hand-written corpus never had.
# `[regex]` takes ONE argument: `[regex]'pattern', $options` is not a constructor call, it is a cast of
# the options enum to a string, and the resulting pattern then fails to compile at first use ("internal"
# for every request). The real constructor is used explicitly here.
$script:HREF_RE = [System.Text.RegularExpressions.Regex]::new('\bhref\s*=\s*("([^"]*)"|''([^'']*)''|([^\s>]+))', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
$script:TAG_NAME_RE = [regex]'^/?\s*([A-Za-z][A-Za-z0-9:-]*)'
# A CDATA section is hidden before any other pass runs; an unclosed one keeps everything to the end of
# the input (the same principle as a removed element with no closing tag).
#
# `\z`, NOT `$`: in .NET an unanchored `$` also matches just BEFORE a trailing "\n", while JavaScript's
# `$` (without `m`) matches only at the very end. Writing `$` here left that trailing newline in the
# source, so `"<p>a</p><!-- unclosed\n"` produced one newline too many. `\z` is the exact end of the
# input, which is what the JavaScript `$` means.
$script:CDATA_RE = [regex]'<!\[CDATA\[([\s\S]*?)(?:\]\]>|\z)'
$script:COMMENT_RE = [regex]'<!--[\s\S]*?(?:-->|\z)'
$script:DOCTYPE_RE = [regex]'<!DOCTYPE[^>]*>'
$script:ENTITY_WINDOW = 12

function Test-AsciiLetter {
    param([char]$Char)
    return (($Char -ge 'A' -and $Char -le 'Z') -or ($Char -ge 'a' -and $Char -le 'z'))
}

function Test-AsciiDigit {
    param([char]$Char)
    return ($Char -ge '0' -and $Char -le '9')
}

function Test-TagStartChar {
    # `<` starts a tag only when followed by [A-Za-z/!]; otherwise it is literal text.
    param([char]$Char)
    return ((Test-AsciiLetter -Char $Char) -or $Char -eq '/' -or $Char -eq '!')
}

function Get-TagEnd {
    <#
      Index of the `>` that ends the tag starting at `Index` (which points at `<`), or -1 when the input
      ends inside the tag. Quote-aware on purpose: `'` and `"` delimit attribute values and a `>` inside
      them does not end the tag.
    #>
    param([string]$Text, [int]$Index)
    $j = $Index
    $n = $Text.Length
    while ($j -lt $n) {
        $ch = $Text[$j]
        if ($ch -eq '"' -or $ch -eq "'") {
            $k = $Text.IndexOf($ch, $j + 1)
            if ($k -lt 0) { return -1 }
            $j = $k + 1
            continue
        }
        if ($ch -eq '>') { return $j }
        $j++
    }
    return -1
}

function Get-TagName {
    # `/?` then optional whitespace then [A-Za-z][A-Za-z0-9:-]*, lowercased as ASCII.
    param([string]$RawTag)
    $m = $script:TAG_NAME_RE.Match($RawTag)
    if (-not $m.Success) { return '' }
    return $m.Groups[1].Value.ToLowerInvariant()
}

function Get-DecodedEntity {
    <#
      Decode the entity at `Index` (which points at `&`); returns @(text, nextIndex) or $null.

      Named entities are matched case-insensitively and are accepted with or without the trailing
      semicolon, as browsers do; numeric references `&#DDD` (1-7 decimal digits) and `&#xHHH` / `&#XHHH`
      (1-6 hex digits) likewise. The reference is looked for within 12 characters of the `&` and there
      is no backtracking, so `&copy2024` stays literal and an unknown name stays verbatim. A numeric
      value outside the Unicode scalar range is left verbatim: the contract does not describe a
      replacement, and inventing one would diverge from the other languages.

      The unary comma is required: without it the two-element array is unrolled by the return path and
      the caller sees only the decoded string, so `$decoded[1]` would be a character of it.
    #>
    param([string]$Text, [int]$Index)
    $start = $Index + 1
    $available = $Text.Length - $start
    if ($available -le 0) { return $null }
    $take = [Math]::Min($script:ENTITY_WINDOW, $available)
    $m = $script:ENTITY_RE.Match($Text.Substring($start, $take))
    if (-not $m.Success) { return $null }
    $body = $m.Groups[1].Value
    $hasSemi = ($m.Groups[2].Value -eq ';')
    $end = $start + $body.Length
    if ($hasSemi) { $end++ }

    if ($body[0] -eq '#') {
        $hex = ($body.Length -gt 1 -and ($body[1] -eq 'x' -or $body[1] -eq 'X'))
        $digits = $body.Substring($(if ($hex) { 2 } else { 1 }))
        $value = [long]0
        for ($d = 0; $d -lt $digits.Length; $d++) {
            $digit = $digits[$d]
            if ($hex) { $value = $value * 16 + [System.Convert]::ToInt32([string]$digit, 16) }
            else { $value = $value * 10 + ([int]$digit - [int][char]'0') }
        }
        if ($value -gt 0x10FFFF -or ($value -ge 0xD800 -and $value -le 0xDFFF)) { return $null }
        return , @([char]::ConvertFromUtf32([int]$value), $end)
    }

    $decoded = $null
    if ($script:NAMED_ENTITIES.TryGetValue($body, [ref]$decoded)) {
        return , @($decoded, $end)
    }
    return $null
}

function Get-AttributeValue {
    # The first `href` attribute of a raw tag body. A `>` inside a quoted value is part of the value.
    param([string]$RawTag)
    $m = $script:HREF_RE.Match($RawTag)
    if (-not $m.Success) { return '' }
    if ($m.Groups[2].Success) { return $m.Groups[2].Value }
    if ($m.Groups[3].Success) { return $m.Groups[3].Value }
    if ($m.Groups[4].Success) { return $m.Groups[4].Value }
    return ''
}

function Test-AbsoluteHref {
    # `[A-Za-z][A-Za-z0-9+.-]*:` at the start of the href -- nothing else, and no URL resolution.
    param([string]$Href)
    return $script:SCHEME_RE.IsMatch($Href)
}

function New-LinkEntry {
    # One link entry, in the key order the contract lists: href, absolute, text.
    param([string]$Href, [System.Text.StringBuilder]$Buffer)
    $entry = [ordered]@{}
    $entry['href'] = $Href
    $entry['absolute'] = (Test-AbsoluteHref -Href $Href)
    $entry['text'] = $Buffer.ToString()
    return $entry
}

function Restore-CdataText {
    <#
      Puts the hidden CDATA bodies back, now that no rule can mistake them for markup. The sentinel is
      U+E000 <index> U+E001 -- private-use code points, which cannot occur in a feed by accident -- and
      the replacement is verbatim: a CDATA body is character data, so nothing inside it is re-parsed and
      an `&` inside it is not decoded.
    #>
    param([string]$Text, [System.Collections.Generic.List[string]]$Bodies)
    if ($Text.IndexOf([char]0xE000) -lt 0) { return $Text }
    $out = [System.Text.StringBuilder]::new($Text.Length)
    $k = 0
    while ($k -lt $Text.Length) {
        if ($Text[$k] -eq [char]0xE000) {
            $digits = ''
            $j = $k + 1
            while ($j -lt $Text.Length -and (Test-AsciiDigit -Char $Text[$j])) {
                $digits += $Text[$j]
                $j++
            }
            if ($digits.Length -gt 0 -and $j -lt $Text.Length -and $Text[$j] -eq [char]0xE001) {
                $index = [int]::Parse($digits, [System.Globalization.CultureInfo]::InvariantCulture)
                if ($index -ge 0 -and $index -lt $Bodies.Count) { [void]$out.Append($Bodies[$index]) }
                $k = $j + 1
                continue
            }
        }
        [void]$out.Append($Text[$k])
        $k++
    }
    return $out.ToString()
}

function ConvertTo-Extracted {
    <#
      The state machine of section 3.

      The passes run in the order the contract prescribes, which is not the numbering of its rules: hide
      every CDATA body first, then remove comments and doctypes, then remove the listed elements with
      their content, and only then walk what is left. Hiding CDATA first is what makes
      `cdata-inside-removed-element` come out right (the whole section disappears with the element it
      sits in) while a `<script>` inside a CDATA BODY survives as text: the body is not markup, and no
      later pass ever sees it.

      `baseUrl` is accepted and deliberately ignored: resolving URLs would need a URI library the layer
      does not have, and it would put a network-semantics question inside a text function.
    #>
    param([string]$Html)

    $bodies = Get-NewList -ElementType 'string'
    $holder = [System.Text.StringBuilder]::new($Html.Length)
    $cursor = 0
    foreach ($m in $script:CDATA_RE.Matches($Html)) {
        [void]$holder.Append($Html.Substring($cursor, $m.Index - $cursor))
        [void]$holder.Append([char]0xE000)
        [void]$holder.Append([System.Convert]::ToString($bodies.Count, [System.Globalization.CultureInfo]::InvariantCulture))
        [void]$holder.Append([char]0xE001)
        $bodies.Add($m.Groups[1].Value)
        $cursor = $m.Index + $m.Length
    }
    [void]$holder.Append($Html.Substring($cursor))
    $src = $holder.ToString()

    $src = $script:COMMENT_RE.Replace($src, '')
    $src = $script:DOCTYPE_RE.Replace($src, '')

    # Step 1: the removed elements go with their content; a missing closing tag means "to the end of
    # input". Sequential per element, exactly like the reference: the order between different element
    # names cannot matter, because each pass only deletes text.
    foreach ($tag in $script:REMOVED_ELEMENTS) {
        $pattern = '<' + $tag + '\b[^>]*>[\s\S]*?(?:</' + $tag + '\s*>|$)'
        $src = [regex]::Replace($src, $pattern, '', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    }

    $text = [System.Text.StringBuilder]::new($src.Length)
    $titleOut = [System.Text.StringBuilder]::new()
    $links = Get-NewList -ElementType 'object'
    $pending = $null      # the currently open <a>: @{ href = ...; buffer = ... }
    $titleSeen = $false
    $inTitle = $false
    $images = 0

    $n = $src.Length
    $i = 0
    while ($i -lt $n) {
        $ch = $src[$i]

        if ($ch -eq '<') {
            $next = ''
            if (($i + 1) -lt $n) { $next = $src[$i + 1] }
            if ($next.Length -eq 0 -or -not (Test-TagStartChar -Char $next)) {
                # `<` with nothing after it, or followed by something that cannot start a tag, is
                # literal text (the browser's tag-open state).
                if ($inTitle) { [void]$titleOut.Append($ch) } else { [void]$text.Append($ch) }
                if (-not $inTitle -and $null -ne $pending) { [void]$pending['buffer'].Append($ch) }
                $i++
                continue
            }

            $end = Get-TagEnd -Text $src -Index $i
            if ($end -lt 0) {
                # End of input inside a tag: the incomplete tag is dropped, including the characters of
                # its name -- `extract("abc<b").text` is "abc" -- and it contributes no newline, no link
                # and no image either.
                break
            }
            $raw = $src.Substring($i + 1, $end - $i - 1)
            $i = $end + 1
            $closing = $raw.StartsWith('/')
            $name = Get-TagName -RawTag $raw

            if ($name -eq 'title') {
                if (-not $closing -and -not $titleSeen) {
                    $inTitle = $true
                    $titleSeen = $true
                }
                elseif ($closing -and $inTitle) {
                    $inTitle = $false
                }
                continue
            }

            if ($name -eq 'img' -and -not $closing) { $images++ }

            if ($name -eq 'a') {
                if (-not $closing) {
                    # HTML does not allow nested anchors: a browser closes the open one and starts the
                    # new one, so the outer link is reported with the text it collected. Each open
                    # anchor therefore needs its OWN buffer: sharing one buffer and clearing it on the
                    # inner `<a>` gives the outer link the inner link's text (or an empty one).
                    if ($null -ne $pending) {
                        $links.Add((New-LinkEntry -Href $pending['href'] -Buffer $pending['buffer']))
                        $pending = $null
                    }
                    $pending = @{
                        href   = (Get-AttributeValue -RawTag $raw)
                        buffer = [System.Text.StringBuilder]::new()
                    }
                }
                elseif ($null -ne $pending) {
                    $links.Add((New-LinkEntry -Href $pending['href'] -Buffer $pending['buffer']))
                    $pending = $null
                }
                continue
            }

            if ($script:NEWLINE_ELEMENTS.Contains($name)) {
                if ($inTitle) { [void]$titleOut.Append("`n") } else { [void]$text.Append("`n") }
                if (-not $inTitle -and $null -ne $pending) { [void]$pending['buffer'].Append("`n") }
            }
            continue
        }

        if ($ch -eq '&') {
            $decoded = Get-DecodedEntity -Text $src -Index $i
            if ($null -ne $decoded) {
                $piece = [string]$decoded[0]
                # While a <title> is open its text belongs to the title and to nothing else: not to the
                # body, and not to an anchor that happens to contain it.
                if ($inTitle) { [void]$titleOut.Append($piece) } else { [void]$text.Append($piece) }
                if (-not $inTitle -and $null -ne $pending) { [void]$pending['buffer'].Append($piece) }
                $i = [int]$decoded[1]
                continue
            }
        }

        if ($inTitle) { [void]$titleOut.Append($ch) } else { [void]$text.Append($ch) }
        if (-not $inTitle -and $null -ne $pending) { [void]$pending['buffer'].Append($ch) }
        $i++
    }

    if ($null -ne $pending) {
        # An anchor still open at the end of input is reported with the text it collected.
        $links.Add((New-LinkEntry -Href $pending['href'] -Buffer $pending['buffer']))
    }

    foreach ($entry in $links) {
        $entry['text'] = Restore-CdataText -Text $entry['text'] -Bodies $bodies
    }

    $result = [ordered]@{}
    $result['title'] = Restore-CdataText -Text $titleOut.ToString() -Bodies $bodies
    $result['text'] = Restore-CdataText -Text $text.ToString() -Bodies $bodies
    $result['links'] = $links
    $result['images'] = $images
    return $result
}

# --------------------------------------------------------------------------------------------
# Capability text.fingerprint (docs/WORKERS.md section 4)
# --------------------------------------------------------------------------------------------

$script:PUNCT_SET = [System.Collections.Generic.HashSet[char]]::new([char[]]'!?,.;:''"()[]{}<>-_/\|*+=~`@#$%^&')
$script:FNV_OFFSET = [long]0
$script:FNV_PRIME = 1099511628211L
$script:FNV_PRIME_LO = [long]0
$script:FNV_PRIME_HI = [long]0
$script:HEX_DIGITS_LOWER = '0123456789abcdef'

function Initialize-FingerprintTables {
    <#
      FNV-1a's offset basis is 14695981039346656037, which does not fit in an Int64 literal and cannot be
      cast into one either (`[long]14695981039346656037` is a conversion error, `[long][uint64]...`
      throws, and a plain `[long]*[long]` multiply overflows into a Double and loses the low bits --
      exactly the trap the contract's "unsigned arithmetic throughout" warns about). So the constant is
      parsed from its two 32-bit halves as unchecked two's complement, and the multiply is done as a
      64x64 -> low 64 widening multiply built out of 32-bit products, in Int64, where the only operation
      that can overflow is `-shl` and `-shl` wraps by definition.
    #>
    $hi = [System.Convert]::ToInt64('cbf29ce4', 16)
    $lo = [System.Convert]::ToInt64('84222325', 16)
    $script:FNV_OFFSET = (($hi -shl 32) -bor ($lo -band 0xFFFFFFFFL))
    $script:FNV_PRIME_LO = ($script:FNV_PRIME -band 0xFFFFFFFFL)
    $script:FNV_PRIME_HI = (($script:FNV_PRIME -shr 32) -band 0xFFFFFFFFL)
}

function Get-Fnv1a64 {
    # FNV-1a over the UTF-8 bytes, unsigned 64-bit, returned as the Int64 with the same bit pattern.
    param([string]$Shingle)
    $bytes = $script:UTF8_NO_BOM.GetBytes($Shingle)
    $h = $script:FNV_OFFSET
    $primeLo = $script:FNV_PRIME_LO
    $primeHi = $script:FNV_PRIME_HI
    foreach ($b in $bytes) {
        $h = $h -bxor [long]$b
        $lo = $h -band 0xFFFFFFFFL
        $hi = ($h -shr 32) -band 0xFFFFFFFFL
        $low = $lo * $primeLo
        $cross = (($low -shr 32) -band 0xFFFFFFFFL) + (($lo * $primeHi) -band 0xFFFFFFFFL) + (($hi * $primeLo) -band 0xFFFFFFFFL)
        $h = (($cross -band 0xFFFFFFFFL) -shl 32) -bor ($low -band 0xFFFFFFFFL)
    }
    return $h
}

function Test-CjkCodePoint {
    param([int]$CodePoint)
    return (($CodePoint -ge 0x3400 -and $CodePoint -le 0x4DBF) -or
        ($CodePoint -ge 0x4E00 -and $CodePoint -le 0x9FFF) -or
        ($CodePoint -ge 0xF900 -and $CodePoint -le 0xFAFF) -or
        ($CodePoint -ge 0x3040 -and $CodePoint -le 0x30FF) -or
        ($CodePoint -ge 0xAC00 -and $CodePoint -le 0xD7AF))
}

function Get-TokenList {
    <#
      Section 4's tokenizer, on UTF-16 code units: every code point it classifies (the ASCII punctuation
      set, Han, kana, Hangul) is inside the BMP, so a surrogate pair would be "other" either way and
      converting would change nothing.

      Two PowerShell notes: `[char]` is cast explicitly because HashSet[char].Contains() binds an
      argument of that type, and the per-character walk is indexed rather than `foreach` (see the note
      in ConvertTo-Normalized).
    #>
    param([string]$Text)
    $tokens = Get-NewList -ElementType 'string'
    foreach ($word in $Text.Split(' ')) {
        if ($word.Length -eq 0) { continue }
        $start = 0
        $stop = $word.Length
        while ($start -lt $stop -and $script:PUNCT_SET.Contains([char]$word[$start])) { $start++ }
        while ($stop -gt $start -and $script:PUNCT_SET.Contains([char]$word[$stop - 1])) { $stop-- }
        if ($stop -le $start) { continue }
        $trimmed = $word.Substring($start, $stop - $start)

        $allPunct = $true
        for ($p = 0; $p -lt $trimmed.Length; $p++) {
            if (-not $script:PUNCT_SET.Contains([char]$trimmed[$p])) { $allPunct = $false; break }
        }
        if ($allPunct) { continue }

        $run = [System.Text.StringBuilder]::new()
        $runCjk = $false
        $haveRun = $false
        for ($q = 0; $q -lt $trimmed.Length; $q++) {
            $ch = $trimmed[$q]
            $cjk = Test-CjkCodePoint -CodePoint ([int][char]$ch)
            if ($haveRun -and $cjk -ne $runCjk) {
                if ($runCjk) {
                    $chars = $run.ToString()
                    if ($chars.Length -eq 1) { $tokens.Add($chars) }
                    else { for ($k = 0; $k + 1 -lt $chars.Length; $k++) { $tokens.Add($chars.Substring($k, 2)) } }
                }
                else {
                    $tokens.Add($run.ToString())
                }
                [void]$run.Clear()
            }
            [void]$run.Append($ch)
            $runCjk = $cjk
            $haveRun = $true
        }
        if ($run.Length -gt 0) {
            if ($runCjk) {
                $chars = $run.ToString()
                if ($chars.Length -eq 1) { $tokens.Add($chars) }
                else { for ($k = 0; $k + 1 -lt $chars.Length; $k++) { $tokens.Add($chars.Substring($k, 2)) } }
            }
            else {
                $tokens.Add($run.ToString())
            }
        }
    }
    return , $tokens
}

function Get-Fingerprint {
    param([string]$Text)
    $tokens = Get-TokenList -Text $Text
    $count = $tokens.Count

    $shingles = Get-NewList -ElementType 'string'
    if ($count -ge 3) {
        for ($k = 0; $k + 3 -le $count; $k++) {
            $shingles.Add($tokens[$k] + ' ' + $tokens[$k + 1] + ' ' + $tokens[$k + 2])
        }
    }
    elseif ($count -gt 0) {
        $shingles.Add(($tokens -join ' '))
    }

    $counters = [int[]]::new(64)
    foreach ($shingle in $shingles) {
        $h = Get-Fnv1a64 -Shingle $shingle
        for ($bit = 0; $bit -lt 64; $bit++) {
            if ((($h -shr $bit) -band 1L) -eq 1L) { $counters[$bit]++ } else { $counters[$bit]-- }
        }
    }

    $hash = [long]0
    for ($bit = 0; $bit -lt 64; $bit++) { if ($counters[$bit] -gt 0) { $hash = $hash -bor (1L -shl $bit) } }

    $hex = [System.Text.StringBuilder]::new(16)
    for ($nibble = 15; $nibble -ge 0; $nibble--) {
        $index = [int](($hash -shr ($nibble * 4)) -band 0xFL)
        [void]$hex.Append($script:HEX_DIGITS_LOWER[$index])
    }

    $result = [ordered]@{}
    $result['simhash'] = $hex.ToString()
    $result['tokens'] = $count
    $result['shingles'] = $shingles.Count
    return $result
}

# --------------------------------------------------------------------------------------------
# Protocol (docs/WORKERS.md section 1)
# --------------------------------------------------------------------------------------------

function Get-DescribeResponse {
    param([string]$Capability, [AllowNull()][object]$Id)
    $worker = [ordered]@{}
    $worker['protocol'] = $script:PROTOCOL_VERSION
    $worker['capability'] = $Capability
    $worker['language'] = $script:LANGUAGE
    $worker['impl'] = $script:IMPL
    $worker['runtime'] = 'PowerShell ' + $PSVersionTable.PSVersion.ToString()
    $worker['deterministic'] = $true
    $response = [ordered]@{}
    $response['id'] = $Id
    $response['ok'] = $true
    $response['worker'] = $worker
    return $response
}

function Get-OkResponse {
    param([AllowNull()][object]$Id, [object]$Output)
    $response = [ordered]@{}
    $response['id'] = $Id
    $response['ok'] = $true
    $response['output'] = $Output
    return $response
}

function Get-ErrorResponse {
    param([AllowNull()][object]$Id, [string]$Code, [string]$Message)
    $errorBody = [ordered]@{}
    $errorBody['code'] = $Code
    $errorBody['message'] = $Message
    $response = [ordered]@{}
    $response['id'] = $Id
    $response['ok'] = $false
    $response['error'] = $errorBody
    return $response
}

function Get-PropertyValue {
    <#
      Returns @(present, value) for a JSON object's property. The lookup is case-sensitive, because
      PowerShell member lookup is not: `$obj.Text` would find `text` and quietly accept a spelling the
      contract does not have.

      The unary comma is load-bearing (without it the array is unrolled and the caller sees only the
      boolean), and the parameter is not called `$input` -- see ConvertTo-CapabilityOutput.
    #>
    param([object]$JsonObject, [string]$Name)
    if ($JsonObject -is [System.Collections.IDictionary]) {
        foreach ($key in $JsonObject.Keys) {
            if (([string]$key) -ceq $Name) { return , @($true, $JsonObject[$key]) }
        }
        return , @($false, $null)
    }
    foreach ($prop in $JsonObject.psobject.Properties) {
        if ($prop.Name -ceq $Name) { return , @($true, $prop.Value) }
    }
    return , @($false, $null)
}

function Get-RequestField {
    # @(op, id) of a parsed request. Case-sensitive, like Get-PropertyValue.
    param([object]$Request)
    $op = $null
    $id = $null
    foreach ($prop in $Request.psobject.Properties) {
        if ($prop.Name -ceq 'op') { $op = $prop.Value }
        elseif ($prop.Name -ceq 'id') { $id = $prop.Value }
    }
    return , @($op, $id)
}

function ConvertTo-CapabilityOutput {
    <#
      `$Payload`, never `$Input`: `$Input` is a PowerShell *automatic* variable (the pipeline-input
      enumerator) and a parameter with that name is silently overwritten by it. The symptom is vicious
      -- the parameter binds, then immediately contains an ArrayList+ArrayListEnumeratorSimple instead
      of the JSON object, every property lookup misses, and a perfectly good request comes back as
      "input.text must be a string" (with four parameters, every argument simply shifts position).
    #>
    param([string]$Capability, [AllowNull()][object]$Payload)

    if ($null -eq $Payload -or $Payload -is [string] -or $Payload -is [System.ValueType] -or
        $Payload -is [System.Array]) {
        throw [System.ArgumentException]::new('input must be an object')
    }

    if ($Capability -eq 'text.extract') {
        $found = Get-PropertyValue -JsonObject $Payload -Name 'html'
        if (-not $found[0] -or -not ($found[1] -is [string])) {
            throw [System.ArgumentException]::new('input.html must be a string')
        }
        $baseFound = Get-PropertyValue -JsonObject $Payload -Name 'baseUrl'
        if ($baseFound[0] -and $null -ne $baseFound[1] -and -not ($baseFound[1] -is [string])) {
            throw [System.ArgumentException]::new('input.baseUrl must be a string or null')
        }
        # `baseUrl` is validated and then deliberately ignored: no URL resolution happens here.
        return (ConvertTo-Extracted -Html ([string]$found[1]))
    }

    $found = Get-PropertyValue -JsonObject $Payload -Name 'text'
    if (-not $found[0] -or -not ($found[1] -is [string])) {
        throw [System.ArgumentException]::new('input.text must be a string')
    }
    if ($Capability -eq 'text.normalize') {
        $result = [ordered]@{}
        $result['text'] = ConvertTo-Normalized -Text ([string]$found[1])
        return $result
    }
    if ($Capability -eq 'text.fingerprint') {
        return (Get-Fingerprint -Text ([string]$found[1]))
    }
    throw [System.InvalidOperationException]::new('unknown capability ' + $Capability)
}

function Invoke-RequestLine {
    param([string]$Line, [string]$Capability)
    $request = $null
    try {
        $request = ConvertFrom-Json $Line
    }
    catch {
        Write-Diag ('malformed JSON on stdin: ' + $_.Exception.Message)
        return (Get-ErrorResponse -Id $null -Code 'bad-input' -Message 'request is not JSON')
    }
    if ($null -eq $request -or $request -is [string] -or $request -is [System.ValueType] -or
        $request -is [System.Array]) {
        return (Get-ErrorResponse -Id $null -Code 'bad-input' -Message 'request must be a JSON object')
    }

    $fields = Get-RequestField -Request $request
    $op = $fields[0]
    $id = $fields[1]

    if ($op -is [string] -and $op -ceq 'describe') { return (Get-DescribeResponse -Capability $Capability -Id $id) }
    if ($op -is [string] -and $op -ceq 'invoke') {
        $invokeInput = $null
        foreach ($prop in $request.psobject.Properties) { if ($prop.Name -ceq 'input') { $invokeInput = $prop.Value } }
        try {
            $output = ConvertTo-CapabilityOutput -Capability $Capability -Payload $invokeInput
        }
        catch [System.ArgumentException] {
            return (Get-ErrorResponse -Id $id -Code 'bad-input' -Message $_.Exception.Message)
        }
        catch {
            Write-Diag ('internal error: ' + $_.Exception.GetType().Name + ': ' + $_.Exception.Message)
            return (Get-ErrorResponse -Id $id -Code 'internal' -Message ($_.Exception.GetType().Name + ': ' + $_.Exception.Message))
        }
        return (Get-OkResponse -Id $id -Output $output)
    }

    $shown = ''
    if ($null -ne $op) { $shown = [string]$op }
    return (Get-ErrorResponse -Id $id -Code 'unsupported' -Message ('unknown op ' + $shown))
}

function Invoke-Protocol {
    <#
      The request loop. stdin is read as UTF-8 through a StreamReader (BOM detection on, so a stray BOM
      on the first line does not become part of the JSON), and every response goes out through
      Write-ProtocolLine, which flushes before the next request is read -- the contract's flush rule, and
      the reason a correct worker cannot look like a timed-out one.
    #>
    param([string]$Capability)
    $reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.UTF8Encoding]::new($false), $true)
    try {
        while ($true) {
            $line = $reader.ReadLine()
            if ($null -eq $line) { break }
            if ($line.Trim().Length -eq 0) { continue }

            # `shutdown` answers the bare envelope and nothing else, and it is checked before the general
            # handler because its answer is deliberately shaped differently from every other one.
            $isShutdown = $false
            $id = $null
            try {
                $probe = ConvertFrom-Json $line
                if ($null -ne $probe -and -not ($probe -is [string]) -and -not ($probe -is [System.ValueType]) -and
                    -not ($probe -is [System.Array])) {
                    $fields = Get-RequestField -Request $probe
                    $op = $fields[0]
                    $id = $fields[1]
                    if ($op -is [string] -and $op -ceq 'shutdown') { $isShutdown = $true }
                }
            }
            catch {
                # Not JSON: Invoke-RequestLine will produce the error envelope.
            }

            if ($isShutdown) {
                $response = [ordered]@{}
                $response['id'] = $id
                $response['ok'] = $true
                Write-ProtocolLine -Value $response
                return 0
            }

            Write-ProtocolLine -Value (Invoke-RequestLine -Line $line -Capability $Capability)
        }
    }
    finally {
        $reader.Dispose()
    }
    return 0
}

# --------------------------------------------------------------------------------------------
# --selfcheck: built-in cases for the contract's edge rules
# --------------------------------------------------------------------------------------------

function Get-SelfCheckCases {
    # Cases are built with explicit code points (`& $cp @(...)`) rather than literal non-ASCII in this
    # file, so the script stays readable whatever code page a tool uses to open it, and so a case can
    # name exactly the character it means.
    $cp = {
        param([int[]]$Points)
        $sb = [System.Text.StringBuilder]::new()
        foreach ($p in $Points) { [void]$sb.Append([char]::ConvertFromUtf32($p)) }
        return $sb.ToString()
    }

    $cases = [System.Collections.Generic.List[object]]::new()
    # `$PayloadValue`, not `$Input`: a script block parameter with that name is swallowed by the
    # automatic variable and every argument after it shifts, which made every case in an earlier version
    # of this list run on an empty string.
    $add = {
        param([string]$Name, [string]$Capability, [string]$PayloadValue, [AllowNull()][object]$Expected)
        $cases.Add([pscustomobject]@{ Name = $Name; Capability = $Capability; Input = $PayloadValue; Expected = $Expected })
    }

    & $add 'normalize: empty input stays empty' 'text.normalize' '' ([ordered]@{ text = '' })
    & $add 'normalize: full-width ASCII, ideographic space and zero-width deleted' 'text.normalize' `
        (& $cp @(0xFF21, 0xFF22, 0xFF23, 0x3000, 0x200B, 0xFF11)) ([ordered]@{ text = 'abc 1' })
    & $add 'normalize: map table then fold (curly quotes, em dash, ellipsis)' 'text.normalize' `
        (& $cp @(0x2018, 0x61, 0x2019, 0x2014, 0x62, 0x2026, 0x63)) ([ordered]@{ text = "'a'-b...c" })
    & $add 'normalize: combining marks deleted, decomposed equals composed' 'text.normalize' `
        ('e' + [char]0x0301) ([ordered]@{ text = 'e' })
    & $add 'normalize: CJK untouched' 'text.normalize' `
        (& $cp @(0x5DF2, 0x7ECF, 0x5F00, 0x64AD, 0x4E86, 0x3000, 0x65E5, 0x672C, 0x8A9E)) `
        ([ordered]@{ text = ((& $cp @(0x5DF2, 0x7ECF, 0x5F00, 0x64AD, 0x4E86)) + ' ' + (& $cp @(0x65E5, 0x672C, 0x8A9E))) })
    & $add 'normalize: Cyrillic and Arabic untouched' 'text.normalize' `
        ((& $cp @(0x041F, 0x0440, 0x0438, 0x0432, 0x0435, 0x0442)) + ' ' + (& $cp @(0x0645, 0x0631, 0x062D, 0x0628, 0x0627))) `
        ([ordered]@{ text = ((& $cp @(0x041F, 0x0440, 0x0438, 0x0432, 0x0435, 0x0442)) + ' ' + (& $cp @(0x0645, 0x0631, 0x062D, 0x0628, 0x0627))) })
    & $add 'normalize: Hangul untouched' 'text.normalize' `
        (& $cp @(0xD55C, 0xAD6D, 0xC5B4)) ([ordered]@{ text = (& $cp @(0xD55C, 0xAD6D, 0xC5B4)) })
    & $add 'normalize: collapse runs and trim' 'text.normalize' " `t a`r`n`n b  " ([ordered]@{ text = 'a b' })
    & $add 'normalize: non-decomposable letters folded (stroke, o-slash, sharp s)' 'text.normalize' `
        (& $cp @(0x0141, 0x00F3, 0x64, 0x017A, 0x20, 0x00D8, 0x00DF)) ([ordered]@{ text = 'lodz oss' })
    # The idempotency pair: expected $null means "the second pass must not change the first".
    & $add 'normalize: idempotency pair (first pass, second pass must match)' 'text.normalize' `
        (& $cp @(0x201C, 0x45, 0x2019, 0x201D, 0x3000, 0x2014, 0xFF21)) $null
    # Astral (non-BMP) input: an astral character is ONE code point and TWO UTF-16 code units, and the
    # tables stop at U+024F, so every one of these passes through unchanged. Walking the replacement
    # string by code unit used to hand a lone surrogate to [char]::ConvertFromUtf32, which throws and
    # turned the whole request into bad-input; tools/workers-diff.mjs found it on U+1F600.
    & $add 'normalize: astral emoji survives (U+1F600, ZWJ sequence, regional indicators)' 'text.normalize' `
        ((& $cp @(0x1F600)) + ' ' + (& $cp @(0x1F469, 0x200D, 0x1F4BB)) + ' ' + (& $cp @(0x1F1EF, 0x1F1F5))) `
        ([ordered]@{ text = ((& $cp @(0x1F600)) + ' ' + (& $cp @(0x1F469, 0x200D, 0x1F4BB)) + ' ' + (& $cp @(0x1F1EF, 0x1F1F5))) })
    & $add 'normalize: astral case pair U+10400/U+10428 is outside the tables, ASCII still folds' 'text.normalize' `
        ((& $cp @(0x1D400, 0x10400)) + ' ' + (& $cp @(0x10428)) + ' A') `
        ([ordered]@{ text = ((& $cp @(0x1D400, 0x10400)) + ' ' + (& $cp @(0x10428)) + ' a') })
    & $add 'normalize: astral between two BMP characters that do get folded' 'text.normalize' `
        ('x' + (& $cp @(0x1F600)) + 'Caf' + [char]0x00E9 + ' ' + [char]0xFF21) `
        ([ordered]@{ text = ('x' + (& $cp @(0x1F600)) + 'cafe a') })

    & $add 'extract: unclosed tag at end of input is dropped' 'text.extract' '<p>abc<b' `
        ([ordered]@{ title = ''; text = "`nabc"; links = @(); images = 0 })
    & $add 'extract: a lone < is literal text' 'text.extract' 'a<' `
        ([ordered]@{ title = ''; text = 'a<'; links = @(); images = 0 })
    & $add 'extract: entity without a semicolon decodes, unknown name stays' 'text.extract' 'a &amp b &unknown; c' `
        ([ordered]@{ title = ''; text = 'a & b &unknown; c'; links = @(); images = 0 })
    & $add 'extract: numeric and hex entities, with and without the semicolon' 'text.extract' '&#65;&#x42;&#X43; &#8212; &#x2014;' `
        ([ordered]@{ title = ''; text = ('ABC ' + [char]0x2014 + ' ' + [char]0x2014); links = @(); images = 0 })
    & $add 'extract: entity values are their own character (nbsp is U+00A0)' 'text.extract' '&nbsp;x' `
        ([ordered]@{ title = ''; text = ([char]0x00A0 + 'x'); links = @(); images = 0 })
    & $add 'extract: no backtracking after a numeric-looking name' 'text.extract' '&copy2024' `
        ([ordered]@{ title = ''; text = '&copy2024'; links = @(); images = 0 })
    & $add 'extract: a lone > inside a quoted attribute does not end the tag' 'text.extract' '<a href="x>y">z</a>' `
        ([ordered]@{ title = ''; text = 'z'; links = @([ordered]@{ href = 'x>y'; absolute = $false; text = 'z' }); images = 0 })
    & $add 'extract: a CDATA body is character data, not markup' 'text.extract' '<![CDATA[<b>raw</b> &amp;]]>' `
        ([ordered]@{ title = ''; text = '<b>raw</b> &amp;'; links = @(); images = 0 })
    & $add 'extract: an unclosed CDATA section runs to the end of the input' 'text.extract' '<![CDATA[unclosed' `
        ([ordered]@{ title = ''; text = 'unclosed'; links = @(); images = 0 })
    & $add 'extract: a title inside an anchor belongs to the title, not to the link' 'text.extract' '<a href="/x"><title>T</title>t</a>' `
        ([ordered]@{ title = 'T'; text = 't'; links = @([ordered]@{ href = '/x'; absolute = $false; text = 't' }); images = 0 })
    & $add 'extract: nested anchors are both reported, outer closed by the inner' 'text.extract' '<a href="/one">one<a href="/two">two' `
        ([ordered]@{
            title = ''
            text  = 'onetwo'
            links = @(
                [ordered]@{ href = '/one'; absolute = $false; text = 'one' },
                [ordered]@{ href = '/two'; absolute = $false; text = 'two' })
            images = 0
        })
    # Two more cases that came out of tools/workers-diff.mjs rather than the hand-written corpus: an
    # uppercase attribute name (the reference regex is case-insensitive; a PowerShell [regex] literal is
    # not), and an unclosed comment at end of input (in .NET `$` matches before a trailing newline,
    # which left one character behind).
    & $add 'extract: an uppercase attribute name still yields its href, scheme case is preserved' 'text.extract' '<A HREF="HTTP://e/x">X</A>' `
        ([ordered]@{
            title = ''
            text  = 'X'
            links = @([ordered]@{ href = 'HTTP://e/x'; absolute = $true; text = 'X' })
            images = 0
        })
    & $add 'extract: an unclosed comment at end of input takes the trailing newline with it' 'text.extract' "<p>a</p><!-- unclosed`n" `
        ([ordered]@{ title = ''; text = "`na`n"; links = @(); images = 0 })

    & $add 'fingerprint: empty text emits nothing' 'text.fingerprint' '' `
        ([ordered]@{ simhash = '0000000000000000'; tokens = 0; shingles = 0 })
    & $add 'fingerprint: punctuation-only tokens emit nothing' 'text.fingerprint' '-- !! ???' `
        ([ordered]@{ simhash = '0000000000000000'; tokens = 0; shingles = 0 })
    & $add 'fingerprint: two tokens make one shingle' 'text.fingerprint' 'a b' `
        ([ordered]@{ simhash = 'e63f991904833892'; tokens = 2; shingles = 1 })
    & $add 'fingerprint: three tokens make one shingle' 'text.fingerprint' 'aa bb cc' `
        ([ordered]@{ simhash = 'c9907bb5c642ac45'; tokens = 3; shingles = 1 })
    & $add 'fingerprint: a CJK run of two emits one bigram' 'text.fingerprint' `
        ((& $cp @(0x5DF2, 0x7ECF)) + ' ' + (& $cp @(0x5DF2, 0x7ECF))) `
        ([ordered]@{ simhash = '27bfb7b6385da4c5'; tokens = 2; shingles = 1 })
    & $add 'fingerprint: edge punctuation is trimmed before the run rule' 'text.fingerprint' 'hello, world.' `
        ([ordered]@{ simhash = '779a65e7023cd2e7'; tokens = 2; shingles = 1 })

    # Field order is part of the contract (the harness has its own check; this one keeps the file honest
    # on its own).
    $describe = Get-DescribeResponse -Capability 'text.normalize' -Id 1
    $okEnvelope = Get-OkResponse -Id 1 -Output ([ordered]@{ text = 'x' })
    $errorEnvelope = Get-ErrorResponse -Id 1 -Code 'bad-input' -Message 'm'
    $orderOk = ((@($describe.Keys) -join ',') -eq 'id,ok,worker') -and
        ((@($describe['worker'].Keys) -join ',') -eq 'protocol,capability,language,impl,runtime,deterministic') -and
        ((@($okEnvelope.Keys) -join ',') -eq 'id,ok,output') -and
        ((@($errorEnvelope.Keys) -join ',') -eq 'id,ok,error') -and
        ((@($errorEnvelope['error'].Keys) -join ',') -eq 'code,message')
    $cases.Add([pscustomobject]@{
            Name       = 'protocol: envelope and descriptor key order match the contract'
            Capability = 'protocol'
            Input      = ''
            Expected   = [pscustomobject]@{ Ok = $orderOk }
        })
    return , $cases
}

function ConvertTo-SingleLine {
    param([AllowNull()][object]$Value)
    try { return (ConvertTo-ProtocolJson -Value $Value) }
    catch { return '?' }
}

function Invoke-SelfCheck {
    $cases = Get-SelfCheckCases
    $passed = 0
    $failures = [System.Collections.Generic.List[string]]::new()

    foreach ($case in $cases) {
        $ok = $false
        $shown = ''
        $detail = ''
        try {
            if ($case.Capability -ceq 'protocol') {
                $ok = [bool]$case.Expected.Ok
                $shown = 'id,ok,worker / id,ok,output / id,ok,error'
                if (-not $ok) { $detail = 'an envelope or the descriptor has the wrong key order' }
            }
            elseif ($case.Capability -ceq 'text.normalize') {
                $first = ConvertTo-Normalized -Text $case.Input
                if ($null -eq $case.Expected) {
                    $second = ConvertTo-Normalized -Text $first
                    $ok = ($first -ceq $second)
                    $shown = (ConvertTo-SingleLine -Value ([ordered]@{ text = $first }))
                    if (-not $ok) {
                        $detail = 'not idempotent: ' + $shown + ' -> ' + (ConvertTo-SingleLine -Value ([ordered]@{ text = $second }))
                    }
                }
                else {
                    $ok = ($first -ceq [string]$case.Expected.text)
                    $shown = (ConvertTo-SingleLine -Value ([ordered]@{ text = $first }))
                    if (-not $ok) { $detail = 'got ' + $shown + ', want ' + (ConvertTo-SingleLine -Value $case.Expected) }
                }
            }
            elseif ($case.Capability -ceq 'text.extract') {
                $shown = (ConvertTo-SingleLine -Value (ConvertTo-Extracted -Html $case.Input))
                $wanted = (ConvertTo-SingleLine -Value $case.Expected)
                $ok = ($shown -ceq $wanted)
                if (-not $ok) { $detail = 'got ' + $shown + ', want ' + $wanted }
            }
            else {
                $shown = (ConvertTo-SingleLine -Value (Get-Fingerprint -Text $case.Input))
                $wanted = (ConvertTo-SingleLine -Value $case.Expected)
                $ok = ($shown -ceq $wanted)
                if (-not $ok) { $detail = 'got ' + $shown + ', want ' + $wanted }
            }
        }
        catch {
            $ok = $false
            $detail = 'raised ' + $_.Exception.GetType().Name + ': ' + $_.Exception.Message
            $shown = $detail
        }
        if ($ok) {
            $passed++
            Write-TextLine ('[ok]   ' + $case.Name + ': ' + $shown)
        }
        else {
            $failures.Add($case.Name + ': ' + $detail)
            Write-TextLine ('[FAIL] ' + $case.Name + ': ' + $detail)
        }
    }

    Write-TextLine ('' + $passed + '/' + $cases.Count + ' checks passed')
    foreach ($failure in $failures) { Write-Diag ('selfcheck failure: ' + $failure) }
    if ($failures.Count -gt 0) { return 1 }
    return 0
}

# --------------------------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------------------------

function Resolve-SpecDirectory {
    <#
      The shared tables live in workers/spec, and the directory is resolved from THIS SCRIPT's location
      rather than from the working directory: the registry's launch command is relative to the repository
      root, but a worker started from anywhere else must still find its tables. The environment override
      exists for a checkout that was relocated after the launcher was written; the working-directory
      fallback is the last resort.
    #>
    $here = $PSScriptRoot
    if ([string]::IsNullOrEmpty($here)) { $here = $env:VMLTEXT_SPEC_DIR }
    if (-not [string]::IsNullOrEmpty($here)) {
        if (Test-Path (Join-Path $here 'latin-lower.json')) { return $here }
        return (Join-Path (Split-Path -Parent (Split-Path -Parent $here)) 'workers/spec')
    }
    return (Join-Path $PWD 'workers/spec')
}

function Get-RequestedCapability {
    param([object[]]$Arguments)
    $capability = $null
    $selfcheck = $false
    for ($i = 0; $i -lt $Arguments.Count; $i++) {
        $arg = [string]$Arguments[$i]
        if ($arg -ceq '--selfcheck') { $selfcheck = $true; continue }
        if ($arg -ceq '--capability' -and ($i + 1) -lt $Arguments.Count) {
            $capability = [string]$Arguments[$i + 1]
            $i++
            continue
        }
        Write-Diag ('error: unexpected argument ' + $arg)
        Write-Diag $script:USAGE
        return $null
    }
    if ($selfcheck -and $null -eq $capability) { return 'selfcheck' }
    if ($null -eq $capability) { return $null }
    if ($script:CAPABILITIES -notcontains $capability) {
        Write-Diag ('error: unknown capability ' + $capability + '; this worker implements ' + ($script:CAPABILITIES -join ', '))
        Write-Diag $script:USAGE
        return $null
    }
    return $capability
}

function Invoke-Main {
    param([string[]]$Arguments)

    Initialize-Encoding

    $major = 0
    try { $major = [int]$PSVersionTable.PSVersion.Major } catch { $major = 0 }
    if ($major -lt 7) {
        Write-Diag ('error: this worker needs PowerShell 7 or newer; this is PowerShell ' + $PSVersionTable.PSVersion.ToString())
        return 2
    }

    if ($Arguments.Count -eq 0) {
        Write-Diag 'error: no arguments given (expected --capability <name> or --selfcheck)'
        Write-Diag $script:USAGE
        return 2
    }
    $mode = Get-RequestedCapability -Arguments $Arguments
    if ($null -eq $mode) { return 2 }

    try {
        $script:SPEC_DIR = Resolve-SpecDirectory
        Initialize-Tables
        Initialize-FingerprintTables
    }
    catch {
        Write-Diag ('error: cannot load the shared tables from ' + $script:SPEC_DIR + ': ' + $_.Exception.Message)
        return 2
    }

    if ($mode -ceq 'selfcheck') { return (Invoke-SelfCheck) }

    Write-Diag ('vmltext.ps1 ready: capability=' + $mode + ', protocol=' + $script:PROTOCOL_VERSION + ', spec tables in ' + $script:SPEC_DIR)
    return (Invoke-Protocol -Capability $mode)
}

exit (Invoke-Main -Arguments $script:Argv)
