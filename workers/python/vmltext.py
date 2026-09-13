#!/usr/bin/env python3
"""vmltext.py - the Python worker of the multilingual text layer.

Implements the three capabilities of docs/WORKERS.md sections 2-4 -- `text.normalize`,
`text.extract`, `text.fingerprint` -- behind the stdio JSON-Lines protocol of section 1.

Standard library only. No third-party packages, no network, no build step.

Usage:
    python workers/python/vmltext.py --capability text.normalize
    python workers/python/vmltext.py --selfcheck

The case and fold tables are read from workers/spec/*.json at startup. The runtime's own Unicode
data is deliberately *not* consulted for text.normalize: the contract says "apply this file", and
`str.lower()` / `unicodedata.normalize` would agree almost everywhere, which is exactly the kind of
near-miss the cross-implementation diff exists to catch.
"""

from __future__ import annotations

import json
import os
import sys
import traceback

CAPABILITIES = ("text.normalize", "text.extract", "text.fingerprint")
PROTOCOL_VERSION = 1
LANGUAGE = "python"
IMPL = "table-driven"
USAGE = ("usage: vmltext.py --capability <text.normalize|text.extract|text.fingerprint> "
         "| --selfcheck")

# JSON shape: compact separators (",", ":"), ensure_ascii=False. Key order is the order the
# contract lists fields in; Python dicts preserve insertion order, so the bytes are stable.
JSON_SEPARATORS = (",", ":")

# ---------------------------------------------------------------------------------------------
# Section 1.2, the Windows encoding trap: the transport is UTF-8 bytes on all three streams.
# ---------------------------------------------------------------------------------------------


def configure_stdio() -> None:
    """UTF-8 on stdin/stdout/stderr, with no newline translation on the protocol stream.

    stdout is written as bytes by `write_line`, so every line ends in a lone LF on every platform,
    which is what "byte-identical output JSON" requires.
    """
    for stream, newline in ((sys.stdin, "\n"), (sys.stdout, "\n"), (sys.stderr, "\n")):
        try:
            stream.reconfigure(encoding="utf-8", newline=newline)  # type: ignore[union-attr]
        except (AttributeError, ValueError, OSError):
            pass


def write_line(payload: dict) -> None:
    """Write one protocol line: compact UTF-8 JSON, one LF, nothing else."""
    line = json.dumps(payload, ensure_ascii=False, separators=JSON_SEPARATORS)
    sys.stdout.buffer.write(line.encode("utf-8", "surrogatepass") + b"\n")
    sys.stdout.buffer.flush()


def diag(message: str) -> None:
    """Free-form English diagnostics go to stderr, never to stdout."""
    sys.stderr.write(message + "\n")
    sys.stderr.flush()


# ---------------------------------------------------------------------------------------------
# Shared tables (workers/spec/*.json). Section 2: nobody consults their own runtime's tables.
# ---------------------------------------------------------------------------------------------

SPEC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, "spec")


class Tables:
    """The loaded tables plus the derived per-code-point lookup lists.

    `direct[cp]` is the whole step-2 result for one code point: a string. The map table's one
    two-code-point entry (U+2026 -> "...") is kept as a string so it stays a one-pass substitution.
    """

    def __init__(self, lower: dict, fold: dict) -> None:
        self.lower = lower
        self.fold = fold
        n = 0x110000
        self.direct = [None] * n
        self.blank = [False] * n

        # Step 1 deletes these; step 2 maps these to a space; step 5 then collapses them.
        delete_ranges = (
            (0x0000, 0x0008), (0x000B, 0x000B), (0x000C, 0x000C), (0x000E, 0x001F),
            (0x007F, 0x007F), (0x200B, 0x200F), (0x202A, 0x202E), (0x2060, 0x2064),
            (0xFEFF, 0xFEFF),
            # Combining marks: deleting them is what makes "e" + U+0301 equal to "e" + nothing,
            # i.e. a decomposed feed compares equal to its composed form without any NFKC.
            (0x0300, 0x036F), (0x1AB0, 0x1AFF), (0x1DC0, 0x1DFF), (0x20D0, 0x20FF),
            (0xFE20, 0xFE2F),
        )
        for lo, hi in delete_ranges:
            for cp in range(lo, hi + 1):
                self.direct[cp] = ""
                self.blank[cp] = True

        map_ranges = (
            (0x00A0, 0x00A0), (0x2000, 0x200A), (0x2028, 0x2029), (0x202F, 0x202F),
            (0x205F, 0x205F), (0x3000, 0x3000),
        )
        for lo, hi in map_ranges:
            for cp in range(lo, hi + 1):
                self.direct[cp] = " "
                self.blank[cp] = True
        for cp in range(0xFF01, 0xFF5F):
            self.direct[cp] = chr(cp - 0xFEE0)

        singles = (
            (0x2018, "'"), (0x2019, "'"), (0x201B, "'"), (0x2032, "'"),
            (0x201C, '"'), (0x201D, '"'), (0x201F, '"'), (0x2033, '"'),
            (0x2010, "-"), (0x2011, "-"), (0x2012, "-"), (0x2013, "-"),
            (0x2014, "-"), (0x2015, "-"), (0x2212, "-"),
            (0x3001, ","), (0x3002, "."),
        )
        for cp, to in singles:
            self.direct[cp] = to
        self.direct[0x2026] = "..."

        self._collapsible = frozenset((0x20, 0x09, 0x0A, 0x0D))

    def step1_2(self, text: str) -> str:
        table = self.direct
        if not table:
            return text
        return "".join([table[ord(c)] if table[ord(c)] is not None else c for c in text])

    def step3_4(self, text: str) -> str:
        lower = self.lower
        fold = self.fold
        out = []
        for ch in text:
            cp = ord(ch)
            got = lower.get(cp)
            if got is not None:
                cp = got
            got = fold.get(cp)
            out.append(got if got is not None else chr(cp))
        return "".join(out)

    def step5_6(self, text: str) -> str:
        blank = self.blank
        collapsible = self._collapsible
        out = []
        pending = False
        for ch in text:
            cp = ord(ch)
            if cp in collapsible or blank[cp]:
                pending = bool(out)
                continue
            if pending:
                out.append(" ")
                pending = False
            out.append(ch)
        return "".join(out)


