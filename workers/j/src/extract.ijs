NB. =====================================================================
NB. extract.ijs — text.extract (docs/WORKERS.md section 3).
NB.
NB. A specified state machine over the SCALAR VALUES, not "whatever an HTML
NB. parser do.es": J's base system has no HTML parser either, and the contract
NB. writes the rules out step by step. Nothing here is normalized — section 3.8
NB. is explicit that extract keeps the newlines, the case and the accents, and
NB. that composing it with text.normalize is the host's job.
NB.
NB. Output shape, in the field order the contract lists:
NB.
NB.   title   byte vector ('' when there is no title, never null)
NB.   text    byte vector
NB.   links   boxed MATRIX of 3 columns, one row per link, columns
NB.           (href ; absolute ; text) — a matrix rather than a list of nested
NB.           box lists, because in J a box holds one thing and nested box lists
NB.           do.not survive being put into other box lists (see json.ijs).
NB.           Row i is `i { links` and its cells are `0 { row`, `1 { row`,
NB.           `2 { row`.
NB.   images  integer
NB.
NB. State lives in script-level names rather than in locals, following the same
NB. reasoning as the JSON scanner: an explicit definition's locals are not
NB. visible to the verbs it calls.
NB. =====================================================================

NB. the six elements removed with their content
EX_REM =: <;._2 (0 : 0)
script
style
noscript
template
svg
iframe
)

NB. the tags that become a newline, on the opening and on the closing tag
EX_NL =: <;._2 (0 : 0)
br
p
div
li
ul
ol
tr
th
td
h1
h2
h3
h4
h5
h6
section
article
header
footer
aside
nav
blockquote
pre
table
hr
dd
dt
figure
figcaption
main
form
)

NB. the named entities of section 3.6 as (name ; code point). Sorted by name,
NB. because the lookup is a binary search: the order is part of the data.
EX_ENT_TAB =: <;._2 (0 : 0)
amp 38
apos 39
copy 169
gt 62
hellip 8230
laquo 171
lt 60
mdash 8212
middot 183
nbsp 160
ndash 8211
quot 34
raquo 187
reg 174
times 215
trade 8482
)

EX_EK =: 3 : '(> 0 { y)'
EX_EV =: 3 : '(> 1 { y)'

NB. value of one ASCII byte as a decimal digit, _1 when it is not one
EX_DIG =: 3 : 0
  v =. (a. i. y)
  if. (v >: 48) *. (v <: 57) do.
      (v - 48) else. _1 end.
)

NB. value of one ASCII byte as a hex digit, _1 when it is not one
EX_HEX =: 3 : 0
  v =. (a. i. y)
  if. (v >: 48) *. (v <: 57) do.
    v - 48
  elseif. (v >: 97) *. (v <: 102) do.
    v - 87
  elseif. (v >: 65) *. (v <: 70) do.
    v - 55
  else.
    _1
  end.
)

NB. is this ASCII byte a letter / a letter or digit?
EX_LET =: 3 : 0
  v =. (a. i. y)
  ((v >: 65) *. (v <: 90)) +. ((v >: 97) *. (v <: 122))
)

EX_ALN =: 3 : 0
  v =. (a. i. y)
  (((v >: 65) *. (v <: 90)) +. ((v >: 97) *. (v <: 122))) +. ((v >: 48) *. (v <: 57))
)

NB. ASCII lowercasing for tag names and entity names. This is NOT text
NB. normalization and it is not the shared table: HTML tag names and entity
NB. names are ASCII by definition, and the contract says both are matched
NB. case-insensitively.
EX_LOWER =: 3 : 0
  v =. (a. i. y)
  if. (v >: 65) *. (v <: 90) do.
    (v + 32) { a.
  else.
    if. v > 127 do.
      (255 { a.) else. y end.
  end.
)

NB. ASCII whitespace byte?
EX_WS =: 3 : 0
  (y = ' ') +. (y = TAB) +. (y = LF) +. (y = CR)
)

NB. ---------------------------------------------------------------------
NB. pre-pass: CDATA, comments, doCtype, removed elements
NB. ---------------------------------------------------------------------

