# workers/perl — the three text capabilities in Perl 5

A worker for the multilingual text layer described by `docs/WORKERS.md`: `text.normalize`,
`text.extract` and `text.fingerprint`, in core Perl 5 only (JSON::PP, `strict`, `warnings`,
`utf8`), with no build step — the script is the artifact.

```
node workers/perl/build.mjs                                # checks the interpreter and the self-check
node workers/perl/build.mjs | tail -1                      # the artifact path
perl workers/perl/vmltext.pl --capability text.extract      # the protocol on stdin/stdout
perl workers/perl/vmltext.pl --selfcheck                    # the worker's own case list
```

## Where it stands

Measured, not asserted:

| Check | Result |
| --- | --- |
| `node tools/workers.mjs --no-build --only perl-text --cap text.normalize` | **22/22** against the reviewed snapshot |
| the same for `text.extract` | **31/31** |
| the same for `text.fingerprint` | **16/16** |
| `perl workers/perl/vmltext.pl --selfcheck` | **43/53**, and the same 43/53 in three consecutive runs |

The last row matters as much as the first three: the self-check used to fail a *different* number
of cases on every run, because it asked `keys %$hash` for a field order. A worker whose own test
cannot agree with itself is a worker whose next reader learns nothing from a red run.

What is still wrong is listed at the bottom rather than hidden, and it is all in the self-check's
stricter cases rather than in the corpus: combining marks, the fingerprint token/shingle cases, a
non-string `input.text`, and the JSON layer's astral round trip.

## What this worker cost, in Perl

Each of these produced a plausible wrong answer first:

- **A numeric literal has no line continuation** in this file's generated tables (that trap belongs to
  another implementation in this layer, and the same class of mistake is easy here: the shared tables
  are read at run time rather than transcribed, precisely so that they cannot drift).
- **`keys %hash` is randomized per process** (a hash-flooding defence). The previous version built the
  answer by inserting keys in the contract's order and handed the hash to JSON::PP, which is an
  assumption a hash does not support: three runs of the same code produced three different field
  orders for `text.extract`, and the harness checks that order. Answers are now ordered pair lists
  (`ordered_obj`, `ordered_json`) with one place that decides what the wire looks like.
- **A JSON boolean is not 1.** `absolute` was computed as `1 : 0`, and a parsed `0` is not a parsed
  `false` to any comparison the harness makes. JSON::PP supplies the literals.
- **`return undef` in a list-returning function is a one-element list.** `decode_entity` signalled
  failure with `return undef`, its caller did `my @got = decode_entity(...)` and tested `if (@got)` -
  which is true for a failure. The caller then used `undef` as the next cursor position, so the walk
  stopped at the first `&` it could not decode (silent truncation), and the uninitialized-value
  warnings from that path filled 800,000 stderr lines and turned a 0.1-second self-check into 11
  seconds. Failure is an empty list now.
- **The self-check's summary line lied**: it printed `$n/$n checks passed` when there were failures.
  It prints `passed/total` and exits non-zero.
- **In `handle`, one worker implements one capability** (a request for another one is `unsupported`),
  so the self-check has to set the capability it is asking about before it calls `handle` - otherwise
  it measured its own `unsupported` answer and reported an empty field order.

## Limits and known failures

- The self-check's 10 remaining failures: combining marks are not deleted (2 cases), zero-width and
  C0/DEL handling in `text.normalize` (1), the `text.fingerprint` token/shingle cases (2), a
  non-string `input.text` answering a result instead of `bad-input` (1, which also trips the two error
  envelope order cases), and the JSON encoder's astral round trip (2).
- The worker is registered in `workers/registry.local.json` (machine-local), not in the published
  registry: the interpreter is not guaranteed on every runner yet, and the entry moves when the
  self-check above is green.
- Anything the contract does not describe is not implemented here on purpose; the three capabilities
  are the whole worker.