def load_tables() -> Tables:
    def read(name: str) -> dict:
        path = os.path.join(SPEC_DIR, name)
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        return {int(k): v for k, v in payload["map"].items()}

    return Tables(read("latin-lower.json"), read("latin-fold.json"))


TABLES: Tables  # assigned in main()


# ---------------------------------------------------------------------------------------------
# Capability text.normalize (section 2)
# ---------------------------------------------------------------------------------------------


def normalize(text: str) -> str:
    """Steps 1-6, in the order the contract lists them. Over Unicode scalar values."""
    text = TABLES.step1_2(text)   # 1 delete, 2 map one-to-one
    text = TABLES.step3_4(text)   # 3 lowercase from latin-lower.json, 4 fold from latin-fold.json
    return TABLES.step5_6(text)   # 5 collapse runs of space/tab/LF/CR, 6 trim


# ---------------------------------------------------------------------------------------------
# Capability text.extract (section 3)
# ---------------------------------------------------------------------------------------------

REMOVED_ELEMENTS = frozenset(("script", "style", "noscript", "template", "svg", "iframe"))

NEWLINE_ELEMENTS = frozenset((
    "br", "p", "div", "li", "ul", "ol", "tr", "th", "td", "h1", "h2", "h3", "h4", "h5", "h6",
    "section", "article", "header", "footer", "aside", "nav", "blockquote", "pre", "table", "hr",
    "dd", "dt", "figure", "figcaption", "main", "form",
))

NAMED_ENTITIES = {
    "amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'", "nbsp": "\u00a0",
    "mdash": "\u2014", "ndash": "\u2013", "hellip": "\u2026", "laquo": "\u00ab",
    "raquo": "\u00bb", "copy": "\u00a9", "reg": "\u00ae", "trade": "\u2122",
    "times": "\u00d7", "middot": "\u00b7",
}

_SCHEME_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+.-")
_HEX_DIGITS = frozenset("0123456789abcdefABCDEF")
_ASCII_LETTERS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
_ENTITY_NAME_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
_NAME_STOP = frozenset(" \t\n\r\f/>")
_NAME_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:")
_ENTITY_NAME_WINDOW = 12

# Marks a fragment that is already character data (a CDATA body) in the link and title buffers, so
# that nothing decodes an entity or reads a tag inside it: the walk never did, and neither may the
# cleaner.
_LITERAL_MARK = "\x00L"

# Placeholder for a hidden CDATA body. It carries the body index and cannot be confused with, or
# split by, a tag scan, an entity or the words the remover looks for.
_CDATA_TOKEN = "\x00CDATA%d\x00"


def _tag_end(text: str, i: int) -> int:
    """Index of the `>` that ends the tag starting at `i`, or -1 when there is none.

    Inside a tag, `'` and `"` delimit attribute values, so a `>` inside them is ordinary text and does
    not end the tag. A `<` inside a tag is ordinary text as well: section 3's "`<` starts a tag only
    when followed by `[A-Za-z/!]`" is a rule about where a tag may *begin*, not a rule that a tag in
    progress ends early, so `</p</A>text</p>` is one tag ending at the first `>` after its attribute
    text. An unterminated attribute value (a quote with no partner) runs to the end of the input.
    """
    j = i
    n = len(text)
    while j < n:
        ch = text[j]
        if ch == '"' or ch == "'":
            k = text.find(ch, j + 1)
            if k < 0:
                return -1         # an unterminated attribute value runs to the end of the input
            j = k + 1
            continue
        if ch == ">":
            return j
        j += 1
    return -1


def _tag_name(raw: str, closing: bool) -> str:
    """Tag name of a raw tag body: `/?` then an optional space, then `[A-Za-z][A-Za-z0-9:-]*`."""
    j = 1 if closing else 0
    while j < len(raw) and raw[j] in " \t\n\r":
        j += 1
    start = j
    if j < len(raw) and raw[j] in _ASCII_LETTERS:
        j += 1
        while j < len(raw) and (raw[j] in _NAME_CHARS or raw[j] == "-"):
            j += 1
    return raw[start:j].lower()


