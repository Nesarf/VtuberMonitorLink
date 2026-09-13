NB. =====================================================================
NB. protocol.ijs — the JSON-Lines protocol of docs/WORKERS.md section 1, and
NB. the entry point `main`.
NB.
NB. One JSON object per line in, one out; nothing but protocol lines on stdout;
NB. English diagnostics on stderr; `shutdown` answered with the bare envelope and
NB. nothing else; the capability named by --capability is the only one served;
NB. anything else on the command line is exit 2.
NB.
NB. ---------------------------------------------------------------------
NB. THE ONE PLACE THIS WORKER DOES NOT MEET THE CONTRACT
NB.
NB. Requests are answered when stdin reaches end of input, not one line at a
NB. time while it is still open. Section 1 says "flush stdout after every
NB. response line, before reading the next request", and this worker cannot read
NB. the next request without the pipe closing.
NB.
NB. That is a limitation of J, not a choice, and it was measured rather than
NB. assumed:
NB.   * `1!:1 ] 3` reads to end of input. With a length (`1!:1 ] 3 [ 1`) it
NB.     still returned all 33 bytes that were available and then blocked for the
NB.     rest until the writer closed the pipe. There is no line-at-a-time read.
NB.   * the only route to a non-blocking read is J's DLL interface, foreign
NB.     `15!:0` (PeekNamedPipe / ReadFile), and that foreign does not exist in
NB.     this J build: `15!:0` and `15!:10` are both undefined.
NB.   * no addons are allowed, and the base system has no socket or thread that
NB.     could watch stdin instead.
NB.
NB. What that means in practice: the worker must be given its input and then
NB. have stdin closed. `node tools/workers.mjs` keeps stdin open, so there
NB. j-text reports `UNUSABLE ... answered 0/N` and the harness falls back to the
NB. reference. The capabilities themselves are exercised by --selfcheck, which
NB. calls the same entry points the protocol calls, and the protocol is
NB. exercised by feeding the worker a whole request stream and closing stdin
NB. (workers/j/README.md has the command).
NB.
NB. Two other platform facts shape this file, both measured:
NB.   * jconsole writes with CRLF and there is no raw-bytes write (the same
NB.     missing foreign). The JSON encoder escapes CR and LF *inside* strings as
NB.     \r and \n, so the only CRLF bytes on the wire are the line terminators.
NB.   * file number 1 is not open ("the specified file number is not open"), so
NB.     responses go to file number 2, which is jconsole's console output — the
NB.     stdout the host reads.
NB. =====================================================================

PROTOCOL_VERSION =: 1
CAP_NAMES =: <;._2 (0 : 0)
text.normalize
text.extract
text.fingerprint
)

NB. the J release, for the descriptor's runtime field
runtimeName =: 3 : 0
  'j' , (2 {. (9!:14 ''))
)

NB. Every response is assembled into a name first and written on its own line.
NB. Writing `PLINE ('...' , x , '...')` looks the same and is not: without the
NB. closing bracket the control block never closes, and J reports a mismatched
NB. control structure 2000 lines later, against whatever definition follows.
PLINE =: 3 : 0
  1!:2&2 y
)

PERR =: 3 : 0
  1!:2&2 y
)

PKILL =: 3 : 0
  2!:55 [ y
)

NB. the descriptor for one capability, in the contract's field order
describeWith =: 3 : 0
  b1 =. '"id":' , p_id , ',"ok":true,"worker":{"protocol":' , (jintv PROTOCOL_VERSION)
  b2 =. ',"capability":' , (jstrv y) , ',"language":"j","impl":"hand-rolled tables","runtime":'
  b3 =. (jstrv (runtimeName 0)) , ',"deterministic":true}'
  b1 , b2 , b3
)

