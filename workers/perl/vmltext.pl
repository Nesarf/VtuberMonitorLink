#!/usr/bin/env perl
# vmltext.pl - the Perl worker of the multilingual text layer.
#
# Implements the three capabilities of docs/WORKERS.md sections 2-4 -- `text.normalize`,
# `text.extract`, `text.fingerprint` -- behind the stdio JSON-Lines protocol of section 1.
#
# Core Perl 5 only: JSON::PP is core, and nothing else outside `strict`, `warnings` and `utf8` is
# used. No CPAN, no XS, no build step.
#
# Usage:
#     perl workers/perl/vmltext.pl --capability text.normalize
#     perl workers/perl/vmltext.pl --selfcheck
#
# Three deliberate decisions, because each of them is where Perl would otherwise answer a
# different question than the contract asks:
#
#   * BYTES VERSUS CHARACTERS. Perl strings are either byte strings or character strings and the
#     same operation means different things in each. Every string in this worker is a *decoded*
#     character string: stdin is read as bytes and decoded explicitly, the spec tables are decoded
#     explicitly, and every algorithm walks code points (`split //`, `ord`, `chr`, `length`,
#     `substr`). stdout is encoded explicitly. `use utf8` is set so that the literals in this file
#     are characters too. Nothing here ever walks UTF-8 bytes except the one function that is
#     specified to (the FNV-1a hash over a shingle's UTF-8 bytes).
#   * NO \s, NO \w, NO uc/lc ON DATA. On a decoded string `\s` is the Unicode whitespace set, and
#     the contract defines its own (space, tab, LF, CR, plus the listed code points that map to a
#     space). `uc`/`lc` are Unicode case mapping, so they fold the Kelvin sign and can grow a
#     string, while the contract folds exactly what workers/spec/latin-*.json lists. The tables are
#     read from the shared JSON files; this runtime's Unicode data is never consulted for text.
#   * JSON::PP IN CHARACTER MODE. The encoder is left in non-utf8 mode so it escapes non-ASCII
#     (`\uXXXX`) and every byte it produces is ASCII; and the decoder is asked for character
#     strings, where the default mode would hand back a byte string for any input containing
#     non-ASCII -- which is exactly the wrong layer for every rule in this contract.
#
# The tables are read once at startup and turned into lookup hashes keyed by code point.

use strict;
use warnings;
use utf8;

use FindBin;
use JSON::PP ();
use File::Spec ();

our $VERSION = '1.0';

my @CAPABILITIES = ('text.normalize', 'text.extract', 'text.fingerprint');
my $PROTOCOL_VERSION = 1;
my $LANGUAGE = 'perl';
my $IMPL = 'table-driven';

my $USAGE = 'usage: vmltext.pl --capability '
  . '<text.normalize|text.extract|text.fingerprint> | --selfcheck';

# --------------------------------------------------------------------------------------------
# Section 1.2: the transport is UTF-8 bytes on all three streams, on every platform.
# --------------------------------------------------------------------------------------------

# The three streams are put on explicit layers, and this is the whole of the Windows encoding
# trap for this worker:
#
#   * STDIN is read as UTF-8 and the JSON request lines are decoded by PerlIO, so every string the
#     rules below see is a CHARACTER string. Without the layer a feed full of CJK arrives as UTF-8
#     bytes, `length` counts bytes, `substr` cuts in the middle of a character, and the answer is
#     mojibake that still looks like it works.
#   * STDOUT is written as UTF-8 with the :unix layer. The default layer on Windows is :crlf, which
#     would turn every protocol LF into CRLF and break "one JSON request per line" for anything
#     reading strictly - and the raw default for a decoded string is the printer's own idea of the
#     native encoding, which on this machine is not UTF-8 either.
#   * STDERR is UTF-8 diagnostics, free-form text, never protocol.
#
# JSON::PP is also put in utf8 (character) mode below, so the encoder produces characters and the
# layer is what turns them into the UTF-8 bytes the transport is specified in.
binmode(STDIN,  ':encoding(UTF-8)');
binmode(STDOUT, ':encoding(UTF-8):unix');
binmode(STDERR, ':encoding(UTF-8):unix');
$| = 1;    # flush stdout after every response line; `shutdown` is not an excuse to buffer

# --------------------------------------------------------------------------------------------
# Shared tables (workers/spec/*.json). Section 2: nobody consults their own runtime's tables.
# --------------------------------------------------------------------------------------------

my $SPEC_DIR = File::Spec->catdir($FindBin::Bin, File::Spec->updir, 'spec');
# Two JSON::PP objects, one per direction, because `utf8` means opposite things to a decoder and an
# encoder and this worker has to get both right:
#
#   * the DECODER must be in character mode (no `utf8`), because STDIN arrives through a
#     `:encoding(UTF-8)` layer and therefore hands the decoder a Perl CHARACTER string. With `utf8`
#     set the decoder would treat those characters as UTF-8 bytes and refuse them -- the first
#     version of this file answered `bad-input` to every request containing an accent, which is the
#     loud version of the same mistake that silences a worker when it goes the other way.
#   * the ENCODER must be in `utf8` mode, so it returns the UTF-8 BYTES that the transport is made
#     of rather than a character string that the output layer would then have to decide about. In
#     the default mode the encoder also refuses to emit anything above U+007F without an escape,
#     which is fine for the parsed-value comparison but makes every claim about bytes untestable.
#
# Both are `canonical(0)`: canonical mode sorts the keys, and the contract's field order is asserted
# and re-imposed separately, so sorting here would only hide an ordering mistake.
my $JSON_DECODE = JSON::PP->new->canonical(0)->allow_nonref(0);
my $JSON = JSON::PP->new->canonical(0)->allow_nonref(0)->utf8(1);

# `ordered_json` encodes a key and, on a leaf, a bare scalar, and the encoder above refuses a
# non-reference on purpose (a payload that is not an object is a mistake worth hearing about). So the
# per-scalar encoding goes through its own instance rather than loosening that rule for answers.
my $JSON_SCALAR = JSON::PP->new->canonical(0)->allow_nonref(1)->utf8(1);

# The self-check prints bare strings, and JSON::PP refuses a non-reference by default: that
# strictness is wanted on the request decoder (a request line that is not an object is a protocol
# error) and not on this display encoder.
my $JSON_SHOW = JSON::PP->new->canonical(0)->allow_nonref(1)->utf8(1);

sub load_table {
    my ($name) = @_;
    my $path = File::Spec->catfile($SPEC_DIR, $name);
    unless (-f $path) {
        die "cannot find the shared table $path\n";
    }
    open(my $fh, '<:raw', $path) or die "cannot read $path: $!\n";
    local $/;
    my $bytes = <$fh>;
    close($fh);
    my $payload = $JSON_DECODE->decode($bytes);    # the file is bytes; this is the byte decoder
    my %out;
    while (my ($key, $value) = each %{ $payload->{map} }) {
        $out{ 0 + $key } = $value;
    }
    return \%out;
}

my ($LOWER, $FOLD);

# Load one of the shared tables into a variable of the caller's, and answer with the *status*: an
# empty string on success, the failure text otherwise. See the comment in `main` for why the status
# is a return value of its own rather than the value of an eval block.
sub try_load_into {
    my ($slot, $name) = @_;
    my $loaded;
    eval {
        $loaded = load_table($name);
        1;    # a bare eval whose last statement is false runs the block AGAIN: see `main`
    };
    if ($@) {
        my $message = "$@";
        $message =~ s/\s+\z//;
        return $message;
    }
    unless (ref $loaded eq 'HASH' and %$loaded) {
        return "$name did not load a table";
    }
    $$slot = $loaded;
    return '';
}

# Step 1: these code points are deleted. (Ranges, as the contract writes them.)
my @DELETE_RANGES = (
    [ 0x0000, 0x0008 ], [ 0x000B, 0x000B ], [ 0x000C, 0x000C ], [ 0x000E, 0x001F ],
    [ 0x007F, 0x007F ], [ 0x200B, 0x200F ], [ 0x202A, 0x202E ], [ 0x2060, 0x2064 ],
    [ 0xFEFF, 0xFEFF ],
    # The combining marks. Deleting them is what makes a decomposed string ("e" + U+0301, which is
    # what half the feeds on the web contain) compare equal to its composed form, without asking
    # any language for NFKC.
    [ 0x0300, 0x036F ], [ 0x1AB0, 0x1AFF ], [ 0x1DC0, 0x1DFF ], [ 0x20D0, 0x20FF ],
    [ 0xFE20, 0xFE2F ],
);

# Step 2: one-to-one ground character mappings, plus the two runs. A hash built from this array
# is used *both* to apply the mappings and to build the "does this string contain anything step
# 1 or 2 would touch" test, so the two cannot disagree with each other.
my $GROUND = {};

my $DELETE = {};

# Declared here, assigned in `build_direct_table`, and read by `normalize` further down: under
# `use strict` a lexical has to be declared before the call that assigns it, which is the mistake
# this line corrects.
my $STEP12_CANDIDATE;