def _emit_entity(text: str, i: int):
    """Decode one entity at `i`. Returns (decoded_text, next_index) or None when not an entity.

    Named entities are accepted with and without the trailing semicolon, as browsers do. The name is
    looked for within 12 characters of the `&` and the longest name that is in the table wins; there
    is no backtracking, so `&copy2024` stays literal (the contract names this case explicitly).
    An unknown name is left verbatim and the `&` stays. Numeric entities (`&#DDD;` 1-7 decimal digits,
    `&#xHHH;` 1-6 hex digits) are accepted with or without the semicolon as well, and give the code
    point back as text.
    """
    n = len(text)
    if text[i] != "&" or i + 1 >= n:
        return None
    ch = text[i + 1]
    if ch == "#":
        j = i + 2
        hex_mode = False
        if j < n and (text[j] == "x" or text[j] == "X"):
            hex_mode = True
            j += 1
        start = j
        if hex_mode:
            while j < n and text[j] in _HEX_DIGITS and j - start < 6:
                j += 1
        else:
            while j < n and text[j].isdigit() and text[j].isascii() and j - start < 7:
                j += 1
        if j == start:
            return None
        digits = text[start:j]
        if j < n and text[j] == ";":
            j += 1
        value = int(digits, 16 if hex_mode else 10)
        # A value that is not a Unicode scalar value is left verbatim: the contract does not
        # describe a replacement, and inventing one would diverge from the other languages.
        if value > 0x10FFFF or 0xD800 <= value <= 0xDFFF:
            return None
        return chr(value), j
    if ch in _ASCII_LETTERS:
        # The name is the maximal run of letters/digits after the '&'. The whole run must be a table
        # name; there is no backtracking, so `&copy2024` and `&ampzz` stay literal while `&amp` and
        # `&amp;` decode. That is the contract's "an unknown named entity stays verbatim" applied to
        # the run as written.
        j = i + 1
        limit = min(n, i + 1 + _ENTITY_NAME_WINDOW)
        while j < limit and text[j] in _ENTITY_NAME_CHARS:
            j += 1
        # Names are matched case-insensitively: `&AMP;` is `&amp;` (section 3 step 6).
        replacement = NAMED_ENTITIES.get(text[i + 1:j].lower())
        if replacement is not None:
            if j < n and text[j] == ";":
                j += 1
            return replacement, j
    return None


def _attr_value(tag: str, wanted: str):
    """Value of an attribute in a raw tag body, or None when the attribute is absent.

    Attribute names never contain `/`, `>` or whitespace, so `/` needs no special handling: it is an
    ordinary character inside an unquoted value (`href=/bare` must yield `/bare`, not `""`).
    """
    i = 1
    n = len(tag)
    while i < n and tag[i] not in _NAME_STOP:
        i += 1
    while i < n:
        while i < n and tag[i] in " \t\n\r\f/":
            i += 1
        start = i
        while i < n and tag[i] not in _NAME_STOP and tag[i] != "=":
            i += 1
        name = tag[start:i].lower()
        while i < n and tag[i] in " \t\n\r\f":
            i += 1
        value = ""
        if i < n and tag[i] == "=":
            i += 1
            while i < n and tag[i] in " \t\n\r\f":
                i += 1
            if i < n and (tag[i] == '"' or tag[i] == "'"):
                quote = tag[i]
                i += 1
                start = i
                while i < n and tag[i] != quote:
                    i += 1
                value = tag[start:i]
                i += 1
            else:
                # An unquoted value ends at whitespace or `>`, never at `/`: `href=/bare` is `/bare`.
                start = i
                while i < n and tag[i] not in " \t\n\r\f>":
                    i += 1
                value = tag[start:i]
        if name == wanted:
            return value
    return None


def _is_absolute_href(href: str) -> bool:
    """`[A-Za-z][A-Za-z0-9+.-]*:` -- a scheme at the start of the href, nothing else."""
    n = len(href)
    if n < 2 or href[0] not in _ASCII_LETTERS:
        return False
    i = 1
    while i < n:
        ch = href[i]
        if ch == ":":
            return True
        if ch not in _SCHEME_CHARS:
            return False
        i += 1
    return False


def _hide_cdata(html: str, bodies: list) -> str:
    """Pass 1: replace each CDATA body with an opaque placeholder and keep the body.

    The contract's word is "hide", and hiding is observable: the walk must not read tags or entities
    inside a CDATA body, while the body still goes away with a removed element that contains it.
    An unclosed section keeps its text to the end of the input, the same principle as a removed
    element without its closing tag.
    """
    out = []
    i = 0
    n = len(html)
    while i < n:
        if html.startswith("<![CDATA[", i):
            end = html.find("]]>", i + 9)
            body = html[i + 9:] if end < 0 else html[i + 9:end]
            out.append(_CDATA_TOKEN % len(bodies))
            bodies.append(body)
            i = n if end < 0 else end + 3
            continue
        out.append(html[i])
        i += 1
    return "".join(out)


def _strip_comments_and_doctypes(text: str) -> str:
    """Pass 2: remove `<!-- ... -->` (or an unclosed comment to end of input) and `<!DOCTYPE ...>`."""
    out = []
    i = 0
    n = len(text)
    while i < n:
        if text.startswith("<!--", i):
            end = text.find("-->", i + 4)
            i = n if end < 0 else end + 3
            continue
        if text.startswith("<!", i) and text[i:i + 9].lower() == "<!doctype":
            end = text.find(">", i)
            i = n if end < 0 else end + 1
            continue
        out.append(text[i])
        i += 1
    return "".join(out)


