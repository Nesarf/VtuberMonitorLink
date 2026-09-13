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
| `node tools/workers-diff.mjs --with-local --n 25 --seed 7 --cap <each>` | **25/25 generated cases unanimous across 10 implementations**, 250 repeat answers identical, no divergence |
| `perl workers/perl/vmltext.pl --selfcheck` | **50/50**, and the same 50/50 in three consecutive runs |

The self-check row matters as much as the corpus rows: it used to fail a *different* number of cases
on every run, because it asked `keys %$hash` for a field order. A worker whose own test cannot agree
with itself is a worker whose next reader learns nothing from a red run.

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
- **A hand-written fast path drifts away from the rules it guards.** `normalize` skips its first two
  steps when the input cannot contain anything they would touch, and that test was a character class
  written out by hand next to the table - with the combining marks missing from it. A string whose only
  interesting characters were accents therefore skipped the steps entirely, and `Cafe` + U+0301 came
  back as `café` while the reference deleted the mark. The class is now built from the same table the
  steps use, so the two cannot disagree. The self-check's own expectation for the zero-width case was
  wrong in the same area (it expected the deleted characters to become spaces) and was corrected
  against the reference implementation, which answers `abcde fg`.
- **The self-check's summary line lied**: it printed `$n/$n checks passed` when there were failures.
  It prints `passed/total` and exits non-zero.
- **In `handle`, one worker implements one capability** (a request for another one is `unsupported`),
  so the self-check has to set the capability it is asking about before it calls `handle` - otherwise
  it measured its own `unsupported` answer and reported an empty field order.

## Limits and known failures

- None open. The self-check's list is empty and the corpus is unanimous for all three capabilities.
  Two of the three "fingerprint failures" it used to report turned out to be wrong *expectations*
  rather than wrong answers - the reference implementation and the shingle hash computed on its own
  both agreed with the worker - and the zero-width expectation was wrong in the same way. They were
  corrected against the reference, not against this file.
- The worker is registered in `workers/registry.local.json` (machine-local), not in the published
  registry: Perl is present on the three CI runners as far as anyone knows, and "as far as anyone
  knows" is not the same as measured, so the entry moves only once that has been checked.
- Anything the contract does not describe is not implemented here on purpose; the three capabilities
  are the whole worker.
