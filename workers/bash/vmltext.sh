#!/usr/bin/env bash
# workers/bash/vmltext.sh - the three text capabilities, in bash, speaking protocol v1.
#
# The contract is docs/WORKERS.md. This file implements text.normalize, text.extract and
# text.fingerprint against it. The shared case and fold tables are not re-implemented here:
# workers/bash/build.mjs turns workers/spec/*.json into workers/bash/tables.generated.sh, which this
# script sources. Run the build first (node workers/bash/build.mjs).
#
# Why the file looks like this
# ----------------------------
# A shell has no Unicode, so this script is byte-oriented throughout and does its own UTF-8 decoding:
# a code point is a decimal number kept as a string, decoding and encoding go through `printf` and the
# shell's own byte indexing, and every table lookup is keyed by that decimal code point. LC_ALL is
# pinned to C before anything else runs, so that `case` patterns, string indexing and `printf` behave
# the same way whatever locale the host happens to have - a UTF-8 locale changes how those primitives
# see multi-byte input, and that is the one thing this file cannot afford to be vague about.
#
# Nothing here ever keys a table lookup by a multi-byte character. On Git for Windows' bash a
# multi-byte literal does not match inside a `case` pattern while the single-byte Latin-1 ones do,
# which is worse than either extreme; the note in README.md records the measurement, and the fold step
# avoids the whole question by applying the composed table (see vm_fold_cp below).
#
# Integers are 32-bit halves. FNV-1a needs a 64-bit multiply and shell arithmetic is signed 64-bit, so
# the hash is kept as (hi, lo) limbs and the multiply is four 32-bit products mod 2^32. That is exact,
# not an approximation: every intermediate stays under 2^63. Nothing here needs `bc`, which is not
# installed on this machine anyway.
#
# Usage (docs/WORKERS.md section 1.1):
#   vmltext.sh --capability text.normalize     protocol loop on stdin/stdout
#   vmltext.sh --selfcheck                     built-in cases, English lines, no protocol traffic
#
# stdout carries protocol lines and nothing else, and every response is flushed before the next
# request is read. Diagnostics go to stderr.
set -u

LC_ALL=C
export LC_ALL
unset GREP_OPTIONS 2>/dev/null || true

VMLTEXT_DIR=$(dirname "$0")
if [ -f "$VMLTEXT_DIR/tables.generated.sh" ]; then
  . "$VMLTEXT_DIR/tables.generated.sh"
else
  printf 'vmltext.sh: %s/tables.generated.sh not found; run: node workers/bash/build.mjs\n' "$VMLTEXT_DIR" >&2
  exit 2
fi

PROTOCOL=1
LANGUAGE=bash
IMPL=table-driven
RUNTIME="bash ${BASH_VERSION}"

# ------------------------------------------------------------------ code points
#
# A "cps" string is a sequence of decimal code points separated by semicolons, with a leading and a
# trailing semicolon: ";104;105;". No code point here is ever 0 (a NUL is rejected at the JSON layer),
# so that form is unambiguous.

# One byte -> its value as a decimal number. `printf '%d' "'x"` is the shell's own byte read, a
# builtin, and identical in every locale this script has been run under.
vm_byte() {
  printf '%d' "'$1"
}

# One ASCII byte -> its decimal value, in VM_BYTE, without a subshell. Assigning instead of printing is
# the difference between a 1 KB document taking a second and taking a minute: `vm_byte` above is a
# builtin but still a command substitution, and this is called once per byte of every input.
VM_BYTE=0
vm_ascii_value() {
  case $1 in
    a) VM_BYTE=97 ;; b) VM_BYTE=98 ;; c) VM_BYTE=99 ;; d) VM_BYTE=100 ;; e) VM_BYTE=101 ;;
    f) VM_BYTE=102 ;; g) VM_BYTE=103 ;; h) VM_BYTE=104 ;; i) VM_BYTE=105 ;; j) VM_BYTE=106 ;;
    k) VM_BYTE=107 ;; l) VM_BYTE=108 ;; m) VM_BYTE=109 ;; n) VM_BYTE=110 ;; o) VM_BYTE=111 ;;
    p) VM_BYTE=112 ;; q) VM_BYTE=113 ;; r) VM_BYTE=114 ;; s) VM_BYTE=115 ;; t) VM_BYTE=116 ;;
    u) VM_BYTE=117 ;; v) VM_BYTE=118 ;; w) VM_BYTE=119 ;; x) VM_BYTE=120 ;; y) VM_BYTE=121 ;;
    z) VM_BYTE=122 ;;
    A) VM_BYTE=65 ;; B) VM_BYTE=66 ;; C) VM_BYTE=67 ;; D) VM_BYTE=68 ;; E) VM_BYTE=69 ;;
    F) VM_BYTE=70 ;; G) VM_BYTE=71 ;; H) VM_BYTE=72 ;; I) VM_BYTE=73 ;; J) VM_BYTE=74 ;;
    K) VM_BYTE=75 ;; L) VM_BYTE=76 ;; M) VM_BYTE=77 ;; N) VM_BYTE=78 ;; O) VM_BYTE=79 ;;
    P) VM_BYTE=80 ;; Q) VM_BYTE=81 ;; R) VM_BYTE=82 ;; S) VM_BYTE=83 ;; T) VM_BYTE=84 ;;
    U) VM_BYTE=85 ;; V) VM_BYTE=86 ;; W) VM_BYTE=87 ;; X) VM_BYTE=88 ;; Y) VM_BYTE=89 ;;
    Z) VM_BYTE=90 ;;
    0) VM_BYTE=48 ;; 1) VM_BYTE=49 ;; 2) VM_BYTE=50 ;; 3) VM_BYTE=51 ;; 4) VM_BYTE=52 ;;
    5) VM_BYTE=53 ;; 6) VM_BYTE=54 ;; 7) VM_BYTE=55 ;; 8) VM_BYTE=56 ;; 9) VM_BYTE=57 ;;
    ' ') VM_BYTE=32 ;; '!') VM_BYTE=33 ;; '"') VM_BYTE=34 ;; '#') VM_BYTE=35 ;; '$') VM_BYTE=36 ;;
    '%') VM_BYTE=37 ;; '&') VM_BYTE=38 ;; "'") VM_BYTE=39 ;; '(') VM_BYTE=40 ;; ')') VM_BYTE=41 ;;
    '*') VM_BYTE=42 ;; '+') VM_BYTE=43 ;; ',') VM_BYTE=44 ;; '-') VM_BYTE=45 ;; '.') VM_BYTE=46 ;;
    '/') VM_BYTE=47 ;; ':') VM_BYTE=58 ;; ';') VM_BYTE=59 ;; '<') VM_BYTE=60 ;; '=') VM_BYTE=61 ;;
    '>') VM_BYTE=62 ;; '?') VM_BYTE=63 ;; '@') VM_BYTE=64 ;; '[') VM_BYTE=91 ;; '\') VM_BYTE=92 ;;
    ']') VM_BYTE=93 ;; '^') VM_BYTE=94 ;; '_') VM_BYTE=95 ;; '`') VM_BYTE=96 ;; '{') VM_BYTE=123 ;;
    '|') VM_BYTE=124 ;; '}') VM_BYTE=125 ;; '~') VM_BYTE=126 ;;
    *) VM_BYTE=$(printf '%d' "'$1") ;;
  esac
}

# One decimal code point -> one UTF-8 byte, as an assignment. Defined here rather than next to vm_char
# only because it is the same escape machinery; the function itself lives below vm_encode.
vm_ascii_byte() {
  printf -v VM_CHAR '%b' "\\$(printf '%03o' "$1")"
}

# Returns the number of bytes in the UTF-8 sequence that starts at the position given (1, 2, 3, and for
# a lead byte that promises four bytes, 4). A malformed sequence is reported as 1 byte, which is what
# keeps the decoder from walking off the end of the string.
#
# This reads the lead byte with the same table `vm_ascii_value` uses rather than with a `case` pattern
# over ranges, and that is not a style choice: on Git for Windows' bash a bracket expression over byte
# ranges does not match a multi-byte character ([\\x80-\\xFF] matches nothing, and neither - measured -
# does a bare `?`), so a pattern-based length would answer 1 for every non-ASCII byte and quietly turn
# every CJK character into three separate bytes. Reading the byte and comparing numbers works, and this
# is the only place that has to be fast.
VM_LEN=1
vm_utf8_len() {
  local s=$1 i=$2 b= ch=
  ch=${s:i:1}
  case $ch in
    a) b=97 ;; b) b=98 ;; c) b=99 ;; d) b=100 ;; e) b=101 ;;
    f) b=102 ;; g) b=103 ;; h) b=104 ;; i) b=105 ;; j) b=106 ;;
    k) b=107 ;; l) b=108 ;; m) b=109 ;; n) b=110 ;; o) b=111 ;;
    p) b=112 ;; q) b=113 ;; r) b=114 ;; s) b=115 ;; t) b=116 ;;
    u) b=117 ;; v) b=118 ;; w) b=119 ;; x) b=120 ;; y) b=121 ;;
    z) b=122 ;;
    A) b=65 ;; B) b=66 ;; C) b=67 ;; D) b=68 ;; E) b=69 ;;
    F) b=70 ;; G) b=71 ;; H) b=72 ;; I) b=73 ;; J) b=74 ;;
    K) b=75 ;; L) b=76 ;; M) b=77 ;; N) b=78 ;; O) b=79 ;;
    P) b=80 ;; Q) b=81 ;; R) b=82 ;; S) b=83 ;; T) b=84 ;;
    U) b=85 ;; V) b=86 ;; W) b=87 ;; X) b=88 ;; Y) b=89 ;;
    Z) b=90 ;;
    0) b=48 ;; 1) b=49 ;; 2) b=50 ;; 3) b=51 ;; 4) b=52 ;;
    5) b=53 ;; 6) b=54 ;; 7) b=55 ;; 8) b=56 ;; 9) b=57 ;;
    ' ') b=32 ;; '!') b=33 ;; '"') b=34 ;; '#') b=35 ;; '$') b=36 ;;
    '%') b=37 ;; '&') b=38 ;; "'") b=39 ;; '(') b=40 ;; ')') b=41 ;;
    '*') b=42 ;; '+') b=43 ;; ',') b=44 ;; '-') b=45 ;; '.') b=46 ;;
    '/') b=47 ;; ':') b=58 ;; ';') b=59 ;; '<') b=60 ;; '=') b=61 ;;
    '>') b=62 ;; '?') b=63 ;; '@') b=64 ;; '[') b=91 ;; '\') b=92 ;;
    ']') b=93 ;; '^') b=94 ;; '_') b=95 ;; '`') b=96 ;; '{') b=123 ;;
    '|') b=124 ;; '}') b=125 ;; '~') b=126 ;;
    *) b=$(vm_byte "$ch") ;;
  esac
  if [ "$b" -lt 128 ]; then
    VM_LEN=1
  elif [ "$b" -lt 224 ]; then
    VM_LEN=2
  elif [ "$b" -lt 240 ]; then
    VM_LEN=3
  elif [ "$b" -lt 245 ]; then
    VM_LEN=4
  else
    VM_LEN=1
  fi
}