def _remove_listed_elements(text: str) -> str:
    """Pass 3: remove the six listed elements with their content, on the raw remaining text."""
    for name in sorted(REMOVED_ELEMENTS):
        out = []
        i = 0
        n = len(text)
        while i < n:
            if text[i] == "<" and text[i + 1:i + 2] != "/":
                j = i + 1
                k = j
                while k < n and text[k] in _NAME_CHARS or (k < n and text[k] == "-"):
                    k += 1
                if text[j:k].lower() == name and (k >= n or text[k] in " \t\n\r\f/>"):
                    end = _tag_end(text, i)
                    if end < 0:
                        i = n          # not a complete opening tag: nothing to remove
                        continue
                    close_at = _find_close(text, end + 1, name)
                    if close_at < 0:
                        i = n          # a missing closing tag means "to end of input"
                        continue
                    close_end = _tag_end(text, close_at)
                    i = n if close_end < 0 else close_end + 1
                    continue
            out.append(text[i])
            i += 1
        text = "".join(out)
    return text


def _find_close(text: str, start: int, name: str) -> int:
    """Index of `</name` at or after `start`, respecting quotes, or -1."""
    i = start
    n = len(text)
    needle = "</" + name
    while i < n:
        at = text.find(needle, i)
        if at < 0:
            return -1
        after = at + len(needle)
        if after >= n or text[after] in " \t\n\r\f/>":
            return at
        i = after
    return -1


def _clean_pieces(pieces) -> str:
    """Clean collected fragments for `links[].text` and `title`.

    A fragment carried as character data (a CDATA body) is already exactly the text the contract
    wants, so it is passed through untouched: decoding an entity or reading a tag inside it would undo
    the whole point of hiding it before the removal passes.
    """
    out = []
    for piece in pieces:
        if piece.startswith(_LITERAL_MARK):
            out.append(piece[len(_LITERAL_MARK):])
        else:
            out.append(clean(piece))
    return "".join(out)


def clean(text: str) -> str:
    """Drop tags and decode entities in a collected fragment (link text, title).

    Nothing is trimmed or collapsed: the contract's rule 4 says a link's text "obeys exactly the same
    rules as the main text", and the main text keeps its newlines, so a block tag inside a link
    contributes a newline here too.
    """
    out = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "<":
            nxt = text[i + 1] if i + 1 < n else ""
            if nxt and nxt.isascii() and (nxt.isalpha() or nxt == "/"):
                end = _tag_end(text, i)
                if end < 0:
                    break
                i = end + 1
                continue
            out.append(ch)
            i += 1
            continue
        if ch == "&":
            got = _emit_entity(text, i)
            if got is not None:
                out.append(got[0])
                i = got[1]
                continue
        out.append(ch)
        i += 1
    return "".join(out)


def extract(html: str, base_url):
    """Steps 1-8 of section 3. `baseUrl` is accepted and deliberately ignored (no URL resolution).

    The contract's observable pass order is: hide every CDATA body, remove comments and doctypes,
    remove the listed elements with their content, and only then walk what is left (steps 3 to 7).
    The order is observable, not cosmetic: hiding CDATA first is what keeps a `<script>` inside a
    CDATA body as text, while a CDATA section inside a removed element still goes with the element.

    Returns the fields in the order the contract lists them.
    """
    hidden = []
    chunk = _hide_cdata(html, hidden)             # 1: hide CDATA bodies
    chunk = _strip_comments_and_doctypes(chunk)   # 2: comments and doctypes
    chunk = _remove_listed_elements(chunk)        # 3: listed elements with their content

    # 4: walk what is left. A hidden CDATA body is opaque here: the walk can neither read markup
    # inside it nor decode an entity there. It is put back at the very end, once no rule can mistake
    # it for markup, which is also what makes a CDATA body inside an anchor part of the link's text.
    out = []
    links = []
    anchor_text = []
    anchor_open = None      # the link entry of the currently open <a>
    title_out = []
    inside_anchor = False
    title_open = False
    title_seen = False
    images = 0

    def emit(value: str) -> None:
        if not value:
            return
        # Step 5: the title's own text belongs to `title` and to nothing else -- not the body and not
        # an anchor's text. A <title> inside an <a> is therefore routed to `title` only; a browser
        # does not render it, so it cannot be part of the link either.
        if title_open:
            title_out.append(value)
            return
        out.append(value)
        if inside_anchor:
            anchor_text.append(value)

    i = 0
    n = len(chunk)
    while i < n:
        ch = chunk[i]

        if ch == "<":
            nxt = chunk[i + 1] if i + 1 < n else ""
            if not nxt or not nxt.isascii() or not (nxt.isalpha() or nxt == "/" or nxt == "!"):
                # `<` not followed by [A-Za-z/!] is literal text.
                emit(ch)
                i += 1
                continue

            end = _tag_end(chunk, i)
            if end < 0:
                # The tag never closed, either because the input ended inside it or because a `<`
                # that starts another tag took over. Either way it is dropped including its name
                # characters, the way a browser's eof-in-tag handling drops it, so it contributes no
                # newline, no link and no image, and nothing after it is walked either.
                break
            raw = chunk[i + 1:end]
            closing = nxt == "/"
            name = _tag_name(raw, closing)
            i = end + 1

            if name == "title":
                if not closing and not title_seen:
                    title_seen = True
                    title_open = True
                elif closing and title_open:
                    title_open = False
                continue

            if not closing and name == "img":
                images += 1

            if name == "a":
                if not closing:
                    if anchor_open is not None:
                        # Nesting: a browser closes the open anchor and starts the new one, so the
                        # outer link is reported with the text it had collected.
                        anchor_open["text"] = "".join(anchor_text)
                        links.append(anchor_open)
                    anchor_text = []
                    inside_anchor = True
                    href = _attr_value(raw, "href")
                    anchor_open = {
                        "href": href or "",
                        "absolute": _is_absolute_href(href or ""),
                        "text": "",
                    }
                elif anchor_open is not None:
                    anchor_open["text"] = "".join(anchor_text)
                    links.append(anchor_open)
                    anchor_open = None
                    inside_anchor = False
                continue

            if name in NEWLINE_ELEMENTS:
                emit("\n")
            continue

        if ch == "&":
            got = _emit_entity(chunk, i)
            if got is not None:
                emit(got[0])
                i = got[1]
                continue
            emit(ch)
            i += 1
            continue

        emit(ch)
        i += 1

    if anchor_open is not None:
        # An anchor still open at the end of input is reported with the text it collected, rather
        # than dropped (section 3 step 4).
        anchor_open["text"] = "".join(anchor_text)
        links.append(anchor_open)

    def restore(value: str) -> str:
        """Put the hidden CDATA bodies back; they are text, not markup, and are not walked."""
        for index, body in enumerate(hidden):
            value = value.replace(_CDATA_TOKEN % index, body)
        return value

    return {
        "title": restore("".join(title_out)),
        "text": restore("".join(out)),
        "links": [{"href": link["href"], "absolute": link["absolute"],
                   "text": restore(link["text"])} for link in links],
        "images": images,
    }