NB. the links array; y is the boxed matrix of 3-column rows
PLINKS =: 3 : 0
  r =. '['
  for_k. (i. # y) do.
    row =. k { y
    if. k > 0 do.
      r =. r , ','
    else.
      r =. r , ''
    end.
    r =. r , '{"href":' , (jstrv (> 0 { row))
    r =. r , ',"absolute":' , (jboolv (> 1 { row))
    r =. r , ',"text":' , (jstrv (> 2 { row)) , '}'
  end.
  r , ']'
)

NB. the error envelope
PERROR =: 3 : 0
  code =. > 0 { y
  msg =. > 1 { y
  r =. '{"id":' , p_id , ',"ok":false,"error":{"code":' , (jstrv code) , ',"message":' , (jstrv msg) , '}}'
  PLINE r
)

NB. answer one invoke request
PINVOKE =: 3 : 0
  inp =. y
  e =. 0
  if. capability -: 'text.normalize' do.
    t =. getstr ('text' ; inp)
    if. 0 = (# t) do.
      e =. 'input.text must be a string'
    else.
      r =. '{"id":' , p_id , ',"ok":true,"output":{"text":' , (jstrv (norm t)) , '}}'
      PLINE r
    end.
  elseif. capability -: 'text.extract' do.
    h =. getstr ('html' ; inp)
    if. 0 = (# h) do.
      e =. 'input.html must be a string'
    else.
      x =. extract (h ; 0)
      r =. '{"id":' , p_id , ',"ok":true,"output":{"title":' , (jstrv (0 { x))
      r =. r , ',"text":' , (jstrv (1 { x))
      r =. r , ',"links":' , (PLINKS (2 { x))
      r =. r , ',"images":' , (jintv (3 { x)) , '}}'
      PLINE r
    end.
  elseif. capability -: 'text.fingerprint' do.
    t =. getstr ('text' ; inp)
    if. 0 = (# t) do.
      e =. 'input.text must be a string'
    else.
      x =. fingerprint t
      r =. '{"id":' , p_id , ',"ok":true,"output":{"simhash":' , (jstrv (0 { x))
      r =. r , ',"tokens":' , (jintv (1 { x))
      r =. r , ',"shingles":' , (jintv (2 { x)) , '}}'
      PLINE r
    end.
  end.
  if. 0 < # e do.
    PERROR ('bad-input' ; e)
  end.
  0
)

NB. one request body; returns 1 when the loop must stop (shutdown).
NB.
NB. The parser's buffer and cursor live in the `jst` locale, so both assignments
NB. name it: assigning the plain names put them in `base`, which is where this
NB. verb runs, and every lookup then saw an empty buffer.
PHANDLE =: 3 : 0
  jb_jst_ =: y
  jp_jst_ =: 0
  p_id =: rawfield_jst_ 'id'
  op =. rawfield_jst_ 'op'
  stop =. 0
  if. op -: '"shutdown"' do.
    r =. '{"id":' , p_id , ',"ok":true}'
    PLINE r
    stop =. 1
  elseif. op -: '"describe"' do.
    PLINE (describeWith capability)
  elseif. op -: '"invoke"' do.
    cap =. getstr ('capability' ; y)
    if. 0 = (# cap) do.
      cap =. capability
    end.
    if. 0 = (cap -: capability) do.
      PERROR ('unsupported' ; 'this worker implements ' , capability)
    else.
      raw =. rawfield_jst_ 'input'
      inp =. ''
      if. (# raw) > 0 do.
        if. (0 { raw) -: '{' do.
          inp =. raw
        end.
      end.
      PINVOKE inp
    end.
  else.
    PERROR ('unsupported' ; 'unknown op ' , op)
  end.
  stop
)

NB. split the input into request lines and answer them in order.
NB. y is the newline-separated byte vector; returns 1 when shutdown was seen.
NB.
NB. `y <;._2 LF` is not "split on newlines": the left argument of ;. is a BOOLEAN
NB. MASK, and a character left argument is a domain error. The mask is `y = LF`,
NB. and <;._2 cuts before each 1 and drops the leading empty piece.
PRUN =: 3 : 0
  stop =. 0
  for_line. ((y = LF) <;._2 y) do.
    ln =. line
    if. (# ln) > 0 do.
      if. (CR = {: ln) do.
        ln =. }: ln
      end.
      if. 0 < # ln do.
        if. stop = 0 do.
          stop =. PHANDLE ln
        end.
      end.
    end.
  end.
  stop
)

NB. read stdin to end of input, then answer the lines in order.
NB. (The note at the top of this file says why that is not line at a time.)
PSERVE =: 3 : 0
  buf =. 1!:1 ] 3
  PRUN buf
  0
)

NB. the command line: --capability <name> and/or --selfcheck, nothing else.
NB.
NB. ARGV always starts with the jconsole path, and the entry after it is the
NB. script when jconsole was given one on its command line, so that is dropped
NB. before the options are read.
PMAIN =: 3 : 0
  argv =. }. ARGV
  if. (# argv) > 0 do.
    a0 =. > 0 { argv
    if. '.ijs' -: (_4 {. a0) do.
      argv =. }. argv
    end.
  end.
  self =. 0
  cap =. ''
  ok =. 1
  i =. 0
  while. i < # argv do.
    a =. > i { argv
    nm =. a
    while. ((# nm) > 0) *. ('-' -: (0 { nm)) do.
      nm =. }. nm
    end.
    if. (nm -: 'selfcheck') +. (nm -: 'self-check') do.
      self =. 1
      i =. i + 1
    elseif. ('.ijs' -: (_4 {. nm)) do.
      i =. i + 1
    elseif. nm -: 'capability' do.
      if. (i + 1) < # argv do.
        cap =. > (i + 1) { argv
        i =. i + 2
      else.
        PERR 'vmltext.ijs: --capability needs a capability name'
        ok =. 0
        i =. # argv
      end.
    elseif. 1 do.
      PERR ('vmltext.ijs: unexpected argument ' , a)
      PERR 'usage: vmltext.ijs --capability text.normalize|text.extract|text.fingerprint [--selfcheck]'
      ok =. 0
      i =. # argv
    end.
  end.
  if. self = 1 do.
    if. 0 = ok do.
      PKILL 2
    end.
    PKILL (selfcheck 0)
  end.
  known =. 0
  for_n. CAP_NAMES do.
    NB. each item of a boxed list arrives BOXED in a for. loop, so it has to be
    NB. unboxed before it can be compared with the capability name
    if. (> n) -: cap do.
      known =. 1
      break.
    end.
  end.
  if. 0 = ok do.
    PKILL 2
  end.
  if. 0 = known do.
    PERR 'vmltext.ijs: --capability must be one of text.normalize|text.extract|text.fingerprint, or give --selfcheck'
    PKILL 2
  end.
  capability =: cap
  PSERVE 0
  PKILL 0
)