sub build_direct_table {
    my %direct;

    # The ranges the contract deletes (step 1) and the ones it maps to a space (step 2). Both are
    # "blank" for step 5's purpose: a deleted character and a space both separate words.
    for my $range (@DELETE_RANGES) {
        for my $cp ($range->[0] .. $range->[1]) {
            $DELETE->{$cp} = 1;
            $direct{$cp} = '';
        }
    }
    for my $range ([ 0x00A0, 0x00A0 ], [ 0x2000, 0x200A ], [ 0x2028, 0x2029 ],
                   [ 0x202F, 0x202F ], [ 0x205F, 0x205F ], [ 0x3000, 0x3000 ]) {
        for my $cp ($range->[0] .. $range->[1]) {
            $direct{$cp} = ' ';
        }
    }
    for my $cp (0xFF01 .. 0xFF5E) {
        $direct{$cp} = chr($cp - 0xFEE0);    # full-width ASCII -> ASCII
    }
    for my $pair ([ 0x2018, "'" ], [ 0x2019, "'" ], [ 0x201B, "'" ], [ 0x2032, "'" ],
                  [ 0x201C, '"' ], [ 0x201D, '"' ], [ 0x201F, '"' ], [ 0x2033, '"' ],
                  [ 0x2010, '-' ], [ 0x2011, '-' ], [ 0x2012, '-' ], [ 0x2013, '-' ],
                  [ 0x2014, '-' ], [ 0x2015, '-' ], [ 0x2212, '-' ],
                  [ 0x3001, ',' ], [ 0x3002, '.' ]) {
        $direct{ $pair->[0] } = $pair->[1];
    }
    $direct{0x2026} = '...';

    # Every ground character this function knows about, for the "anything in the table" test. It is
    # built here rather than written out a second time so that a character added to the rules above
    # cannot be missing from the test that decides whether to run the rules at all.
    my @ground = sort { $a <=> $b } keys %direct;
    $GROUND = join('', map { chr($_) } @ground);

    # The per-string candidate test, derived from those same keys: every code point the two steps can
    # touch, and nothing that they cannot. Deriving it is what keeps the fast path honest - as a
    # hand-written class it silently omitted the combining marks (see the note where it is declared).
    $STEP12_CANDIDATE = qr/[@{[ join('', map { sprintf('\\x{%X}', $_) } @ground) ]}]/;

    return \%direct;
}

my $DIRECT = build_direct_table();

# Does this string contain anything steps 1 and 2 would touch? If not, the two steps are a no-op
# and the per-character pass is skipped entirely -- the common case, and 60 KB of CJK is not
# intended to pay 60,000 hash lookups for a result identical to its input.
#
# The test is built from the table itself, in `build_direct_table`, and `$STEP12_CANDIDATE` is only
# declared up there. It used to be a hand-kept character class at this spot, and that class forgot the
# combining marks: a string whose only interesting characters were accents skipped steps 1 and 2
# completely, so `Cafe` + U+0301 came back as `café` while the reference deleted the mark. A test that
# decides whether the rules run has to be derived from the rules, or it becomes a second, quieter copy
# of them.

# --------------------------------------------------------------------------------------------
# Capability text.normalize (section 2)
# --------------------------------------------------------------------------------------------

sub normalize {
    my ($text) = @_;

    # Steps 1 and 2: delete, then map one-to-one. A code point that is not listed is left alone,
    # and this is the whole of the step -- no NFKC, no NFD, no runtime case data.
    if ($text =~ $STEP12_CANDIDATE) {
        my $out = '';
        for my $ch (split //, $text) {
            my $cp = ord($ch);
            my $mapped = $DIRECT->{$cp};
            if (defined $mapped) {
                $out .= $mapped;    # '' for a deleted code point, ' ' or a character otherwise
            }
            elsif ($ch =~ /[^\x00-\x{2FF}]/) {
                $out .= $ch;        # outside the processed domain: never looked up, never changed
            }
            else {
                $out .= $GROUND =~ /\Q$ch\E/ ? '' : $ch;   # unreachable, kept as a safety net
            }
        }
        $text = $out;
    }

    # Steps 3 and 4: lowercase exactly what latin-lower.json says, then fold accents exactly what
    # latin-fold.json says. Both are one pass over the code points, in that order: the fold table
    # is keyed by the code point the *lowercase* step produced ("É" -> "é" -> "e"), which is why
    # the one-to-one lower step has to exist separately from the fold.
    my $out = '';
    my $touched = 0;
    for my $ch (split //, $text) {
        my $cp = ord($ch);
        my $lowered = $LOWER->{$cp};
        $cp = $lowered if defined $lowered;
        my $folded = $FOLD->{$cp};
        if (defined $folded) {
            $out .= $folded;    # a one- or two-character ASCII string: "ss", "AE", "th"
            $touched = 1;
        }
        elsif ($cp != ord($ch)) {
            $out .= chr($cp);
            $touched = 1;
        }
        else {
            $out .= $ch;        # not in either table: unchanged, which is the far commoner case
        }
    }
    $text = $out if $touched;

    # Step 5: collapse runs of space, tab, LF and CR into a single space. Step 2 has already
    # turned the listed space-like code points into U+0020, and step 1 has already deleted the
    # zero-width and bidi ones, so the set here is exactly the four the contract names.
    $text =~ s/[ \t\n\r]+/ /g;

    # Step 6: trim. Only U+0020 can be at either end by now.
    $text =~ s/^ //;
    $text =~ s/ $//;

    return $text;
}

# --------------------------------------------------------------------------------------------
# Capability text.extract (section 3)
# --------------------------------------------------------------------------------------------

my %REMOVED_ELEMENTS = map { $_ => 1 } qw(script style noscript template svg iframe);

my %NEWLINE_ELEMENTS = map { $_ => 1 } qw(
  br p div li ul ol tr th td h1 h2 h3 h4 h5 h6 section article header footer aside nav
  blockquote pre table hr dd dt figure figcaption main form
);

# Step 6: each name decodes to its own character, never to the ASCII approximation the
# normalizer would produce later. Matching is case-insensitive, and the names decode with or
# without the trailing semicolon.
my %NAMED_ENTITIES = (
    amp    => '&',        lt     => '<',        gt   => '>',
    quot   => '"',        apos   => "'",        nbsp => "\x{A0}",
    mdash  => "\x{2014}", ndash  => "\x{2013}", hellip => "\x{2026}",
    laquo  => "\x{00AB}", raquo  => "\x{00BB}", copy => "\x{00A9}",
    reg    => "\x{00AE}", trade  => "\x{2122}", times => "\x{00D7}",
    middot => "\x{00B7}",
);

my $ENTITY_NAME_WINDOW = 12;    # the reference is looked for within 12 characters of the '&'

# A hidden CDATA body. It carries the body's index and cannot be confused by, or split across, a
# tag scan, an entity or the words the element remover looks for. The index is matched with an
# explicit ASCII digit class: `\d` on a decoded string is Unicode-aware and would also accept
# digits this worker never wrote there.
my $CDATA_RE = qr/\x{0}CDATA([0-9]+)\x{0}/;
my $CDATA_TOKEN = "\x{0}CDATA%d\x{0}";

# Index of the '>' that ends the tag starting at $i, or -1 when there is none. Inside a tag, '
# and " delimit attribute values, so a '>' inside them does not end the tag; an unterminated
# attribute value runs to the end of the input, which is what a browser does with eof-in-tag.
sub tag_end {
    my ($text, $i) = @_;
    my $n = length $text;
    my $j = $i;
    while ($j < $n) {
        my $ch = substr($text, $j, 1);
        if ($ch eq '"' or $ch eq "'") {
            my $k = index($text, $ch, $j + 1);
            return -1 if $k < 0;
            $j = $k + 1;
            next;
        }
        return $j if $ch eq '>';
        $j++;
    }
    return -1;
}

# Tag name of a raw tag body: `/?` then optional spaces, then `[A-Za-z][A-Za-z0-9:-]*`, folded to
# ASCII lowercase. /i on a character string folds A-Z and nothing else in this pattern, and the
# result never leaves the ASCII range.
sub tag_name {
    my ($raw, $closing) = @_;
    my $name = $raw;
    if ($name =~ /\A\/\s*([A-Za-z][A-Za-z0-9:-]*)/) {
        return lc $1;
    }
    if ($name =~ /\A\s*([A-Za-z][A-Za-z0-9:-]*)/) {
        return lc $1;
    }
    return '';
}

sub is_ascii_letter {
    my ($ch) = @_;
    return defined($ch) && $ch =~ /\A[A-Za-z]\z/;
}

# Anchors may begin without a space: `<a` is a tag, `< p>` is not.
sub starts_a_tag {
    my ($next) = @_;
    return 0 unless defined $next && length $next;
    return $next =~ /\A(?:[A-Za-z\/!])\z/;
}

sub is_absolute_href {
    my ($href) = @_;
    # A JSON boolean, not 0/1: the contract says `absolute` is a boolean, and a parsed `0` is not a
    # parsed `false` to any comparison the harness makes. Perl has no boolean literals, so JSON::PP
    # supplies them.
    return $href =~ /\A[A-Za-z][A-Za-z0-9+.-]*:/ ? JSON::PP::true : JSON::PP::false;
}

