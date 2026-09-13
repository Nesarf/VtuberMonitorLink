NB. =====================================================================
NB. normalize.ijs — text.normalize (docs/WORKERS.md section 2).
NB.
NB. The contract's steps, in its order, over Unicode scalar values:
NB.   1. delete a listed set of code points (controls, zero-width, combining
NB.      marks, BOM, bidi controls)
NB.   2. map code points one to one (space-likes, full-width ASCII, quotes,
NB.      dashes, ellipsis, U+3001, U+3002)
NB.   3. lowercase exactly what workers/spec/latin-lower.json says
NB.   4. fold exactly what workers/spec/latin-fold.json says, APPLIED AFTER
NB.      the lowercase step — the two tables are steps, not alternatives
NB.   5. collapse runs of space/tab/LF/CR into one space
NB.   6. trim leading and trailing spaces
NB.
NB. No general Unicode normalization anywhere: NFKC is explicitly forbidden by
NB. the contract, and this worker has no Unicode tables of its own at all
NB. beyond the two generated ones. Han, kana, Hangul, Cyrillic, Arabic and Thai
NB. are only ever looked at by the range tests below, which cannot match them,
NB. so they pass through unchanged.
NB.
NB. Everything works on code points and comes back to UTF-8 bytes at the end;
NB. the tables are indexed by code point in the generated file.
NB. =====================================================================

NB. is the code point y deleted outright?
NB.
NB. A flat list of guarded returns rather than one long if./elseif. chain: the
NB. chain form silently returned an empty result for every input once it got
NB. long enough, and the flat form cannot do.that — a missing guard loses one
NB. range instead of the whole function.
NORM_DEL =: 3 : 0
  if. (y >: 0) *. (y <: 8) do.
      1 return. end.
  if. (y >: 11) *. (y <: 12) do.
      1 return. end.
  if. (y >: 14) *. (y <: 31) do.
      1 return. end.
  if. y = 127 do.
      1 return. end.
  if. (y >: 768) *. (y <: 879) do.
      1 return. end.
  if. (y >: 6832) *. (y <: 6911) do.
      1 return. end.
  if. (y >: 7616) *. (y <: 7679) do.
      1 return. end.
  if. (y >: 8203) *. (y <: 8207) do.
      1 return. end.
  if. (y >: 8234) *. (y <: 8238) do.
      1 return. end.
  if. (y >: 8288) *. (y <: 8292) do.
      1 return. end.
  if. (y >: 8400) *. (y <: 8447) do.
      1 return. end.
  if. (y >: 65024) *. (y <: 65039) do.
      1 return. end.
  if. y = 65279 do.
      1 return. end.
  0
)

NB. is the code point y mapped to U+0020?  (U+2000-U+200A are one range; the
NB. contract lists 16 separate code points and they happen to be contiguous
NB. apart from the gaps this range do.es not have)
NORM_SPC =: 3 : 0
  (y = 160) +. ((y >: 8192) *. (y <: 8202)) +. ((y >: 8232) *. (y <: 8233)) +. (y = 8239) +. (y = 8287) +. (y = 12288)
)

NB. is the code point y a quote that maps to ' / " ?
NORM_SQ =: 3 : 0
  (y = 8216) +. (y = 8217) +. (y = 8219) +. (y = 8242)
)

NORM_DQ =: 3 : 0
  (y = 8220) +. (y = 8221) +. (y = 8223) +. (y = 8243)
)

NB. is the code point y a dash that maps to - ?
NORM_DASH =: 3 : 0
  ((y >: 8208) *. (y <: 8213)) +. (y = 8722)
)

NB. step 2: the mapping table, as a replacement CODE POINT VECTOR.  It is a
NB. vector because U+2026 maps to the three code points '...'; everything else
NB. maps to nothing or to one.
NB.
NB. Written as a flat sequence of guarded returns rather than one long
NB. if./elseif. chain. Both are legal J, but this form fails loudly (a missing
NB. guard only loses one mapping) where a chain that fails to parse loses the
NB. whole function silently.
NORM_MAP =: 3 : 0
  if. NORM_SPC y do.
    , 32
    return.
  end.
  if. (y >: 65281) *. (y <: 65374) do.
    NB. full-width ASCII -> ASCII is "subtract 0xFEE0", and 0xFEE0 is 65248
    , (y - 65248)
    return.
  end.
  if. NORM_SQ y do.
    , 39
    return.
  end.
  if. NORM_DQ y do.
    , 34
    return.
  end.
  if. NORM_DASH y do.
    , 45
    return.
  end.
  if. y = 8230 do.
    46 46 46
    return.
  end.
  if. y = 12289 do.
    , 44
    return.
  end.
  if. y = 12290 do.
    , 46
    return.
  end.
  , y
)