# ---------------------------------------------------------------------------------------------
# Capability text.fingerprint (section 4)
# ---------------------------------------------------------------------------------------------

FNV_OFFSET_BASIS = 14695981039346656037
FNV_PRIME = 1099511628211
MASK64 = 0xFFFFFFFFFFFFFFFF

_PUNCT_ONLY = frozenset("!?,.;:'\"()[]{}<>-_/\\|*+=~`@#$%^&")
_CJK_RANGES = ((0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF),
               (0x3040, 0x30FF), (0xAC00, 0xD7AF))


def _is_cjk(ch: str) -> bool:
    cp = ord(ch)
    for lo, hi in _CJK_RANGES:
        if lo <= cp <= hi:
            return True
    return False


def _tokenize(text: str):
    """Emitted tokens for one normalized text, in order.

    Each token is trimmed of leading and trailing ASCII punctuation *before* the run/bigram rule, so
    "hello," and "hello" emit the same token; a token that is empty after trimming emits nothing.
    """
    tokens = []
    for word in text.split(" "):
        if not word:
            continue
        start = 0
        end = len(word)
        while start < end and word[start] in _PUNCT_ONLY:
            start += 1
        while end > start and word[end - 1] in _PUNCT_ONLY:
            end -= 1
        word = word[start:end]
        if not word:
            continue
        run = []
        run_cjk = False
        for ch in word:
            cjk = _is_cjk(ch)
            if run and cjk != run_cjk:
                _flush_run(tokens, run, run_cjk)
                run = []
            run.append(ch)
            run_cjk = cjk
        if run:
            _flush_run(tokens, run, run_cjk)
    return tokens


def _flush_run(tokens, run, run_cjk: bool) -> None:
    if run_cjk:
        if len(run) == 1:
            tokens.append(run[0])
        else:
            for k in range(len(run) - 1):
                tokens.append(run[k] + run[k + 1])
    else:
        tokens.append("".join(run))


def fnv1a64(text: str) -> int:
    """FNV-1a over the UTF-8 bytes, unsigned 64-bit. The mask after every multiply is required."""
    h = FNV_OFFSET_BASIS
    for byte in text.encode("utf-8", "surrogatepass"):
        h ^= byte
        h = (h * FNV_PRIME) & MASK64
    return h


def fingerprint(text: str):
    tokens = _tokenize(text)
    count = len(tokens)
    if count < 3:
        shingles = [" ".join(tokens)] if count else []
    else:
        shingles = [" ".join(tokens[k:k + 3]) for k in range(count - 2)]

    counters = [0] * 64
    for shingle in shingles:
        h = fnv1a64(shingle)
        for bit in range(64):
            counters[bit] += 1 if (h >> bit) & 1 else -1

    value = 0
    for bit in range(64):
        if counters[bit] > 0:
            value |= 1 << bit

    return {
        "simhash": format(value, "016x"),
        "tokens": count,
        "shingles": len(shingles),
    }


# ---------------------------------------------------------------------------------------------
# Protocol (section 1) and dispatcher
# ---------------------------------------------------------------------------------------------


def describe(capability: str, request_id) -> dict:
    return {
        "id": request_id,
        "ok": True,
        "worker": {
            "protocol": PROTOCOL_VERSION,
            "capability": capability,
            "language": LANGUAGE,
            "impl": IMPL,
            "runtime": "Python %s" % sys.version.split()[0],
            "deterministic": True,
        },
    }