# One UTF-8 sequence (1-4 bytes) -> one decimal code point.
vm_decode_one() {
  local b1 b2 b3 b4
  vm_ascii_value "${1:0:1}"
  b1=$VM_BYTE
  if [ "$b1" -lt 128 ]; then
    printf '%s' "$b1"
    return 0
  fi
  vm_ascii_value "${1:1:1}"
  b2=$VM_BYTE
  if [ "$b1" -lt 224 ]; then
    printf '%s' "$(( ((b1 - 192) << 6) + (b2 - 128) ))"
    return 0
  fi
  vm_ascii_value "${1:2:1}"
  b3=$VM_BYTE
  if [ "$b1" -lt 240 ]; then
    printf '%s' "$(( ((b1 - 224) << 12) + ((b2 - 128) << 6) + (b3 - 128) ))"
    return 0
  fi
  vm_ascii_value "${1:3:1}"
  b4=$VM_BYTE
  printf '%s' "$(( ((b1 - 240) << 18) + ((b2 - 128) << 12) + ((b3 - 128) << 6) + (b4 - 128) ))"
}

# One decimal code point -> UTF-8 bytes, assigned to VM_BYTES. Assigned rather than printed because
# the callers append it to something and a subshell per character would be the whole cost of the run.
#
# The three octal digits per byte are concatenated into one string and split again on the way out, on
# purpose: `printf %b` consumes AT MOST three digits of an octal escape, so a twelve-character
# `\357\274\241` written as one run would be read as one escape plus the literal text "274241" -
# six bytes where three belong, and mojibake that still looks like it "did something". This is the
# single subtlest bug in this file, and it is why the encoder is written as digits-in, digits-out.
VM_BYTES=
vm_encode() {
  local cp=$1
  local o
  if [ "$cp" -lt 128 ]; then
    vm_ascii_byte "$cp"
    VM_BYTES=$VM_CHAR
    return 0
  fi
  if [ "$cp" -lt 2048 ]; then
    o=$(printf '%03o' "$((192 + (cp >> 6)))")
    o=$o$(printf '%03o' "$((128 + (cp & 63)))")
    VM_BYTES=$(printf '%b' "\\${o:0:3}\\${o:3:3}")
    return 0
  fi
  if [ "$cp" -lt 65536 ]; then
    o=$(printf '%03o' "$((224 + (cp >> 12)))")
    o=$o$(printf '%03o' "$((128 + ((cp >> 6) & 63)))")
    o=$o$(printf '%03o' "$((128 + (cp & 63)))")
    VM_BYTES=$(printf '%b' "\\${o:0:3}\\${o:3:3}\\${o:6:3}")
    return 0
  fi
  o=$(printf '%03o' "$((240 + (cp >> 18)))")
  o=$o$(printf '%03o' "$((128 + ((cp >> 12) & 63)))")
  o=$o$(printf '%03o' "$((128 + ((cp >> 6) & 63)))")
  o=$o$(printf '%03o' "$((128 + (cp & 63)))")
  VM_BYTES=$(printf '%b' "\\${o:0:3}\\${o:3:3}\\${o:6:3}\\${o:9:3}")
}

# One decimal code point -> UTF-8 bytes, printed. A multi-byte code point is one printf plus the octal
# machinery; an ASCII one is a table lookup, and that table exists because this is the inner loop: a
# `printf` inside a command substitution costs about 20ms per call on this machine, which over a 1 KB
# document is the difference between 13 seconds and a fraction of one.
vm_char() {
  local cp=$1
  case $cp in
    32) printf '%s' ' ' ;;
    33) printf '%s' '!' ;;
    34) printf '%s' '"' ;;
    35) printf '%s' '#' ;;
    36) printf '%s' '$' ;;
    37) printf '%s' '%' ;;
    38) printf '%s' '&' ;;
    39) printf '%s' "'" ;;
    40) printf '%s' '(' ;;
    41) printf '%s' ')' ;;
    42) printf '%s' '*' ;;
    43) printf '%s' '+' ;;
    44) printf '%s' ',' ;;
    45) printf '%s' '-' ;;
    46) printf '%s' '.' ;;
    47) printf '%s' '/' ;;
    48) printf '%s' '0' ;;
    49) printf '%s' '1' ;;
    50) printf '%s' '2' ;;
    51) printf '%s' '3' ;;
    52) printf '%s' '4' ;;
    53) printf '%s' '5' ;;
    54) printf '%s' '6' ;;
    55) printf '%s' '7' ;;
    56) printf '%s' '8' ;;
    57) printf '%s' '9' ;;
    58) printf '%s' ':' ;;
    59) printf '%s' ';' ;;
    60) printf '%s' '<' ;;
    61) printf '%s' '=' ;;
    62) printf '%s' '>' ;;
    63) printf '%s' '?' ;;
    64) printf '%s' '@' ;;
    65) printf '%s' 'A' ;;
    66) printf '%s' 'B' ;;
    67) printf '%s' 'C' ;;
    68) printf '%s' 'D' ;;
    69) printf '%s' 'E' ;;
    70) printf '%s' 'F' ;;
    71) printf '%s' 'G' ;;
    72) printf '%s' 'H' ;;
    73) printf '%s' 'I' ;;
    74) printf '%s' 'J' ;;
    75) printf '%s' 'K' ;;
    76) printf '%s' 'L' ;;
    77) printf '%s' 'M' ;;
    78) printf '%s' 'N' ;;
    79) printf '%s' 'O' ;;
    80) printf '%s' 'P' ;;
    81) printf '%s' 'Q' ;;
    82) printf '%s' 'R' ;;
    83) printf '%s' 'S' ;;
    84) printf '%s' 'T' ;;
    85) printf '%s' 'U' ;;
    86) printf '%s' 'V' ;;
    87) printf '%s' 'W' ;;
    88) printf '%s' 'X' ;;
    89) printf '%s' 'Y' ;;
    90) printf '%s' 'Z' ;;
    91) printf '%s' '[' ;;
    92) printf '%s' '\' ;;
    93) printf '%s' ']' ;;
    94) printf '%s' '^' ;;
    95) printf '%s' '_' ;;
    96) printf '%s' '`' ;;
    97) printf '%s' 'a' ;;
    98) printf '%s' 'b' ;;
    99) printf '%s' 'c' ;;
    100) printf '%s' 'd' ;;
    101) printf '%s' 'e' ;;
    102) printf '%s' 'f' ;;
    103) printf '%s' 'g' ;;
    104) printf '%s' 'h' ;;
    105) printf '%s' 'i' ;;
    106) printf '%s' 'j' ;;
    107) printf '%s' 'k' ;;
    108) printf '%s' 'l' ;;
    109) printf '%s' 'm' ;;
    110) printf '%s' 'n' ;;
    111) printf '%s' 'o' ;;
    112) printf '%s' 'p' ;;
    113) printf '%s' 'q' ;;
    114) printf '%s' 'r' ;;
    115) printf '%s' 's' ;;
    116) printf '%s' 't' ;;
    117) printf '%s' 'u' ;;
    118) printf '%s' 'v' ;;
    119) printf '%s' 'w' ;;
    120) printf '%s' 'x' ;;
    121) printf '%s' 'y' ;;
    122) printf '%s' 'z' ;;
    123) printf '%s' '{' ;;
    124) printf '%s' '|' ;;
    125) printf '%s' '}' ;;
    126) printf '%s' '~' ;;
    *)
      if [ "$cp" -lt 32 ]; then
        printf '%b' "\\$(printf '%03o' "$cp")"
        return 0
      fi
      vm_encode "$cp"
      printf '%s' "$VM_BYTES"
      ;;
  esac
}

# UTF-8 bytes -> the cps form above. An invalid sequence is kept as its individual bytes: a shell
# cannot do better, and dropping input silently is worse than keeping it visibly.
vm_cps_of_bytes() {
  local s=$1
  local n=${#s} i=0 out= b1= len=
  while [ "$i" -lt "$n" ]; do
    vm_utf8_len "$s" "$i"
    len=$VM_LEN
    if [ "$((i + len))" -gt "$n" ]; then len=1; fi
    if [ "$len" -eq 1 ]; then
      vm_ascii_value "${s:i:1}"
      out=$out$VM_BYTE';'
    else
      out=$out$(vm_decode_one "${s:i:len}")';'
    fi
    i=$((i + len))
  done
  printf ';%s' "$out"
}

# The cps form back to UTF-8 bytes: ';104;105;' -> "hi".
vm_bytes_of_cps() {
  local s=$1 cp out=
  local IFS=';'
  for cp in $s; do
    if [ -z "$cp" ]; then continue; fi
    vm_encode "$cp"
    out=$out$VM_BYTES
  done
  unset IFS
  printf '%s' "$out"
}

# ------------------------------------------------------------------ character classes
#
# Every class is a numeric range test: exact, locale-independent, and cheap. The ranges are the
# contract's own lists, not a Unicode table. Note what is NOT here: U+0080-U+009F (the C1 controls) are
# not deleted, because docs/WORKERS.md section 2 lists U+007F and stops - the reference agrees, and
# "fixing" that would be inventing a rule.

vm_is_deleted() {
  local c=$1
  if [ "$c" -le 8 ]; then return 0; fi
  if [ "$c" -eq 11 ] || [ "$c" -eq 12 ]; then return 0; fi
  if [ "$c" -ge 14 ] && [ "$c" -le 31 ]; then return 0; fi
  if [ "$c" -eq 127 ]; then return 0; fi
  if [ "$c" -ge 768 ] && [ "$c" -le 879 ]; then return 0; fi
  if [ "$c" -ge 6832 ] && [ "$c" -le 6911 ]; then return 0; fi
  if [ "$c" -ge 7616 ] && [ "$c" -le 7679 ]; then return 0; fi
  if [ "$c" -ge 8203 ] && [ "$c" -le 8207 ]; then return 0; fi
  if [ "$c" -ge 8234 ] && [ "$c" -le 8238 ]; then return 0; fi
  if [ "$c" -ge 8288 ] && [ "$c" -le 8292 ]; then return 0; fi
  if [ "$c" -ge 8400 ] && [ "$c" -le 8447 ]; then return 0; fi
  if [ "$c" -ge 65024 ] && [ "$c" -le 65039 ]; then return 0; fi
  if [ "$c" -eq 65279 ]; then return 0; fi
  return 1
}

vm_is_space_like() {
  local c=$1
  if [ "$c" -eq 32 ] || [ "$c" -eq 9 ] || [ "$c" -eq 10 ] || [ "$c" -eq 13 ]; then return 0; fi
  if [ "$c" -eq 160 ]; then return 0; fi
  if [ "$c" -ge 8192 ] && [ "$c" -le 8202 ]; then return 0; fi
  if [ "$c" -eq 8232 ] || [ "$c" -eq 8233 ]; then return 0; fi
  if [ "$c" -eq 8239 ] || [ "$c" -eq 8287 ]; then return 0; fi
  if [ "$c" -eq 12288 ]; then return 0; fi
  return 1
}

vm_is_cjk() {
  local c=$1
  if [ "$c" -ge 13312 ] && [ "$c" -le 19903 ]; then return 0; fi
  if [ "$c" -ge 19968 ] && [ "$c" -le 40959 ]; then return 0; fi
  if [ "$c" -ge 63744 ] && [ "$c" -le 64255 ]; then return 0; fi
  if [ "$c" -ge 12352 ] && [ "$c" -le 12543 ]; then return 0; fi
  if [ "$c" -ge 44032 ] && [ "$c" -le 55215 ]; then return 0; fi
  return 1
}

# The punctuation set of docs/WORKERS.md section 4. Transcribed by hand from the reference
# implementation's PUNCT_ONLY string - this is the one table in this file that is not shared data, so
# it is written as hex: `\` and `"` inside a `case` pattern are a quoting trap and an escape is not.
#
#   !?,.;:'"()[]{}<>-_/\|*+=~`@#$%^&
vm_is_punct() {
  case $1 in
    33|34|35|36|37|38|39|40|41|42|43|44|45|46|47|58|59|60|61|62|63|64|91|92|93|94|95|96|123|124|125|126) return 0 ;;
  esac
  return 1
}