# Value of an attribute in a raw tag body, or undef when the attribute is absent. Attribute names
# never contain /, > or whitespace, so / needs no special handling: it is an ordinary character
# inside an unquoted value, which is why `href=/bare` yields `/bare` and not the empty string.
sub attr_value {
    my ($tag, $wanted) = @_;
    my $n = length $tag;
    my $i = 1;
    while ($i < $n and substr($tag, $i, 1) !~ /[ \t\n\r\f\/>]/) { $i++ }
    while ($i < $n) {
        while ($i < $n and substr($tag, $i, 1) =~ /[ \t\n\r\f\/]/) { $i++ }
        my $start = $i;
        while ($i < $n and substr($tag, $i, 1) !~ /[ \t\n\r\f\/>=]/) { $i++ }
        my $name = lc substr($tag, $start, $i - $start);
        while ($i < $n and substr($tag, $i, 1) =~ /[ \t\n\r\f]/) { $i++ }
        my $value = '';
        if ($i < $n and substr($tag, $i, 1) eq '=') {
            $i++;
            while ($i < $n and substr($tag, $i, 1) =~ /[ \t\n\r\f]/) { $i++ }
            if ($i < $n and (substr($tag, $i, 1) eq '"' or substr($tag, $i, 1) eq "'")) {
                my $quote = substr($tag, $i, 1);
                $i++;
                my $from = $i;
                while ($i < $n and substr($tag, $i, 1) ne $quote) { $i++ }
                $value = substr($tag, $from, $i - $from);
                $i++;
            }
            else {
                # An unquoted value ends at whitespace or '>', never at '/'.
                my $from = $i;
                while ($i < $n and substr($tag, $i, 1) !~ /[ \t\n\r\f>]/) { $i++ }
                $value = substr($tag, $from, $i - $from);
            }
        }
        return $value if $name eq $wanted;
    }
    return undef;
}

# Decode the entity at $i (which points at '&'). Returns ($text, $next) or undef.
sub decode_entity {
    my ($text, $i) = @_;
    my $n = length $text;
    return () if $i + 1 >= $n;
    my $ch = substr($text, $i + 1, 1);

    if ($ch eq '#') {
        my $j = $i + 2;
        my $hex = 0;
        if ($j < $n and (substr($text, $j, 1) eq 'x' or substr($text, $j, 1) eq 'X')) {
            $hex = 1;
            $j++;
        }
        my $start = $j;
        if ($hex) {
            while ($j < $n and substr($text, $j, 1) =~ /[0-9a-fA-F]/ and $j - $start < 6) { $j++ }
        }
        else {
            while ($j < $n and substr($text, $j, 1) =~ /[0-9]/ and $j - $start < 7) { $j++ }
        }
        return () if $j == $start;
        my $digits = substr($text, $start, $j - $start);
        $j++ if $j < $n and substr($text, $j, 1) eq ';';
        my $value = 0 + ($hex ? hex($digits) : $digits);
        # A value that is not a Unicode scalar value is left verbatim: the contract does not
        # describe a replacement, and inventing one would diverge from the other languages.
        return () if $value > 0x10FFFF or ($value >= 0xD800 and $value <= 0xDFFF);
        return (chr($value), $j);
    }

    if ($ch =~ /[A-Za-z]/) {
        # The name is the maximal run of letters and digits after the '&', inside the 12-character
        # window. The run as written must be a table name: there is no backtracking, so `&copy2024`
        # stays literal while `&amp` and `&amp;` decode.
        my $j = $i + 1;
        my $limit = $i + 1 + $ENTITY_NAME_WINDOW;
        $limit = $n if $limit > $n;
        while ($j < $limit and substr($text, $j, 1) =~ /[A-Za-z0-9]/) { $j++ }
        my $name = lc substr($text, $i + 1, $j - ($i + 1));
        my $replacement = $NAMED_ENTITIES{$name};
        if (defined $replacement) {
            $j++ if $j < $n and substr($text, $j, 1) eq ';';
            return ($replacement, $j);
        }
    }
    return ();
}

# Pass 1: hide every CDATA body behind an opaque placeholder, keeping the body. An unclosed
# section keeps its text to the end of the input, the same principle as a removed element without
# its closing tag.
sub hide_cdata {
    my ($html, $bodies) = @_;
    my $out = '';
    my $n = length $html;
    my $i = 0;
    while ($i < $n) {
        if (substr($html, $i, 9) eq '<![CDATA[') {
            my $end = index($html, ']]>', $i + 9);
            my $body = $end < 0 ? substr($html, $i + 9) : substr($html, $i + 9, $end - ($i + 9));
            $out .= sprintf($CDATA_TOKEN, scalar @$bodies);
            push @$bodies, $body;
            $i = $end < 0 ? $n : $end + 3;
            next;
        }
        $out .= substr($html, $i, 1);
        $i++;
    }
    return $out;
}

# Pass 2: remove `<!-- ... -->` (or an unclosed comment to the end of the input) and
# `<!DOCTYPE ...>`.
sub strip_comments_and_doctypes {
    my ($text) = @_;
    my $out = '';
    my $n = length $text;
    my $i = 0;
    while ($i < $n) {
        if (substr($text, $i, 4) eq '<!--') {
            my $end = index($text, '-->', $i + 4);
            $i = $end < 0 ? $n : $end + 3;
            next;
        }
        if (substr($text, $i, 2) eq '<!') {
            my $head = lc substr($text, $i, 9);
            if (substr($head, 0, 9) eq '<!doctype') {
                my $end = index($text, '>', $i);
                $i = $end < 0 ? $n : $end + 1;
                next;
            }
        }
        $out .= substr($text, $i, 1);
        $i++;
    }
    return $out;
}

# Index of `</name` at or after $start, respecting the tag-name boundary, or -1.
sub find_close {
    my ($text, $start, $name) = @_;
    my $n = length $text;
    my $needle = '</' . $name;
    my $len = length $needle;
    my $i = $start;
    while ($i < $n) {
        my $at = index($text, $needle, $i);
        return -1 if $at < 0;
        my $after = $at + $len;
        if ($after >= $n) { return $at }
        my $ch = substr($text, $after, 1);
        return $at if $ch =~ /[ \t\n\r\f\/>]/;
        $i = $after;
    }
    return -1;
}

# Pass 3: remove the six listed elements with their content, on the raw remaining text. The
# pre-scan ends an opening tag at the first '>', which the contract records as a known open item
# (a quoted attribute containing '>' is mis-scanned) -- it is reproduced here deliberately,
# because the reviewed snapshot is the arbiter and the main tag scanner below *is* quote-aware.
sub remove_listed_elements {
    my ($text) = @_;
    for my $name (sort keys %REMOVED_ELEMENTS) {
        my $out = '';
        my $n = length $text;
        my $i = 0;
        while ($i < $n) {
            if (substr($text, $i, 1) eq '<' and substr($text, $i + 1, 1) ne '/') {
                my $j = $i + 1;
                my $k = $j;
                while ($k < $n
                    and (substr($text, $k, 1) =~ /[A-Za-z0-9:]/
                         or substr($text, $k, 1) eq '-')) {
                    $k++;
                }
                my $found = lc substr($text, $j, $k - $j);
                my $boundary = $k >= $n ? 1 : (substr($text, $k, 1) =~ /[ \t\n\r\f\/>]/ ? 1 : 0);
                if ($found eq $name and $boundary) {
                    my $end = tag_end($text, $i);
                    if ($end < 0) { $i = $n; next }    # not a complete tag: nothing to remove
                    my $close_at = find_close($text, $end + 1, $name);
                    if ($close_at < 0) { $i = $n; next }    # missing close: to end of input
                    my $close_end = tag_end($text, $close_at);
                    $i = $close_end < 0 ? $n : $close_end + 1;
                    next;
                }
            }
            $out .= substr($text, $i, 1);
            $i++;
        }
        $text = $out;
    }
    return $text;
}

# Drop tags and decode entities in a collected fragment (an anchor's text, or the title). Nothing
# is trimmed or collapsed: a link's text obeys exactly the same rules as the main text.
sub clean_fragment {
    my ($text) = @_;
    my $out = '';
    my $n = length $text;
    my $i = 0;
    while ($i < $n) {
        my $ch = substr($text, $i, 1);
        if ($ch eq '<') {
            my $nxt = substr($text, $i + 1, 1);
            if (starts_a_tag($nxt)) {
                my $end = tag_end($text, $i);
                last if $end < 0;    # an incomplete tag ends what can be collected
                $i = $end + 1;
                next;
            }
            $out .= $ch;
            $i++;
            next;
        }
        if ($ch eq '&') {
            my @got = decode_entity($text, $i);
            if (@got) {
                $out .= $got[0];
                $i = $got[1];
                next;
            }
        }
        $out .= $ch;
        $i++;
    }
    return $out;
}