def error_response(request_id, code: str, message: str) -> dict:
    return {"id": request_id, "ok": False, "error": {"code": code, "message": message}}


def require_string(value, label: str) -> str:
    if not isinstance(value, str):
        raise ValueError("input.%s must be a string" % label)
    return value


def invoke(capability: str, payload) -> dict:
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        raise ValueError("input must be an object")
    if capability == "text.normalize":
        text = require_string(payload.get("text"), "text")
        return {"text": normalize(text)}
    if capability == "text.fingerprint":
        text = require_string(payload.get("text"), "text")
        return fingerprint(text)
    if capability == "text.extract":
        html = require_string(payload.get("html"), "html")
        base_url = payload.get("baseUrl")
        if base_url is not None and not isinstance(base_url, str):
            raise ValueError("input.baseUrl must be a string or null")
        return extract(html, base_url)
    raise KeyError(capability)


def handle(request) -> dict:
    if not isinstance(request, dict):
        return error_response(None, "bad-input", "request must be a JSON object")
    request_id = request.get("id")
    op = request.get("op")
    if op == "describe":
        return describe(CURRENT_CAPABILITY, request_id)
    if op == "invoke":
        requested = request.get("capability")
        if not isinstance(requested, str):
            return error_response(request_id, "bad-input", "invoke requires a string capability")
        if requested != CURRENT_CAPABILITY:
            return error_response(
                request_id, "unsupported",
                "this worker implements %s, not %s" % (CURRENT_CAPABILITY, requested))
        try:
            output = invoke(CURRENT_CAPABILITY, request.get("input"))
        except ValueError as exc:
            return error_response(request_id, "bad-input", str(exc))
        except Exception as exc:  # a bug in here is an `internal` error, not a crash
            diag("internal error: %s: %s" % (type(exc).__name__, exc))
            return error_response(request_id, "internal", "%s: %s" % (type(exc).__name__, exc))
        return {"id": request_id, "ok": True, "output": output}
    return error_response(request_id, "unsupported", "unknown op: %r" % (op,))


CURRENT_CAPABILITY = ""


def run_protocol() -> int:
    while True:
        line = sys.stdin.readline()
        if line == "":
            break
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError as exc:
            diag("malformed JSON on stdin: %s" % exc)
            write_line(error_response(None, "bad-input", "malformed JSON: %s" % exc))
            continue

        if isinstance(request, dict) and request.get("op") == "shutdown":
            write_line({"id": request.get("id"), "ok": True})
            return 0

        try:
            response = handle(request)
        except Exception as exc:  # never let a handler bug kill the worker silently
            diag("internal error: %s" % exc)
            diag(traceback.format_exc())
            response = error_response(
                request.get("id") if isinstance(request, dict) else None,
                "internal", "%s: %s" % (type(exc).__name__, exc))
        write_line(response)


# ---------------------------------------------------------------------------------------------
# --selfcheck: built-in cases for the contract's edge rules
# ---------------------------------------------------------------------------------------------


def _show(value, limit: int = 120) -> str:
    text = json.dumps(value, ensure_ascii=False, separators=JSON_SEPARATORS)
    if len(text) > limit:
        text = text[:limit] + "..."
    return text