# ------------------------------------------------------------------ normalize

# docs/WORKERS.md section 2, in the order that section gives: delete, map, lowercase, fold, collapse,
# trim. The lowercase and fold steps are the generated tables; this script does not decide what a
# letter is.
#
# Collapse and trim are not a second pass: a space is only ever "pending" with something already
# emitted, and it is written out when the next real character arrives. That is why "  a   b  " is
# "a b" and "   " is "". The accumulator is local rather than global on purpose - a global that two
# nested helpers both write is how a trailing space gets added back after it was dropped.
vm_normalize() {
  local src=$1
  local n=${#src} i=0 ch b1 len cp
  local pending=0
  local out=
  while [ "$i" -lt "$n" ]; do
    ch=${src:i:1}
    vm_ascii_value "$ch"
    cp=$VM_BYTE
    if [ "$cp" -ge 128 ]; then
      vm_utf8_len "$src" "$i"
      len=$VM_LEN
      if [ "$((i + len))" -gt "$n" ]; then len=1; fi
      if [ "$len" -eq 1 ]; then
        cp=$VM_BYTE
      elif [ "$len" -eq 2 ]; then
        # Two-byte sequences are decoded inline: every Latin-1 letter in the corpus is one of these,
        # and a command substitution here costs 10-20ms. The arithmetic is the same as vm_decode_one
        # does - ((b1-192) << 6) + (b2-128) - with the two byte reads unrolled.
        vm_ascii_value "${src:i+1:1}"
        cp=$(( ((cp - 192) << 6) + (VM_BYTE - 128) ))
        i=$((i + 2))
        if vm_is_deleted "$cp"; then continue; fi
        if vm_is_space_like "$cp"; then
          if [ -n "$out" ]; then pending=1; fi
          continue
        fi
        if [ "$pending" -eq 1 ]; then
          out=$out' '
          pending=0
        fi
        vm_fold_cp "$cp"
        out=$out$VM_FOLDED
        continue
      else
        cp=$(vm_decode_one "${src:i:len}")
      fi
      i=$((i + len))
      if vm_is_deleted "$cp"; then continue; fi
      if vm_is_space_like "$cp"; then
        if [ -n "$out" ]; then pending=1; fi
        continue
      fi
      if [ "$pending" -eq 1 ]; then
        out=$out' '
        pending=0
      fi
      if [ "$cp" -ge 65281 ] && [ "$cp" -le 65374 ]; then
        vm_fold_cp $((cp - 65248))
        out=$out$VM_FOLDED
        continue
      fi
      case $cp in
        8216|8217|8219|8242) vm_fold_cp 39; out=$out$VM_FOLDED; continue ;;
        8220|8221|8223|8243) vm_fold_cp 34; out=$out$VM_FOLDED; continue ;;
        8208|8209|8210|8211|8212|8213|8722) vm_fold_cp 45; out=$out$VM_FOLDED; continue ;;
        8230)
          vm_fold_cp 46
          out=$out$VM_FOLDED$VM_FOLDED$VM_FOLDED
          continue
          ;;
        12289) vm_fold_cp 44; out=$out$VM_FOLDED; continue ;;
        12290) vm_fold_cp 46; out=$out$VM_FOLDED; continue ;;
      esac
      vm_fold_cp "$cp"
      out=$out$VM_FOLDED
      continue
    fi
    if [ "$cp" -eq 32 ] || [ "$cp" -eq 9 ] || [ "$cp" -eq 10 ] || [ "$cp" -eq 13 ]; then
      if [ -n "$out" ]; then pending=1; fi
      i=$((i + 1))
      continue
    fi
    if [ "$cp" -le 8 ] || [ "$cp" -eq 11 ] || [ "$cp" -eq 12 ] \
      || { [ "$cp" -ge 14 ] && [ "$cp" -le 31 ]; } || [ "$cp" -eq 127 ]; then
      i=$((i + 1))
      continue
    fi
    if [ "$pending" -eq 1 ]; then
      out=$out' '
      pending=0
    fi
    # The last step for an ASCII character, inlined: A-Z is the only ASCII code point the contract's
    # tables change (fold(lower('A')) is 'a'; every other ASCII code point is itself). Calling
    # vm_fold_cp here was measured at 14ms per character against 1ms for this case table - the
    # function call plus its ~120-arm dispatch is the entire cost of a normalizer over ASCII text.
    case $cp in
      65) out=${out}a ;;
      66) out=${out}b ;;
      67) out=${out}c ;;
      68) out=${out}d ;;
      69) out=${out}e ;;
      70) out=${out}f ;;
      71) out=${out}g ;;
      72) out=${out}h ;;
      73) out=${out}i ;;
      74) out=${out}j ;;
      75) out=${out}k ;;
      76) out=${out}l ;;
      77) out=${out}m ;;
      78) out=${out}n ;;
      79) out=${out}o ;;
      80) out=${out}p ;;
      81) out=${out}q ;;
      82) out=${out}r ;;
      83) out=${out}s ;;
      84) out=${out}t ;;
      85) out=${out}u ;;
      86) out=${out}v ;;
      87) out=${out}w ;;
      88) out=${out}x ;;
      89) out=${out}y ;;
      90) out=${out}z ;;
      *) out=$out$ch ;;
    esac
    i=$((i + 1))
  done
  VM_TEXT=$out
}

# One code point through the contract's steps 3 and 4, in that order, into VM_FOLDED. The order is the
# whole point of having two tables: lowercase first, then fold what the lowercase produced, and then
# lowercase the result of the fold again where the fold table answered in uppercase (U+00C0 -> "A").
#
# Both tables are keyed by code point, and the fold step's key is the *character* the lowercase step
# produced - so the literal two-step path has to turn that character back into a code point. The
# generated composed table is that same chain, keyed by the original code point, in one lookup; it is
# built from both JSON files and checked entry by entry against them by build.mjs.
#
# What the fallback has to be is the subtle part, and it is where a first draft went wrong. The composed
# table only carries code points for which the chain changes something, and latin-lower.json covers
# U+0000-U+024F while latin-fold.json also has answers for accented letters the lower table does not
# mention (U+00E9 -> e: the lower table has no entry for e-acute, and the fold table does). So for a
# code point in the tables' domain the answer is the fold step's, not the code point as text - which is
# why this reads as one decision tree and not as "composed table, else identity".
#
# The ASCII branch is the hot path for real text and is pure shell arithmetic plus one assignment:
# fold(lower('A')) is 'a', and fold of every other ASCII code point is itself. Writing it as a case
# table instead of "convert to a character, then convert back" is worth the length - the conversions
# are two command substitutions per character, and that is 20ms a character on this machine.
VM_FOLDED=
vm_fold_cp() {
  local cp=$1
  case $cp in
    65) VM_FOLDED='a' ;;
    66) VM_FOLDED='b' ;;
    67) VM_FOLDED='c' ;;
    68) VM_FOLDED='d' ;;
    69) VM_FOLDED='e' ;;
    70) VM_FOLDED='f' ;;
    71) VM_FOLDED='g' ;;
    72) VM_FOLDED='h' ;;
    73) VM_FOLDED='i' ;;
    74) VM_FOLDED='j' ;;
    75) VM_FOLDED='k' ;;
    76) VM_FOLDED='l' ;;
    77) VM_FOLDED='m' ;;
    78) VM_FOLDED='n' ;;
    79) VM_FOLDED='o' ;;
    80) VM_FOLDED='p' ;;
    81) VM_FOLDED='q' ;;
    82) VM_FOLDED='r' ;;
    83) VM_FOLDED='s' ;;
    84) VM_FOLDED='t' ;;
    85) VM_FOLDED='u' ;;
    86) VM_FOLDED='v' ;;
    87) VM_FOLDED='w' ;;
    88) VM_FOLDED='x' ;;
    89) VM_FOLDED='y' ;;
    90) VM_FOLDED='z' ;;
    32) VM_FOLDED=' ' ;;
    33) VM_FOLDED='!' ;;
    34) VM_FOLDED='"' ;;
    35) VM_FOLDED='#' ;;
    36) VM_FOLDED='$' ;;
    37) VM_FOLDED='%' ;;
    38) VM_FOLDED='&' ;;
    39) VM_FOLDED="'" ;;
    40) VM_FOLDED='(' ;;
    41) VM_FOLDED=')' ;;
    42) VM_FOLDED='*' ;;
    43) VM_FOLDED='+' ;;
    44) VM_FOLDED=',' ;;
    45) VM_FOLDED='-' ;;
    46) VM_FOLDED='.' ;;
    47) VM_FOLDED='/' ;;
    48) VM_FOLDED='0' ;;
    49) VM_FOLDED='1' ;;
    50) VM_FOLDED='2' ;;
    51) VM_FOLDED='3' ;;
    52) VM_FOLDED='4' ;;
    53) VM_FOLDED='5' ;;
    54) VM_FOLDED='6' ;;
    55) VM_FOLDED='7' ;;
    56) VM_FOLDED='8' ;;
    57) VM_FOLDED='9' ;;
    58) VM_FOLDED=':' ;;
    59) VM_FOLDED=';' ;;
    60) VM_FOLDED='<' ;;
    61) VM_FOLDED='=' ;;
    62) VM_FOLDED='>' ;;
    63) VM_FOLDED='?' ;;
    64) VM_FOLDED='@' ;;
    91) VM_FOLDED='[' ;;
    92) VM_FOLDED='\' ;;
    93) VM_FOLDED=']' ;;
    94) VM_FOLDED='^' ;;
    95) VM_FOLDED='_' ;;
    96) VM_FOLDED='`' ;;
    123) VM_FOLDED='{' ;;
    124) VM_FOLDED='|' ;;
    125) VM_FOLDED='}' ;;
    126) VM_FOLDED='~' ;;
    *)
      if [ "$cp" -lt 128 ]; then
        # 0-31 and 127: a control character, which survives the normalizer untouched (the contract
        # deletes U+0000-U+0008, U+000B, U+000C, U+000E-U+001F and U+007F, so what is left is TAB, LF,
        # CR and the C1-range escapes that never reach here as single bytes).
        VM_FOLDED=$(vm_char "$cp")
        return 0
      fi
      # Both files stop at U+024F: for anything above that the contract's steps 3 and 4 have nothing to
      # say, and this early exit is why a CJK document is not paying for two table lookups per character.
      if [ "$cp" -gt 591 ]; then
        VM_FOLDED=$(vm_char "$cp")
        return 0
      fi
      vm_lowerfold_ascii "$cp"
      if [ "$VM_LOWERFOLD" != "$cp" ]; then
        VM_FOLDED=$VM_LOWERFOLD
        return 0
      fi
      vm_fold_ascii "$cp"
      VM_FOLDED=$VM_FOLD_ASCII
      ;;
  esac
}