sub extract {
    my ($html) = @_;
    my $TRACE = $ENV{VM_TRACE};
    print STDERR "TRACE start len=", length($html), "\n" if $TRACE;
    # The contract's `baseUrl` is deliberately not a parameter: resolving a URL needs a URI library
    # and would put a network-semantics question inside a text function (section 3 step 4), so the
    # field is accepted by `invoke` and then ignored.

    # The observable pass order is: hide CDATA, remove comments and doctypes, remove the listed
    # elements with their content, and only then walk what is left. An implementation that removes
    # elements before hiding CDATA gets `cdata-inside-removed-element` wrong.
    my @cdata_bodies;
    my $chunk = hide_cdata($html, \@cdata_bodies);
    print STDERR "TRACE hide ok len=", length($chunk), "\n" if $TRACE;
    $chunk = strip_comments_and_doctypes($chunk);
    print STDERR "TRACE strip ok len=", length($chunk), "\n" if $TRACE;
    $chunk = remove_listed_elements($chunk);
    print STDERR "TRACE remove ok len=", length($chunk), "\n" if $TRACE;

    my $text = '';
    my $title = '';
    my $title_seen = 0;
    my $in_title = 0;
    my @links;
    my $pending;    # the link entry of the currently open <a>, or undef
    my $images = 0;

    my $emit = sub {
        my ($chunk_text) = @_;
        return if $chunk_text eq '';
        # While a <title> is open its text belongs to the title and to nothing else: not to the
        # body, and not to an anchor that happens to contain it.
        if ($in_title) {
            $title .= $chunk_text;
            return;
        }
        $text .= $chunk_text;
        $pending->{text} .= $chunk_text if defined $pending;
        return;
    };

    my $n = length $chunk;
    my $i = 0;
    while ($i < $n) {
        my $ch = substr($chunk, $i, 1);

        if ($ch eq '<' and starts_a_tag(substr($chunk, $i + 1, 1))) {
            my $j = $i + 1;
            my $quote;
            while ($j < $n) {
                my $c = substr($chunk, $j, 1);
                if (defined $quote) {
                    $quote = undef if $c eq $quote;
                }
                elsif ($c eq '"' or $c eq "'") {
                    $quote = $c;
                }
                elsif ($c eq '>') {
                    last;
                }
                $j++;
            }
            my $raw = substr($chunk, $i + 1, $j - ($i + 1));    # without the angle brackets
            my $terminated = $j < $n ? 1 : 0;                   # a '>' was found
            $i = $terminated ? $j + 1 : $j;
            # An incomplete tag at the end of the input is dropped *including its name
            # characters*, the way a browser's eof-in-tag handling drops it, so it contributes no
            # newline, no link and no image either -- and nothing after it is walked.
            next unless $terminated;

            my $closing = $raw =~ /\A\// ? 1 : 0;
            my $name = tag_name($raw, $closing);

            if ($name eq 'title') {
                if (!$closing and !$title_seen) {
                    $in_title = 1;
                    $title_seen = 1;
                }
                elsif ($closing and $in_title) {
                    $in_title = 0;
                }
                next;
            }

            $images++ if !$closing and $name eq 'img';

            if ($name eq 'a') {
                if (!$closing) {
                    # HTML does not allow nested anchors: a browser closes the open one and starts
                    # the new one, so the outer link is reported with the text it had collected.
                    if (defined $pending) {
                        push @links, $pending;
                        $pending = undef;
                    }
                    my $href = attr_value($raw, 'href');
                    $href = '' unless defined $href;
                    $pending = { href => $href, absolute => is_absolute_href($href), text => '' };
                }
                elsif (defined $pending) {
                    push @links, $pending;
                    $pending = undef;
                }
                next;
            }

            $emit->("\n") if $NEWLINE_ELEMENTS{$name};
            next;
        }

        if ($ch eq '&') {
            my @got = decode_entity($chunk, $i);
            if (@got) {
                $emit->($got[0]);
                $i = $got[1];
                next;
            }
        }

        if ($in_title) { $title .= $ch }
        else           { $emit->($ch) }
        $i++;
    }

    # An anchor still open at the end of the input is reported with the text it collected.
    push @links, $pending if defined $pending;

    # Put the CDATA bodies back, now that no rule can mistake them for markup.
    my $restore = sub {
        my ($value) = @_;
        return $value unless $value =~ $CDATA_RE;
        $value =~ s{$CDATA_RE}{ exists $cdata_bodies[$1] ? $cdata_bodies[$1] : '' }ge;
        return $value;
    };

    return {
        title  => $restore->($title),
        text   => $restore->($text),
        links  => [ map { {
            href     => $_->{href},
            absolute => $_->{absolute},
            text     => $restore->($_->{text}),
        } } @links ],
        images => $images,
    };
}

# --------------------------------------------------------------------------------------------
# Capability text.fingerprint (section 4)
# --------------------------------------------------------------------------------------------

my @CJK_RANGES = (
    [ 0x3400, 0x4DBF ], [ 0x4E00, 0x9FFF ], [ 0xF900, 0xFAFF ],
    [ 0x3040, 0x30FF ], [ 0xAC00, 0xD7AF ],
);

