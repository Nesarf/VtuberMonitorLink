NB. =====================================================================
NB. json.ijs — a hand-rolled JSON decoder and encoder.
NB.
NB. do.cs/WORKERS.md section 1 says the protocol is one JSON object per line,
NB. and the deliverable forbids addons, so this is written from scratch. It
NB. handles what the protocol needs and is strict about it: object / array /
NB. string / number / true / false / null, escapes including \uXXXX with
NB. surrogate pairs, and arbitrary nesting.
NB.
NB. A decoded value is a boxed structure:
NB.
NB.   (<'s') ; byte vector            a string, as UTF-8 bytes
NB.   (<'n') ; raw number text        a number, kept verbatim so that echoing
NB.                                   it back cannot change its spelling
NB.   (<'b') ; 0 or 1                  true / false
NB.   (<'z') ; 0                       null
NB.   (<'o') ; boxed list of (k ; v)  an object, in input order
NB.   (<'a') ; boxed list of values    an array
NB.
NB. ---------------------------------------------------------------------
NB. Why the scanner lives in a locale and repeats four helpers
NB.
NB. The decoder is a position-threading state machine. J's explicit
NB. definitions (3 : 0) make every name assigned inside them local, and a
NB. local is not visible to a verb the definition calls — verified, not
NB. assumed: an inner 3 : 0 assigning `zz =. zz + 1` where the outer
NB. definition set `zz` fails with "value error: zz". So the cursor cannot be
NB. a local, and a dyadic verb carries only one left and one right argument.
NB. J's answer for shared mutable state is a locale, so the scanner lives in
NB. the locale `jst` and reads/modifies `jstbuf` and `jstpos` there.
NB.
NB. A name defined in base is *not* visible from another locale either: a
NB. verb in locale `qq` referring to `BSL` defined in base fails, and it fails
NB. confusingly — the error is "noun result was required", the message J gives
NB. when an `if.` condition has no noun, not "value error". So the scanner
NB. repeats the handful of helpers it needs (constants, divm, bdig, bhex,
NB. hval, chs, e8c) inside its own locale instead of reaching out of it.
NB. =====================================================================

cocurrent 'jst'

NB. ---- the helpers this locale needs, defined here on purpose ----