# ------------------------------------------------------------------ extract
#
# docs/WORKERS.md section 3. State lives in VM_X_* variables rather than in a struct, because that is
# what a shell has.

VM_X_TEXT=
VM_X_TITLE=
VM_X_LINKSJSON=
VM_X_LINKFIRST=1
VM_X_IMAGES=0
VM_X_IN_TITLE=0
VM_X_TITLE_SEEN=0
VM_X_IN_LINK=0
VM_X_LINKHREF=
VM_X_LINKABS=0
VM_X_LINKTEXT=

# The end of the tag whose '<' is at $2: VM_TAG_END is the index of '>' or the length of the string
# when the tag never closes. '>' inside a quoted attribute value does not end a tag.
VM_TAG_END=0
vm_tag_end() {
  local s=$1
  local start=$2
  local n=${#s} j=$((start + 1)) q= ch
  while [ "$j" -lt "$n" ]; do
    ch=${s:j:1}
    if [ -n "$q" ]; then
      if [ "$ch" = "$q" ]; then q=; fi
    elif [ "$ch" = '"' ] || [ "$ch" = "'" ]; then
      q=$ch
    elif [ "$ch" = '>' ]; then
      VM_TAG_END=$j
      return 0
    fi
    j=$((j + 1))
  done
  VM_TAG_END=$n
}

vm_is_removed_element() {
  case $1 in
    script|style|noscript|template|svg|iframe) return 0 ;;
  esac
  return 1
}

vm_is_newline_tag() {
  case $1 in
    br|p|div|li|ul|ol|tr|th|td|h1|h2|h3|h4|h5|h6) return 0 ;;
    section|article|header|footer|aside|nav|blockquote|pre|table|hr) return 0 ;;
    dd|dt|figure|figcaption|main|form) return 0 ;;
  esac
  return 1
}

# ASCII letters lowercased, for the case-insensitive tag and entity-name comparisons. Applied to a
# tag name or an entity name - both ASCII by construction - never to document text. Assigns
# VM_ASCII_LOWER rather than printing: it is called once per tag, which on a real document is often.
VM_ASCII_LOWER=
vm_ascii_lower() {
  local s=$1
  local i=0 ch out= b
  while [ "$i" -lt "${#s}" ]; do
    ch=${s:i:1}
    vm_ascii_value "$ch"
    b=$VM_BYTE
    if [ "$b" -ge 65 ] && [ "$b" -le 90 ]; then
      vm_ascii_byte "$((b + 32))"
      out=$out$VM_CHAR
    else
      out=$out$ch
    fi
    i=$((i + 1))
  done
  VM_ASCII_LOWER=$out
}

