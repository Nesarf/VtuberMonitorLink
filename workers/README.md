# workers — one capability, several languages

This directory holds the project's multilingual layer: the same three text capabilities implemented
in several languages, driven through one corpus, and **diffed against each other** rather than against
a single authority. The contract is [`../docs/WORKERS.md`](../docs/WORKERS.md) — read that first; this
file is the map.

```
workers/
  registry.json              what exists: capabilities, build command, artifact, launch command
  registry.local.example.json  machine-local overlay (the real one is gitignored) for tool paths
  spec/
    latin-lower.json         shared case table  (generated, do not hand-edit)
    latin-fold.json          shared fold table  (generated, do not hand-edit)
    generate-tables.py       regenerates both from Python's unicodedata
    cases/*.json             65 hand-written cases, the inputs
    expected/*.json          the reviewed snapshot, the answers
  js/       vmltext.js       the reference implementation, and a worker like the others
  java/     vmltext.jar      JDK 17, no dependencies, tables read at run time
  cpp/      vmltext          C++17, no dependencies, tables embedded at build time
  go/       vmltext          Go, standard library only
  python/   vmltext.py       Python 3, standard library only
  r/ j/ pwsh/ bash/          machine-local implementations (see below)
```

## Running it

```bash
npm run workers                # build what is missing, run every case through every implementation
npm run workers -- --list      # what is registered, what is built, how big the corpus is
npm run workers -- --build-only
npm run workers -- --cap text.fingerprint --only go-text
npm run workers -- --update    # re-record the reviewed snapshot from the reference
node workers/java/vmltext.jar --selfcheck     # one implementation's own case list
```

The verdict is the cross-implementation diff. A run prints, per capability, how many cases were
unanimous across how many answering implementations, then one `DIVERGES` block per case that was not —
naming the implementations and showing their answers side by side, so nobody has to guess who is
right. A case where every implementation agrees but the snapshot disagrees also fails: that is how the
contract itself gets corrected, deliberately. An implementation that answers nothing is reported once
as `UNUSABLE` rather than turning every case into an apparent divergence, and an implementation whose
interpreter is not installed is a `[skip]`.

## What the corpus has already caught

This is the part worth reading if you are deciding whether the layer is worth its upkeep. Every one of
these was found by an implementation disagreeing with another, not by a test the author wrote:

| Found | Where |
| --- | --- |
| Lower-casing and accent-folding were treated as alternatives instead of steps, so `É` became `é` and never `e`, and `normalize` was not idempotent | the reference; caught by the Java implementation reading the contract more carefully than the code |
| Hex entity references never decoded (`parseInt("x2014", 16)` is `NaN`) | the reference; caught by the corpus |
| Entities inside `<title>` went to the body, so the title lost its `&` | the reference and two implementations that had read it |
| Entity names mapped to ASCII approximations (`&mdash;` to `-`) instead of their own characters | the reference |
| An unclosed `<a>` was dropped, losing a link on every truncated document | the reference |
| Ignoring a nested `<a>` silently dropped the inner href | the Go implementation flagged it; the contract was changed rather than the code |
| Input ending *inside* a tag lost one more character than the contract said | the Java implementation |
| CDATA content was re-parsed as markup, which defeats the point of CDATA | the Python implementation, diffing itself against the reference over 156 inputs the corpus did not contain |
| A worker that answered correctly and never flushed looked like a broken worker | the C++ implementation (stdout buffering), then stdin buffering in the same worker |
| A machine-specific Go path and a Windows-only artifact name in published build scripts | the release-path review, before either shipped |

## Machine-local implementations

`r-text`, `j-text`, `pwsh-text` and `bash-text` need interpreters that not every machine has. Their
entries live in `workers/registry.local.json` (gitignored, merged over the published registry by the
harness) so that the published registry stays portable and a run elsewhere reports them as `[skip]`.
Copy `registry.local.example.json` and fill in your own paths; never put an absolute path from your
machine into `registry.json` — the release checks reject machine-specific paths, and a registry that
only works on one computer is not a registry.

The R worker currently agrees with everyone on `text.extract` and `text.normalize` and disagrees on
every SimHash: that is a 64-bit arithmetic problem in R (where `integer` is 32-bit and `double` loses
precision above 2^53), not a language limit, and it is listed in `docs/WORKERS.md` section 8 as an
open item rather than hidden.

## Adding a language

Section 6 of the contract has the steps. The short version: implement the protocol, apply the shared
tables (not your runtime's Unicode data), answer `--selfcheck`, register the artifact and launch
command, then make the corpus unanimous. If you think an expected answer is wrong, say so with the
rule you are reading — a disagreement about the contract is a finding, and it is the reason this
directory exists.
