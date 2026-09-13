NB. =====================================================================
NB. fingerprint.ijs — text.fingerprint (docs/WORKERS.md section 4).
NB.
NB. All integer arithmetic, on purpose: section 4 says so, and it is what makes
NB. "byte-identical across languages" achievable rather than aspirational.
NB.
NB. ---------------------------------------------------------------------
NB. Why the hash is kept as eight bytes and not as a J number
NB.
NB. J's extended-precision integers are exact, but the residue verb `|` is not
NB. exact on them: `4294967296 | 12638153115695167455` returns 2248259551 when
NB. the answer is 2248259295 (it divides by a float). And `(22 b.)`, the bitwise
NB. verb, refuses anything above 2^31 outright ("x has nonintegral value"). J's
NB. 64-bit FLOATS cannot hold the FNV-1a state exactly either — 14695981039346656037
NB. is not representable as a double.
NB.
NB. So the state is an 8-byte little-endian vector and the two operations are
NB. done on bytes, where every intermediate is small enough to be exact:
NB. multiply by 0x83 in place with carries, and XOR one byte in. That is slower
NB. than a native multiply and it is exact on every platform, which is the whole
NB. point of the capability.
NB. =====================================================================

NB. ---- the punctuation set, as a membership table -------------------------
NB. The set is !?,.;:'"()[]{}<>-_/\|*+=~`@#$%^& from the contract's step 3.
NB. FP_PUNCT_V is the 0/1 vector itself: a code point below 128 indexes it
NB. directly (a code point IS its byte value there) and everything above 127 is
NB. punctuation-free, so testing a code point needs no UTF-8 encoding at all.
NB. The first version encoded the code point and then indexed the table with a
NB. CHARACTER, which is a domain error.
FP_PUNCT_P =: '!?,.;:''"()[]{}<>-_/\|*+=~`@#$%^&'
FP_PUNCT_V =: (i. 256) e. (a. i. FP_PUNCT_P)

NB. is the CODE POINT y punctuation?
FP_ISPUNCT =: 3 : 0
  if. y > 127 do.
    0
  else.
    (y { FP_PUNCT_V)
  end.
)