# A tag's name, from the raw text between its angle brackets: skip a leading '/', then the name up to
# the first space, tab or '>'. Sets VM_NAME, VM_NAME_CLOSING and VM_NAME_VALID.
#
# The reference reads the name with /^\/?\s*([A-Za-z][A-Za-z0-9:-]*)/ and falls back to the empty name
# when that does not match, which is what makes "<p>abc<b" drop the tag instead of emitting the newline
# a "<b" would otherwise add. The validity flag here is that same rule: a name that does not start with
# an ASCII letter is not a name at all.
VM_NAME=
VM_NAME_CLOSING=0
VM_NAME_VALID=0
vm_tag_name_of() {
  local raw=$1 first=
  VM_NAME_CLOSING=0
  VM_NAME_VALID=0
  case $raw in
    /*) VM_NAME_CLOSING=1; raw=${raw#/} ;;
  esac
  raw=${raw%% *}
  raw=${raw%%	*}
  raw=${raw%%>*}
  # A self-closing tag's slash is not part of its name: the reference reads the name with
  # /^\/?\s*([A-Za-z][A-Za-z0-9:-]*)/, a character set that stops at the slash, so `<br/>`, `<p/>`,
  # `<hr/>` and every other tag written without a space before the slash are ordinary tags there. This
  # function used to keep the slash, which made the name `br/`, which is not in the newline list - so
  # `<br/>` contributed nothing while `<br />` worked, and the fuzzer found it as a single missing
  # newline in one generated case.
  raw=${raw%%/*}
  first=${raw:0:1}
  case $first in
    [A-Za-z]) VM_NAME_VALID=1 ;;
    *) VM_NAME=; return 0 ;;
  esac
  vm_ascii_lower "$raw"
  VM_NAME=$VM_ASCII_LOWER
}

# CDATA parking: a section's contents wait in an array while a marker byte pair stands in for them, so
# the main pass copies them out verbatim instead of parsing them as markup.
VM_CDATA_LIST=()
VM_CDATA_N=0
VM_CDATA_MARK=
vm_cdata_park() {
  VM_CDATA_N=$((VM_CDATA_N + 1))
  VM_CDATA_LIST[$VM_CDATA_N]=$1
  printf -v VM_CDATA_MARK '\001%d\002' "$VM_CDATA_N"
}

# index of the first occurrence of $2 in $1 at or after $3, or -1
vm_index_of() {
  local s=$1
  local needle=$2
  local from=$3
  local n=${#s} ln=${#needle} i=$from
  while [ "$i" -le "$((n - ln))" ]; do
    if [ "${s:i:ln}" = "$needle" ]; then
      printf '%s' "$i"
      return 0
    fi
    i=$((i + 1))
  done
  printf '%s' -1
}

# From the end of a removed element's opening tag, find the end of the element: its closing tag, or
# the end of the input. Sets VM_SKIP_NEXT.
VM_SKIP_NEXT=0
vm_skip_removed() {
  local s=$1
  local name=$2
  local from=$3
  local n=${#s} i=$from ch raw
  while [ "$i" -lt "$n" ]; do
    ch=${s:i:1}
    if [ "$ch" != '<' ]; then
      i=$((i + 1))
      continue
    fi
    vm_tag_end "$s" "$i"
    raw=${s:i+1:VM_TAG_END-i-1}
    i=$((VM_TAG_END + 1))
    case $raw in
      /*)
        vm_tag_name_of "$raw"
        if [ "$VM_NAME" = "$name" ]; then
          VM_SKIP_NEXT=$i
          return 0
        fi
        ;;
    esac
  done
  VM_SKIP_NEXT=$n
}

# The pre-pass of docs/WORKERS.md section 3 steps 1-2: CDATA keeps its text, comments and doctypes go,
# and the six removed elements go with their content.
#
# The reference does this with four regular expressions over the whole document, which a shell does
# not have. This walks the string once instead, with the same tag scanner the main pass uses. The one
# place it can differ from the reference is stated in README.md: the reference stops a removed element
# at the first '>' even when that '>' is inside a quoted attribute value, this stops at the real end
# of the tag. The corpus contains no such document; where they differ this is the browser's answer.
VM_PRE=
vm_extract_prepass() {
  local s=$1
  local n=${#s} i=0 out= ch raw end inner keep
  while [ "$i" -lt "$n" ]; do
    ch=${s:i:1}
    if [ "$ch" != '<' ]; then
      out=$out$ch
      i=$((i + 1))
      continue
    fi
    if [ "${s:i:9}" = '<![CDATA[' ]; then
      end=$(vm_index_of "$s" ']]>' $((i + 9)))
      if [ "$end" -lt 0 ]; then
        inner=${s:i+9}
        i=$n
      else
        inner=${s:i+9:end-i-9}
        i=$((end + 3))
      fi
      # The reference replaces a CDATA section with its contents before anything else looks at the
      # document, so markup and entities inside it are text, not markup. Keeping that property needs
      # the contents to be out of reach of the scanner: they are parked and a marker takes their
      # place, and the main pass puts them back.
      vm_cdata_park "$inner"
      out=$out$VM_CDATA_MARK
      continue
    fi
    if [ "${s:i:4}" = '<!--' ]; then
      end=$(vm_index_of "$s" '-->' $((i + 4)))
      if [ "$end" -lt 0 ]; then
        i=$n
      else
        i=$((end + 3))
      fi
      continue
    fi
    keep=${s:i:9}
    vm_ascii_lower "$keep"
    if [ "$VM_ASCII_LOWER" = '<!doctype' ]; then
      vm_tag_end "$s" "$i"
      i=$((VM_TAG_END + 1))
      continue
    fi
    keep=$i
    vm_tag_end "$s" "$i"
    raw=${s:i+1:VM_TAG_END-i-1}
    i=$((VM_TAG_END + 1))
    vm_tag_name_of "$raw"
    if [ "$VM_NAME_VALID" -eq 1 ] && [ "$VM_NAME_CLOSING" -eq 0 ] && vm_is_removed_element "$VM_NAME"; then
      vm_skip_removed "$s" "$VM_NAME" "$i"
      i=$VM_SKIP_NEXT
      continue
    fi
    # Everything else is copied through *verbatim*, and this is not an optimisation - it is what keeps
    # this pass from having opinions that belong to the main pass. A first version rebuilt every tag
    # as '<' + raw + '>', which invented a '>' for a tag that never closed: "a < b > c 5<6" came out
    # as "a < b > c 5<6>" and the extra character was the pass's, not the document's.
    #
    # The '>' is only written back when the source had one, and a '<' at the very end of the input is
    # copied as itself - the main pass reads it as literal text, where '<' + '>' would be an empty tag
    # that the main pass drops.
    out=$out'<'$raw
    if [ "$VM_TAG_END" -lt "$n" ]; then
      out=$out'>'
    fi
  done
  VM_PRE=$out
}

# A decoded chunk (a newline for a block tag, an entity, a parked CDATA section) goes to the title if a
# title is open and to the body otherwise - and to an open anchor's collected text too, unless the
# title is where it landed. The last clause is the reference's own arrangement (its pushText routes a
# decoded entity to the body unconditionally and a plain character through the title check, and only
# the plain-character path reaches the anchor when a title is open) and it is pinned by the corpus:
# `<a href="/x"><title>T</title>t</a>` reports the link's text as "t", not "Tt".
vm_x_push() {
  local chunk=$1
  if [ "$VM_X_IN_TITLE" -eq 1 ]; then
    VM_X_TITLE=$VM_X_TITLE$chunk
    return 0
  fi
  VM_X_TEXT=$VM_X_TEXT$chunk
  if [ "$VM_X_IN_LINK" -eq 1 ]; then
    VM_X_LINKTEXT=$VM_X_LINKTEXT$chunk
  fi
}

# An anchor closes: report it with the text it collected. The absolute test is the contract's own
# scheme test, [A-Za-z][A-Za-z0-9+.-]*: at the start of the href - done by hand, because a `grep`
# here would be a subprocess per link for a six-character question.
vm_x_close_link() {
  local href=$VM_X_LINKHREF
  local i=0 n=${#href} ch
  VM_X_LINKABS=0
  if [ "$n" -gt 0 ]; then
    ch=${href:0:1}
    case $ch in
      [A-Za-z])
        i=1
        while [ "$i" -lt "$n" ]; do
          ch=${href:i:1}
          case $ch in
            ':') VM_X_LINKABS=1; break ;;
            [A-Za-z0-9+.-]) ;;
            *) break ;;
          esac
          i=$((i + 1))
        done
        ;;
    esac
  fi
  # An anchor closes: report it, with the text it collected, as one entry of the links array. The entry
  # is built here rather than collected into a record and parsed afterwards - the href and the text go
  # straight through the JSON encoder, so no byte of either can be mistaken for a separator.
  local absjson=false
  if [ "$VM_X_LINKABS" -eq 1 ]; then absjson=true; fi
  local comma=
  if [ "$VM_X_LINKFIRST" -eq 1 ]; then comma=; else comma=,; fi
  VM_X_LINKSJSON=$VM_X_LINKSJSON$comma"{\"href\":$(vm_json_encode "$VM_X_LINKHREF"),\"absolute\":$absjson,\"text\":$(vm_json_encode "$VM_X_LINKTEXT")}"
  VM_X_LINKFIRST=0
  VM_X_IN_LINK=0
  VM_X_LINKHREF=
  VM_X_LINKTEXT=
}

# href="..." / href='...' / href=bare, with the word boundary the reference's \b gives. Sets VM_HREF.
VM_HREF=
vm_href_of() {
  local raw=$1
  local n=${#raw} i=0 ch before j q k
  VM_HREF=
  while [ "$i" -lt "$n" ]; do
    if [ "${raw:i:4}" = 'href' ]; then
      before=
      if [ "$i" -gt 0 ]; then before=${raw:i-1:1}; fi
      case $before in
        ''|' '|'	'|'
') ;;
        *) i=$((i + 1)); continue ;;
      esac
      j=$((i + 4))
      while [ "$j" -lt "$n" ]; do
        ch=${raw:j:1}
        case $ch in
          ' '|'	'|'
') j=$((j + 1)) ;;
          *) break ;;
        esac
      done
      if [ "${raw:j:1}" != '=' ]; then
        i=$((i + 1))
        continue
      fi
      j=$((j + 1))
      while [ "$j" -lt "$n" ]; do
        ch=${raw:j:1}
        case $ch in
          ' '|'	'|'
') j=$((j + 1)) ;;
          *) break ;;
        esac
      done
      ch=${raw:j:1}
      if [ "$ch" = '"' ] || [ "$ch" = "'" ]; then
        q=$ch
        k=$((j + 1))
        while [ "$k" -lt "$n" ]; do
          ch=${raw:k:1}
          if [ "$ch" = "$q" ]; then
            VM_HREF=${raw:j+1:k-j-1}
            return 0
          fi
          k=$((k + 1))
        done
        VM_HREF=${raw:j+1}
        return 0
      fi
      k=$j
      while [ "$k" -lt "$n" ]; do
        ch=${raw:k:1}
        case $ch in
          ' '|'	'|'
'|'>') break ;;
        esac
        k=$((k + 1))
      done
      VM_HREF=${raw:j:k-j}
      return 0
    fi
    i=$((i + 1))
  done
}

# Entities, docs/WORKERS.md section 6: each name decodes to its own character, names are matched
# case-insensitively, and named and numeric references are decoded with or without the trailing
# semicolon. Sets VM_ENT_TEXT and VM_ENT_NEXT; returns 1 when there is no reference at $2.
VM_ENT_TEXT=
VM_ENT_NEXT=0
vm_entity_at() {
  local s=$1
  local i=$2
  local n=${#s} j=$((i + 1)) body= ch hex=0 cp b
  if [ "$((j + 12))" -lt "$n" ]; then n=$((j + 12)); fi
  if [ "$j" -ge "$n" ]; then return 1; fi
  ch=${s:j:1}
  if [ "$ch" = '#' ]; then
    j=$((j + 1))
    if [ "$j" -lt "$n" ]; then
      ch=${s:j:1}
      if [ "$ch" = 'x' ] || [ "$ch" = 'X' ]; then hex=1; j=$((j + 1)); fi
    fi
    while [ "$j" -lt "$n" ]; do
      ch=${s:j:1}
      if [ "$hex" -eq 1 ]; then
        case $ch in
          [0-9a-fA-F]) ;;
          *) break ;;
        esac
        if [ "${#body}" -ge 6 ]; then return 1; fi
      else
        case $ch in
          [0-9]) ;;
          *) break ;;
        esac
        if [ "${#body}" -ge 7 ]; then return 1; fi
      fi
      body=$body$ch
      j=$((j + 1))
    done
    if [ -z "$body" ]; then return 1; fi
    ch=${s:j:1}
    if [ "$ch" != ';' ]; then
      if [ "$hex" -eq 1 ]; then
        case $ch in
          [0-9a-fA-F]) return 1 ;;
        esac
      else
        case $ch in
          [0-9]) return 1 ;;
        esac
      fi
    fi
    if [ "$hex" -eq 1 ]; then
      cp=$((16#$body))
    else
      cp=$((10#$body))
    fi
    if [ "$cp" -eq 0 ] || [ "$cp" -gt 1114111 ]; then return 1; fi
    if [ "$cp" -ge 55296 ] && [ "$cp" -le 57343 ]; then return 1; fi
    vm_encode "$cp"
    VM_ENT_TEXT=$VM_BYTES
    if [ "$ch" = ';' ]; then VM_ENT_NEXT=$((j + 1)); else VM_ENT_NEXT=$j; fi
    return 0
  fi
  while [ "$j" -lt "$n" ]; do
    ch=${s:j:1}
    case $ch in
      [A-Za-z0-9]) ;;
      *) break ;;
    esac
    if [ "${#body}" -ge 8 ]; then return 1; fi
    body=$body$ch
    j=$((j + 1))
  done
  if [ "${#body}" -lt 2 ]; then return 1; fi
  ch=${s:j:1}
  case $ch in
    [A-Za-z0-9]) return 1 ;;
  esac
  vm_ascii_lower "$body"
  case $VM_ASCII_LOWER in
    amp) VM_ENT_TEXT='&' ;;
    lt) VM_ENT_TEXT='<' ;;
    gt) VM_ENT_TEXT='>' ;;
    quot) VM_ENT_TEXT='"' ;;
    apos) VM_ENT_TEXT="'" ;;
    nbsp) VM_ENT_TEXT=$(vm_char 160) ;;
    mdash) VM_ENT_TEXT=$(vm_char 8212) ;;
    ndash) VM_ENT_TEXT=$(vm_char 8211) ;;
    hellip) VM_ENT_TEXT=$(vm_char 8230) ;;
    laquo) VM_ENT_TEXT=$(vm_char 171) ;;
    raquo) VM_ENT_TEXT=$(vm_char 187) ;;
    copy) VM_ENT_TEXT=$(vm_char 169) ;;
    reg) VM_ENT_TEXT=$(vm_char 174) ;;
    trade) VM_ENT_TEXT=$(vm_char 8482) ;;
    times) VM_ENT_TEXT=$(vm_char 215) ;;
    middot) VM_ENT_TEXT=$(vm_char 183) ;;
    *) return 1 ;;
  esac
  if [ "$ch" = ';' ]; then VM_ENT_NEXT=$((j + 1)); else VM_ENT_NEXT=$j; fi
  return 0
}

# The main scan, docs/WORKERS.md section 3 steps 3-8. Every branch here is a rule in that section,
# including the two that a browser-based reading would get wrong if they were guessed at: a '<' is a
# tag only when followed by a letter, '/' or '!', and a tag that never closes at the end of the input
# is dropped with its name.
vm_extract_main() {
  local src=$1
  local n=${#src} i=0 ch raw nx keep
  VM_X_TEXT=
  VM_X_TITLE=
  VM_X_LINKSJSON=
  VM_X_LINKFIRST=1
  VM_X_IMAGES=0
  VM_X_IN_TITLE=0
  VM_X_TITLE_SEEN=0
  VM_X_IN_LINK=0
  VM_X_LINKHREF=
  VM_X_LINKTEXT=
  while [ "$i" -lt "$n" ]; do
    ch=${src:i:1}
    if [ "$ch" = '<' ]; then
      nx=${src:i+1:1}
      keep=0
      case $nx in
        [A-Za-z/!]) keep=1 ;;
      esac
      if [ "$keep" -eq 1 ]; then
        vm_tag_end "$src" "$i"
        raw=${src:i+1:VM_TAG_END-i-1}
        i=$((VM_TAG_END + 1))
        vm_tag_name_of "$raw"
        # A tag whose name is not a name (the reference's regex did not match) is dropped and takes its
        # characters with it: "<p>abc<b" is "\nabc", not "\nab\n". That is the contract's eof-in-tag
        # rule, and the newline a "<b>" would have contributed must not be contributed by "<b.
        if [ "$VM_NAME_VALID" -eq 0 ]; then
          continue
        fi
        # A tag that never closes is dropped before it does anything at all - no newline, no anchor,
        # no image count. The reference's loop enters the same branches, but every one of those effects
        # lands in `text` (a newline) or in a link that is only reported when it is closed, and the
        # reference routes a lone '<p' nowhere because the tag token is incomplete. "<p" is "" and
        # "a<div" is "a"; a first version of this produced "\n" and "a\n".
        if [ "$VM_TAG_END" -eq "$n" ]; then
          continue
        fi
        case $VM_NAME in
          title)
            if [ "$VM_NAME_CLOSING" -eq 0 ] && [ "$VM_X_TITLE_SEEN" -eq 0 ]; then
              VM_X_IN_TITLE=1
              VM_X_TITLE_SEEN=1
            elif [ "$VM_NAME_CLOSING" -eq 1 ] && [ "$VM_X_IN_TITLE" -eq 1 ]; then
              VM_X_IN_TITLE=0
            fi
            continue
            ;;
          img)
            if [ "$VM_NAME_CLOSING" -eq 0 ]; then VM_X_IMAGES=$((VM_X_IMAGES + 1)); fi
            continue
            ;;
          a)
            if [ "$VM_NAME_CLOSING" -eq 0 ]; then
              if [ "$VM_X_IN_LINK" -eq 1 ]; then vm_x_close_link; fi
              vm_href_of "$raw"
              VM_X_LINKHREF=$VM_HREF
              VM_X_LINKTEXT=
              VM_X_IN_LINK=1
            elif [ "$VM_X_IN_LINK" -eq 1 ]; then
              vm_x_close_link
            fi
            continue
            ;;
        esac
        if vm_is_newline_tag "$VM_NAME"; then
          vm_x_push '
'
        fi
        continue
      fi
    fi
    if [ "$ch" = '&' ]; then
      if vm_entity_at "$src" "$i"; then
        vm_x_push "$VM_ENT_TEXT"
        i=$VM_ENT_NEXT
        continue
      fi
    fi
    # A parked CDATA section: copied out verbatim, so markup and entities inside it stay text.
    if [ "$ch" = $'\001' ]; then
      VM_MARK_END=$(vm_index_of "$src" $'\002' "$i")
      if [ "$VM_MARK_END" -gt 0 ]; then
        VM_CDATA_IDX=${src:i+1:VM_MARK_END-i-1}
        vm_x_push "${VM_CDATA_LIST[$VM_CDATA_IDX]}"
        i=$((VM_MARK_END + 1))
        continue
      fi
    fi
    # Plain text, inlined. A character that is not a '<', an '&' or a parked CDATA marker is copied
    # verbatim, and the fast path matters here for the same reason it does in the normalizer: `vm_x_push`
    # is a function call per character, and the corpus's largest document has a few thousand of them.
    #
    # Inside a <title> the character belongs to the title and to nothing else - not to the body, and not
    # to an open anchor's collected text. `<a href="/x"><title>T</title>t</a>` reports the link's text as
    # "t", and a first version of this inlined path added the title's "T" to it as well.
    if [ "$VM_X_IN_TITLE" -eq 1 ]; then
      VM_X_TITLE=$VM_X_TITLE$ch
    else
      VM_X_TEXT=$VM_X_TEXT$ch
      if [ "$VM_X_IN_LINK" -eq 1 ]; then
        VM_X_LINKTEXT=$VM_X_LINKTEXT$ch
      fi
    fi
    i=$((i + 1))
  done
  if [ "$VM_X_IN_LINK" -eq 1 ]; then vm_x_close_link; fi
}

vm_extract() {
  vm_extract_prepass "$1"
  vm_extract_main "$VM_PRE"
}

# ------------------------------------------------------------------ fingerprint

VM_F_SIMHASH=0000000000000000
VM_F_TOKENS=0
VM_F_SHINGLES=0

# FNV-1a, 64-bit, over the UTF-8 bytes of $1, as 32-bit limbs in VM_H_HI/VM_H_LO.
#
# The hash is kept as (hi, lo), each under 2^32, because shell arithmetic is signed 64-bit. A 64-bit
# multiply therefore has to be written as smaller ones, and the shape matters:
#
#   P = 1099511628211 = 16777216*2^16 + 435, so in base 2^16 the prime is two limbs (435, 16777216)
#   the hash is four limbs: (h0, h1) = lo, (h2, h3) = hi
#
# The product modulo 2^64 is then a five-limb convolution, and it is done that way rather than with two
# 32-bit halves because every intermediate here is under 2^48 - 16-bit limbs cannot overflow, so no
# term has to be reduced and no carry can be lost. Two earlier versions of this function reduced terms
# that still had a carry to give, and both produced a correct low word with a wrong high word: the
# first hashed "x" to d20e5875b5e99600, the second to 93647b4e86021707, and the correct answer is
# af63f54c86021707. That failure mode - half the answer right, which a one-case spot check cannot see -
# is the reason the corpus is the judge here.
vm_fnv1a_bytes() {
  local s=$1
  local n=${#s} i=0 b= ch=
  local lo=2216829733 hi=3421674724
  local h0= h1= h2= h3= t0= t1= t2= t3= t4= carry= v= s0= s1= s2= s3=
  while [ "$i" -lt "$n" ]; do
    ch=${s:i:1}
    vm_ascii_value "$ch"
    b=$VM_BYTE
    # A byte above 0x7F is not in vm_ascii_value's table (it falls back to `printf %d "'x"` there, which
    # is right for a single byte; a multi-byte character would be read as its first byte).
    if [ "$b" -ge 128 ]; then b=$(vm_byte "$ch"); fi
    lo=$((lo ^ b))
    h0=$((lo % 65536))
    h1=$((lo / 65536))
    h2=$((hi % 65536))
    h3=$((hi / 65536))
    t0=$((h0 * 435))
    t1=$((h0 * 16777216 + h1 * 435))
    t2=$((h1 * 16777216 + h2 * 435))
    t3=$((h2 * 16777216 + h3 * 435))
    t4=$((h3 * 16777216))
    # carry propagation, bottom-up, into separate results: adding the carry to t0..t4 in place would
    # read a value it had already overwritten (which is how the first version of this dropped the top
    # limb and lost the high half of every hash after the first byte).
    carry=0
    v=$((t0 + carry))
    s0=$((v % 65536))
    carry=$((v / 65536))
    v=$((t1 + carry))
    s1=$((v % 65536))
    carry=$((v / 65536))
    v=$((t2 + carry))
    s2=$((v % 65536))
    carry=$((v / 65536))
    v=$((t3 + carry))
    s3=$((v % 65536))
    carry=$((v / 65536))
    # the sixth limb (t4 + carry) is dropped on purpose: the result is taken mod 2^64, which is what
    # "unsigned 64-bit throughout" means.
    lo=$((s0 + s1 * 65536))
    hi=$((s2 + s3 * 65536))
    i=$((i + 1))
  done
  VM_H_HI=$hi
  VM_H_LO=$lo
}
# Emitted tokens of one space-free token, appended to VM_TOKENS as \x1f-delimited byte strings.
# docs/WORKERS.md section 4 step 2: trim edge punctuation, then group into runs (CJK vs other); a CJK
# run of 1 is itself, a longer CJK run is its overlapping bigrams, an "other" run is itself.
vm_tokenize_one() {
  local token=$1
  local n=${#token} i=0 b
  while [ "$i" -lt "$n" ]; do
    b=$(vm_byte "${token:i:1}")
    if vm_is_punct "$b"; then i=$((i + 1)); else break; fi
  done
  token=${token:i}
  n=${#token}
  while [ "$n" -gt 0 ]; do
    b=$(vm_byte "${token:n-1:1}")
    if vm_is_punct "$b"; then n=$((n - 1)); else break; fi
  done
  token=${token:0:n}
  if [ -z "$token" ]; then return 0; fi
  local cps run= runcjk= cp cjk=0 idx=0
  cps=$(vm_cps_of_bytes "$token")
  local IFS=';'
  for cp in $cps; do
    if [ -z "$cp" ]; then continue; fi
    if vm_is_cjk "$cp"; then cjk=1; else cjk=0; fi
    if [ -z "$run" ]; then
      runcjk=$cjk
      run=$cp
    elif [ "$cjk" -eq "$runcjk" ]; then
      run=$run';'$cp
    else
      vm_emit_run "$run" "$runcjk"
      runcjk=$cjk
      run=$cp
    fi
  done
  unset IFS
  if [ -n "$run" ]; then vm_emit_run "$run" "$runcjk"; fi
}

vm_emit_run() {
  local run=$1
  local iscjk=$2
  local IFS=';' cp
  local -a parts=()
  for cp in $run; do
    if [ -n "$cp" ]; then parts+=("$cp"); fi
  done
  unset IFS
  local n=${#parts[@]} k=0 out=
  if [ "$iscjk" -eq 1 ]; then
    if [ "$n" -eq 1 ]; then
      vm_encode "${parts[0]}"
      vm_emit_token "$VM_BYTES"
      return 0
    fi
    while [ "$k" -lt "$((n - 1))" ]; do
      vm_encode "${parts[k]}"
      out=$VM_BYTES
      vm_encode "${parts[k+1]}"
      vm_emit_token "$out$VM_BYTES"
      k=$((k + 1))
    done
    return 0
  fi
  while [ "$k" -lt "$n" ]; do
    vm_encode "${parts[k]}"
    out=$out$VM_BYTES
    k=$((k + 1))
  done
  vm_emit_token "$out"
}

vm_emit_token() {
  VM_TOKENS=$VM_TOKENS$1$'\x1f'
}

# docs/WORKERS.md section 4. The text is already normalized (that is the pipeline), but it is trimmed
# here anyway: this capability must not depend on its caller having done it.
vm_fingerprint() {
  local text=$1
  local piece t
  VM_TOKENS=
  local IFS=' '
  local -a raw=()
  # shellcheck disable=SC2086
  set -f
  for piece in $text; do
    if [ -n "$piece" ]; then raw+=("$piece"); fi
  done
  set +f
  unset IFS
  local k=0
  while [ "$k" -lt "${#raw[@]}" ]; do
    vm_tokenize_one "${raw[k]}"
    k=$((k + 1))
  done
  local IFS=$'\x1f'
  local -a toks=()
  for t in $VM_TOKENS; do
    if [ -n "$t" ]; then toks+=("$t"); fi
  done
  unset IFS
  VM_F_TOKENS=${#toks[@]}
  local -a shingles=()
  if [ "${#toks[@]}" -eq 0 ]; then
    VM_F_SHINGLES=0
  elif [ "${#toks[@]}" -lt 3 ]; then
    shingles=("${toks[*]}")
    VM_F_SHINGLES=1
  else
    local j=0
    while [ "$j" -le "$(( ${#toks[@]} - 3 ))" ]; do
      shingles+=("${toks[j]} ${toks[j+1]} ${toks[j+2]}")
      j=$((j + 1))
    done
    VM_F_SHINGLES=${#shingles[@]}
  fi
  local -a counters=()
  local z=0
  while [ "$z" -lt 64 ]; do
    counters+=(0)
    z=$((z + 1))
  done
  local s=0 bit=0 bitval=0
  while [ "$s" -lt "${#shingles[@]}" ]; do
    vm_fnv1a_bytes "${shingles[s]}"
    bit=0
    while [ "$bit" -lt 32 ]; do
      if [ "$(( (VM_H_LO >> bit) & 1 ))" -eq 1 ]; then
        counters[bit]=$(( ${counters[bit]} + 1 ))
      else
        counters[bit]=$(( ${counters[bit]} - 1 ))
      fi
      bit=$((bit + 1))
    done
    bit=0
    while [ "$bit" -lt 32 ]; do
      if [ "$(( (VM_H_HI >> bit) & 1 ))" -eq 1 ]; then
        counters[bit+32]=$(( ${counters[bit+32]} + 1 ))
      else
        counters[bit+32]=$(( ${counters[bit+32]} - 1 ))
      fi
      bit=$((bit + 1))
    done
    s=$((s + 1))
  done
  local lo=0 hi=0
  bit=0
  while [ "$bit" -lt 32 ]; do
    if [ "${counters[bit]}" -gt 0 ]; then lo=$(( lo | (1 << bit) )); fi
    if [ "${counters[bit+32]}" -gt 0 ]; then hi=$(( hi | (1 << bit) )); fi
    bit=$((bit + 1))
  done
  VM_F_SIMHASH=$(printf '%08x%08x' "$hi" "$lo")
}

# ------------------------------------------------------------------ JSON
#
# The harness sends raw UTF-8 in the values (no \u escaping), so the parser passes bytes through
# untouched - but \u escapes are in the corpus (surrogate pairs included), so it decodes them too.
# This is not a general JSON parser: it understands the request shapes of docs/WORKERS.md section 1 and
# the input objects of sections 2-4, and it returns a value's raw text for the caller to interpret.

# Top-level key $2 in object text $1. Sets VM_J_FOUND, VM_J_VAL (the raw value text).
VM_J_FOUND=0
VM_J_VAL=
vm_json_value() {
  local s=$1
  local want=$2
  local n=${#s} i=1 ch k j key start depth
  VM_J_FOUND=0
  VM_J_VAL=
  while [ "$i" -lt "$n" ]; do
    ch=${s:i:1}
    if [ "$ch" != '"' ]; then
      i=$((i + 1))
      continue
    fi
    k=$((i + 1))
    key=
    while [ "$k" -lt "$n" ]; do
      ch=${s:k:1}
      if [ "$ch" = '\' ]; then k=$((k + 2)); continue; fi
      if [ "$ch" = '"' ]; then break; fi
      key=$key$ch
      k=$((k + 1))
    done
    i=$((k + 1))
    j=$i
    while [ "$j" -lt "$n" ]; do
      ch=${s:j:1}
      case $ch in
        ' '|'	'|'
') j=$((j + 1)) ;;
        *) break ;;
      esac
    done
    if [ "${s:j:1}" != ':' ]; then continue; fi
    j=$((j + 1))
    while [ "$j" -lt "$n" ]; do
      ch=${s:j:1}
      case $ch in
        ' '|'	'|'
') j=$((j + 1)) ;;
        *) break ;;
      esac
    done
    start=$j
    ch=${s:j:1}
    if [ "$ch" = '"' ]; then
      k=$((j + 1))
      while [ "$k" -lt "$n" ]; do
        ch=${s:k:1}
        if [ "$ch" = '\' ]; then k=$((k + 2)); continue; fi
        if [ "$ch" = '"' ]; then break; fi
        k=$((k + 1))
      done
      j=$((k + 1))
    elif [ "$ch" = '{' ] || [ "$ch" = '[' ]; then
      depth=0
      k=$j
      while [ "$k" -lt "$n" ]; do
        ch=${s:k:1}
        if [ "$ch" = '"' ]; then
          k=$((k + 1))
          while [ "$k" -lt "$n" ]; do
            ch=${s:k:1}
            if [ "$ch" = '\' ]; then k=$((k + 2)); continue; fi
            if [ "$ch" = '"' ]; then break; fi
            k=$((k + 1))
          done
        elif [ "$ch" = '{' ] || [ "$ch" = '[' ]; then
          depth=$((depth + 1))
        elif [ "$ch" = '}' ] || [ "$ch" = ']' ]; then
          depth=$((depth - 1))
          if [ "$depth" -eq 0 ]; then k=$((k + 1)); break; fi
        fi
        k=$((k + 1))
      done
      j=$k
    else
      k=$j
      while [ "$k" -lt "$n" ]; do
        ch=${s:k:1}
        case $ch in
          ','|'}'|' '|'	'|'
') break ;;
        esac
        k=$((k + 1))
      done
      j=$k
    fi
    if [ "$key" = "$want" ]; then
      VM_J_FOUND=1
      VM_J_VAL=${s:start:j-start}
      return 0
    fi
    i=$j
  done
  return 1
}

# Decodes the JSON string at $1 (a value that starts with '"') into bytes. Sets VM_STR_OK / VM_STR.
# A \u0000 is refused: bash cannot hold a NUL in a variable, so accepting it would silently truncate
# the value, and a truncation that looks like agreement is worse than an error.
VM_STR_OK=0
VM_STR=
vm_json_string() {
  local s=$1
  local n=${#s} i=1 out= ch hex cp lo
  VM_STR_OK=0
  VM_STR=
  if [ "${s:0:1}" != '"' ]; then return 1; fi
  while [ "$i" -lt "$n" ]; do
    ch=${s:i:1}
    if [ "$ch" = '"' ]; then
      VM_STR=$out
      VM_STR_OK=1
      return 0
    fi
    if [ "$ch" != '\' ]; then
      out=$out$ch
      i=$((i + 1))
      continue
    fi
    ch=${s:i+1:1}
    case $ch in
      '"') out=$out'"' ;;
      '\') out=$out'\' ;;
      '/') out=$out'/' ;;
      b) out=$out$(printf '\b') ;;
      f) out=$out$(printf '\f') ;;
      n) out=$out'
' ;;
      r) out=$out$(printf '\r') ;;
      t) out=$out$(printf '\t') ;;
      u)
        hex=${s:i+2:4}
        case $hex in
          [0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]) ;;
          *) return 1 ;;
        esac
        cp=$((16#$hex))
        i=$((i + 6))
        if [ "$cp" -ge 55296 ] && [ "$cp" -le 56319 ]; then
          lo=${s:i:6}
          case $lo in
            '\u'[dD][c-fC-F][0-9a-fA-F][0-9a-fA-F])
              cp=$(( 65536 + ((cp - 55296) * 1024) + (16#${lo:2:4} - 56320) ))
              i=$((i + 6))
              ;;
          esac
        fi
        if [ "$cp" -eq 0 ] || [ "$cp" -gt 1114111 ]; then return 1; fi
        if [ "$cp" -ge 55296 ] && [ "$cp" -le 57343 ]; then return 1; fi
        vm_encode "$cp"
        out=$out$VM_BYTES
        continue
        ;;
      *) return 1 ;;
    esac
    i=$((i + 2))
  done
  return 1
}

# JSON-encodes a byte string: the escaping JSON.stringify does for what can appear in this protocol's
# output. Non-ASCII bytes are passed through as UTF-8, which is what the wire format says they are.
vm_json_encode() {
  local s=$1
  local n=${#s} i=0 ch b out='"'
  while [ "$i" -lt "$n" ]; do
    ch=${s:i:1}
    b=$(vm_byte "$ch")
    if [ "$b" -ge 32 ] && [ "$b" -ne 34 ] && [ "$b" -ne 92 ] && [ "$b" -ne 127 ]; then
      out=$out$ch
    else
      case $b in
        34) out=$out'\"' ;;
        92) out=$out'\\' ;;
        8) out=$out'\b' ;;
        9) out=$out'\t' ;;
        10) out=$out'\n' ;;
        12) out=$out'\f' ;;
        13) out=$out'\r' ;;
        *) out=$out$(printf '\\u%04x' "$b") ;;
      esac
    fi
    i=$((i + 1))
  done
  printf '%s"' "$out"
}

# ------------------------------------------------------------------ capabilities

# Each returns the output object on stdout and 0, or an English message on stdout and 1. The caller
# turns the second case into a bad-input envelope.
vm_cap_normalize() {
  local input=$1
  if vm_json_value "$input" text && vm_json_string "$VM_J_VAL"; then
    vm_normalize "$VM_STR"
    printf '{"text":%s}' "$(vm_json_encode "$VM_TEXT")"
    return 0
  fi
  printf '%s' 'input.text must be a string'
  return 1
}

vm_cap_extract() {
  local input=$1
  if ! vm_json_value "$input" html || ! vm_json_string "$VM_J_VAL"; then
    printf '%s' 'input.html must be a string'
    return 1
  fi
  vm_extract "$VM_STR"
  # The links array is built during the scan, so there is nothing to parse back out here: no record
  # format, no separator that a byte of an href could be confused with.
  printf '{"title":%s,"text":%s,"links":[%s],"images":%d}' \
    "$(vm_json_encode "$VM_X_TITLE")" "$(vm_json_encode "$VM_X_TEXT")" "$VM_X_LINKSJSON" "$VM_X_IMAGES"
  return 0
}

vm_cap_fingerprint() {
  local input=$1
  if vm_json_value "$input" text && vm_json_string "$VM_J_VAL"; then
    vm_fingerprint "$VM_STR"
    printf '{"simhash":"%s","tokens":%d,"shingles":%d}' "$VM_F_SIMHASH" "$VM_F_TOKENS" "$VM_F_SHINGLES"
    return 0
  fi
  printf '%s' 'input.text must be a string'
  return 1
}

# ------------------------------------------------------------------ protocol

vm_bad() {
  local idjson=$1
  local code=$2
  local msg=$3
  printf '{"id":%s,"ok":false,"error":{"code":%s,"message":%s}}\n' \
    "$idjson" "$(vm_json_encode "$code")" "$(vm_json_encode "$msg")"
}

# One JSON object per line in, one per line out, flushed as it is written (`printf` is a builtin and
# writes straight to the descriptor; there is no stdio buffer to fill, which is the trap section 1 of
# the contract describes for C).
vm_loop() {
  local line idjson=null op= input= out= status=0
  while IFS= read -r line; do
    case $line in
      *[![:space:]]*) ;;
      *) continue ;;
    esac
    idjson=null
    if vm_json_value "$line" id; then idjson=$VM_J_VAL; fi
    op=
    if vm_json_value "$line" op && vm_json_string "$VM_J_VAL"; then op=$VM_STR; fi
    case $op in
      shutdown)
        printf '{"id":%s,"ok":true}\n' "$idjson"
        return 0
        ;;
      describe)
        printf '{"id":%s,"ok":true,"worker":{"protocol":%d,"capability":%s,"language":%s,"impl":%s,"runtime":%s,"deterministic":true}}\n' \
          "$idjson" "$PROTOCOL" "$(vm_json_encode "$VMLTEXT_CAPABILITY")" "$(vm_json_encode "$LANGUAGE")" \
          "$(vm_json_encode "$IMPL")" "$(vm_json_encode "$RUNTIME")"
        ;;
      invoke)
        # The contract says a worker answers `unsupported` when it is asked for a capability it was not
        # launched for. This worker used to run whatever it had been launched with and report whatever
        # went wrong inside that, which is a wiring mistake dressed up as a bad request; the mismatch
        # probe in tools/workers.mjs asks this question of every implementation on every run, and it
        # named this one as soon as the worker stopped timing out.
        asked=
        if vm_json_value "$line" capability && vm_json_string "$VM_J_VAL"; then asked=$VM_STR; fi
        if [ -n "$asked" ] && [ "$asked" != "$VMLTEXT_CAPABILITY" ]; then
          vm_bad "$idjson" unsupported "this worker implements $VMLTEXT_CAPABILITY"
          continue
        fi
        input='{}'
        if vm_json_value "$line" input; then input=$VM_J_VAL; fi
        out=
        status=0
        case $VMLTEXT_CAPABILITY in
          text.normalize) out=$(vm_cap_normalize "$input") || status=1 ;;
          text.extract) out=$(vm_cap_extract "$input") || status=1 ;;
          text.fingerprint) out=$(vm_cap_fingerprint "$input") || status=1 ;;
        esac
        if [ "$status" -ne 0 ]; then
          vm_bad "$idjson" bad-input "$out"
        else
          printf '{"id":%s,"ok":true,"output":%s}\n' "$idjson" "$out"
        fi
        ;;
      '')
        vm_bad "$idjson" bad-input 'request is not JSON'
        ;;
      *)
        vm_bad "$idjson" unsupported "unknown op $op"
        ;;
    esac
  done
  return 0
}

# ------------------------------------------------------------------ self-check
#
# The contract's own edge rules, one English line each, on stdout (the reference writes its self-check
# to stderr, but a self-check whose report disappears when a harness captures only stdout is not
# evidence), and no protocol traffic at all in this mode.

VM_CHECKS=0
VM_PASSED=0

vm_check() {
  local name=$1
  local got=$2
  local want=$3
  VM_CHECKS=$((VM_CHECKS + 1))
  if [ "$got" = "$want" ]; then
    VM_PASSED=$((VM_PASSED + 1))
    printf '  [ok]   %s\n' "$name"
  else
    printf '  [FAIL] %s\n' "$name"
    printf '         expected [%s]\n' "$want"
    printf '         got      [%s]\n' "$got"
  fi
}

vm_selfcheck() {
  local once want
  printf 'vmltext.sh --selfcheck (%s, %s)\n' "$IMPL" "$RUNTIME"
  printf 'text.normalize\n'
  vm_normalize "$(vm_char 65313)$(vm_char 65314)$(vm_char 65315)$(vm_char 65297)$(vm_char 65298)$(vm_char 65299)"
  vm_check 'full-width ASCII becomes ASCII' "$VM_TEXT" 'abc123'
  vm_normalize 'Café Łódź'
  vm_check 'lowercase then fold, both tables' "$VM_TEXT" 'cafe lodz'
  vm_normalize "$(vm_char 101)$(vm_char 769)"
  vm_check 'a combining mark is deleted' "$VM_TEXT" 'e'
  vm_normalize "$(vm_char 97)$(vm_char 8203)$(vm_char 98)"
  vm_check 'a zero-width character is deleted' "$VM_TEXT" 'ab'
  vm_normalize '已经开播了 Привет مرحبا'
  vm_check 'CJK, Cyrillic and Arabic are untouched' "$VM_TEXT" '已经开播了 Привет مرحبا'
  vm_normalize '  a   b  '
  vm_check 'whitespace collapses and trims' "$VM_TEXT" 'a b'
  vm_normalize ''
  vm_check 'empty input stays empty' "$VM_TEXT" ''
  vm_normalize "$(vm_char 201)$(vm_char 32)$(vm_char 65281)"
  once=$VM_TEXT
  vm_normalize "$once"
  vm_check 'idempotent on its own output' "$VM_TEXT" "$once"
  printf 'text.extract\n'
  vm_extract '<p>a<b>b'
  vm_check 'a tag unclosed at EOF is dropped with its name' "$VM_X_TEXT" '
ab'
  vm_extract 'a &amp b &amp; c'
  vm_check 'entities decode with and without a semicolon' "$VM_X_TEXT" 'a & b & c'
  vm_extract "x &#8212; &#x2014; y"
  vm_check 'decimal and hex numeric references' "$VM_X_TEXT" "x $(vm_char 8212) $(vm_char 8212) y"
  vm_extract '<p>keep</p><script>var a=1</script>'
  vm_check 'a removed element goes with its content' "$VM_X_TEXT" '
keep
'
  vm_extract '<title>T &amp; U</title><p>b</p>'
  vm_check 'the title is decoded and kept out of the text' "$VM_X_TITLE|$VM_X_TEXT" 'T & U|
b
'
  vm_extract '<a href="x>y">z</a> <a href="https://e.com">m</a>'
  vm_check 'a quoted > does not end a tag; schemes mark absoluteness' "$VM_X_LINKSJSON" '{"href":"x>y","absolute":false,"text":"z"},{"href":"https://e.com","absolute":true,"text":"m"}'
  vm_extract '<img src=a><IMG src=b>'
  vm_check 'images are counted case-insensitively' "$VM_X_IMAGES" '2'
  vm_extract "<a href='/one'>one<a href='/two'>two"
  vm_check 'nested and unclosed anchors are both reported' "$VM_X_LINKSJSON" '{"href":"/one","absolute":false,"text":"one"},{"href":"/two","absolute":false,"text":"two"}'
  printf 'text.fingerprint\n'
  vm_fingerprint 'openai gpt 已经 已经'
  vm_check 'token and shingle counts' "$VM_F_TOKENS/$VM_F_SHINGLES" '4/2'
  vm_fingerprint 'hello, world.'
  vm_check 'edge punctuation is trimmed' "$VM_F_TOKENS" '2'
  vm_fingerprint '-- !!'
  vm_check 'punctuation-only tokens emit nothing' "$VM_F_TOKENS" '0'
  vm_fingerprint '已经开播'
  vm_check 'a four-character CJK run is three overlapping bigrams' "$VM_F_TOKENS" '3'
  vm_fingerprint ''
  vm_check 'empty text: no tokens, no shingles, all-zero hash' "$VM_F_TOKENS/$VM_F_SHINGLES/$VM_F_SIMHASH" '0/0/0000000000000000'
  vm_fingerprint 'x'
  vm_fnv1a_bytes 'x'
  want=$(printf '%08x%08x' "$VM_H_HI" "$VM_H_LO")
  vm_check 'one token hashes to the 64-bit FNV-1a of itself' "$VM_F_SIMHASH" "$want"
  printf '%d/%d checks passed\n' "$VM_PASSED" "$VM_CHECKS"
  [ "$VM_PASSED" -eq "$VM_CHECKS" ] || return 1
  return 0
}

# ------------------------------------------------------------------ main
#
# Guarded so that the file can be sourced for its functions (by a test, or by another script) without
# starting a protocol loop: sourcing leaves BASH_SOURCE[0] different from $0, exactly as in the
# reference implementation's `if (process.argv[1] && ...) main()`.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then

VMLTEXT_CAPABILITY=
VMLTEXT_MODE=loop
while [ "$#" -gt 0 ]; do
  case $1 in
    --capability)
      if [ "$#" -lt 2 ]; then
        printf 'vmltext.sh: --capability needs a name (text.normalize|text.extract|text.fingerprint)\n' >&2
        exit 2
      fi
      VMLTEXT_CAPABILITY=$2
      shift 2
      ;;
    --selfcheck)
      VMLTEXT_MODE=selfcheck
      shift
      ;;
    *)
      printf 'vmltext.sh: unexpected argument "%s"\n' "$1" >&2
      printf 'usage: vmltext.sh --capability <text.normalize|text.extract|text.fingerprint> [--selfcheck]\n' >&2
      exit 2
      ;;
  esac
done

if [ "$VMLTEXT_MODE" = selfcheck ]; then
  vm_selfcheck
  exit $?
fi

case $VMLTEXT_CAPABILITY in
  text.normalize|text.extract|text.fingerprint) ;;
  '')
    printf 'vmltext.sh: --capability is required (text.normalize|text.extract|text.fingerprint)\n' >&2
    exit 2
    ;;
  *)
    printf 'vmltext.sh: unknown capability "%s" (text.normalize|text.extract|text.fingerprint)\n' "$VMLTEXT_CAPABILITY" >&2
    exit 2
    ;;
esac

vm_loop
exit 0

fi