SELFCHECK_CASES = (
    # (name, capability, input, expected output) -- expected None means "idempotency pair".
    ("normalize: empty input stays empty", "text.normalize", {"text": ""}, {"text": ""}),
    ("normalize: full-width ASCII plus small-caps trap",
     "text.normalize", {"text": "\uff23\uff41\uff46\u00e9\u200b"},
     {"text": "cafe"}),
    ("normalize: Latin Extended-A folds (L-stroke, O-acute)",
     "text.normalize", {"text": "\u0141\u00f3d\u017a   \u017b\u00d3\u0141\u0106"},
     {"text": "lodz zolc"}),
    ("normalize: zero-width and bidi controls deleted",
     "text.normalize", {"text": "a\u200bb\u200f\u2060\u2064\ufeffc"},
     {"text": "abc"}),
    ("normalize: U+0130 absent from the lower table, folded by the fold table",
     "text.normalize", {"text": "\u0130stanbul"}, {"text": "istanbul"}),
    ("normalize: CJK passes through untouched",
     "text.normalize", {"text": "\u4f60\u597d\u4e16\u754c \u3053\u3093\u306b\u3061\u306f"},
     {"text": "\u4f60\u597d\u4e16\u754c \u3053\u3093\u306b\u3061\u306f"}),
    ("normalize: combining marks deleted, decomposed equals composed (no NFKC)",
     "text.normalize", {"text": "e\u0301"}, {"text": "e"}),
    ("normalize: combining marks deleted after a non-Latin base, base kept",
     "text.normalize", {"text": "\u0438\u0306"}, {"text": "\u0438"}),
    ("normalize: idempotency pair (curly quotes, em dash, wide space)",
     "text.normalize", {"text": "\u201cDon\u2019t\u201d\u00a0\u2014\u3000\u2018x\u2019\u2026"},
     None),
    ("normalize: NFKC rather than the table (U+FB01 ligature) is left alone",
     "text.normalize", {"text": "\ufb01n"}, {"text": "\ufb01n"}),
    ("normalize: map table then collapse (U+3000, U+2028, U+2026)",
     "text.normalize", {"text": "a\u3000\u3000b\u2028c\u2026d"},
     {"text": "a b c...d"}),
    ("normalize: collapse is one space and trim removes the ends",
     "text.normalize", {"text": " \t a\r\n\r\nb  "}, {"text": "a b"}),
    ("extract: unclosed script swallows the rest",
     "text.extract", {"html": "a<script>bad<p>x", "baseUrl": None},
     {"title": "", "text": "a", "links": [], "images": 0}),
    ("extract: entity without a semicolon is decoded (named only)",
     "text.extract", {"html": "a &amp b &amp; c &notanentity; d", "baseUrl": None},
     {"title": "", "text": "a & b & c &notanentity; d", "links": [], "images": 0}),
    ("extract: named entity with and without the semicolon, no backtracking",
     "text.extract", {"html": "&amp x &amp; y &ampzz", "baseUrl": None},
     {"title": "", "text": "& x & y &ampzz", "links": [], "images": 0}),
    ("extract: entity values are their own character, names case-insensitive",
     "text.extract", {"html": "&nbsp;&mdash;&ndash;&hellip;&laquo;&raquo;&copy;&reg;&trade;&times;&middot;&AMP;", "baseUrl": None},
     {"title": "", "text": "\u00a0\u2014\u2013\u2026\u00ab\u00bb\u00a9\u00ae\u2122\u00d7\u00b7&",
      "links": [], "images": 0}),
    ("extract: numeric entities, decimal and hex, semicolon optional",
     "text.extract", {"html": "&#65;&#x42;&#X43; &#169; &#65no &#x41no", "baseUrl": None},
     {"title": "", "text": "ABC \u00a9 Ano Ano", "links": [], "images": 0}),
    ("extract: links carry href verbatim and absolute by scheme",
     "text.extract",
     {"html": "<a href=\"/x\">Rel</a> <a href=\"HTTP://e/x\">Abs</a>", "baseUrl": "http://b/"},
     {"title": "", "text": "Rel Abs",
      "links": [{"href": "/x", "absolute": False, "text": "Rel"},
                {"href": "HTTP://e/x", "absolute": True, "text": "Abs"}],
      "images": 0}),
    ("extract: unclosed tag at end of input is dropped",
     "text.extract", {"html": "Hello <b", "baseUrl": None},
     {"title": "", "text": "Hello ", "links": [], "images": 0}),
    ("extract: nested anchors follow the browser (both links reported)",
     "text.extract", {"html": "<a href=\"/one\">one<a href=\"/two\">two", "baseUrl": None},
     {"title": "", "text": "onetwo",
      "links": [{"href": "/one", "absolute": False, "text": "one"},
                {"href": "/two", "absolute": False, "text": "two"}], "images": 0}),
    ("extract: nested anchors, inner one properly closed, both reported",
     "text.extract", {"html": "<a href=\"/one\">a<a href=\"/y\">b</a>c</a>", "baseUrl": None},
     {"title": "", "text": "abc",
      "links": [{"href": "/one", "absolute": False, "text": "a"},
                {"href": "/y", "absolute": False, "text": "b"}], "images": 0}),
    ("extract: end of input inside a tag drops the incomplete tag",
     "text.extract", {"html": "<p>abc<b", "baseUrl": None},
     {"title": "", "text": "\nabc", "links": [], "images": 0}),
    ("extract: a lone < at the end is literal text",
     "text.extract", {"html": "a<", "baseUrl": None},
     {"title": "", "text": "a<", "links": [], "images": 0}),
    ("extract: images counted, first title taken and decoded, title absent from text",
     "text.extract", {"html": "<title> A &amp; B </title><p>x<IMG src=q></p>", "baseUrl": None},
     {"title": " A & B ", "text": "\nx\n", "links": [], "images": 1}),
    ("extract: a <title> inside an <a> feeds the title only, not the link text",
     "text.extract", {"html": "<a href=\"/x\"><title>T</title>t</a>", "baseUrl": None},
     {"title": "T", "text": "t",
      "links": [{"href": "/x", "absolute": False, "text": "t"}], "images": 0}),
    ("extract: stray < and a > inside an attribute value",
     "text.extract", {"html": "<p>2 < 3 <a title=\"a>b\" href=\"/q\">L</a></p>", "baseUrl": None},
     {"title": "", "text": "\n2 < 3 L\n",
      "links": [{"href": "/q", "absolute": False, "text": "L"}], "images": 0}),
    ("fingerprint: empty text emits nothing",
     "text.fingerprint", {"text": ""}, {"simhash": "0000000000000000", "tokens": 0, "shingles": 0}),
    ("fingerprint: three tokens make one shingle (hash of exactly that shingle)",
     "text.fingerprint", {"text": "aa bb cc"},
     {"simhash": "c9907bb5c642ac45", "tokens": 3, "shingles": 1}),
    ("fingerprint: leading/trailing ASCII punctuation trimmed before the run rule",
     "text.fingerprint", {"text": "hello, world. (x) \"y\" ..."},
     {"simhash": "80342250f0128200", "tokens": 4, "shingles": 2}),
    ("fingerprint: CJK run of 4 emits 3 overlapping bigrams",
     "text.fingerprint", {"text": "\u5df2\u7ecf\u5df2\u7ecf"},
     {"simhash": "02986de98409853c", "tokens": 3, "shingles": 1}),
    ("fingerprint: CJK run of 6 emits 5 bigrams, shingles of 3",
     "text.fingerprint", {"text": "\u5df2\u7ecf\u5df2\u7ecf\u5df2\u7ecf"},
     {"simhash": "02986de98409853c", "tokens": 5, "shingles": 3}),
)


