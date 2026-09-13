# workers/csharp - the C# worker

The C# member of the multilingual text layer: `text.normalize`, `text.extract` and
`text.fingerprint` (docs/WORKERS.md sections 2, 3 and 4) behind the JSON-Lines protocol of section 1.

It is a plain .NET console application with **no third-party packages at all** - the project file
declares no `PackageReference`, so a build needs no NuGet feed and no network - and it targets
`net8.0`, the lowest currently supported LTS, so any SDK from 8 up can build it.

## Build and run

```
node workers/csharp/build.mjs                                   # publishes to workers/csharp/dist/
workers/csharp/dist/vmltext.exe --capability text.normalize     # the protocol loop
workers/csharp/dist/vmltext.exe --selfcheck                     # the built-in case list
```

The artifact is `workers/csharp/dist/vmltext.exe` on Windows and `workers/csharp/dist/vmltext`
elsewhere - the platform-mapped form, exactly as `workers/registry.json` declares it. It is
framework-dependent: the host that launches it is the machine that built it, and a self-contained
bundle would be tens of megabytes of runtime duplicating an installation that is already there.

Nothing in the repository hard-codes where the SDK lives. `build.mjs` looks for `dotnet` on `PATH`
and honours `DOTNET_ROOT` / `DOTNET_ROOT(x86)` as environment hints; a machine-local install belongs
in `workers/registry.local.json`, which is gitignored and exists for exactly that.

The build is **warning-free by construction**: the project sets `TreatWarningsAsErrors`, so a
warning is a failed build rather than something to read past.

## Strategy

**The shared tables are read at run time, not embedded.** `workers/spec/latin-lower.json` and
`latin-fold.json` are parsed at startup with `System.Text.Json` and turned into two dense arrays
indexed by code point. A missing or malformed table is a startup failure (stderr, exit 2), never a
silent fallback to .NET's own Unicode data: a worker that answered with the runtime's tables would
look right on almost every case and be wrong on exactly the ones this layer exists to find.
`VML_SPEC_DIR` overrides the search, which otherwise walks up from the working directory looking for
`workers/spec` and then tries the executable's own location.

**One JSON writer, written by hand, in bytes.** `JsonOut` appends UTF-8 bytes in the contract's
field order and flushes each line. No object graph is serialised, no dictionary decides a key order,
and no number is formatted through a culture. This is not fastidiousness: `System.Text.Json`'s
default encoder escapes non-ASCII (CJK becomes `\uXXXX`) and HTML-significant characters, and the
corpus is full of CJK, em dashes and astral characters.

**Culture is never consulted.** The contract specifies code-point behaviour and says the shared
tables are the rule, so:
- no `ToLower()`/`ToUpper()`/`String.Compare`/`String.Trim()` call exists anywhere in the worker;
- tag names are lowercased with `ToLowerInvariant` (they are ASCII by construction) and compared
  with explicit ASCII folds;
- the protocol's integers are appended digit by digit rather than through a formatter;
- the self-check runs its Turkish and German cases under `tr-TR` and `de-DE` and expects the same
  answers as everywhere else.

`InvariantGlobalization` is deliberately **false**. Turning it on would make every culture the
invariant one, which would make the worker immune to the trap it is meant to defeat - and the
self-check could no longer prove that the answer does not move with the machine's locale, because
the runtime would refuse to have one.

## What the self-check pins

48 checks: 44 built-in cases that call the protocol layer's capability entry point directly (17
`text.normalize`, 17 `text.extract`, 10 `text.fingerprint`), plus 4 that exercise the response
envelopes on the wire. `workers/csharp/dist/vmltext.exe --selfcheck` prints one English line per case
and an `N/M checks passed` summary, and exits non-zero on failure.

The cases are the contract's edge rules (the section 3 pass order, the unclosed-tag rules, the
12-character entity window, the anchor rules, the CJK bigram tokenizer) with the traps this worker
was written around pinned next to them:

- **Culture-sensitive defaults.** `normalize/U+0130` proves the lower table is consulted rather than
  .NET's (`İ` is absent from it and folds to `i`), and two cases run under `tr-TR` and `de-DE`: an
  ASCII `I` must not become the dotless `ı`, and `ß` must fold to `ss` rather than to the
  culture's capital. The expected values are literals, so a rule that changes without its case
  changing fails loudly.
- **UTF-16 code units are not code points.** An emoji survives `normalize` unchanged, an astral code
  point outside both tables passes through, an astral body text survives extraction byte for byte,
  and a surrogate pair fingerprints as one token - the shape of the bug that made a published worker
  in this layer reject every emoji.
- **`String.Trim()` is not the contract's whitespace.** One case pins `U+2007 FIGURE SPACE` (mapped
  to a space, then collapsed) next to `U+0085 NEXT LINE` (neither mapped nor whitespace, so kept
  verbatim). Those two are the pair that tells the contract's rule apart from .NET's.
- **Composition and mutation.** The case/fold tables must compose (U+00C9: lower, then fold), a
  two-character fold output must not re-enter either table, and normalization of an already
  normalized string must be a no-op.
- **The wire format.** Three checks assert the response envelopes themselves: describe's key order
  and field set, invoke's key order including the nested `href`/`absolute`/`text` order inside every
  `links[]` element, and the shutdown envelope's exact `{"id":...,"ok":true}` shape with no extra
  payload. No corpus case compares a shutdown line, which is how two implementations carried an
  extra `output` payload through four implementations unnoticed.

The fingerprint expectations are produced by a second, independent implementation inside the
self-check: `Fnv1a64BigInteger` does the hash in `BigInteger` with an explicit `mod 2^64`, the way
the contract writes it, rather than by calling the worker's own `ulong` loop. The two agree only if
both are the contract's algorithm.

## Notes on this language, for the next person

- **`Console.Out` is buffered and `Console.In` is a pipe.** Responses go through
  `JsonOut.WriteLineTo`, which writes and flushes to `Console.OpenStandardOutput()`. The request
  loop reads the standard input stream directly - a descriptor read, not `StreamReader.ReadLine` -
  so a partial line is never held in a block buffer while the host waits for an answer. That is the
  same trap that broke the first C++ worker from the other side.
- **All three streams are UTF-8 without a BOM.** `Console.InputEncoding`/`OutputEncoding` are set
  before anything else touches them, and the writer emits bytes, so a redirected stdout cannot pick
  up the system code page (GBK on a Chinese Windows) or a byte-order mark.
- **`System.Text.Json` parses; it does not serialise anything here.** Requests are validated with
  `JsonDocument` configured to *reject* comments and trailing commas, because a lenient parser turns
  a malformed request into a plausible-looking answer. Member lookup is case-sensitive, so
  `{"Text":"x"}` is a missing field rather than an answer.
- **The `id` is echoed as the bytes that arrived**, sliced out of the raw request line by a small
  scanner rather than re-serialised. Numbers, strings and nested values all round-trip unchanged.
- **`bin/` and `obj/` are build intermediates.** The root `.gitignore` already covers
  `workers/*/bin/` and `workers/*/obj/`, and `workers/*/dist/` for the artifact.
