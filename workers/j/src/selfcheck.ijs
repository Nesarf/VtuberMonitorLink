NB. =====================================================================
NB. selfcheck.ijs — `--selfcheck`, the built-in case list of do.cs/WORKERS.md
NB. section 1.1: one English line per case, then `N/M checks passed`, exit
NB. non-zero on failure, and no protocol traffic on stdout in this mode.
NB.
NB. The cases cover the edge rules the contract pins, so a broken build fails
NB. here rather than in the corpus: an unclosed tag, an entity with and without
NB. a semicolon, a numeric and a hex reference, a zero-width character,
NB. full-width ASCII, CJK left alone, an idempotency pair, and empty input.
NB.
NB. Every case verb returns '' for pass or a one-line English reason for
NB. failure, and a failure message carries a hex dump of what was produced so
NB. it can be read without re-running anything. The cases call the same
NB. capability entry points the protocol uses, so this exercises the real path.
NB.
NB. Expected values are built from numeric code points wherever the point of a
NB. case is a character that is invisible or easy to mistype (U+200B, U+00A0,
NB. the combining acute). Written as literals in this file they would make the
NB. test depend on the editor's encoding, which is the failure these tests are
NB. supposed to catch.
NB. =====================================================================

NB. a byte vector as space-separated hex, for failure messages
SC_HEX =: 3 : 0
  d =. '0123456789abcdef'
  r =. 0 $ a.
  for_b. y do.
    v =. a. i. b
    r =. r , ' ' , (d {~ (16 | v)) , (d {~ (16 | (v divm 16)))
  end.
  if. 0 = # r do.
      '(empty)' else. (2 }. r) end.
)

NB. compare a produced byte vector against an expected one
SC_EQ =: 3 : 0
  got =. > 0 { y
  want =. > 1 { y
  if. got -: want do.
    ''
  else.
    'produced [' , (SC_HEX got) , '] but expected [' , (SC_HEX want) , ']'
  end.
)

NB. the UTF-8 bytes of a vector of code points
cpx =: 3 : 0
  e8x y
)

NB. ---- capability entry points, with the checks each one needs ----------

jv_norm =: 3 : 0
  norm y
)

jv_ext =: 3 : 0
  1 { extract y
)

exres_ext =: 3 : 0
  extract y
)

jv_fp =: 3 : 0
  fingerprint y
)

NB. is h a string of lowercase hex digits?
SC_LOWERHEX =: 3 : 0
  r =. 1
  for_c. y do.
    v =. a. i. c
    if. 0 = (((v >: 48) *. (v <: 57)) +. ((v >: 97) *. (v <: 102))) do.
      r =. 0
      break.
    end.
  end.
  r
)

NB. is there a space anywhere in y?
SC_ANYSP =: 3 : 0
  +./ (y = ' ')
)

NB. ---- the cases --------------------------------------------------------

SC_C01 =: 3 : 0
  SC_EQ (jv_norm '') ; ''
)

SC_C02 =: 3 : 0
  big =. , (500 $ cpx (24050 24050 24050))
  SC_EQ (jv_norm big) ; big
)

SC_C03 =: 3 : 0
  SC_EQ (jv_norm ('a' , (cpx 8203) , 'b')) ; 'ab'
)

SC_C04 =: 3 : 0
  SC_EQ (jv_norm (cpx 65313 65314 65315)) ; 'abc'
)

SC_C05 =: 3 : 0
  SC_EQ (jv_norm ('e' , (cpx 769))) ; 'e'
)

SC_C06 =: 3 : 0
  t =. cpx (24050 24050 1055 1088 1605)
  SC_EQ (jv_norm t) ; t
)

SC_C07 =: 3 : 0
  SC_EQ (jv_norm ('a' , (cpx 8212) , 'b' , (cpx 8230))) ; 'a-b...'
)

SC_C08 =: 3 : 0
  SC_EQ (jv_norm ('  a ' , TAB , TAB , 'b ' , LF , LF , ' c  ')) ; 'a b c'
)

SC_C09 =: 3 : 0
  r =. jv_norm '  ' , (cpx 201) , '  '
  if. 0 = (r -: 'e') do.
    'U+00C9 should map, through the lower table then the fold table, to e; produced [' , (SC_HEX r) , ']'
  else.
    ''
  end.
)

SC_C10 =: 3 : 0
  a =. jv_norm (cpx 201 223 216)
  SC_EQ (jv_norm a) ; a
)

