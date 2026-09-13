# C++17 worker for `text.normalize`, `text.extract`, `text.fingerprint`

The C++ implementation of the three text capabilities described in
[`docs/WORKERS.md`](../../docs/WORKERS.md). One dependency-free program, one artifact, one capability
per process, JSON Lines over stdio.

* artifact: `workers/cpp/dist/vmltext.exe` on Windows, `workers/cpp/dist/vmltext` elsewhere — the
  name follows `process.platform`, the way `workers/registry.json` declares it per platform
* launch:   `workers/cpp/dist/vmltext.exe --capability <text.normalize|text.extract|text.fingerprint>`
* build:    `node workers/cpp/build.mjs`

## Build

```
node workers/cpp/build.mjs                 # auto-detect, in this order: g++ -> clang++ -> MSVC
node workers/cpp/build.mjs --compiler msvc # force one, to exercise a fallback
```

The last stdout line is the artifact path. The toolchain is printed while building (`[cc] ...`).
The script never downloads anything and never touches the network.

**Compiler used for this artifact: `g++ 13.2.0`** (MinGW-w64, Strawberry Perl's GCC on PATH). The
same sources were also compiled and the whole corpus run with **MSVC `cl` 19.51** to make sure the
fallback is not untested code; the checked-in artifact is the `g++` one because `g++` is the first
preference.

What the script does, in order:

1. Detects a compiler.
   * `g++` on PATH (Strawberry Perl, MSYS2, a Linux/macOS toolchain) — preferred.
   * `clang++` on PATH.
   * `cl` on PATH, or, when it is not, the Visual Studio installation found with `vswhere.exe`
     and the `vcvars64.bat` that ships with it. The compile is then run through `cmd.exe` with the
     environment set up first, because outside a developer environment `cl.exe` cannot even find its
     own headers.
   * Nothing found: a clear English error listing the three options, exit 1.
2. Generates `src/tables.generated.h` from `workers/spec/latin-lower.json` and
   `workers/spec/latin-fold.json` (see "Strategy" below; the header is a generated file and is not
   meant to be edited).
3. Compiles every `src/*.cpp` with `-std=c++17 -O2 -static-libgcc -static-libstdc++ -Wall -Wextra`
   (MSVC: `/nologo /std:c++17 /O2 /EHsc /W4`, with object files under `dist/obj/` so that `dist/`
   holds the artifact and nothing else).

No absolute path from the machine that built the artifact is written into this repository: the
Visual Studio location is discovered at build time, and everything else is relative to the
repository root.

## Run

As a worker (what the host does):

```
workers\cpp\dist\vmltext.exe --capability text.normalize
{"id":1,"op":"describe"}
{"id":2,"op":"invoke","capability":"text.normalize","input":{"text":"Café"}}
{"id":3,"op":"shutdown"}
```

```
{"id":1,"ok":true,"worker":{"protocol":1,"capability":"text.normalize","language":"cpp","impl":"table-driven","runtime":"g++ 13.2.0","deterministic":true}}
{"id":2,"ok":true,"output":{"text":"cafe"}}
{"id":3,"ok":true,"output":{"bye":true}}
```

Self-check (42 built-in cases, one English line per case, `N/M checks passed`, exit 1 on failure):

```
workers\cpp\dist\vmltext.exe --selfcheck
```

The self-check report goes to **stderr**, matching the JavaScript reference and section 1's rule that
stdout carries protocol messages and nothing else. Every line is pure ASCII — values are escaped for
display as `\uXXXX` — so a console whose code page is not UTF-8 cannot mangle the report. Nothing is
written to stdout in this mode.

Any other argument, a missing `--capability`, or an unknown capability name is reported on stderr
with exit 2.

## Strategy

**Bytes on the wire, code points only where a rule is defined per code point.** Every string in the
program is a `std::string` of UTF-8 bytes. Bytes are scanned directly for the ASCII delimiters the
rules use (`<`, `>`, `&`, `"`, `'`, space), which is safe because none of them can occur inside a
multi-byte UTF-8 sequence. Code points are decoded only where the contract defines a rule per code
point — the mapping tables, the combining-mark deletion ranges, the CJK run detection, entity
decoding — and the result is re-encoded to UTF-8 before it reaches the serializer.

**No Unicode library, no locale.** There is no ICU and no `<codecvt>`-style conversion anywhere:
section 2 forbids consulting the runtime's Unicode data, and C++ is the language where that rule is
free, because it has none. Numbers go through `std::to_chars`/`std::from_chars` (locale-independent),
never `printf`-with-a-locale or `strtod`.

**The spec tables are embedded at build time.** `build.mjs` turns the two JSON files into
`src/tables.generated.h` — two sorted `uint32_t` arrays and an array of ASCII strings — and the
binary carries them. That is the reason this is code generation and not "read the JSON when
starting":  the worker must stay dependency-free, and embedding avoids both a file the artifact
depends on at run time and a JSON parser inside the worker beyond the small one the protocol itself
needs. Lookup is a binary search, so no hash container ever gets the chance to make output order
non-deterministic. A table change is a rebuild, which also means the artifact records the spec
revision it implements.

**Determinism.** Responses are built as an insertion-ordered value tree and serialized compact, with
the field order the contract lists the fields in (`text`; `title, text, links, images`; `href,
absolute, text`; `simhash, tokens, shingles`). Strings are escaped exactly as `JSON.stringify` does:
`"`, `\` and control characters below U+0020 only, lone surrogates as `\uXXXX`, everything else as
raw UTF-8. There is no `std::unordered_map` in the program at all.

**FNV-1a in `uint64_t`, exactly as written.** `h = 14695981039346656037; h ^= byte; h *=
1099511628211` over the UTF-8 bytes of each shingle. The multiply wraps modulo 2^64 — unsigned
overflow is well defined in C++ and is precisely what the contract asks for, so it is left
unnoticed on purpose (and commented as such in `src/fingerprint.cpp`).

**I/O is deliberately dumb, and it is tested.** stdin is switched to binary mode, read unbuffered at
the byte level, and every response line is flushed immediately. Both halves have a `--selfcheck`
case that runs over a real pipe whose write end stays open — the way the host holds it — because
getting either one wrong produces no error at all: just silence until the host times out. (A
buffered `fread` on a pipe keeps asking the kernel for more bytes until its buffer is full, so a
worker that reads a block at a time answers nothing while stdin is open; that bug was live in this
worker for one build.)

**`text.extract` is a scanner with stated tie-breaks.** Removed elements are skipped to `</name>`
(case-insensitively, quotes honoured) or to end of input; an `<a>` opened while another is open
closes the outer one and reports it before the inner starts, which is what a browser does with
markup HTML does not allow; an anchor still open at end of input is reported with the text it
collected; an incomplete tag at end of input is dropped entirely — name characters included, and it
contributes no newline and counts no image, so `<p` extracts to the empty string — while a lone `<`
that never started a tag is literal text. CDATA is character data: `<![CDATA[<b>raw</b>]]>` keeps
`<b>raw</b>` as text and is not re-parsed as markup, and an unclosed CDATA section keeps everything
to the end of input, like a removed element with no closing tag. Entities are decoded to their own
character (`&nbsp;` is U+00A0, not a space, and not the ASCII the normalizer would later produce),
with or without the trailing semicolon and without backtracking, so `&copy2024` stays literal. The
title is decoded, is not normalized, is kept out of `text`, and a title inside an anchor belongs to
the title and not to the link's text either. Nothing in `text.extract` normalizes anything:
`extract` then `normalize` is the host's composition, not this worker's.

**Small hand-written JSON.** The protocol needs a parser and a serializer, and the contract forbids
dependencies, so `src/json.cpp` implements exactly what a host request can contain: the full escape
set including `\uXXXX` with surrogate pairs, integers, doubles, nesting. Strings are the one place
where bytes are sanitized: ill-formed UTF-8 becomes U+FFFD, which is what a JavaScript host does when
it decodes stdin as UTF-8. Lone surrogates survive as WTF-8 so the serializer can re-emit them as
escapes, again matching `JSON.stringify`.

## Layout

| file | contents |
| --- | --- |
| `build.mjs` | table generation + compilation (the deliverable build entry point) |
| `src/main.cpp` | argument handling and the request loop |
| `src/stdio_io.{h,cpp}` | binary-mode, unbuffered, flushed byte I/O |
| `src/json.{h,cpp}` | JSON value, parser, serializer |
| `src/utf8.h` | UTF-8 decode/encode helpers |
| `src/tables.{h,cpp}` | table lookup over the generated arrays |
| `src/tables.generated.h` | generated from `workers/spec/*.json`; do not edit |
| `src/normalize.cpp` | `text.normalize` |
| `src/extract.cpp` | `text.extract` |
| `src/fingerprint.cpp` | `text.fingerprint` |
| `src/render.cpp` | builds each capability's output object (shared by the loop and the self-check) |
| `src/selfcheck.cpp` | the 42 built-in cases |

## Known limits

* **Artifact name follows the platform.** The build writes `dist/vmltext.exe` on Windows and
  `dist/vmltext` everywhere else, matching the per-platform `artifact`/`launch` entries in
  `workers/registry.json`, so the same command works for a Linux CI job.
* **`text.extract` re-scans for the closing tag of a removed element.** `<script>` and friends are
  skipped by searching for `</name` (case-insensitively, honouring quotes) from after the opening
  tag. A missing closing tag means "to end of input", as the contract says; nested same-name
  elements and a `</script>` inside a JavaScript string literal are not modelled, because the
  contract does not ask for them.
* **CDATA, comments and doctypes are handled inside the scan**, not as the pre-passes the JavaScript
  reference uses. The observable results agree on the corpus; they can differ only for a comment
  nested inside a `<script>` whose closing tag is missing, where this worker removes everything to
  end of input (the contract's rule for a missing closing tag) rather than removing the comment
  first. CDATA content is copied as literal text, so entities inside it are decoded by this worker
  (the contract's entity rule is global and gives CDATA no exception) while tags inside it stay
  literal.
* **The `describe` `runtime` field is machine-specific** (`g++ 13.2.0`, `MSVC cl 19.51...`), like the
  Java worker's JDK version. It is the one field of the protocol that cannot be identical across
  languages; capability outputs are byte-identical.
* **Doubles appear only if a host sends a non-integer `id`.** They are echoed using
  `std::to_chars` shortest round-trip formatting, which matches `JSON.stringify` for the values that
  can realistically appear.
* **Malformed UTF-8 in a request is replaced with U+FFFD**, so the worker cannot echo invalid bytes
  back as invalid JSON. The corpus is always well-formed UTF-8, so this is a safety net, not a rule.
