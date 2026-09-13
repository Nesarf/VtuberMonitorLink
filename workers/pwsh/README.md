# The PowerShell worker (`pwsh-text`)

PowerShell 7 implementation of the three text capabilities in `docs/WORKERS.md`:
`text.normalize`, `text.extract`, `text.fingerprint`, behind the JSON-Lines stdio protocol of
section 1.

- artifact: `workers/pwsh/vmltext.ps1` — **a script, not a binary**
- interpreter: PowerShell 7 (`pwsh`) on `PATH`; registered in `workers/registry.json` as
  `pwsh -NoProfile -NoLogo -NonInteractive -File workers/pwsh/vmltext.ps1`
- modules/packages: none. Everything used is in the PowerShell 7 install (`System.Text`,
  `System.Collections.Generic`, `System.Globalization`, `regex`). No network at run time.
- build step: **there is no compilation.** `workers/pwsh/build.mjs` only checks the interpreter, the
  shared tables and the self-check, then records a manifest. It does not produce a binary, and it
  does not pretend to.

## Run it

```powershell
# repository root
pwsh -NoProfile -File workers/pwsh/vmltext.ps1 --capability text.normalize   # protocol on stdin/stdout
pwsh -NoProfile -File workers/pwsh/vmltext.ps1 --selfcheck                   # 28 built-in cases
node workers/pwsh/build.mjs                                                  # checks, prints the artifact path
node tools/workers.mjs                                                       # the full cross-language diff
node tools/workers.mjs --no-build --cap text.extract --only pwsh-text        # one implementation, one capability
```

The host starts it as `<artifact> --capability <name>` (section 1.1); the registry entry keeps the
`pwsh` flags because a user profile would otherwise be loaded into the process that writes protocol
lines, and `-NonInteractive` keeps a prompt from becoming a stdout line.

## Strategy

**One pass per capability, tables from `workers/spec/`.** The case and fold tables are read from
`workers/spec/latin-lower.json` and `latin-fold.json` at start-up. PowerShell's own `ToLower()`,
`ToUpper()` and culture-aware rules are never used: they would agree almost everywhere and disagree
exactly where the corpus looks.

`normalize` keeps the contract's steps as separate tables — steps 1+2 fused into one
code-point→string map (both are per-code-point and neither feeds the other), and steps 3 and 4 as
their own tables applied in order to the code points of the step-2 result. Fusing step 4 into the
step-2 map as well is the obvious optimisation and it is wrong; see "Bugs this file hit" below.

`extract` is a hand-written state machine. The CDATA bodies are hidden behind a sentinel before any
other pass runs, the removed elements and the comments/doctypes go, and then one left-to-right scan
walks what is left, with the in-progress anchor keeping its own buffer.

`fingerprint` tokenizes on spaces, trims ASCII punctuation at the edges, splits the remainder into
runs, and hashes with FNV-1a over UTF-8 bytes using Int64 arithmetic (PowerShell has no unsigned
64-bit multiply that wraps; see below).

## PowerScript traps this implementation is built around

These are the things that made a straightforward implementation quietly wrong. Each one is also
noted at the point in the script where it matters.

1. **`Write-Output` is protocol traffic.** Any cmdlet that emits a value, any bare expression, any
   `Write-Host` used as a debug print, becomes a line on stdout, and the host counts lines by id — so
   one stray line reads as a lost case. Every response goes through `Write-ProtocolLine`, which
   writes raw UTF-8 bytes to the standard output stream and flushes. That is also the only way to get
   a lone LF on every platform: `[Console]::WriteLine` uses the host's newline.