LF   =: 10 { a.
CR   =: 13 { a.
TAB  =: 9 { a.
QUOT =: 34 { a.
BSL  =: 92 { a.

divm =: 4 : '(<. (x % y))'
bdig =: 3 : '((y >: 48) *. (y <: 57))'
blet =: 3 : '(((y >: 65) *. (y <: 90)) +. ((y >: 97) *. (y <: 122)))'
bhex =: 3 : '(((y >: 48) *. (y <: 57)) +. ((y >: 97) *. (y <: 102)) +. ((y >: 65) *. (y <: 70)))'
hval =: 3 : 0
  v =. a. i. y
  if. v > 57 do.
      (v - 87) else. (v - 48) end.
)
chs =: 3 : '(y { a.)'
e8c =: 3 : 0
  c =. y
  if. c < 128 do.
    , (c { a.)
  elseif. c < 2048 do.
    (((192 + (c divm 64)) { a.) , (chs (128 + (64 | c))))
  elseif. c < 65536 do.
    (((224 + (c divm 4096)) { a.) , (chs (128 + (64 | (c , (c divm 64))))))
  elseif. 1 do.
    (((240 + (c divm 262144)) { a.) , (chs (128 + (64 | (c , (c divm 64) , (c divm 4096))))))
  end.
)

NB. ---- scanner state ----

jstbuf =: 0 $ a.
jstpos =: 0

NB. move the cursor
adv =: 3 : 0
  jstpos =: jstpos + y
)

NB. is the byte at the cursor the byte VALUE y?
NB.
NB. Two things about this little verb cost real time:
NB.   * the comparison has to be numeric. Comparing the buffer byte with a
NB.     CHARACTER literal answered 0 for every input, so every key lookup in the
NB.     protocol missed and the worker answered "unknown op null" to everything.
NB.   * the two parser names are read into locals first. This locale's own names
NB.     were somehow not visible inside the definition, and reading them through
NB.     locals is visible from anywhere.
at =: 4 : 0
  buf =. jstbuf_jst_
  pos =. jstpos_jst_
  if. pos < # buf do.
    (a. i. (pos { buf)) = x
  else.
    0
  end.
)

NB. skip JSON whitespace
wsp =: 3 : 0
  while. jstpos < # jstbuf do.
    b =. jstpos { jstbuf
    if. (b -: ' ') +. (b -: TAB) +. (b -: LF) +. (b -: CR) do.
      jstpos =: jstpos + 1
    else.
      break.
    end.
  end.
)

NB. cursor at the opening quote -> index just past the closing quote
strend =: 3 : 0
  p =. jstpos + 1
  while. p < # jstbuf do.
    b =. p { jstbuf
    if. b -: BSL do.
      p =. p + 2
    elseif. b -: '"' do.
      p =. p + 1
      break.
    else.
      p =. p + 1
    end.
  end.
  p
)

NB. cursor at 45 or a digit -> index just past the number
numend =: 3 : 0
  p =. jstpos
  if. (p < # jstbuf) *. ((p { jstbuf) -: '-') do.
    p =. p + 1
  end.
  while. (p < # jstbuf) *. (bdig (a. i. (p { jstbuf))) do.
    p =. p + 1
  end.
  if. (p < # jstbuf) *. ((p { jstbuf) -: '.') do.
    p =. p + 1
    while. (p < # jstbuf) *. (bdig (a. i. (p { jstbuf))) do.
      p =. p + 1
    end.
  end.
  if. (p < # jstbuf) *. (((p { jstbuf) -: 'e') +. ((p { jstbuf) -: 'E')) do.
    p =. p + 1
    if. (p < # jstbuf) *. (((p { jstbuf) -: '+') +. ((p { jstbuf) -: '-')) do.
      p =. p + 1
    end.
    while. (p < # jstbuf) *. (bdig (a. i. (p { jstbuf))) do.
      p =. p + 1
    end.
  end.
  p
)

NB. are the four bytes at index y four hex digits?
ishex4 =: 3 : 0
  if. (y + 3) < # jstbuf do.
    t =. 4 {. y }. jstbuf
    ok =. 1
    for_k. t do.
      if. 0 = bhex (a. i. k) do.
      ok =. 0 end.
    end.
    ok
  else.
    0
  end.
)

NB. value of the four hex digits at index y
hex4 =: 3 : 0
  v =. 0
  for_k. (4 {. y }. jstbuf) do.
    v =. ((v * 16) + (hval k))
  end.
  v
)

NB. decode the string whose opening quote is at the cursor; leaves the cursor
NB. just past the closing quote; the result is UTF-8 bytes
str =: 3 : 0
  sx =. 0 $ a.
  p =. jstpos + 1
  while. p < # jstbuf do.
    b =. p { jstbuf
    if. b -: '"' do.
      p =. p + 1
      break.
    end.
    if. b -: BSL do.
      if. (p + 1) < # jstbuf do.
        e =. (p + 1) { jstbuf
        if. e -: 'n' do.
          sx =. sx , LF
          p =. p + 2
        elseif. e -: 't' do.
          sx =. sx , TAB
          p =. p + 2
        elseif. e -: 'r' do.
          sx =. sx , CR
          p =. p + 2
        elseif. e -: 'b' do.
          sx =. sx , (8 { a.)
          p =. p + 2
        elseif. e -: 'f' do.
          sx =. sx , (12 { a.)
          p =. p + 2
        elseif. e -: '"' do.
          sx =. sx , '"'
          p =. p + 2
        elseif. e -: BSL do.
          sx =. sx , BSL
          p =. p + 2
        elseif. e -: '/' do.
          sx =. sx , '/'
          p =. p + 2
        elseif. e -: 'u' do.
          if. ishex4 (p + 2) do.
            cp =. hex4 (p + 2)
            p =. p + 6
            NB. a surrogate pair is one code point, not two
            if. ((cp >: 55296) *. (cp <: 56319)) *. ((p + 5) < # jstbuf) do.
              if. ((p { jstbuf) -: BSL) *. (((p + 1) { jstbuf) -: 'u') do.
                if. ishex4 (p + 2) do.
                  lo =. hex4 (p + 2)
                  if. (lo >: 56320) *. (lo <: 57343) do.
                    cp =. (65536 + ((cp - 55296) * 1024) + (lo - 56320))
                    p =. p + 6
                  end.
                end.
              end.
            end.
            sx =. sx , (e8c cp)
          else.
            p =. p + 2
          end.
        elseif. 1 do.
          p =. p + 2
        end.
      else.
        p =. p + 1
      end.
    else.
      sx =. sx , b
      p =. p + 1
    end.
  end.
  jstpos =: p
  sx
)

NB. skip a whole JSON value: returns the index just past it.
NB.
NB. The object/array branch walks with a local `p` because `strend` wants the
NB. cursor, so it saves and restores jstpos around each quoted string. A
NB. version of this that returned the stale `p` (the value from before the
NB. walk) reported a value's end as its start, which made every nested field
NB. lookup return an empty slice.
vend =: 3 : 0
  wsp 0
  if. jstpos >: # jstbuf do.
    jstpos
  elseif. at 34 do.
    strend 0
  elseif. (at 123) +. (at 91) do.
    depth =. 0
    p =. jstpos
    while. p < # jstbuf do.
      b =. p { jstbuf
      if. b -: '"' do.
        jstpos =: p
        p =. strend 0
      elseif. (b -: '{') +. (b -: '[') do.
        depth =. depth + 1
        p =. p + 1
      elseif. (b -: '}') +. (b -: ']') do.
        depth =. depth - 1
        p =. p + 1
        if. depth = 0 do.
          break.
        end.
      else.
        p =. p + 1
      end.
    end.
    jstpos =: p
    p
  elseif. at 116 do.
    jstpos + 4
  elseif. at 102 do.
    jstpos + 5
  elseif. at 110 do.
    jstpos + 4
  elseif. 1 do.
    numend 0
  end.
)

NB. =====================================================================
NB. json.ijs (tail) — the decoder, the object model, and the encoder.
NB.
NB. ---------------------------------------------------------------------
NB. The object model, and why it is this flat
NB.
NB. J boxing cost this file several wrong versions, so the shapes are stated
NB. here once, in full, and everything below obeys them.
NB.
NB.   scalar value:   (<tag) , (<text)
NB.                     tag  's' string   text = the UTF-8 bytes
NB.                          'n' number   text = the number as written
NB.                          'b' boolean  text = 'true' / 'false'
NB.                          'z' null     text = 'null'
NB.                          'o' object   text = the object's raw JSON text
NB.                          'a' array    text = the array's raw JSON text
NB.
NB.   array members:  a boxed list of scalar values.
NB.
NB.   object members: nowhere in memory. An object value carries its raw text
NB.                   and a field is parsed out of that text on demand, by
NB.                   `rawfieldof` / `getstr` below, using this same decoder.
NB.
NB. Why so flat: a J box is a scalar that holds one thing, and the things that
NB. "hold a list" do.not compose. LINK (`;`) razes its arguments ('s' ; 'abc'
NB. is a 2 3 character matrix; 'o' ; matrix extends the tag to 'oooo'), and
NB. `(,~ 1 2$<'') , (< m)` merges a matrix into the accumulator so that
NB. #members ends up counting cells. Boxed matrices do.survive being boxed,
NB. but nesting a pair around one is a fight with the rank system for no gain:
NB. the protocol only ever asks for the text of one field of one object.
NB.
NB. Every expression that indexes or that mixes more than two verbs is
NB. parenthesised, because J evaluates right to left and `f x -: g i { o`
NB. parses as `(f -: g) i { o` — a hook, not the comparison it looks like.
NB. =====================================================================

NB. build a scalar value; both halves are boxed explicitly (see above)
jval =: 3 : 0
  (< (> 0 { y)) , (< (> 1 { y))
)

jt =: 3 : 0
  (> 0 { y)
)

jv =: 3 : 0
  (> 1 { y)
)

NB. is the value's tag x?
jis =: 4 : 0
  if. x -: (> 0 { y) do.
      1 else. 0 end.
)

value =: 3 : 0
  wsp 0
  if. jstpos >: # jstbuf do.
    jval 'z' ; 'null'
  elseif. at 123 do.
    obj 0
  elseif. at 91 do.
    arr 0
  elseif. at 34 do.
    jval 's' ; (str 0)
  elseif. at 116 do.
    jstpos =: jstpos + 4
    jval 'b' ; 'true'
  elseif. at 102 do.
    jstpos =: jstpos + 5
    jval 'b' ; 'false'
  elseif. at 110 do.
    jstpos =: jstpos + 4
    jval 'z' ; 'null'
  elseif. 1 do.
    s =. jstpos
    e =. numend 0
    if. e > s do.
      jstpos =: e
      jval 'n' ; ((e - s) {. s }. jstbuf)
    else.
      jstpos =: jstpos + 1
      jval 'z' ; 'null'
    end.
  end.
)

NB. An object decodes to (<'o') , (<its raw JSON text>); the members are not
NB. kept. `vstart` is the index of the opening brace, so the raw text is one
NB. slice when the walk is do.ne.
obj =: 3 : 0
  vstart =. jstpos
  jstpos =: jstpos + 1
  wsp 0
  while. jstpos < # jstbuf do.
    if. at 125 do.
      jstpos =: jstpos + 1
      break.
    end.
    if. -. at 34 do.
      jstpos =: (# jstbuf) + 1
      break.
    end.
    str 0
    wsp 0
    if. at 58 do.
      jstpos =: jstpos + 1
    end.
    value 0
    wsp 0
    if. at 44 do.
      jstpos =: jstpos + 1
      wsp 0
    end.
  end.
  jval 'o' ; ((jstpos - vstart) {. vstart }. jstbuf)
)

NB. An array decodes to (<'a') , (<its members>) — the members are cheap to
NB. keep and nothing needs the raw text of an array.
arr =: 3 : 0
  jstpos =: jstpos + 1
  m =. (<'')
  wsp 0
  while. jstpos < # jstbuf do.
    if. at 93 do.
      jstpos =: jstpos + 1
      break.
    end.
    v =. value 0
    m =. m , (< v)
    wsp 0
    if. at 44 do.
      jstpos =: jstpos + 1
      wsp 0
    end.
  end.
  jval 'a' ; (}. m)
)

NB. parse a whole JSON text
parse =: 3 : 0
  jstbuf =: y
  jstpos =: 0
  value 0
)

NB. the index of the first occurrence of the KEY "y" in the buffer, or #jstbuf.
NB.
NB. Three details, each of which was a wrong answer first:
NB.   * J's dyadic E. is `pattern E. text` — the LEFT argument is the pattern,
NB.     the opposite of how `text ss pattern` would read, and there is no `ss`.
NB.   * the key must be delimited by the quote on the LEFT too: searching for
NB.     "input" inside {"capability":"text.normalize","input":...} matches the
NB.     substring "input" of "capability" and reads the wrong value. Requiring
NB.     the byte before the opening quote to be a non-alphanumeric fixes it.
NB.   * a later match has to be tried when an earlier one is not a key.
findsub =: 3 : 0
  pat =. ('"' , (y , '"'))
  r =. # jstbuf
  from =. 0
  while. from < # jstbuf do.
    m =. pat E. (from }. jstbuf)
    ix =. m i. 1
    if. ix >: # m do.
      break.
    end.
    at1 =. from + ix
    ok =. 1
    if. at1 > 0 do.
      pb =. a. i. ((at1 - 1) { jstbuf)
      if. (blet pb) +. (bdig pb) do.
        ok =. 0
      end.
    end.
    if. ok = 1 do.
      r =. at1
      break.
    end.
    from =. at1 + 1
  end.
  r
)

NB. key y's value taken verbatim out of the buffer as raw JSON text, so an id
NB. of any type is echoed unchanged; the four bytes `null` when absent. This
NB. scans for "key" anywhere, which is all the protocol needs: the request
NB. object is flat apart from `input`, and `input` is parsed on demand.
rawfield =: 3 : 0
  ix =. findsub y
  if. ix < # jstbuf do.
    jstpos =: (ix + 2 + (# y))
    wsp 0
    if. at 58 do.
      jstpos =: jstpos + 1
      wsp 0
      s =. jstpos
      e =. vend 0
      ((e - s) {. s }. jstbuf)
    else.
      'null'
    end.
  else.
    'null'
  end.
)

cocurrent 'base'

NB. ---------------------------------------------------------------------
NB. nested objects: decode the raw text again on demand
NB. ---------------------------------------------------------------------

NB. tag and value accessors, defined here as well as in the jst locale above:
NB. a name defined in one locale is not visible from another, and these are
NB. used from the protocol loop in base.
jt =: 3 : 0
  (> 0 { y)
)

jv =: 3 : 0
  (> 1 { y)
)

jis =: 4 : 0
  if. x -: (> 0 { y) do.
      1 else. 0 end.
)

NB. decode a value from raw JSON text
jparse =: 3 : 0
  parse_jst_ y
)

NB. the raw JSON text of field k of the object whose raw text is t, or '' when
NB. the field is absent. Only the object's own top level is searched, so a key
NB. that also appears further in cannot win by accident.
rawfieldof =: 3 : 0
  k =. > 0 { y
  t =. > 1 { y
  r =. ''
  jstbuf_jst_ =: t
  jstpos_jst_ =: 0
  if. 1 = at_jst_ 123 do.
    jstpos_jst_ =: 1
    while. jstpos_jst_ < # t do.
      wsp_jst_ 0
      if. 1 = at_jst_ 125 do.
        break.
      end.
      if. 0 = at_jst_ 34 do.
        break.
      end.
      kk =. str_jst_ 0
      wsp_jst_ 0
      if. 1 = at_jst_ 58 do.
        jstpos_jst_ =: (jstpos_jst_ + 1)
      end.
      s =. jstpos_jst_
      e =. vend_jst_ 0
      if. kk -: k do.
        r =. ((e - s) {. s }. t)
        break.
      end.
      jstpos_jst_ =: e
      wsp_jst_ 0
      if. 1 = at_jst_ 44 do.
        jstpos_jst_ =: (jstpos_jst_ + 1)
      end.
    end.
  end.
  r
)

NB. the string value of field k of the object whose raw text is t; '' when the
NB. field is absent or is not a string
getstr =: 3 : 0
  k =. > 0 { y
  t =. > 1 { y
  r =. rawfieldof (k ; t)
  if. 1 > # r do.
    ''
  elseif. -. ((0 { r) -: '"') do.
    ''
  else.
    jstbuf_jst_ =: r
    jstpos_jst_ =: 0
    str_jst_ 0
  end.
)

NB. ---------------------------------------------------------------------
NB. building JSON text
NB. ---------------------------------------------------------------------

NB. two lowercase hex digits for a byte value
hx2 =: 3 : 0
  d =. '0123456789abcdef'
  ((d {~ (16 | (y divm 16))) , (d {~ (16 | y)))
)

NB. escape one string: UTF-8 bytes in, the JSON string body out, no quotes.
NB.
NB. Bytes that are not escaped pass through unchanged, because the payload is
NB. already UTF-8 and the protocol is UTF-8: there is nothing to re-encode.
NB. CR and LF *are* escaped, which is also what keeps J's CRLF line endings
NB. out of the JSON payload — the only CRLF on stdout is the line terminator.
jesc =: 3 : 0
  o =. 0 $ a.
  for_b. y do.
    c =. b
    n =. a. i. c
    if. c -: '"' do.
      o =. o , '\"'
    elseif. c -: BSL do.
      o =. o , '\\'
    elseif. n < 32 do.
      o =. o , '\u00'
      o =. o , (hx2 n)
    else.
      o =. o , c
    end.
  end.
  o
)

NB. a string as a JSON value, quotes included
jstrv =: 3 : '((QUOT , (jesc y)) , QUOT)'

NB. an integer as a JSON value
fmtint =: 3 : 0
  if. y = 0 do.
    , '0'
  else.
    d =. '0123456789'
    o =. 0 $ a.
    n =. y
    while. n > 0 do.
      o =. (d {~ (10 | n)) , o
      n =. n divm 10
    end.
    o
  end.
)

jintv =: 3 : 0
  if. y < 0 do.
    ('-' , (fmtint (- y)))
  else.
    fmtint y
  end.
)

jboolv =: 3 : 0
  if. y = 0 do.
      'false' else. 'true' end.
)