def run_selfcheck(capability: str) -> int:
    passed = 0
    total = 0
    failures = []
    for name, kind, payload, expected in SELFCHECK_CASES:
        total += 1
        try:
            if kind == "text.normalize":
                first = normalize(payload["text"])
                if expected is None:
                    second = normalize(first)
                    ok = first == second
                    detail = "unstable: %s -> %s" % (_show(first), _show(second))
                    shown = _show({"text": first})
                else:
                    ok = first == expected["text"]
                    detail = "got %s, want %s" % (_show(first), _show(expected["text"]))
                    shown = _show({"text": first})
            elif kind == "text.fingerprint":
                first = fingerprint(payload["text"])
                ok = first == expected
                detail = "got %s, want %s" % (_show(first), _show(expected))
                shown = _show(first)
            else:
                first = extract(payload["html"], payload["baseUrl"])
                ok = first == expected
                detail = "got %s, want %s" % (_show(first), _show(expected))
                shown = _show(first)
        except Exception as exc:
            ok = False
            detail = "raised %s: %s" % (type(exc).__name__, exc)
            shown = detail
        if ok:
            passed += 1
            print("[pass] %s: %s" % (name, shown))
        else:
            failures.append((name, detail))
            print("[FAIL] %s: %s" % (name, detail))

    # Key order is part of the contract: the response must list the fields in the spec's order.
    total += 1
    try:
        envelope = handle({"id": 1, "op": "invoke", "capability": "text.normalize",
                           "input": {"text": "x"}})
        failure_envelope = handle({"id": 2, "op": "invoke", "capability": "text.normalize",
                                   "input": {"text": 7}})
        descriptor = handle({"id": 3, "op": "describe"})
        for cap, want in (
            ("text.normalize", ("text",)),
            ("text.extract", ("title", "text", "links", "images")),
            ("text.fingerprint", ("simhash", "tokens", "shingles")),
        ):
            if cap == "text.normalize":
                out = invoke("text.normalize", {"text": "x"})
            elif cap == "text.fingerprint":
                out = invoke("text.fingerprint", {"text": "x"})
            else:
                out = invoke("text.extract", {"html": "x", "baseUrl": None})
            if tuple(out.keys()) != want:
                raise AssertionError("%s field order is %s, want %s"
                                     % (cap, tuple(out.keys()), want))
        if tuple(envelope.keys()) != ("id", "ok", "output"):
            raise AssertionError("invoke envelope key order is %s" % (tuple(envelope.keys()),))
        if tuple(failure_envelope.keys()) != ("id", "ok", "error"):
            raise AssertionError("error envelope key order is %s"
                                 % (tuple(failure_envelope.keys()),))
        if failure_envelope["error"]["code"] != "bad-input":
            raise AssertionError("a non-string input.text must give bad-input, got %r"
                                 % (failure_envelope["error"]["code"],))
        if tuple(descriptor["worker"].keys()) != ("protocol", "capability", "language", "impl",
                                                  "runtime", "deterministic"):
            raise AssertionError("descriptor key order is %s"
                                 % (tuple(descriptor["worker"].keys()),))
        passed += 1
        print("[pass] protocol: output, error and descriptor field order match the contract")
    except Exception as exc:
        failures.append(("protocol: field order", str(exc)))
        print("[FAIL] protocol: field order: %s" % exc)

    print("%d/%d checks passed" % (passed, total))
    if failures:
        for name, detail in failures:
            diag("selfcheck failure: %s: %s" % (name, detail))
        return 1
    return 0


# ---------------------------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------------------------


def parse_args(argv):
    if argv == ["--selfcheck"]:
        return ("selfcheck", None)
    if len(argv) == 2 and argv[0] == "--capability":
        return ("run", argv[1])
    diag("error: unexpected command line (expected --capability <name> or --selfcheck)")
    diag(USAGE)
    return ("bad", None)


def main(argv) -> int:
    configure_stdio()
    mode, capability = parse_args(argv)
    if mode == "bad":
        return 2

    global CURRENT_CAPABILITY
    try:
        global TABLES
        TABLES = load_tables()
    except Exception as exc:
        diag("error: cannot load the shared tables from %s: %s" % (SPEC_DIR, exc))
        return 2

    if mode == "selfcheck":
        # The capability is irrelevant here (every case calls its function directly), but `handle`
        # is exercised too, so it must not be left empty.
        CURRENT_CAPABILITY = "text.normalize"
        return run_selfcheck("text.normalize")

    if capability not in CAPABILITIES:
        diag("error: unknown --capability %r; this worker implements %s"
             % (capability, ", ".join(CAPABILITIES)))
        return 2

    CURRENT_CAPABILITY = capability
    diag("vmltext.py ready: capability=%s, protocol=%d, spec tables in %s"
         % (capability, PROTOCOL_VERSION, os.path.normpath(SPEC_DIR)))
    return run_protocol()


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except BrokenPipeError:
        sys.exit(0)