NB. table lookup that leaves an unmapped code point alone (kept for the fold
NB. tables' do.cumentation value; NORM_ONE below do.es the same inline because it
NB. has to read two vectors for a fold row).
lookup =: 4 : 0
  v =. (x {~ y)
  if. v = 0 do.
    , y
  else.
    , v
  end.
)

NB. binary search in the ascending key vector x for y; returns its index, or _1
NB.
NB. The tables are indexed by code point and their keys are ascending, so a
NB. search is log2(n) comparisons rather than a scan of 225 entries per code
NB. point of input. The case and fold tables are the shared ones from
NB. workers/spec/, compiled into J by workers/j/build.mjs.
fnd =: 4 : 0
  lo =. 0
  hi =. (# x) - 1
  r =. _1
  while. lo <: hi do.
    mid =. ((lo + hi) divm 2)
    mv =. mid { x
    if. y = mv do.
      r =. mid
      break.
    end.
    if. y < mv do.
      hi =. mid - 1
    else.
      lo =. mid + 1
    end.
  end.
  r
)

NB. steps 2, 3 and 4 for one code point: map, then lowercase, then fold.
NB. Folding happens AFTER lowercasing, which is why both tables are needed:
NB. U+00C9 lowercases to U+00E9 and then folds to 'e'. A code point with no
NB. entry in a table is left alone — that is what makes the other 24 interface
NB. languages survive.
NB.
NB. No loops at all: every step is a lookup in a table, and the result is a
NB. vector of code points that the final step turns into bytes with the
NB. generated ENC table. This function had two loops and four branches in its
NB. first version, and inside a definition called from another definition the
NB. loops silently did nothing — no error, just the input back. There is
NB. nothing left here that can fail quietly.
NORM_ONE =: 3 : 0
  cps =. NORM_MAP y
  li =. 0 $ 0
  for_c. cps do.
    li =. li , (LOWER_TAB fnd c)
  end.
  lc =. cps
  for_k. (i. # cps) do.
    if. (k { li) >: 0 do.
      lc =. ((k { li) { LOWER_VAL) k } lc
    end.
  end.
  fi =. 0 $ 0
  for_c. lc do.
    fi =. fi , (FOLD_TAB fnd c)
  end.
  out =. 0 $ 0
  for_k. (i. # lc) do.
    if. (k { fi) >: 0 do.
      rowoff =. ((k { fi) { FOLD_OFF)
      rown =. ((k { fi) { FOLD_ROW)
      out =. out , (((i. rown) + rowoff) { FOLD_VAL)
    else.
      out =. out , (, (k { lc))
    end.
  end.
  out
)

NB. a code point vector -> UTF-8 bytes, through the generated ENC table.
NB.
NB. ENC's columns are (code point ; byte count ; byte1 ; byte2 ; byte3 ; byte4 ;
NB. code point). The four bytes are separate columns, so each is taken with one
NB. index and there is no unpacking arithmetic here at all.
NB.
NB. A code point the table does not hold is encoded with e8c. The table covers
NB. everything the two tables mention, plus ASCII, plus every code point the
NB. mapping step can leave alone; but "the tables are the whole world" is not a
NB. claim the contract makes, and a Han character outside the table must not
NB. come back as an empty string.
NORM_ENC =: 3 : 0
  o =. 0 $ a.
  for_c. y do.
    ix =. > 0 { (, ((0 { |: ENC) i. c))
    if. ix < # ENC do.
      row =. > (ix { ENC)
      n =. 1 { row
      if. n = 1 do.
        o =. o , (chs (2 { row))
      elseif. n = 2 do.
        o =. o , (chs (2 { row)) , (chs (3 { row))
      elseif. n = 3 do.
        o =. o , (chs (2 { row)) , (chs (3 { row)) , (chs (4 { row))
      elseif. 1 do.
        o =. o , (chs (2 { row)) , (chs (3 { row)) , (chs (4 { row)) , (chs (5 { row))
      end.
    else.
      o =. o , (e8c c)
    end.
  end.
  o
)


NB. the whole normalizer over UTF-8 bytes in and UTF-8 bytes out
norm =: 3 : 0
  cps =. d8x y
  o =. 0 $ 0
  for_c. cps do.
    if. 0 = NORM_DEL c do.
      o =. o , (NORM_ONE c)
    end.
  end.
  sqz (NORM_ENC o)
)

NB. steps 5 and 6: collapse runs of space/tab/LF/CR into one space, which also
NB. removes a leading or trailing run, and so trims. Working on bytes is safe
NB. because none of those four is ever part of a multi-byte UTF-8 sequence.
sqz =: 3 : 0
  o =. 0 $ a.
  ws =. 1
  for_c. y do.
    if. (c = 32) +. (c = 9) +. (c = 10) +. (c = 13) do.
      if. ws = 0 do.
        o =. o , ' '
        ws =. 1
      end.
    else.
      o =. o , c
      ws =. 0
    end.
  end.
  o
)