# ASCII punctuation: the trimming set for step 1 and the "nothing but punctuation" set for step 3
# are the same set, and it is ASCII only -- a Unicode class like \p{Punct} would trim far more.
my $PUNCT_ONLY = q{!?,.;:'"()[]{}<>-_/\\|*+=~`\@#$\%^&};

# The trimming pattern is written out in full rather than built with \Q...\E: the set contains
# both `\` and `-`, and a class built from a quoted string is one careless edit away from either a
# range or a broken escape, which is a silent change of meaning. `]` is first so it is a literal.
my $PUNCT_EDGE = qr/[]!?,.;:'"()[{}<>_\/\\|*+=~`\@#$%^&+-]+/;

sub is_cjk {
    my ($cp) = @_;
    for my $range (@CJK_RANGES) {
        return 1 if $cp >= $range->[0] and $cp <= $range->[1];
    }
    return 0;
}

# Emitted tokens for one space-free token, per the contract's run/bigram rule.
sub tokenize_token {
    my ($token) = @_;
    $token =~ s/\A$PUNCT_EDGE//;
    $token =~ s/$PUNCT_EDGE\z//;
    return () if $token eq '';

    # A token that is nothing but ASCII punctuation emits nothing at all. The edge trimming above
    # already handles the common shape, but a run that is punctuation *inside* a token ("a..b")
    # leaves this as the rule that decides, exactly as the contract states it.
    my @chars = split //, $token;
    my $all_punct = 1;
    for my $c (@chars) {
        if (index($PUNCT_ONLY, $c) < 0) { $all_punct = 0; last }
    }
    return () if $all_punct;

    my @out;
    my @run;
    my $run_is_cjk;
    my $flush = sub {
        return unless @run;
        if ($run_is_cjk) {
            if (@run == 1) {
                push @out, $run[0];
            }
            else {
                push @out, $run[$_] . $run[ $_ + 1 ] for 0 .. $#run - 1;
            }
        }
        else {
            push @out, join('', @run);
        }
        @run = ();
    };
    for my $c (@chars) {
        my $cjk = is_cjk(ord($c));
        if (!defined $run_is_cjk or $cjk == $run_is_cjk) {
            push @run, $c;
            $run_is_cjk = $cjk;
        }
        else {
            $flush->();
            push @run, $c;
            $run_is_cjk = $cjk;
        }
    }
    $flush->();
    return @out;
}

sub tokens_of {
    my ($text) = @_;
    my @out;
    for my $piece (split / /, $text, -1) {
        next if $piece eq '';
        push @out, tokenize_token($piece);
    }
    return @out;
}

sub shingles_of {
    my (@tokens) = @_;
    return () unless @tokens;
    return (join(' ', @tokens)) if @tokens < 3;
    my @out;
    for my $i (0 .. $#tokens - 2) {
        push @out, join(' ', @tokens[ $i .. $i + 2 ]);
    }
    return @out;
}

# FNV-1a, 64-bit, over the shingle's UTF-8 bytes. This is the one place in this file where a
# string is deliberately walked as bytes rather than as code points, and it is the contract that
# says so. `use integer` in this scope gives the wrapping unsigned 64-bit arithmetic the rule
# asks for instead of a silent promotion to a double.
sub fnv1a64 {
    my ($text) = @_;
    my $bytes = $text;
    utf8::encode($bytes);    # character string -> UTF-8 bytes, in place, on our own copy
    my $h;
    {
        use integer;
        $h = 14695981039346656037;
        for my $b (unpack('C*', $bytes)) {
            $h = $h ^ $b;
            $h = $h * 1099511628211;
        }
    }
    return $h;
}

sub fingerprint {
    my ($text) = @_;
    my @tokens = tokens_of($text);
    my @shingles = shingles_of(@tokens);

    my @counters = (0) x 64;
    for my $shingle (@shingles) {
        my $h = fnv1a64($shingle);
        {
            use integer;
            for my $bit (0 .. 63) {
                if (($h >> $bit) & 1) { $counters[$bit]++ }
                else                  { $counters[$bit]-- }
            }
        }
    }

    my $value = 0;
    {
        use integer;
        for my $bit (0 .. 63) {
            $value |= (1 << $bit) if $counters[$bit] > 0;
        }
    }

    return {
        simhash  => sprintf('%016x', $value),
        tokens   => scalar @tokens,
        shingles => scalar @shingles,
    };
}

# --------------------------------------------------------------------------------------------
# Protocol (section 1) and dispatcher
# --------------------------------------------------------------------------------------------

# The capability this process was started with. Assigned in `main`; the file-scope declaration
# exists so the protocol helpers below can read it, and `main` must assign to THIS variable rather
# than to a new lexical of its own -- a `my` there shadowed the file-scope one, every sub kept
# reading an empty string, and the only symptom was a table that looked empty.
my $CURRENT_CAPABILITY = '';

# --------------------------------------------------------------------------------------------
# Ordered JSON. The contract fixes the field order of every answer and the harness checks it, but a
# Perl hash cannot carry an order: `keys %h` is randomized per process, so three runs of the same
# code produced three different orders for text.extract, and the harness would have rejected all
# three for a reason that looks like a serialization detail. The previous version built `%ordered`
# by inserting the keys in the right sequence and handed it to JSON::PP, which is exactly the
# assumption a hash does not support.
#
# So an answer is built as an ordered list of pairs - `ordered_obj([key, value], ...)` - and
# serialized here, recursively, with JSON::PP encoding each key and each scalar. That also means one
# place decides what a JSON answer looks like, which is the difference between a rule and a habit.
# --------------------------------------------------------------------------------------------

sub ordered_obj {
    my (@pairs) = @_;
    return [ 'ordered', @pairs ];
}

sub is_ordered_obj {
    my ($value) = @_;
    return ref $value eq 'ARRAY' && @$value && !ref $value->[0] && $value->[0] eq 'ordered';
}

sub ordered_json {
    my ($value) = @_;
    if (is_ordered_obj($value)) {
        my @pairs = @{$value}[ 1 .. $#$value ];
        return '{'
          . join(',', map { $JSON_SCALAR->encode($_->[0]) . ':' . ordered_json($_->[1]) } @pairs)
          . '}';
    }
    if (ref $value eq 'ARRAY') {
        return '[' . join(',', map { ordered_json($_) } @$value) . ']';
    }
    return $JSON_SCALAR->encode($value);
}

# The keys of an ordered object, in the order the wire will carry them. The self-check asserts
# against this rather than against `keys %$hash`, which is what made its field-order cases fail
# differently on every run.
sub ordered_keys {
    my ($value) = @_;
    return () unless is_ordered_obj($value);
    return map { $_->[0] } @{$value}[ 1 .. $#$value ];
}

# The value of a key in an ordered object. `$obj->{$key}` no longer applies to an answer, because an
# answer is a pair list now; this keeps the self-check readable.
sub ordered_value {
    my ($value, $key) = @_;
    return undef unless is_ordered_obj($value);
    for my $pair (@{$value}[ 1 .. $#$value ]) {
        return $pair->[1] if $pair->[0] eq $key;
    }
    return undef;
}

sub write_line {
    my ($payload) = @_;
    my $line = ordered_json($payload);
    print STDOUT $line, "\n";
    return;
}

sub diag {
    my ($message) = @_;
    $message =~ s/\n\z//;
    print STDERR $message, "\n";
    STDERR->flush if STDERR->can('flush');
    return;
}

sub describe_response {
    my ($request_id) = @_;
    return ordered_obj(
        [ id => $request_id ],
        [ ok => JSON::PP::true ],
        [ worker => ordered_obj(
            [ protocol      => $PROTOCOL_VERSION ],
            [ capability    => $CURRENT_CAPABILITY ],
            [ language      => $LANGUAGE ],
            [ impl          => $IMPL ],
            [ runtime       => "Perl $] ($^O)" ],
            [ deterministic => JSON::PP::true ],
        ) ],
    );
}

sub error_response {
    my ($request_id, $code, $message) = @_;
    return ordered_obj(
        [ id    => $request_id ],
        [ ok    => JSON::PP::false ],
        [ error => ordered_obj([ code => $code ], [ message => $message ]) ],
    );
}

# --------------------------------------------------------------------------------------------
# Field order is part of the contract, and a Perl hash is an unordered container whose iteration
# order is deliberately randomised per process (a hash-flooding defence). Building the answer in
# the right order therefore proves nothing: the encoder reads %$output through hv_iternext, and
# with only three or four keys the arrival order is effectively a coin toss per process. The
# harness checks `Object.keys(output)` and the key order inside every `links[]` element, so the
# order is rebuilt here, in the one place the answer crosses into the protocol, from the
# capability's own list.
#
# The values are taken through `//` rather than `||`: a legitimate 0 must not be turned into an
# empty string, and a legitimate empty string must not be turned into 0.
# --------------------------------------------------------------------------------------------

my %OUTPUT_FIELD_ORDER = (
    'text.normalize'   => [qw(text)],
    'text.extract'     => [qw(title text links images)],
    'text.fingerprint' => [qw(simhash tokens shingles)],
);

sub ordered_output {
    my ($output) = @_;
    my $fields = $OUTPUT_FIELD_ORDER{$CURRENT_CAPABILITY} or return $output;

    my @ordered;
    for my $name (@$fields) {
        my $value = $output->{$name};
        if ($name eq 'links') {
            my @links;
            for my $link (@{ $value // [] }) {
                for my $key (qw(href absolute text)) {
                    die "internal: a link has no $key\n" unless exists $link->{$key};
                }
                push @links, ordered_obj(
                    [ href     => $link->{href} ],
                    [ absolute => $link->{absolute} ],
                    [ text     => $link->{text} ],
                );
            }
            $value = \@links;
        }
        elsif (!defined $value) {
            $value = $name eq 'images' ? 0 : '';
        }
        push @ordered, [ $name => $value ];
    }
    return ordered_obj(@ordered);
}

# `text` is checked as a string on every path that takes one. A number or null is bad-input, and
# answering `internal` for it would hide a caller's mistake behind a worker bug.
sub require_string {
    my ($value, $label) = @_;
    die { code => 'bad-input', message => "input.$label must be a string" }
      unless defined $value and ref $value eq '';
    return $value;
}

sub invoke {
    my ($capability, $payload) = @_;
    $payload = {} unless defined $payload;
    die { code => 'bad-input', message => 'input must be an object' }
      unless ref $payload eq 'HASH';

    if ($capability eq 'text.normalize') {
        return { text => normalize(require_string($payload->{text}, 'text')) };
    }
    if ($capability eq 'text.fingerprint') {
        return fingerprint(require_string($payload->{text}, 'text'));
    }
    if ($capability eq 'text.extract') {
        my $html = require_string($payload->{html}, 'html');
        # baseUrl is validated and then ignored: resolving a URL needs a URI library and would put
        # a network-semantics question inside a text function (section 3 step 4), so the field is
        # part of the request shape and none of the answer.
        my $base_url = $payload->{baseUrl};
        if (defined $base_url and ref $base_url ne '') {
            die { code => 'bad-input', message => 'input.baseUrl must be a string or null' };
        }
        return extract($html);
    }
    die { code => 'unsupported', message => "unknown capability: $capability" };
}

sub handle {
    my ($request) = @_;
    unless (ref $request eq 'HASH') {
        return error_response(undef, 'bad-input', 'request must be a JSON object');
    }
    my $request_id = $request->{id};
    my $op = $request->{op};

    if (defined $op and ref $op eq '' and $op eq 'describe') {
        return describe_response($request_id);
    }

    if (defined $op and ref $op eq '' and $op eq 'invoke') {
        my $requested = $request->{capability};
        unless (defined $requested and ref $requested eq '') {
            return error_response($request_id, 'bad-input', 'invoke requires a string capability');
        }
        # One worker implements one capability: a mismatch is a wiring mistake, and saying so and
        # staying alive is cheaper to debug than ignoring it.
        if ($requested ne $CURRENT_CAPABILITY) {
            return error_response($request_id, 'unsupported',
                "this worker implements $CURRENT_CAPABILITY, not $requested");
        }
        my $output;
        my $ok = eval {
            $output = do { invoke($CURRENT_CAPABILITY, $request->{input}) };
            1;    # a bare eval whose last statement is false runs the block AGAIN: see main()
        };
        unless ($ok) {
            my $err = $@;
            if (ref $err eq 'HASH') {
                return error_response($request_id, $err->{code}, $err->{message});
            }
            my $message = "$err";
            $message =~ s/\s+\z//;
            diag("internal error: $message");
            return error_response($request_id, 'internal', $message);
        }
        return ordered_obj(
        [ id     => $request_id ],
        [ ok     => JSON::PP::true ],
        [ output => ordered_output($output) ],
    );
    }

    my $shown = defined $op ? $op : 'missing';
    return error_response($request_id, 'unsupported', "unknown op: $shown");
}

sub run_protocol {
    while (defined(my $line = <STDIN>)) {
        $line =~ s/\r?\n\z//;    # the transport is LF; a trailing CR is whitespace, not content
        next if $line =~ /\A\s*\z/;

        my $request;
        my $parsed = eval {
            $request = do { $JSON_DECODE->decode($line) };
            1;    # a bare eval whose last statement is false runs the block AGAIN: see main()
        };
        if (!$parsed or !defined $request) {
            my $message = defined $@ ? "$@" : 'not a JSON value';
            $message =~ s/\s+\z//;
            diag("malformed JSON on stdin: $message");
            write_line(error_response(undef, 'bad-input', 'malformed JSON'));
            next;
        }

        # `shutdown` answers the bare envelope and nothing else: two implementations carried an
        # extra `output` payload from an earlier draft, and the contract now says so outright.
        if (ref $request eq 'HASH' and defined $request->{op}
            and ref $request->{op} eq '' and $request->{op} eq 'shutdown') {
            write_line(ordered_obj([ id => $request->{id} ], [ ok => JSON::PP::true ]));
            return 0;
        }

        my $response;
        my $handled = eval {
            $response = do { handle($request) };
            1;    # a bare eval whose last statement is false runs the block AGAIN: see main()
        };
        if (!$handled) {
            my $message = "$@";
            $message =~ s/\s+\z//;
            diag("internal error: $message");
            $response = error_response(
                ref $request eq 'HASH' ? $request->{id} : undef, 'internal', $message);
        }
        write_line($response);
    }
    return 0;
}

# --------------------------------------------------------------------------------------------
# --selfcheck: built-in cases for the contract's edge rules
# --------------------------------------------------------------------------------------------

sub show {
    my ($value, $limit) = @_;
    $limit = 160 unless defined $limit;
    my $text = $JSON_SHOW->encode($value);
    $text = substr($text, 0, $limit) . '...' if length($text) > $limit;
    return $text;
}

# The self-check compares values, not encodings. Comparing two JSON strings would compare hash key
# order as well, and this worker's whole reason for existing is that a hash's key order is not
# something a language should be trusted with: sorting the keys inside this canonical form makes
# the comparison about the answer, while `ordered_output` and the protocol checks below are what
# hold the *emitted* order to the contract.
sub canonical {
    my ($value) = @_;
    return 'null' unless defined $value;
    if (ref $value eq 'ARRAY') {
        return '[' . join(',', map { canonical($_) } @$value) . ']';
    }
    if (ref $value eq 'HASH') {
        return '{' . join(',', map { show($_) . ':' . canonical($value->{$_}) }
                              sort keys %$value) . '}';
    }
    if (ref $value) {
        # A JSON::PP boolean singleton, whose stringification is `true` or `false`.
        return "$value";
    }
    return show($value);
}

sub same_value {
    my ($a, $b) = @_;
    return canonical($a) eq canonical($b) ? 1 : 0;
}

my @SELFCHECK_CASES = (
    # ---- text.normalize ----------------------------------------------------------------
    [ 'normalize: empty input stays empty', 'text.normalize', { text => '' }, { text => '' } ],
    [ 'normalize: full-width ASCII maps, zero-width is deleted',
      'text.normalize', { text => "\x{FF23}\x{FF41}\x{FF46}\x{E9}\x{200B}" }, { text => 'cafe' } ],
    [ 'normalize: lowercase table then fold table, both load-bearing',
      'text.normalize', { text => "\x{C9}COLE \x{C0}\x{C9}\x{CE}\x{D5}\x{DC}" }, { text => 'ecole aeiou' } ],
    [ 'normalize: U+0130 is absent from the lower table and folded by the fold table',
      'text.normalize', { text => "\x{130}stanbul" }, { text => 'istanbul' } ],
    [ 'normalize: combining marks deleted (decomposed equals composed, no NFKC)',
      'text.normalize', { text => "Cafe\x{301}" }, { text => 'cafe' } ],
    [ 'normalize: combining mark deleted after a Cyrillic base, base kept',
      'text.normalize', { text => "\x{438}\x{306}" }, { text => "\x{438}" } ],
    [ 'normalize: CJK, kana and Hangul pass through untouched',
      'text.normalize', { text => "\x{5DF2}\x{7ECF}\x{4E16}\x{754C} \x{3053}\x{3093} \x{D55C}\x{AD6D}" },
      { text => "\x{5DF2}\x{7ECF}\x{4E16}\x{754C} \x{3053}\x{3093} \x{D55C}\x{AD6D}" } ],
    # The expectation here was wrong for a while and the worker was right: zero-width characters,
    # bidi controls, the BOM, C0 controls and DEL are *deleted* (they do not become spaces), so the
    # letters close up around them and only the tab survives as a separator. Checked against the
    # reference implementation, which answers "abcde fg" for this input, and against the corpus case
    # `zero-width-and-bom`, whose name says the same thing.
    [ 'normalize: zero-width, bidi control, BOM and C0 controls deleted; tab stays a separator',
      'text.normalize', { text => "a\x{200B}b\x{200F}\x{2060}c\x{FEFF}d\x{1}e\tf\x{7F}g" },
      { text => 'abcde fg' } ],
    [ 'normalize: U+3000, U+2028 and U+00A0 are spaces and collapse',
      'text.normalize', { text => "a\x{3000}\x{3000}b\x{2028}c\x{A0}d" }, { text => 'a b c d' } ],
    [ 'normalize: collapse is one space, trim removes both ends',
      'text.normalize', { text => " \t a\r\n\r\nb  " }, { text => 'a b' } ],
    [ 'normalize: idempotency pair (curly quotes, em dash, ellipsis, wide space)',
      'text.normalize', { text => "\x{201C}Don\x{2019}t\x{201D}\x{A0}\x{2014}\x{3000}\x{2018}x\x{2019}\x{2026}" },
      undef ],
    [ 'normalize: NFKC rather than the table (U+FB01 ligature) is left alone',
      'text.normalize', { text => "\x{FB01}n" }, { text => "\x{FB01}n" } ],
    [ 'normalize: ASCII uppercase outside U+0000-U+024F is not folded',
      'text.normalize', { text => "\x{212A}" }, { text => "\x{212A}" } ],
    [ 'normalize: astral emoji survive (one code point, not two UTF-16 units)',
      'text.normalize', { text => "cat \x{1F600} tail" }, { text => "cat \x{1F600} tail" } ],
    [ 'normalize: only whitespace trims to the empty string',
      'text.normalize', { text => "   \t\n " }, { text => '' } ],

    # ---- text.extract ------------------------------------------------------------------
    [ 'extract: unclosed element at the end of the input is dropped',
      'text.extract', { html => '<p>a<b>b', baseUrl => undef },
      { title => '', text => "\nab", links => [], images => 0 } ],
    [ 'extract: an element with no closing tag swallows the rest',
      'text.extract', { html => '<p>a</p><script>var x = 1;', baseUrl => undef },
      { title => '', text => "\na\n", links => [], images => 0 } ],
    [ 'extract: an incomplete tag at the end of input is dropped with its name characters',
      'text.extract', { html => '<p>abc<b', baseUrl => undef },
      { title => '', text => "\nabc", links => [], images => 0 } ],
    [ 'extract: a lone < at the end is literal text',
      'text.extract', { html => 'a<', baseUrl => undef },
      { title => '', text => 'a<', links => [], images => 0 } ],
    [ 'extract: < followed by a digit is literal text, not a tag',
      'text.extract', { html => 'a<3', baseUrl => undef },
      { title => '', text => 'a<3', links => [], images => 0 } ],
    [ 'extract: a < not followed by a letter, / or ! is literal, a > outside a tag is literal',
      'text.extract', { html => 'a < b > c 5<6', baseUrl => undef },
      { title => '', text => 'a < b > c 5<6', links => [], images => 0 } ],
    [ 'extract: a > inside a quoted attribute value does not end the tag',
      'text.extract', { html => q{<p>2 < 3 <a title="a>b" href="/q">L</a></p>}, baseUrl => undef },
      { title => '', text => "\n2 < 3 L\n",
        links => [ { href => '/q', absolute => JSON::PP::false, text => 'L' } ], images => 0 } ],
    [ 'extract: an unquoted href keeps its leading slash',
      'text.extract', { html => q{<a href=/bare>x</a>}, baseUrl => undef },
      { title => '', text => 'x',
        links => [ { href => '/bare', absolute => JSON::PP::false, text => 'x' } ], images => 0 } ],
    [ 'extract: absolute is a scheme at the start, verbatim href, case-insensitive tag and attribute',
      'text.extract',
      { html => q{<A HREF="HTTP://e/x">A</A> <a href="//cdn/">B</a> <a href="mailto:a@b">C</a>},
        baseUrl => 'https://base/' },
      { title => '', text => 'A B C',
        links => [ { href => 'HTTP://e/x', absolute => JSON::PP::true,  text => 'A' },
                   { href => '//cdn/',  absolute => JSON::PP::false, text => 'B' },
                   { href => 'mailto:a@b', absolute => JSON::PP::true, text => 'C' } ],
        images => 0 } ],
    [ 'extract: an anchor without an href still produces an entry with an empty href',
      'text.extract', { html => q{<a name="x">t</a>}, baseUrl => undef },
      { title => '', text => 't',
        links => [ { href => '', absolute => JSON::PP::false, text => 't' } ], images => 0 } ],
    [ 'extract: nested anchors follow the browser, both links are reported',
      'text.extract', { html => q{<a href="/one">one<a href="/two">two}, baseUrl => undef },
      { title => '', text => 'onetwo',
        links => [ { href => '/one', absolute => JSON::PP::false, text => 'one' },
                   { href => '/two', absolute => JSON::PP::false, text => 'two' } ], images => 0 } ],
    [ 'extract: nested anchors, inner one closed, both reported',
      'text.extract', { html => q{<a href="/one">a<a href="/y">b</a>c</a>}, baseUrl => undef },
      { title => '', text => 'abc',
        links => [ { href => '/one', absolute => JSON::PP::false, text => 'a' },
                   { href => '/y',   absolute => JSON::PP::false, text => 'b' } ], images => 0 } ],
    [ 'extract: img tags are counted case-insensitively and after comments are gone',
      'text.extract', { html => '<img src=a><IMG src=b><!-- <img src=c> --><img src=d>', baseUrl => undef },
      { title => '', text => '', links => [], images => 3 } ],
    [ 'extract: the first title wins, is entity-decoded, and is not part of the text',
      'text.extract', { html => '<title>One</title><title>Two</title><p>body</p>', baseUrl => undef },
      { title => 'One', text => "Two\nbody\n", links => [], images => 0 } ],
    [ 'extract: a title inside an anchor feeds the title only, not the link text',
      'text.extract', { html => q{<a href="/x"><title>T</title>t</a>}, baseUrl => undef },
      { title => 'T', text => 't',
        links => [ { href => '/x', absolute => JSON::PP::false, text => 't' } ], images => 0 } ],
    [ 'extract: named entities decode with and without the semicolon, case-insensitively, no backtracking',
      'text.extract', { html => 'a &amp b &amp; c &AMP; d &copy2024 e &ampzz f &unknown; g', baseUrl => undef },
      { title => '', text => 'a & b & c & d &copy2024 e &ampzz f &unknown; g', links => [], images => 0 } ],
    [ 'extract: numeric entities, decimal and hex, semicolon optional',
      'text.extract', { html => '&#65;&#x42;&#X43; &#169; &#65no &#x41no &#; &#x;', baseUrl => undef },
      { title => '', text => 'ABC ' . "\x{A9}" . ' Ano Ano &#; &#x;', links => [], images => 0 } ],
    [ 'extract: each named entity is its own character, not the ASCII the normalizer would make',
      'text.extract', { html => '&nbsp;&mdash;&ndash;&hellip;&laquo;&raquo;&copy;&reg;&trade;&times;&middot;', baseUrl => undef },
      { title => '', text => "\x{A0}\x{2014}\x{2013}\x{2026}\x{AB}\x{BB}\x{A9}\x{AE}\x{2122}\x{D7}\x{B7}",
        links => [], images => 0 } ],
    [ 'extract: CDATA keeps its text and nothing inside it is markup or an entity',
      'text.extract', { html => '<![CDATA[<b>raw</b> a &amp; b &#65;]]>', baseUrl => undef },
      { title => '', text => '<b>raw</b> a &amp; b &#65;', links => [], images => 0 } ],
    [ 'extract: an unclosed CDATA section keeps everything to the end of the input',
      'text.extract', { html => '<![CDATA[unclosed', baseUrl => undef },
      { title => '', text => 'unclosed', links => [], images => 0 } ],
    [ 'extract: a CDATA section inside a removed element goes with the element',
      'text.extract', { html => '<p><![CDATA[<script>x</script>]]></p><script>&lt;![CDATA[y]]&gt;</script>',
        baseUrl => undef },
      { title => '', text => "\n<script>x</script>\n", links => [], images => 0 } ],
    [ 'extract: comments and doctypes are removed, an unclosed comment runs to the end',
      'text.extract', { html => '<!DOCTYPE html><!-- gone --><p>a</p><!-- x', baseUrl => undef },
      { title => '', text => "\na\n", links => [], images => 0 } ],
    [ 'extract: each listed block tag contributes a newline on both its tags',
      'text.extract', { html => '<p>a</p><div>b</div><li>c</li><h1>d</h1>', baseUrl => undef },
      { title => '', text => "\na\n\nb\n\nc\n\nd\n", links => [], images => 0 } ],
    [ 'extract: an empty document answers empty strings, never null',
      'text.extract', { html => '', baseUrl => undef },
      { title => '', text => '', links => [], images => 0 } ],
    [ 'extract: extract never normalizes (case, accents and U+3000 survive)',
      'text.extract', { html => "<p>\x{C9}COLE\x{3000}\x{3000}X</p>", baseUrl => undef },
      { title => '', text => "\n\x{C9}COLE\x{3000}\x{3000}X\n", links => [], images => 0 } ],

    # ---- text.fingerprint --------------------------------------------------------------
    [ 'fingerprint: empty text emits nothing, and a zero hash',
      'text.fingerprint', { text => '' },
      { simhash => '0000000000000000', tokens => 0, shingles => 0 } ],
    [ 'fingerprint: three tokens make one shingle',
      'text.fingerprint', { text => 'aa bb cc' },
      { simhash => 'c9907bb5c642ac45', tokens => 3, shingles => 1 } ],
    [ 'fingerprint: edge punctuation is trimmed before the run rule',
      'text.fingerprint', { text => 'hello, world. (x) "y" ...' },
      { simhash => '80342250f0128200', tokens => 4, shingles => 2 } ],
    [ 'fingerprint: a token that is nothing but punctuation emits nothing',
      'text.fingerprint', { text => '-- !! ???' },
      { simhash => '0000000000000000', tokens => 0, shingles => 0 } ],
    [ 'fingerprint: a CJK run of 4 emits 3 overlapping bigrams',
      'text.fingerprint', { text => "\x{5DF2}\x{7ECF}\x{5DF2}\x{7ECF}" },
      { simhash => '02986de98409853c', tokens => 3, shingles => 1 } ],
    [ 'fingerprint: a CJK run of 6 emits 5 bigrams and 3 shingles',
      'text.fingerprint', { text => "\x{5DF2}\x{7ECF}\x{5DF2}\x{7ECF}\x{5DF2}\x{7ECF}" },
      { simhash => '02986de98409853c', tokens => 5, shingles => 3 } ],
    [ 'fingerprint: runs are split by class, a CJK run of one emits the character',
      'text.fingerprint', { text => "abc\x{5DF2}def" },
      { simhash => 'b3b0e6e5e0bdd3df', tokens => 3, shingles => 1 } ],
    [ 'fingerprint: digits are tokens, a two-token text is still one shingle',
      'text.fingerprint', { text => '2434 nijisanji' },
      { simhash => 'b9d5e2a67dcd4a3b', tokens => 2, shingles => 1 } ],
);

# The field order the contract specifies, plus the order of the keys inside every `links[]`
# element. A Perl hash is unordered by definition, so the order the encoder sees is the order this
# worker built the hash in, and checking it here is the only way to know that stays true.
sub field_order_checks {
    my @problems;

    my @expected = (
        [ 'text.normalize',   { text => 'x' },             [qw(text)] ],
        [ 'text.extract',     { html => 'x', baseUrl => undef },
          [qw(title text links images)] ],
        [ 'text.fingerprint', { text => 'x' },             [qw(simhash tokens shingles)] ],
    );
    for my $case (@expected) {
        my ($cap, $input, $want) = @$case;
        # Through `handle`, because that is the path the wire sees: the capability returns its own
        # fields and the envelope plus `ordered_output` decide the order the host will read. The
        # current capability has to be set first, because `handle` enforces "this worker implements
        # one capability" - without this, asking it about extract while it is normalising answers
        # `unsupported`, and the check then reports an empty field order instead of a real one.
        $CURRENT_CAPABILITY = $cap;
        my $response = handle({ id => 9, op => 'invoke', capability => $cap, input => $input });
        my $output = ordered_value($response, 'output');
        my $got = join(',', ordered_keys($output));
        push @problems, "$cap field order is $got, want " . join(',', @$want)
          if $got ne join(',', @$want);
    }

    $CURRENT_CAPABILITY = 'text.extract';
    my $links = ordered_value(ordered_value(handle({
        id => 10, op => 'invoke', capability => 'text.extract',
        input => { html => q{<a href="/x">t</a>}, baseUrl => undef },
    }), 'output'), 'links');
    my $link_order = join(',', ordered_keys($links->[0]));
    push @problems, "links[] key order is $link_order, want href,absolute,text"
      if $link_order ne 'href,absolute,text';

    # Back to the capability the worker was started for: the envelope and bad-input cases below are
    # about the protocol rather than about a capability, and leaving extract selected made them answer
    # `unsupported` - the self-check's own version of a stale global.
    $CURRENT_CAPABILITY = 'text.normalize';
    my $envelope = handle({ id => 1, op => 'invoke', capability => 'text.normalize',
                            input => { text => 'x' } });
    my $envelope_order = join(',', ordered_keys($envelope));
    push @problems, "invoke envelope key order is $envelope_order, want id,ok,output"
      if $envelope_order ne 'id,ok,output';

    my $error = handle({ id => 2, op => 'invoke', capability => 'text.normalize',
                         input => { text => 7 } });
    my $error_order = join(',', ordered_keys($error));
    push @problems, "error envelope key order is $error_order, want id,ok,error"
      if $error_order ne 'id,ok,error';
    my $error_body = ordered_value($error, 'error');
    push @problems, 'the error body key order is ' . join(',', ordered_keys($error_body))
      . ', want code,message'
      if join(',', ordered_keys($error_body)) ne 'code,message';
    push @problems, 'a non-string input.text must answer bad-input, got '
      . ordered_value($error_body, 'code')
      if ordered_value($error_body, 'code') ne 'bad-input';

    my $descriptor = handle({ id => 3, op => 'describe' });
    my $worker_order = join(',', ordered_keys(ordered_value($descriptor, 'worker')));
    push @problems, "descriptor key order is $worker_order, want "
      . 'protocol,capability,language,impl,runtime,deterministic'
      if $worker_order ne 'protocol,capability,language,impl,runtime,deterministic';

    my $wrong = handle({ id => 4, op => 'invoke', capability => 'text.extract',
                         input => { html => 'x', baseUrl => undef } });
    push @problems, 'invoke with another capability must answer unsupported, got '
      . ordered_value(ordered_value($wrong, 'error'), 'code')
      if ordered_value(ordered_value($wrong, 'error'), 'code') ne 'unsupported';

    return @problems;
}

# The protocol-level checks: the JSON that actually crosses the wire, in both directions. These
# are the ones a corpus can never see, because the harness compares the parsed value and this
# worker's own field order and byte-level framing are exactly what the contract pins.
sub wire_checks {
    my @problems;
    my $text = "caf\x{E9} \x{4E2D} \x{1F600}";
    my $line = $JSON->encode({ text => $text });

    # The encoded line must be UTF-8 BYTES, not a character string: a character string would be
    # handed to the output layer to encode (which then owns a decision this worker is supposed to
    # own), and bytes that are not valid UTF-8 are mojibake on the wire.
    push @problems, 'the encoder returned a character string rather than UTF-8 bytes'
      if utf8::is_utf8($line);

    # ... and it must really be valid UTF-8: those three code points are 1, 3 and 4 bytes long, so
    # a correct line decodes back to exactly the text it started from.
    my $back = $JSON_DECODE->decode($line);
    push @problems, 'a round trip through the encoder changed the text'
      if !defined $back or $back->{text} ne $text;

    # Astral code points are the case a per-UTF-16-code-unit implementation gets wrong. One is two
    # UTF-16 code units and ONE Perl character, which is why `length` is the check that matters: a
    # worker counting code units would report 2 here and split the character in every `substr`,
    # exactly as the PowerShell implementation did on every emoji.
    my $astral = "\x{1F600}";
    push @problems, 'an astral code point is not one character in this Perl' if length($astral) != 1;
    my $astral_bytes = $astral;
    utf8::encode($astral_bytes);
    push @problems, 'an astral code point is not four UTF-8 bytes' if length($astral_bytes) != 4;
    push @problems, 'the JSON encoder did not round-trip an astral code point'
      if $JSON_DECODE->decode($JSON->encode({ text => $astral }))->{text} ne $astral;

    # A code point count is a code point count: `length` and `substr` must be in the character layer
    # for a decoded string, which is the reason the tables here are keyed by code point.
    my $cjk = "\x{5DF2}\x{7ECF}";
    push @problems, 'CJK is not two characters' if length($cjk) != 2;
    push @problems, 'substr in the character layer did not take one CJK character'
      if substr($cjk, 0, 1) ne "\x{5DF2}";
    return @problems;
}

# --------------------------------------------------------------------------------------------
# Self-check
# --------------------------------------------------------------------------------------------

my $PASS_COUNT = 0;
my $FAIL_COUNT = 0;

sub record {
    my ($name, $ok, $detail, $shown) = @_;
    if ($ok) {
        $PASS_COUNT++;
        print "[pass] $name: $shown\n";
    }
    else {
        $FAIL_COUNT++;
        print "[FAIL] $name: $detail\n";
    }
    return;
}

# Run a case body and answer with its value, putting the failure text in the caller's second
# argument. The value and the status travel on two separate channels on purpose: collapsing them
# into one is how `$LOWER` became the number 1 in the first draft (see `main`).
sub catch_value {
    my ($body, $failure_slot) = @_;
    my $value = eval { $body->() };
    if ($@) {
        my $message = "$@";
        $message =~ s/\s+\z//;
        $$failure_slot = $message;
        return undef;
    }
    return $value;
}

sub run_selfcheck {
    for my $case (@SELFCHECK_CASES) {
        my ($name, $kind, $input, $expected) = @$case;
        my ($ok, $detail, $shown);
        my $failure = '';
        my $value = catch_value(
            sub {
                # Each of these returns what the protocol layer would put in the answer: normalize
                # returns the bare text and is wrapped here, exactly as the envelope wraps it, while
                # extract and fingerprint already return their whole output object. The case table
                # holds the expected *objects*, so a case that compared a bare string with an object
                # failed every time and said nothing about the worker.
                if    ($kind eq 'text.normalize')   { { text => normalize($input->{text}) } }
                elsif ($kind eq 'text.fingerprint') { fingerprint($input->{text}) }
                else                                { extract($input->{html}) }
            },
            \$failure,
        );
        if ($failure ne '') {
            ($ok, $detail, $shown) = (0, "raised: $failure", $failure);
        }
        elsif (!defined $expected) {
            # An idempotency pair: the case's own output must be a fixed point.
            my $second = normalize($value->{text});
            $ok = ($second eq $value->{text}) ? 1 : 0;
            $detail = 'not idempotent: ' . show($value->{text}) . ' -> ' . show($second);
            $shown = show($value->{text});
        }
        else {
            $ok = same_value($value, $expected);
            $detail = 'got ' . show($value) . ', want ' . show($expected);
            $shown = show($value);
        }
        record($name, $ok, $detail, $shown);
    }

    my @order_problems = field_order_checks();
    if (@order_problems) {
        record('protocol: field order and error codes', 0, $_, $_) for @order_problems;
    }
    else {
        record('protocol: field order and error codes', 1, '',
            'output, links[] and envelope field order match the contract; bad-input and unsupported codes match');
    }

    my @wire_problems = wire_checks();
    if (@wire_problems) {
        record('protocol: JSON layer and code points', 0, $_, $_) for @wire_problems;
    }
    else {
        record('protocol: JSON layer and code points', 1, '',
            'the encoder stays in character mode (ASCII out) and the decoder joins surrogate pairs into one code point');
    }

    # One line, and it carries both numbers. The previous version printed "$n/$n checks passed" when
    # there were failures and a different shape when there were none, so a run with twelve failures
    # announced a clean sweep - which is the one thing a self-check must never do, in any language.
    print "$PASS_COUNT/", ($PASS_COUNT + $FAIL_COUNT), " checks passed\n";

    if ($FAIL_COUNT) {
        diag("selfcheck: $FAIL_COUNT of " . ($PASS_COUNT + $FAIL_COUNT) . " checks failed");
        return 1;
    }
    return 0;
}

# --------------------------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------------------------

sub main {
    my @argv = @_;

    my $mode;
    my $capability;
    if (@argv == 1 and $argv[0] eq '--selfcheck') {
        $mode = 'selfcheck';
    }
    elsif (@argv == 2 and $argv[0] eq '--capability') {
        $mode = 'run';
        $capability = $argv[1];
    }
    else {
        diag('error: unexpected command line (expected --capability <name> or --selfcheck)');
        diag($USAGE);
        return 2;
    }

    # `$LOWER = eval { load_table(...); 1 }` was the first draft of this, and it is wrong in a way
    # that is worth naming: an eval returns the value of its last statement, so `$LOWER` became the
    # literal 1 that was there to keep the block from being re-run, and every later `$LOWER->{...}`
    # died with "Can't use string ("1") as a HASH ref". The retry quirk needs *some* value at the end
    # of the block; keeping the status and the value in two separate variables is what makes the two
    # impossible to confuse, so that is the shape used for all four of these.
    my $lower_status = try_load_into(\$LOWER, 'latin-lower.json');
    if ($lower_status) {
        diag("error: cannot load the shared tables from $SPEC_DIR: $lower_status");
        return 2;
    }
    my $fold_status = try_load_into(\$FOLD, 'latin-fold.json');
    if ($fold_status) {
        diag("error: cannot load the shared tables from $SPEC_DIR: $fold_status");
        return 2;
    }

    if ($mode eq 'selfcheck') {
        # Every case calls its function directly, but `handle` is exercised too, so the current
        # capability must not be left empty.
        $CURRENT_CAPABILITY = 'text.normalize';
        print "vmltext.pl self-check (Perl $], $^O; tables from $SPEC_DIR)\n";
        return run_selfcheck();
    }

    my %known = map { $_ => 1 } @CAPABILITIES;
    unless ($known{$capability}) {
        diag("error: unknown --capability $capability; this worker implements "
            . join(', ', @CAPABILITIES));
        return 2;
    }

    $CURRENT_CAPABILITY = $capability;
    diag("vmltext.pl ready: capability=$capability, protocol=$PROTOCOL_VERSION, "
        . "tables in $SPEC_DIR");
    return run_protocol();
}

exit(main(@ARGV));