2. **Encoding.** `[Console]::OutputEncoding` and `[Console]::InputEncoding` are set to
   `[Text.UTF8Encoding]::new($false)` (the contract's prescription for `pwsh`, section 1.2), and
   stdin is additionally read through a `StreamReader` built on `[Console]::OpenStandardInput()` with
   an explicit UTF-8 decoder, so the transport does not depend on the console's code page at all. On
   this machine the default *input* encoding is GBK/936, which is exactly the "looks like it works"
   failure the contract warns about.

3. **Code points vs UTF-16 code units.** `normalize` walks code points with
   `[char]::ConvertToUtf32` / `[char]::IsHighSurrogate`; extract and fingerprint stay on UTF-16 code
   units deliberately, because every code point they classify is inside the BMP (tag names and
   delimiters are ASCII, and the Han/kana/Hangul ranges the contract lists all end below U+FFFF).

4. **`foreach` over a `[string]` yields one item, not characters.** On PowerShell 7.6,
   `foreach ($c in $s)` enumerates the whole string as a single value; `[char]$c` then fails with
   "String must be exactly one character long". Every per-character walk in this file is an indexed
   `for`.

5. **`$Input` is an automatic variable.** A function or script-block parameter named `$Input` is
   silently overwritten by the pipeline-input enumerator: the parameter binds, then holds an
   `ArrayList+ArrayListEnumeratorSimple`, every property lookup misses, and a valid request comes back
   as `input.text must be a string`. With four parameters, every argument shifts position instead.
   The parameters here are `$Payload` and `$PayloadValue`.

6. **Arrays returned from a function are unrolled.** An empty `List` returned from a function arrives
   as `$null`, so the first `.Add()` fails; a two-element array arrives as its first element. The
   returns that need to stay intact use the unary comma (`return , $list`, `return , @($a, $b)`).

7. **64-bit FNV-1a in PowerShell.** `14695981039346656037` does not fit in an `Int64` literal and
   cannot be cast into one (`[long]` throws, `[long][uint64]` throws), and `[long] * [long]` that
   overflows silently becomes a `Double` and loses the low bits — the exact trap the contract's
   "unsigned arithmetic throughout" warns about. The offset basis is therefore parsed from its two
   32-bit halves as unchecked two's complement, and the multiply is done as a widening 64x64→64
   multiply built from 32-bit products in `Int64`, where the only operation that overflows is `-shl`
   and `-shl` wraps by definition. The nibbles are formatted by hand rather than with `.ToString('x16')`
   on a `UInt64`, so nothing depends on an unsigned type PowerShell only half supports.

8. **`ConvertTo-Json` is not used for output.** It escapes non-ASCII (`\uXXXX`) where `JSON.stringify`
   emits raw UTF-8, and the field order a diff checks is an incidental behaviour of the serializer
   rather than something it promises. Output is serialised by hand in `ConvertTo-ProtocolJson`, with
   `[ordered]` dictionaries and the contract's key order.

## `--selfcheck`

28 built-in cases, one English line each, then `N/M checks passed`; exit 0 only if all pass.
It covers unclosed tags, an entity without a semicolon, numeric and hex entities, a zero-width
character, full-width ASCII, CJK/Cyrillic/Arabic/Hangul pass-through, an idempotency pair, empty
input, CDATA (markup, unclosed, and inside a removed element), a title inside an anchor, nested
anchors, and the response/descriptor key order. The lines go to **stdout** (the mode is defined as
producing no protocol traffic, so the two cannot be confused); the same text goes to stderr as
diagnostics when a case fails, so a failing run is legible either way.

## Known limits and judgement calls

- **`build.mjs` does not compile anything, by design.** It resolves the interpreter, verifies the
  tables are readable, runs `--selfcheck`, and writes `workers/pwsh/dist/build-manifest.json`
  (gitignored). The manifest carries a hash of the script and of both tables, because plain
  "artifact older than its sources" freshness is meaningless when the artifact *is* a source.
- **PowerShell 7 only.** The worker checks `$PSVersionTable.PSVersion.Major` and exits 2 with an
  English message under 5.1. `build.mjs` names `powershell` as a candidate so that a machine without
  `pwsh` gets a message that says what was tried, and skips any candidate below 7.
- **No machine-specific paths anywhere in the published files.** The interpreter is the bare `pwsh`;
  `workers/registry.local.json` (gitignored) is the place for a machine whose PowerShell lives
  somewhere unusual.
- **Codes not implemented:** the contract's closed error set includes `timeout`; this worker never
  emits it (it has no work that can time out), so `bad-input`, `unsupported` and `internal` are the
  only codes it produces.
- **Numbers:** `text.fingerprint` emits integers, printed with the invariant culture. The emitter
  refuses anything that is not an `int`/`long` rather than formatting a double, since the contract
  forbids locale-dependent number formatting and nothing here needs a double.
- **The title's own text is excluded from an anchor's text**, because the reference and the reviewed
  snapshot both do that (`title-inside-anchor` in `workers/spec/expected/text.extract.json`). The
  contract sentence says an `&` inside a `<title>` belongs to the title and not the body; extending
  that to an anchor the title sits inside is the reading the snapshot encodes, and this worker follows
  the snapshot.
- **Entity window:** "within 12 characters of the `&`" is read as a fixed 12-character body window
  with no backtracking, which is what the case pins. An implementation that instead searched from the
  `&` to an *earlier* semicolon would take a shorter window and would agree on all corpus cases while
  differing on `&cop;y`; that ambiguity is reported rather than resolved here.

## Bugs this file hit (kept as notes, because they are PowerShell-specific)

Found while writing it:

- Parsing `$args` inside a function instead of at script scope → every run exited 2 with no output.
- Fusing steps 3+4 into the step-2 map → `text.normalize` returned `ABC` for full-width
  `ABC` (the map produced `A`, and step 3 had already been spent on the source code point).
- Sharing one buffer for nested anchors → the outer link lost or stole the inner link's text.
- A parameter named `$Input` → every `invoke` answered `input.text must be a string`.
- A script-block parameter named `$Input` in the self-check helper → every case ran on an empty string
  and "expected" its own input.
- Treating CDATA as a pre-pass that re-parses its body → `<![CDATA[<b>raw</b>]]>` lost its tags, and
  entities inside a CDATA body were decoded.

Found later by `tools/workers-diff.mjs` — the hand-written corpus contained none of these:

- **Every astral (non-BMP) code point was rejected.** `text.normalize` walked the *replacement string*
  of steps 3 and 4 by UTF-16 code unit, so for an unmapped astral code point the replacement is a
  surrogate pair and the high surrogate was handed to `[char]::ConvertFromUtf32`, which throws — and
  the throw surfaced as a `bad-input` answer rather than a crash. Fixed by walking that replacement by
  code point (`Get-CodePoints`, built on `[char]::ConvertToUtf32` / `[char]::IsHighSurrogate`), while
  keeping the fast path: a replacement of one unit that is not a high surrogate — which is every entry
  in the map table — never calls the helper, so BMP throughput is unchanged.
  `"cat 😀 tail 🇯🇵"` and `"𝐀𐐀 𐐨 A"` now match the reference exactly (`"cat 😀 tail 🇯🇵"`,
  `"𝐀𐐀 𐐨 a"`). The tables stay BMP-only; astral input passes through, as section 2 says.
- **An uppercase attribute name lost its href.** `[regex]'...\bhref...'` is **case-sensitive** in .NET,
  while the reference regex carries the `i` flag, so `<A HREF="C">` produced an empty href. Fixed with an
  explicit `IgnoreCase`. (PowerShell's own `-match` operator is case-insensitive, which is what makes
  this trap easy to miss. Related: `[regex]'pattern', $options` is *not* a constructor call — it casts
  the options enum to a string and yields an invalid pattern.)
- **An unclosed comment at end of input left one character behind.** In .NET an unanchored `$` also
  matches just *before* a trailing `"\n"`, while JavaScript's `$` (without `m`) matches only at the very
  end, so `"<p>a</p><!-- unclosed\n"` produced one newline too many. The end-of-input alternatives in
  the comment and CDATA patterns now use `\z`, the exact end of the input.

All three are covered by built-in self-check cases now. `tools/workers-diff.mjs` is clean for
`text.normalize` and `text.fingerprint` (200 generated cases each, 6-way unanimous), and `pwsh-text` is
never on the minority side of an `text.extract` divergence.