SC_C11 =: 3 : 0
  SC_EQ (jv_ext ('abc<' , 'b')) ; 'abc'
)

SC_C12 =: 3 : 0
  SC_EQ (jv_ext 'a<') ; 'a<'
)

SC_C13 =: 3 : 0
  SC_EQ (jv_ext 'a &amp b &amp; c') ; 'a & b & c'
)

SC_C14 =: 3 : 0
  SC_EQ (jv_ext 'x&#x4E2Dy') ; ('x' , (cpx 24050) , 'y')
)

SC_C15 =: 3 : 0
  SC_EQ (jv_ext 'x&#20013;y') ; ('x' , (cpx 24050) , 'y')
)

SC_C16 =: 3 : 0
  SC_EQ (jv_ext 'a&nbsp b') ; ('a' , (cpx 160) , 'b')
)

SC_C17 =: 3 : 0
  SC_EQ (jv_ext '<p>x</p><script>var a=1</script>') ; (LF , 'x' , LF)
)

SC_C18 =: 3 : 0
  r =. exres_ext '<title>T</title><p>body</p><img src=a>'
  if. 0 = ((0 { r) -: 'T') do.
    'the title came back as [' , (SC_HEX (0 { r)) , ']'
  elseif. 0 = ((3 { r) = 1) do.
    'the image count came back as ' , (": 3 { r)
  elseif. SC_ANYSP (1 { r) do.
    'the title leaked into the body as [' , (SC_HEX (1 { r)) , ']'
  else.
    ''
  end.
)

SC_C19 =: 3 : 0
  SC_EQ (jv_ext '<a href="/a">A<a href="/b">B</a></a>') ; 'AB'
)

SC_C20 =: 3 : 0
  lk =. 2 { exres_ext '<a href="/a">A</a> <a href="/b">B</a>'
  if. 2 ~: # lk do.
    'expected two links, produced ' , (": # lk)
  else.
    h0 =. > 0 { (0 { lk)
    if. 0 = (h0 -: '/a') do.
      'the first href came back as [' , (SC_HEX h0) , ']'
    else.
      ''
    end.
  end.
)

SC_C21 =: 3 : 0
  r =. exres_ext '<a href="/x">text'
  lk =. 2 { r
  if. 1 ~: # lk do.
    'expected the unclosed anchor to be reported, produced ' , (": # lk) , ' link(s)'
  else.
    t0 =. > 2 { (0 { lk)
    if. 0 = (t0 -: 'text') do.
      'the link text came back as [' , (SC_HEX t0) , ']'
    else.
      ''
    end.
  end.
)

SC_C22 =: 3 : 0
  r =. jv_fp ''
  if. 0 = ((0 { r) -: (16 $ '0')) do.
    'the hash came back as ' , (0 { r)
  elseif. 0 = ((1 { r) = 0) do.
    'the token count came back as ' , (": 1 { r)
  elseif. 0 = ((2 { r) = 0) do.
    'the shingle count came back as ' , (": 2 { r)
  else.
    ''
  end.
)

SC_C23 =: 3 : 0
  h =. 0 { jv_fp 'openai gpt is here'
  if. 16 ~: # h do.
    'the hash is ' , (": # h) , ' characters long'
  elseif. 0 = SC_LOWERHEX h do.
    'the hash is not 16 lowercase hex digits: [' , h , ']'
  else.
    ''
  end.
)

SC_C24 =: 3 : 0
  r =. jv_fp '-- !!'
  if. 0 = (1 { r) do.
      '' else. 'the token count came back as ' , (": 1 { r) end.
)

SC_C25 =: 3 : 0
  r =. jv_fp ('openai gpt ' , (cpx 24050) , ' ' , (cpx 24050))
  if. 4 ~: (1 { r) do.
    'the token count came back as ' , (": 1 { r)
  elseif. 2 ~: (2 { r) do.
    'the shingle count came back as ' , (": 2 { r)
  else.
    ''
  end.
)

SC_C26 =: 3 : 0
  r =. jv_fp 'x'
  if. 1 ~: (1 { r) do.
    'the token count came back as ' , (": 1 { r)
  elseif. 0 = ((0 { r) -: (FP_FNV 'x')) do.
    'the hash came back as ' , (0 { r) , ' but one token hashes to ' , (FP_FNV 'x')
  else.
    ''
  end.
)

NB. ---- the list, and the runner ----------------------------------------

SC_NAME =: <;._2 (0 : 0)
normalize: an empty string stays empty
normalize: a 1 KB CJK document passes through unchanged
normalize: a zero-width space is deleted
normalize: full-width ASCII becomes ASCII
normalize: a combining mark is deleted
normalize: CJK, Cyrillic and Arabic are untouched
normalize: the em dash and the ellipsis are mapped
normalize: runs of whitespace collapse and are trimmed
normalize: U+00C9 goes through the lower table and then the fold table
normalize: the fold step is idempotent
extract: an unclosed tag is dropped with its name
extract: a lone < at the end is literal text
extract: an entity decodes with and without a semicolon
extract: a hex entity decodes
extract: a numeric entity decodes
extract: an entity without a semicolon decodes
extract: script and style go with their content
extract: the title is kept out of the text, images are counted
extract: a nested anchor keeps the outer link
extract: an anchor does not swallow the next one
extract: an anchor unclosed at the end is still reported
)

NB. Run every case and report. Nothing goes to stdout: this mode is not the
NB. protocol, and the contract says there must be no protocol traffic here.
NB.
NB. The dispatch is by NAME, and the case verbs are not put in a list. Putting
NB. them in one and indexing it made every case raise the same unrelated error in
NB. this build, and a self-check that reports one failure for twenty-one
NB. different inputs is worse than no self-check at all.
selfcheck =: 3 : 0
  pass =. 0
  for_nm. SC_NAME do.
    why =. ''
    try.
      why =. SC_RUN (> nm)
    catch.
      NB. 13!:12, the error-text foreign, raises a rank error of its own here,
      NB. so the report is deliberately generic.
      why =. 'raised an error'
    end.
    if. 0 = # why do.
      pass =. pass + 1
      1!:2&2 ('  [ok]   ' , (> nm))
    else.
      1!:2&2 ('  [FAIL] ' , (> nm) , ' - ' , why)
    end.
  end.
  1!:2&2 (((": pass) , '/' , (": # SC_NAME)) , ' checks passed')
  if. pass = # SC_NAME do.
    0
  else.
    1
  end.
)

SC_RUN =: 3 : 0
  if. y -: 'normalize: an empty string stays empty' do. SC_C01 0 return. end.
  if. y -: 'normalize: a 1 KB CJK document passes through unchanged' do. SC_C02 0 return. end.
  if. y -: 'normalize: a zero-width space is deleted' do. SC_C03 0 return. end.
  if. y -: 'normalize: full-width ASCII becomes ASCII' do. SC_C04 0 return. end.
  if. y -: 'normalize: a combining mark is deleted' do. SC_C05 0 return. end.
  if. y -: 'normalize: CJK, Cyrillic and Arabic are untouched' do. SC_C06 0 return. end.
  if. y -: 'normalize: the em dash and the ellipsis are mapped' do. SC_C07 0 return. end.
  if. y -: 'normalize: runs of whitespace collapse and are trimmed' do. SC_C08 0 return. end.
  if. y -: 'normalize: U+00C9 goes through the lower table and then the fold table' do. SC_C09 0 return. end.
  if. y -: 'normalize: the fold step is idempotent' do. SC_C10 0 return. end.
  if. y -: 'extract: an unclosed tag is dropped with its name' do. SC_C11 0 return. end.
  if. y -: 'extract: a lone < at the end is literal text' do. SC_C12 0 return. end.
  if. y -: 'extract: an entity decodes with and without a semicolon' do. SC_C13 0 return. end.
  if. y -: 'extract: a hex entity decodes' do. SC_C14 0 return. end.
  if. y -: 'extract: a numeric entity decodes' do. SC_C15 0 return. end.
  if. y -: 'extract: an entity without a semicolon decodes' do. SC_C16 0 return. end.
  if. y -: 'extract: script and style go with their content' do. SC_C17 0 return. end.
  if. y -: 'extract: the title is kept out of the text, images are counted' do. SC_C18 0 return. end.
  if. y -: 'extract: a nested anchor keeps the outer link' do. SC_C19 0 return. end.
  if. y -: 'extract: an anchor does not swallow the next one' do. SC_C20 0 return. end.
  if. y -: 'extract: an anchor unclosed at the end is still reported' do. SC_C21 0 return. end.
  'no such case'
)