NB. ---- CJK membership ----------------------------------------------------
NB. Han U+3400-U+4DBF, U+4E00-U+9FFF, U+F900-U+FAFF, kana U+3040-U+30FF,
NB. Hangul U+AC00-U+D7AF.
FP_CJK_LO =: 13312 19968 63744 12352 44032
FP_CJK_HI =: 19903 40959 64255 12543 55215
FP_CJK =: 3 : 0
  r =. 0
  for_k. (i. 5) do.
    if. (y >: (k { FP_CJK_LO)) *. (y <: (k { FP_CJK_HI)) do.
      r =. 1
      break.
    end.
  end.
  r
)

NB. ---------------------------------------------------------------------
NB. FNV-1a 64 over bytes, done on eight bytes, most significant byte first
NB.
NB. Nothing here uses a 64-bit J number, and that is not a style choice:
NB.   * `(22 b.)`, the bitwise verb, refuses anything above 2^31 ("x has
NB.     nonintegral value") — and the FNV state is 64 bits wide;
NB.   * J's extended-precision integers are exact, but the residue verb is NOT
NB.     exact on them: `4294967296 | 12638153115695167455` answers 2248259551
NB.     where the answer is 2248259295 (it divides by a float);
NB.   * a J 64-bit FLOAT cannot hold the FNV offset basis exactly either
NB.     (14695981039346656037 is not representable as a double).
NB.
NB. So the state is eight bytes and every intermediate stays under 2^16, where
NB. J is exact. The full multiply is written out byte by byte rather than as a
NB. loop over a chain: the loop versions of it were wrong twice, each time
NB. producing eight plausible bytes.
NB. ---------------------------------------------------------------------

NB. XOR one byte value into the LOW byte of the 8-byte state.
NB.
NB. The low byte is index 7 (the state is most significant byte first).
NB. The amendment is `value index } array`: `(a0) 7 } x` puts the NUMBER 7 into
NB. position a0, which is not what it looks like. Written the other way round
NB. the hash came back wrong in its lowest byte only.
FP_XOR1 =: 4 : 0
  a0 =. (7 { x) (22 b.) y
  (a0) 7 } x
)

NB. multiply the 8-byte state y by the FNV prime 0x100000001B3.
NB.
NB. The prime is 179 (0xB3) plus 2^8 plus 2^40, so
NB.
NB.   out = y * 179  +  (y << 8)  +  (y << 40)     mod 2^64
NB.
NB. Each of those three terms leaves the bytes below i untouched, so byte i of
NB. the result is
NB.
NB.   q[i] = the carry chain of (y * 179)  +  y[i-1]  +  y[i-5]
NB.
NB. and that is all there is to it: the two shifted copies enter the chain at
NB. their own byte, and the carry runs left to right. Every intermediate is
NB. under 2^16, so J is exact.
NB.
NB. Getting this right was the whole difficulty of the fingerprint capability in
NB. J. Two loop versions produced eight plausible bytes but the wrong hash, and
NB. so did a version that read the state with the bytes the wrong way round and
NB. a version that used 0x83 instead of 0xB3. The written-out form below can be
NB. checked by hand against the reference value for the empty input, where the
NB. state is the offset basis 0xCB F2 9C E4 84 22 23 25 and the prime product is
NB. 0xAF 63 BD 4C 86 01 B7 DF.
FP_PRIME8 =: 3 : 0
  s0 =. 179 * (y {~ 0)
  s1 =. (179 * (y {~ 1)) + (y {~ 0)
  s2 =. (179 * (y {~ 2)) + (y {~ 1)
  s3 =. (179 * (y {~ 3)) + (y {~ 2)
  s4 =. (179 * (y {~ 4)) + (y {~ 3)
  s5 =. (179 * (y {~ 5)) + ((y {~ 4) + (y {~ 0))
  s6 =. (179 * (y {~ 6)) + ((y {~ 5) + (y {~ 1))
  s7 =. (179 * (y {~ 7)) + ((y {~ 6) + (y {~ 2))
  car =. s0 divm 256
  r0 =. 256 | s0
  t1 =. s1 + car
  car =. t1 divm 256
  r1 =. 256 | t1
  t2 =. s2 + car
  car =. t2 divm 256
  r2 =. 256 | t2
  t3 =. s3 + car
  car =. t3 divm 256
  r3 =. 256 | t3
  t4 =. s4 + car
  car =. t4 divm 256
  r4 =. 256 | t4
  t5 =. s5 + car
  car =. t5 divm 256
  r5 =. 256 | t5
  t6 =. s6 + car
  car =. t6 divm 256
  r6 =. 256 | t6
  t7 =. s7 + car
  r7 =. 256 | t7
  r0 , r1 , r2 , r3 , r4 , r5 , r6 , r7
)

NB. FNV-1a 64 over the byte vector y, as eight bytes most significant first
FP_FNV8 =: 3 : 0
  h =. 203 242 156 228 132 34 35 37
  for_b. y do.
    h =. FP_PRIME8 h
    h =. h FP_XOR1 (a. i. b)
  end.
  h
)

NB. eight state bytes (most significant first) -> 16 lowercase hex digits
FP_HEX8 =: 3 : 0
  hexd =. '0123456789abcdef'
  r =. 0 $ a.
  for_b. y do.
    r =. r , (hexd {~ (16 | (b divm 16)))
    r =. r , (hexd {~ (16 | b))
  end.
  r
)

NB. the hash of a byte vector as the 16-character string the contract wants
FP_FNV =: 3 : 0
  FP_HEX8 (FP_FNV8 y)
)

NB. ---------------------------------------------------------------------
NB. tokens and shingles
NB. ---------------------------------------------------------------------

NB. the tokens emitted for one space-free piece
FP_TOK =: 3 : 0
  cps =. d8x y
  n =. # cps
  s =. 0
  while. (s < n) *. (FP_ISPUNCT (s { cps)) do.
    s =. s + 1
  end.
  e =. n
  while. (e > s) *. (FP_ISPUNCT ((e - 1) { cps)) do.
    e =. e - 1
  end.
  if. e <: s do.
    (< 0 $ a.)
    return.
  end.
  mid =. ((e - s) {. s }. cps)
  allp =. 1
  for_c. mid do.
    if. 0 = FP_ISPUNCT c do.
      allp =. 0
      break.
    end.
  end.
  if. allp = 1 do.
    (< 0 $ a.)
    return.
  end.
  out =. 0 $ <''
  if. FP_CJK (0 { mid) do.
    cur =. 1
  else.
    cur =. 0
  end.
  seg =. 0 $ 0
  for_c. mid do.
    if. (FP_CJK c) = cur do.
      seg =. seg , c
    else.
      out =. out , (< (FP_EMIT cur ; seg))
      cur =. FP_CJK c
      seg =. , c
    end.
  end.
  out =. out , (< (FP_EMIT cur ; seg))
  out
)

NB. emit one run: y is (isCjk ; code points)
FP_EMIT =: 3 : 0
  cj =. > 0 { y
  seg =. > 1 { y
  if. cj = 1 do.
    if. 1 = # seg do.
      , (e8x seg)
    else.
      r =. 0 $ a.
      for_k. (i. (# seg) - 1) do.
        r =. r , (e8x ((k { seg) , ((k + 1) { seg)))
      end.
      r
    end.
  else.
    e8x seg
  end.
)

NB. all emitted tokens of a (already normalized) text.
NB.
NB. `y <;._2 ' '` is not "split on spaces": the left argument of ;. is a
NB. BOOLEAN mask, and a character left argument is a domain error. The mask here
NB. is `y = ' '`, and <;._2 cuts before each 1 and drops the leading empty piece.
FP_TOKENS =: 3 : 0
  out =. 0 $ <''
  for_t. ((y = ' ') <;._2 y) do.
    if. (# t) > 0 do.
      for_u. (FP_TOK t) do.
        if. (# (> u)) > 0 do.
          out =. out , u
        end.
      end.
    end.
  end.
  out
)

NB. the shingles: overlapping runs of three, or the whole list when short
FP_SHINGLES =: 3 : 0
  toks =. y
  n =. # toks
  if. n = 0 do.
    (< 0 $ a.)
    return.
  end.
  if. n < 3 do.
    r =. 0 $ a.
    for_k. (i. n) do.
      if. k > 0 do.
        r =. r , ' '
      end.
      r =. r , (> k { toks)
    end.
    (< r)
    return.
  end.
  out =. 0 $ <''
  for_k. (i. 1 + n - 3) do.
    r =. (> k { toks)
    r =. r , ' ' , (> (k + 1) { toks)
    r =. r , ' ' , (> (k + 2) { toks)
    out =. out , (< r)
  end.
  out
)

NB. ---------------------------------------------------------------------
NB. SimHash over the shingle hashes
NB. ---------------------------------------------------------------------

NB. the bit vector of an 8-byte little-endian hash: 64 bits, bit i = (i { bits)
FP_BITS =: 3 : 0
  r =. 0 $ 0
  for_k. (i. 8) do.
    v =. y {~ k
    r =. r , ((0 { v) (17 b.) 1)
    r =. r , ((0 { v) (17 b.) 2) divm 2
    r =. r , ((0 { v) (17 b.) 4) divm 4
    r =. r , ((0 { v) (17 b.) 8) divm 8
    r =. r , ((0 { v) (17 b.) 16) divm 16
    r =. r , ((0 { v) (17 b.) 32) divm 32
    r =. r , ((0 { v) (17 b.) 64) divm 64
    r =. r , ((0 { v) (17 b.) 128) divm 128
  end.
  r
)

NB. the whole capability: y is the normalized text as bytes
fingerprint =: 3 : 0
  toks =. FP_TOKENS y
  shs =. FP_SHINGLES toks
  cnt =. 64 $ 0
  for_s. shs do.
    bits =. FP_BITS (FP_FNV8 (> s))
    for_k. (i. 64) do.
      if. (k { bits) = 1 do.
        cnt =. (1 + (k { cnt)) k } cnt
      else.
        cnt =. ((k { cnt) - 1) k } cnt
      end.
    end.
  end.
  hx =. 64 $ 0
  for_k. (i. 64) do.
    if. (k { cnt) > 0 do.
      hx =. (k) 1 } hx
    end.
  end.
  (< (FP_HEX64 hx)) , (< (# toks)) , (< (# shs))
)

NB. a 64-element 0/1 bit vector -> 16 lowercase hex digits, most significant
NB. first. Bits are held in their own vector rather than packed into a number,
NB. for the reason given at the top of this file: the bitwise verb refuses
NB. anything above 2^31 and the hash does not fit in a J 64-bit float.
NB.
NB. Hex digit k is bits (60-4k) .. (63-4k) of the hash, so the LOWEST index of
NB. the group is 60 - 4k: for k = 15 that is 0, and for k = 0 it is 60. Writing
NB. the four terms the other way round makes the last group index -3 and every
NB. hash fails with an index error on its final digit.
FP_HEX64 =: 3 : 0
  hexd =. '0123456789abcdef'
  r =. 0 $ a.
  for_k. (i. 16) do.
    lo =. 60 - (4 * k)
    v =. ((y {~ (lo + 3)) * 8) + ((y {~ (lo + 2)) * 4) + ((y {~ (lo + 1)) * 2) + (y {~ lo)
    r =. r , (hexd {~ v)
  end.
  r
)

NB. add two decimal strings
FP_ADDSTR =: 3 : 0
  a =. > 0 { y
  b =. > 1 { y
  na =. # a
  nb =. # b
  n =. na >. nb
  a =. ((n - na) $ '0') , a
  b =. ((n - nb) $ '0') , b
  r =. 0 $ a.
  car =. 0
  for_k. ((n - 1) - i. n) do.
    v =. ((a. i. (a {~ k)) + (a. i. (b {~ k))) + car
    r =. (('0123456789' {~ (10 | v))) , r
    car =. v divm 10
  end.
  if. car > 0 do.
    (('0123456789' {~ car)) , r
  else.
    r
  end.
)

NB. a decimal string -> 16 lowercase hex digits (zero padded)
NB. repeated division by 16 on the decimal string; the value is at most 2^64.
FP_HEXOF =: 3 : 0
  hexd =. '0123456789abcdef'
  dig =. y
  r =. 0 $ a.
  if. 0 = # dig do. dig =. , '0' end.
  while. (1 < # dig) +. (dig ~: , '0') do.
    q =. 0 $ a.
    rem =. 0
    for_k. (i. # dig) do.
      cur =. (rem * 10) + (a. i. (dig {~ k))
      d =. cur divm 16
      rem =. 16 | cur
      if. (d > 0) +. (0 < # q) do.
        q =. q , ('0123456789' {~ d)
      end.
    end.
    r =. (hexd {~ rem) , r
    dig =. q
    if. 0 = # dig do. dig =. , '0' end.
  end.
  while. 16 > # r do.
    r =. '0' , r
  end.
  if. 16 < # r do. (16 {. r) end.
  r
)
