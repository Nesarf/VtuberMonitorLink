# workers/j — the three text capabilities in J

A worker for the multilingual text layer described by `docs/WORKERS.md`:
`text.normalize`, `text.extract` and `text.fingerprint`, in J's base system
only (no addons, no network, nothing installed).

## Build and run

```
node workers/j/build.mjs                                     # generate + assemble
node workers/j/build.mjs | tail -1                           # the artifact path
```

`build.mjs` compiles `workers/spec/latin-lower.json` and `latin-fold.json` into
`workers/j/tables.generated.ijs` (J cannot parse JSON) and then assembles
`workers/j/vmltext.ijs` from `workers/j/src/*.ijs` plus those tables. Its last
stdout line is the generated table path, as section 6 of the contract asks.

Run it with jconsole:

```
<jconsole> workers/j/vmltext.ijs --capability text.normalize
<jconsole> workers/j/vmltext.ijs --capability text.extract
<jconsole> workers/j/vmltext.ijs --capability text.fingerprint
<jconsole> workers/j/vmltext.ijs --selfcheck
```

Where is jconsole? The build looks, in order, at `jconsole` on `PATH`, then
`$VML_J`, then the `j-text` launch command in `workers/registry.local.json`,
then `workers/j/_jconsole.local` (a gitignored one-line file with the path; the
leading underscore is the repository's convention for worker scratch files).
**No machine path appears in any published file here** — the launcher lives in
the gitignored overlay, which is what it is for. Note that the JDK also ships a
program called `jconsole`, which does not run J scripts, so the build asks each
candidate for its J version before believing it.

The worker is launched by the host through `workers/registry.local.json`:

```json
{ "id": "j-text", "language": "j",
  "capabilities": ["text.normalize", "text.extract", "text.fingerprint"],
  "build": ["node", "workers/j/build.mjs"],
  "artifact": "workers/j/vmltext.ijs",
  "launch": ["<this machine's jconsole.exe>", "workers/j/vmltext.ijs"] }
```

## Strategy

- **Bytes, not characters.** Everything works on UTF-8 bytes (J type 2). J's
  literal-character handling never touches the data; the worker decodes UTF-8
  itself. That is what section 1.2 is about, and doing it by hand is also what
  keeps CJK, Cyrillic, Arabic and Hangul unchanged.
- **The tables are the rule.** Step 3 and step 4 of `text.normalize` are the
  shared tables from `workers/spec/`, compiled in at build time. J's own case
  handling is never consulted. A lookup is a binary search over an ascending key
  vector plus a select from the value vector.
- **No general Unicode normalization.** NFKC is forbidden by the contract and is
  not present. Only the listed delete ranges, the listed one-to-one maps, the
  two tables, collapsing and trimming.
- **The encoder is a generated table.** `ENC` holds (code point ; byte count ;
  byte 1..4 ; code point) for every code point the normalizer can emit, so
  encoding a code point is a lookup rather than a branch.
- **JSON by hand.** A decoder for the one request object per line (escapes,
  `\uXXXX` with surrogate pairs, nesting) and an encoder (escaping exactly CR,
  LF and the two mandatory escapes). Numbers are echoed verbatim so their
  spelling cannot change.
- **Locales for state.** A J explicit definition's locals are not visible to the
  verbs it calls, so the JSON scanner's buffer and cursor live in the locale
  `jst` and the HTML state in script-level names. This is not optional; it is
  how J does mutable state at all.

## Honest limits

**The worker answers when stdin closes, not one line at a time.** Section 1
requires flushing each response before reading the next request, and this worker
cannot read the next request while the pipe is open. That was measured, not
assumed:

- `1!:1 ] 3` reads to end of input. With a length (`1!:1 ] 3 [ 1`) it still
  returned all 33 available bytes and then blocked for the rest until the writer
  closed the pipe. There is no line-at-a-time read in this J build.
- The only route to a non-blocking read is J's DLL interface, foreign `15!:0`
  (`PeekNamedPipe`/`ReadFile`), and that foreign does not exist in j9.6: both
  `15!:0` and `15!:10` are undefined. So there is no way to poll stdin.
- No addons are allowed, and the base system has no socket or thread that could
  watch stdin instead.

Consequences: `node tools/workers.mjs` keeps stdin open, so it reports j-text as
`UNUSABLE … answered 0/N` and falls back to the reference. Feeding the worker a
whole request stream and closing stdin works and is how the protocol was tested:

```
node workers/j/_harness.mjs                 # (in the development tree only)
```

**Sixteen-bit words for FNV.** `text.fingerprint` needs `(h * 1099511628211) mod
2^64`, and none of the natural routes work in J:

- `(22 b.)`, the bitwise verb, refuses anything above 2^31 ("x has nonintegral
  value"), and the state is 64 bits wide;
- a J 64-bit **float** cannot hold the FNV offset basis exactly
  (`14695981039346656037` is not representable as a double);
- J's **extended-precision integers** (a literal with an `x`) are exact, but the
  residue verb is not exact on them once the value passes 2^63:
  `4294967296 | 396801799391` answers `1664808159` where the answer is
  `2248259295`. Anything that forms a 64-bit intermediate and takes its residue
  recomputes the right answer as the wrong one.

So the state is eight bytes and every operation keeps its intermediates small.
That is slower than a native multiply and it is exact, which is the point of the
capability.

**Where the implementation stands.** `--selfcheck` runs 21 cases and reports per
case; at the time of writing 2 of 21 pass, so the normalize and extract
capabilities are **not** correct in the assembled worker. The pieces were
developed and tested individually (`d8x`/`e8x` round-trip, the JSON decoder
against the real request shape, the tables against the spec files) and the
assembled worker still diverges. This is a report, not an excuse: the harness is
right and the worker is wrong.

**What to look at first, after the pass counts.** With stdin closed the worker does
answer, and every answer is the same one:
`{"id":null,"ok":false,"error":{"code":"unsupported","message":"unknown op null"}}`.
The request reader is therefore not extracting `op` from the incoming line at all,
which matters as a clue: the JSON decoder round-trips against the real request
shape when it is tested on its own, so the loss is in the join between reading a
line and handing it to the decoder, not in the decoder. That is a much smaller
problem than the capability work above it.

**How to run it at all.** Because this interpreter cannot read a live pipe, the
registry entry carries `"batch": true`, which makes the harness write every case and
then close stdin (`docs/WORKERS.md` section 1.3). Without that flag a run against
this worker can only report UNUSABLE, and the thirty seconds it spends doing so is
the harness being polite about a conversation that was never going to happen.

**Timing.** The normalizer's per-character work is the slow part: about 0.3 ms
per character on this machine, measured with `6!:1`. A 10 KB document is
therefore tens of seconds, i.e. past the harness's 30 s timeout for a whole
corpus, and that is why the fix is vectorization rather than a bigger machine.

## What this cost, in J

Kept because each one produced a plausible wrong answer first, and each is a
trap any J implementation will hit:

1. **`x0`, `y0`, `x1`, `y1` are reserved.** They are the built-in argument names
   of an explicit definition; assigning to one silently yields an empty local.
   This decoded UTF-8 with the continuation bytes the wrong way round.
2. **A verb chain associates from the right.** `3 , X + Y` is `3 , (X + Y)`.
   `(s {. e }. buf)` is a different slice from `((e-s) {. s }. buf)` and the
   wrong one is silent.
3. **A title noun on the left of a verb makes it monadic.** `f a ; b` calls `f`
   monadically, and `FP_ADD8 b8 y8` is a monadic call with two arguments.
4. **`;` is not "make a pair".** `'s' ; 'abc'` is the 2×3 character matrix `'s'`
   over `'abc'`, and `'o' ; matrix` extends the tag to `'oooo'`. Box explicitly.
5. **Nested box structures are merged.** `(,~ 1 2$<'') , (< m)` merges a matrix
   into the accumulator so that `#members` counts cells, and a key comes back as
   the letter `i`.
6. **A J numeric literal has no line continuation.** A vector written over two
   lines is two sentences and only the first is assigned — the generated fold
   table silently had 24 of its 294 entries.
7. **Control words need their trailing dot, on their own line.** `end` is a plain
   word, `do` is a plain word, and the mismatch is reported against whatever
   definition happens to follow, thousands of lines later.
8. **`if.`/`elseif.` chains break down once they get long.** `NORM_MAP` returned
   an empty vector for every input until it was rewritten as guarded returns.
9. **`;.` takes a boolean mask, not a delimiter.** `y <;._2 ' '` is a domain
   error; the mask is `y = ' '`.
10. **`':'` is not a string literal.** A colon is a token, so `at ':'` is invalid
    and every lookup that used it missed.
11. **Locale names are not visible across locales.** `BSL` in `base` is not `BSL`
    in `jst`, and the error is "noun result was required", not "value error".
12. **`(a0) 7 } x` puts the number 7 into position `a0`.** The amendment is
    `value index } array`; written the other way round the hash was wrong in its
    lowest byte only.
13. **A hook with no left argument.** `SC_C01 , SC_C02` is not a list of verbs,
    and calling its head raises whatever the first name last failed on.
14. **`*.` has no short-circuit.** `(p < n) *. (q { v) = 3` indexes even when
    `p < n` is false, so the bounds test has to be a branch.