NB. after the CDATA opener starting at i, the index just past the closer, or n
EX_CDEND =: 3 : 0
  i =. y
  n =. # exs
  p =. i + 9
  r =. n
  while. p < n do.
    if. ((p + 2) < n) *. ((p { exs) = 93) *. (((p + 1) { exs) = 93) *. (((p + 2) { exs) = 62) do.
      r =. p + 3
      break.
    end.
    p =. p + 1
  end.
  r
)

NB. after the comment opener at i, the index just past -->, or n
EX_CMEND =: 3 : 0
  i =. y
  n =. # exs
  p =. i + 4
  r =. n
  while. p < n do.
    if. ((p + 2) < n) *. ((p { exs) = 45) *. (((p + 1) { exs) = 45) *. (((p + 2) { exs) = 62) do.
      r =. p + 3
      break.
    end.
    p =. p + 1
  end.
  r
)

NB. after the <!doctype ...> starting at i, or n when it never closes
EX_DTEND =: 3 : 0
  i =. y
  n =. # exs
  p =. i + 2
  r =. n
  while. p < n do.
    if. (p { exs) = 62 do.
      r =. p + 1
      break.
    end.
    p =. p + 1
  end.
  r
)

NB. if the tag name immediately after the '<' at i is one of the six removed
NB. elements, the index just past its closing tag (or n); else 0
EX_REMAT =: 3 : 0
  i =. y
  n =. # exs
  sc =. EX_SCAN i
  nm =. > 3 { sc
  hit =. 0
  for_t. EX_REM do.
    if. t -: nm do.
      hit =. 1
      break.
    end.
  end.
  r =. 0
  if. hit = 1 do.
    cl =. (('<' , '/' , nm)) E. exs
    ix =. cl i. 1
    if. ix >: # cl do.
      r =. n
    else.
      p =. ix
      while. (p < n) *. ((p { exs) ~: '>') do.
        p =. p + 1
      end.
      if. p < n do.
      r =. p + 1 else. r =. n end.
    end.
  end.
  r
)

NB. the pre-pass. One left-to-right sweep: CDATA is unwrapped in place,
NB. comments and doCtypes are dropped, and the six removed elements are skipped
NB. with their content.
EX_STRIP =: 3 : 0
  cps =. y
  n =. # cps
  r =. 0 $ 0
  i =. 0
  while. i < n do.
    c =. i { cps
    if. c = 60 do.
      h1 =. c
      h2 =. c
      h3 =. c
      h4 =. c
      if. (i + 1) < n do.
      h1 =. (i + 1) { cps end.
      if. (i + 2) < n do.
      h2 =. (i + 2) { cps end.
      if. (i + 3) < n do.
      h3 =. (i + 3) { cps end.
      if. (i + 4) < n do.
      h4 =. (i + 4) { cps end.
      doC =: 0
      if. h1 = 33 do.
        if. (h2 = 45) *. (h3 = 45) do.
          i =. EX_CMEND i
          doC =. 1
        elseif. (h2 = 91) *. ((i + 8) < n) *. (((i + 3) { cps) = 67) *. (((i + 4) { cps) = 68) *. (((i + 5) { cps) = 65) *. (((i + 6) { cps) = 84) *. (((i + 7) { cps) = 65) *. (((i + 8) { cps) = 91) do.
          NB. <![CDATA[...]]> keeps its inner text
          e =. EX_CDEND i
          r =. r , ((e - 3) {. (i + 9) }. cps)
          i =. e
          doC =. 1
        elseif. 1 do.
          l1 =. EX_LOWER h2
          l2 =. EX_LOWER h3
          l3 =. EX_LOWER h4
          if. (l1 = 'd') *. (l2 = 'o') *. (l3 = 'c') do.
            i =. EX_DTEND i
            doC =. 1
          end.
        end.
      end.
      if. doC = 0 do.
        if. (EX_LET h1) +. (h1 = '/') do.
          e =. EX_REMAT i
          if. e > 0 do.
            i =. e
            doC =. 1
          end.
        end.
      end.
      if. doC = 0 do.
        r =. r , c
        i =. i + 1
      end.
    else.
      r =. r , c
      i =. i + 1
    end.
  end.
  r
)

NB. ---------------------------------------------------------------------
NB. tag scanning
NB. ---------------------------------------------------------------------

NB. Scan the tag whose '<' is at index y.  Returns (end ; rawStart ; rawEnd ;
NB. name), where end is where the main loop continues.  An unterminated tag
NB. ends at #exs, which drops the tag and — because the loop then stops — the
NB. rest of the input, exactly as the contract's eof-in-tag rule says.
EX_SCAN =: 3 : 0
  i =. y
  n =. # exs
  p =. i + 1
  q =. p
  quote =. 0
  while. p < n do.
    c =. p { exs
    if. quote ~= 0 do.
      if. c = quote do.
        quote =. 0
      end.
    elseif. (c = 34) +. (c = 39) do.
      quote =. c
    elseif. c = 62 do.
      break.
    end.
    p =. p + 1
  end.
  e =. n
  rs =. p
  if. p < n do.
    e =. p + 1
    rs =. p
  end.
  rq =. q
  while. (rq < rs) *. (EX_WS (rq { exs) +. ((rq { exs) = '/')) do.
    rq =. rq + 1
  end.
  nm =. 0 $ a.
  while. (rq < rs) *. (EX_ALN (rq { exs) +. ((rq { exs) = 58) +. ((rq { exs) = '-')) do.
    nm =. nm , (EX_LOWER (rq { exs))
    rq =. rq + 1
  end.
  e , q , rs , nm
)

EX_ISNL =: 3 : 0
  r =. 0
  for_t. EX_NL do.
    if. t -: y do.
      r =. 1
      break.
    end.
  end.
  r
)

NB. href of a tag whose raw text (between the angle brackets) is y, verbatim,
NB. '' when there is none. The name must not be part of a longer one, and the
NB. value may be quoted or unquoted, as browsers accept.
EX_HREF =: 3 : 0
  n =. # y
  i =. 0
  r =. 0 $ a.
  while. i < n do.
    if. (EX_LOWER (i { y)) = 'h' do.
      if. 1 = ((EX_LOWER ((i + 1) { y)) = 'r') *. ((EX_LOWER ((i + 2) { y)) = 'e') *. ((EX_LOWER ((i + 3) { y)) = 'f') do.
        ok =. 1
        if. i > 0 do.
          if. (EX_ALN (i - 1) { y) +. (((i - 1) { y) = '-') +. (((i - 1) { y) = ':') do.
            ok =. 0
          end.
        end.
        if. ok = 1 do.
          j =. i + 4
          while. (j < n) *. (EX_WS (j { y)) do.
            j =. j + 1
          end.
          if. (j < n) *. ((j { y) = '=') do.
            j =. j + 1
            while. (j < n) *. (EX_WS (j { y)) do.
              j =. j + 1
            end.
            if. j < n do.
              if. ((j { y) = 34) +. ((j { y) = 39) do.
                qc =. j { y
                k =. j + 1
                while. (k < n) *. ((k { y) ~: qc) do.
                  k =. k + 1
                end.
                r =. ((k - (j + 1)) {. (j + 1) }. y)
              else.
                k =. j
                while. (k < n) *. (0 = (EX_WS (k { y) +. ((k { y) = 62))) do.
                  k =. k + 1
                end.
                r =. ((k - j) {. j }. y)
              end.
            end.
            break.
          end.
        end.
      end.
    end.
    i =. i + 1
  end.
  r
)

NB. do.es href y start with a scheme, [A-Za-z][A-Za-z0-9+.-]*: ?
EX_ABS =: 3 : 0
  n =. # y
  if. n < 2 do.
    0
    return.
  end.
  if. 0 = EX_LET (0 { y) do.
    0
    return.
  end.
  i =. 1
  while. i < n do.
    c =. i { y
    if. c = 58 do.
      1
      return.
    end.
    if. 0 = ((EX_ALN c) +. (c = '+') +. (c = '.') +. (c = '-')) do.
      0
      return.
    end.
    i =. i + 1
  end.
  0
)

NB. ---------------------------------------------------------------------
NB. entity decoding: (code point ; next index), code point _1 for "literal"
NB. ---------------------------------------------------------------------

EX_ENT =: 3 : 0
  i =. y
  n =. # exs
  lim =. 12
  if. (i + 12) >: n do.
    lim =. (n - i + 1)
  end.
  semi =. lim
  for_k. (i. lim) do.
    if. ((i + 1 + k) { exs) = 59 do.
      semi =. k + 1
      break.
    end.
  end.
  if. semi < 1 do.
    _1 , (i + 1)
    return.
  end.
  if. (i + 1) >: n do.
    _1 , (i + 1)
    return.
  end.
  b1 =. (i + 1) { exs
  if. b1 = 35 do.
    NB. a numeric reference: &#DDD; or &#xHHH;
    hex =. 0
    st =. i + 2
    if. (st < n) *. (((st { exs) = 120) +. ((st { exs) = 88)) do.
      hex =. 1
      st =. st + 1
    end.
    cap =. 7
    if. hex = 1 do.
      cap =. 6
    end.
    cp =. 0
    nd =. 0
    k =. st
    while. (nd < cap) *. (k < (i + 1 + semi)) do.
      if. hex = 1 do.
        h =. EX_HEX (k { exs)
      else.
        h =. EX_DIG (k { exs)
      end.
      if. h < 0 do.
        break.
      end.
      cp =. ((cp * (hex { 10 16)) + h)
      nd =. nd + 1
      k =. k + 1
    end.
    r =. _1 , (i + 1)
    if. (nd > 0) *. (cp <: 1114111) do.
      if. (cp <: 55295) +. (cp >: 57344) do.
        r =. cp , k
      end.
    end.
    r
  elseif. EX_LET b1 do.
    NB. &name; — a letter followed by up to seven letters or digits
    nm =. 0 $ a.
    k =. i + 1
    while. ((# nm) < 8) *. (k < (i + 1 + semi)) do.
      if. 0 = EX_ALN (k { exs) do.
        break.
      end.
      nm =. nm , (EX_LOWER (k { exs))
      k =. k + 1
    end.
    r =. _1 , (i + 1)
    ix =. EX_EFND nm
    if. ix >: 0 do.
      r =. (EX_EV (ix { EX_ENT_TAB)) , k
    end.
    r
  else.
    _1 , (i + 1)
  end.
)

EX_EFND =: 3 : 0
  lo =. 0
  hi =. (# EX_ENT_TAB) - 1
  r =. _1
  while. lo <: hi do.
    mid =. ((lo + hi) divm 2)
    mv =. EX_EK (mid { EX_ENT_TAB)
    if. y -: mv do.
      r =. mid
      break.
    end.
    if. (0 { y) < (0 { mv) do.
      hi =. mid - 1
    elseif. (0 { y) > (0 { mv) do.
      lo =. mid + 1
    else.
      hi =. mid - 1
    end.
  end.
  r
)

NB. ---------------------------------------------------------------------
NB. the main state machine
NB. ---------------------------------------------------------------------
exs =: 0 $ 0
eout =: 0 $ a.
etitle =: 0 $ a.
etseen =: 0
eintitle =: 0
elinks =: ((0 3) $ a:)
eimages =: 0
epend =: 0
ehref =: 0 $ a.
etxt =: 0 $ a.

NB. one chunk of text: it goes to the title while a title is open, to the body
NB. otherwise, and to the anchor being collected either way.
EX_PUSH =: 3 : 0
  if. eintitle = 1 do.
    etitle =: etitle , y
  else.
    eout =: eout , y
  end.
  if. epend = 1 do.
    etxt =: etxt , y
  end.
)

NB. append the anchor being collected (if any) and clear it
EX_FLUSH =: 3 : 0
  if. epend = 1 do.
    elinks =: elinks , ((< ehref) , (< (EX_ABS ehref)) , (< etxt))
    epend =: 0
    etxt =: 0 $ a.
    ehref =: 0 $ a.
  end.
)

NB. open an anchor: the href is read verbatim from the tag's raw text
EX_OPENA =: 3 : 0
  EX_FLUSH 0
  ehref =: EX_HREF y
  etxt =: 0 $ a.
  epend =: 1
)

EX_MAIN =: 3 : 0
  n =. # exs
  i =. 0
  while. i < n do.
    c =. i { exs
    if. c = 60 do.
      lk =. 0
      if. (i + 1) < n do.
        nb =. (i + 1) { exs
        if. (EX_LET nb) +. (nb = '/') +. (nb = '!') do.
          lk =. 1
        end.
      end.
      if. lk = 1 do.
        sc =. EX_SCAN i
        e =. > 0 { sc
        rs =. > 1 { sc
        re =. > 2 { sc
        nm =. > 3 { sc
        i =. e
        raw =. ((re - (rs - 1)) {. rs }. exs)
        closing =. 0
        if. (rs < n) *. ((rs { exs) = '/') do.
          closing =. 1
        end.
        if. nm -: 'title' do.
          if. closing = 0 do.
            if. etseen = 0 do.
              eintitle =: 1
              etseen =: 1
            end.
          else.
            if. eintitle = 1 do.
              eintitle =: 0
            end.
          end.
        elseif. nm -: 'img' do.
          if. closing = 0 do.
            eimages =: eimages + 1
          end.
        elseif. nm -: 'a' do.
          if. closing = 0 do.
            NB. HTML do.es not allow nested anchors: a browser closes the open one
            NB. and starts the new one, so the outer link keeps what it had
            EX_OPENA raw
          else.
            EX_FLUSH 0
          end.
        elseif. EX_ISNL nm do.
          EX_PUSH LF
        end.
      else.
        EX_PUSH c
        i =. i + 1
      end.
    elseif. c = 38 do.
      de =. EX_ENT i
      if. (> 0 { de) >: 0 do.
        EX_PUSH (e8c (> 0 { de))
        i =. (> 1 { de)
      else.
        EX_PUSH c
        i =. i + 1
      end.
    else.
      EX_PUSH c
      i =. i + 1
    end.
  end.
  EX_FLUSH 0
  eout
)

NB. entry point: y is (html ; baseUrl). The base URL is deliberately unused —
NB. section 3.4 says hrefs are reported verbatim and resolving them is not this
NB. function's job. The result is a boxed 4-list in the contract's field order.
extract =: 3 : 0
  exs =: EX_STRIP (d8x (> 0 { y))
  eout =: 0 $ a.
  etitle =: 0 $ a.
  etseen =: 0
  eintitle =: 0
  eimages =: 0
  elinks =: ((0 3) $ a:)
  epend =: 0
  ehref =: 0 $ a.
  etxt =: 0 $ a.
  txt =. EX_MAIN 0
  (< (e8x etitle)) , (< (e8x txt)) , (< elinks) , (< eimages)
)
