NB. =====================================================================
NB. core.ijs — byte, code point and UTF-8 helpers.
NB.
NB. Assembled by workers/j/build.mjs into vmltext.ijs; it is a part, not a
NB. script. Everything here works on *bytes* (J type 2, 8-bit characters): the
NB. transport is UTF-8 bytes and docs/WORKERS.md section 1.2 says they must
NB. survive unchanged for CJK, Cyrillic, Arabic and Hangul, so this file does
NB. its own UTF-8 decoding and never lets J's literal-character handling near
NB. the data.
NB.
NB. J notes that cost real time here, kept because they will cost it again:
NB.
NB.   * J evaluates right to left, and a chain of verbs is read from the right:
NB.     `3 , X + Y` is `3 , (X + Y)`. Every phrase below that mixes verbs is
NB.     parenthesised, including ones where it looks redundant.
NB.   * J's % is FLOAT division. A float cannot index a. ("x is not an
NB.     integer"), so integer division is `divm`.
NB.   * x0 / y0 / x1 / y1 ... are the built-in names for the arguments of an
NB.     explicit definition. Assigning to one gives an empty local instead.
NB.   * a verb chain with no left argument reads as a HOOK: `(> 2) { row` is
NB.     index 2 applied to a box, not row[2] unboxed.
NB. =====================================================================

NB. ---------------------------------------------------------------------
NB. 1.1 byte utilities
NB. ---------------------------------------------------------------------

LF   =: 10 { a.
CR   =: 13 { a.
TAB  =: 9 { a.
SP   =: 32 { a.
QUOT =: 34 { a.
BSL  =: 92 { a.

NB. integer division: J's % is float division and a float cannot index a table
divm =: 4 : '(<. (x % y))'

NB. is the byte value y a decimal digit / hex digit / ASCII letter?
bdig =: 3 : '((y >: 48) *. (y <: 57))'
bhex =: 3 : '(((y >: 48) *. (y <: 57)) +. ((y >: 97) *. (y <: 102)) +. ((y >: 65) *. (y <: 70)))'
blet =: 3 : '(((y >: 65) *. (y <: 90)) +. ((y >: 97) *. (y <: 122)))'
baln =: 3 : '((blet y) +. (bdig y))'

NB. numeric value of one hex digit character
hval =: 3 : 0
  v =. a. i. y
  if. v > 57 do.
    v - 87
  else.
    v - 48
  end.
)

NB. numeric byte value -> the one-character string with that byte value
chs =: 3 : '(y { a.)'

NB. ---------------------------------------------------------------------
NB. 1.2 UTF-8: bytes -> code points
NB.
NB. LEN is the decoder's only table: how many bytes the sequence starting with a
NB. given byte occupies. Everything else is arithmetic.
NB.
NB. A continuation byte past the end of the input is read as NUL, and its value
NB. is then meaningless — which is deliberate. Such a byte is malformed UTF-8,
NB. the contract never sends it, and reading a byte that is not there must not
NB. be an index error. (Indexing the vector directly was the first version, and
NB. it threw "x is 1; too long for y" instead of decoding; the self-check
NB. caught it.)
NB. ---------------------------------------------------------------------

LEN =: (256 $ 1) , 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1
LEN =: LEN (194 + i. 30) }~ (30 $ 2)
LEN =: LEN (224 + i. 16) }~ (16 $ 3)
LEN =: LEN (240 + i. 5) }~ (5 $ 4)

NB. the byte at index y of the buffer `bv`, or NUL when it is past the end
bAt =: 3 : 0
  r =. 0
  if. y < # bv do.
    r =. a. i. (y { bv)
  end.
  r
)

NB. Decode the sequence starting at index `idx` of the buffer `bv`; the result
NB. is (code point ; bytes consumed). The two inputs are script-level names
NB. rather than arguments because a J verb takes one left and one right
NB. argument, and `verb vec ; i` calls the verb *monadically* with the boxed
NB. list — a noun on the left of a verb becomes the whole right argument.
tou8 =: 3 : 0
  i0 =. idx
  b0 =. bAt i0
  ln =. LEN {~ b0
  q1 =. bAt (i0 + 1)
  q2 =. bAt (i0 + 2)
  q3 =. bAt (i0 + 3)
  if. ln = 1 do.
    b0 , 1
  elseif. ln = 2 do.
    ((((b0 - 192) * 64) + q1) - 128) , 2
  elseif. ln = 3 do.
    ((((((b0 - 224) * 64) + q1) - 128) * 64) + q2) - 128 , 3
  elseif. 1 do.
    (((((((((b0 - 240) * 64) + q1) - 128) * 64) + q2) - 128) * 64) + q3) - 128 , 4
  end.
)

NB. whole byte vector -> vector of code points
d8x =: 3 : 0
  bv =: y
  n =. # bv
  out =. (0 $ 0)
  idx =: 0
  while. idx < n do.
    cell =. tou8 0
    out =. (out , ({. cell))
    idx =: (idx + ({: cell))
  end.
  out
)

NB. ---------------------------------------------------------------------
NB. 1.3 UTF-8: code points -> bytes
NB. ---------------------------------------------------------------------

NB. one code point -> its UTF-8 bytes.
NB.
NB. Each continuation byte is 0x80 plus the next six bits of the code point above
NB. the bits already emitted, so the shifts are divm by 64, 4096 and 262144 —
NB. the SAME divisors as the leading byte's, not the previous byte's. Using the
NB. wrong divisor produces a two-byte sequence whose second byte is 0x03 instead
NB. of 0xA9, which is still two well-formed-looking bytes and decodes to the
NB. wrong character rather than failing.
e8c =: 3 : 0
  c =. y
  if. c < 128 do.
    , (c { a.)
    return.
  end.
  if. c < 2048 do.
    b1 =. 192 + (c divm 64)
    q1 =. 128 + (64 | c)
    ((b1 { a.) , (chs q1))
    return.
  end.
  if. c < 65536 do.
    b1 =. 224 + (c divm 4096)
    q1 =. 128 + (64 | (c divm 64))
    q2 =. 128 + (64 | c)
    ((b1 { a.) , (chs q1) , (chs q2))
    return.
  end.
  b1 =. 240 + (c divm 262144)
  q1 =. 128 + (64 | (c divm 4096))
  q2 =. 128 + (64 | (c divm 64))
  q3 =. 128 + (64 | c)
  ((b1 { a.) , (chs q1) , (chs q2) , (chs q3))
)

NB. vector of code points -> UTF-8 bytes
e8x =: 3 : 0
  if. 0 = # y do.
    (0 $ a.)
  else.
    ; (e8c each y)
  end.
)
