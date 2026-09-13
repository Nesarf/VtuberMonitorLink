#!/usr/bin/env python3
"""vmlllm.py - the Python worker of the multilingual layer for `llm.parse`.

Implements the capability of docs/WORKERS.md section 11 behind the stdio JSON-Lines protocol of
section 1. It is the *believing* half of the LLM glue: a model answers with a fenced block, with
prose around the object, with a trailing comma, with tags that are not in the vocabulary, with the
same tag twice in two spellings, with a summary longer than the field can hold. Asking a model -
HTTP, retries, a key, a budget - is I/O and stays in the application; turning the answer into a
small, checked structure and saying what had to be thrown away is pure text work, and that is the
part several languages get subtly and silently different.

Standard library only. No third-party packages, no network, no build step.

Usage:
    python workers/python/vmlllm.py --capability llm.parse
    python workers/python/vmlllm.py --selfcheck

Five of the contract's rules exist because a runtime's default would otherwise decide the answer,
and each of them is a trap in Python specifically:

  * whitespace is the ASCII set (space, tab, LF, CR) and not `str.strip()`, which also strips
    U+00A0 and U+3000 - a tag padded with a no-break space must *not* be trimmed into a match;
  * folding is `A`-`Z` to `a`-`z` and not `str.lower()`, which folds the Kelvin sign U+212A to `k`
    and would return a tag the application never defined;
  * JSON is RFC 8259 and not `json.loads`, which accepts the bare tokens `NaN`, `Infinity` and
    `-Infinity` unless it is told not to;
  * truncation counts code points, not UTF-16 code units or bytes, and a JSON text for a
    non-string element has to survive astral characters;
  * the order of every list and of every object is part of the answer.
"""

from __future__ import annotations

import json
import sys
import traceback

CAPABILITIES = ("llm.parse",)
PROTOCOL_VERSION = 1
LANGUAGE = "python"
IMPL = "scan-and-check"
USAGE = "usage: vmlllm.py --capability llm.parse | --selfcheck"

# Compact separators and raw non-ASCII, the same choice the Python text worker makes: the contract
# fixes the encoding (UTF-8) and the key order, and `dict` preserves insertion order.
JSON_SEPARATORS = (",", ":")

# ---------------------------------------------------------------------------------------------
# Section 1.2, the Windows encoding trap: the transport is UTF-8 bytes on all three streams.
# ---------------------------------------------------------------------------------------------


def configure_stdio() -> None:
    """UTF-8 on stdin/stdout/stderr, with no newline translation on the protocol stream.

    stdout is written as bytes by `write_line`, so every line ends in a lone LF on every platform,
    which is what "byte-identical output JSON" requires. `newline=""` on stdout would be the other
    way to stop a CR LF; writing bytes is the one that also survives a text-mode console.
    """
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", newline="\n")  # type: ignore[union-attr]
        except (AttributeError, ValueError, OSError):
            pass


def write_line(payload: dict) -> None:
    """Write one protocol line: compact UTF-8 JSON, one LF, nothing else.

    `errors="surrogatepass"` is the same choice vmltext.py makes: it cannot trigger on the answers
    this capability produces, and a worker that raises while answering is worse than one that
    writes an odd byte for input no language can agree about anyway.
    """
    line = json.dumps(payload, ensure_ascii=False, separators=JSON_SEPARATORS)
    sys.stdout.buffer.write(line.encode("utf-8", "surrogatepass") + b"\n")
    sys.stdout.buffer.flush()


def diag(message: str) -> None:
    """Free-form English diagnostics go to stderr, never to stdout."""
    sys.stderr.write(message + "\n")
    sys.stderr.flush()


# ---------------------------------------------------------------------------------------------
# The two character sets the contract defines, and the one runtime default it replaces.
# ---------------------------------------------------------------------------------------------

# Rule 4/5/8: "trimmed of leading and trailing whitespace" is the ASCII set of section 11 (the same
# four characters text.normalize's step 5 collapses). `str.strip()` is NOT this function: it strips
# the whole Unicode whitespace property, so it would turn a tag padded with U+00A0 into a
# vocabulary match that the contract says it is not.
ASCII_WHITESPACE = " \t\n\r"

# Rule 9: `repaired` is decided by comparing the payload slice with "the whole trimmed input", and
# the reference implements "trimmed" with JavaScript's `String.prototype.trim`. That is a *wider*
# set than ASCII_WHITESPACE - it includes U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F,
# U+205F, U+3000 and U+FEFF - and the difference is observable: an answer whose object is followed
# by a non-breaking space is `repaired: false` under the reference and would be `repaired: true`
# under an ASCII-only comparison. The two sets are therefore kept apart here on purpose:
# ASCII_WHITESPACE trims tags and summaries (rules 4 and 8), JS_TRIM_CHARS decides `repaired`.
#
# Python's `str.strip()` is not this set either: it does not strip U+FEFF, and it *does* strip
# U+001C-U+001F and U+0085, which JavaScript's trim leaves alone - checked against Node rather than
# assumed, because that difference is the same kind of near-miss as `str.strip()` versus rule 4.
JS_TRIM_CHARS = (
    "\t\n\v\f\r "
    "\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)

_ASCII_UPPER = {cp: cp + 32 for cp in range(0x41, 0x5B)}


def trim_ascii(text: str) -> str:
    """Trim the four ASCII whitespace characters, and nothing else (rules 4 and 8)."""
    start = 0
    end = len(text)
    while start < end and text[start] in ASCII_WHITESPACE:
        start += 1
    while end > start and text[end - 1] in ASCII_WHITESPACE:
        end -= 1
    return text[start:end]


def js_trim(text: str) -> str:
    """Trim what `String.prototype.trim` trims, for the `repaired` comparison of rule 9."""
    start = 0
    end = len(text)
    while start < end and text[start] in JS_TRIM_CHARS:
        start += 1
    while end > start and text[end - 1] in JS_TRIM_CHARS:
        end -= 1
    return text[start:end]


def fold_ascii(text: str) -> str:
    """Fold `A`-`Z` to `a`-`z`, and nothing else (rule 5).

    `str.lower()` is NOT this function: it is Unicode-aware, and it maps the Kelvin sign U+212A to
    `k` and the dotted capital I U+0130 to `i` + U+0307. Either would make an unmatched tag match a
    vocabulary entry and return a tag the application never defined. It is also locale-independent
    by construction, so the answer cannot depend on the interface language of the machine.
    """
    return text.translate(_ASCII_UPPER)


def utf8_key(text: str):
    """The ordering key every ordering in this layer uses: UTF-8 bytes.

    For well-formed text this is the same order as comparing code points (UTF-8 preserves it), so
    the explicit encoding is not decoration: it is the rule written where it is applied.
    """
    return text.encode("utf-8", "surrogatepass")


# ---------------------------------------------------------------------------------------------
# Capability llm.parse (section 11)
# ---------------------------------------------------------------------------------------------


class BadInput(Exception):
    """`bad-input`: a malformed request, answered as an error envelope and never as a guess."""


def _bad(message: str) -> BadInput:
    return BadInput(message)


def is_integer(value) -> bool:
    """`Number.isInteger` as the reference means it: a real integer, not a bool.

    In Python `isinstance(True, int)` is true, so a JSON `true` would otherwise be accepted as a
    limit; in JavaScript `Number.isInteger(true)` is false. The corpus does not carry that case,
    which is exactly why it is checked here.
    """
    return isinstance(value, int) and not isinstance(value, bool)


def first_object_slice(text: str):
    """The first complete JSON object in `text`, ignoring braces inside strings. None when none.

    Rule 1: braces are counted by depth, a string opens at an unescaped `"` and closes at the next
    unescaped `"`, and a backslash escapes exactly the character after it. A text with no `{`, or
    one whose braces never balance, has no payload - which is a normal event, not an error.
    """
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escaped = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def drop_trailing_commas(slice_text: str):
    """Rule 2, the one repair: a comma followed by whitespace and `}` or `]` is dropped.

    A comma inside a string is a character of that string, so string state is tracked here exactly
    as it is in the payload scan. A repair that does not track it corrupts data - `{"a": "x,}"}`
    would lose a character of the answer - and the contract is explicit that precision beats
    tolerance. Returns (text, removed).
    """
    out = []
    in_string = False
    escaped = False
    removed = 0
    i = 0
    n = len(slice_text)
    while i < n:
        ch = slice_text[i]
        if in_string:
            out.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
            continue
        if ch == ",":
            j = i + 1
            while j < n and slice_text[j] in ASCII_WHITESPACE:
                j += 1
            if j < n and slice_text[j] in "}]":
                removed += 1
                i += 1          # the comma goes; the whitespace after it stays
                continue
        out.append(ch)
        i += 1
    return "".join(out), removed


def _reject_constant(token: str):
    """`parse_constant` hook: RFC 8259 has no `NaN`, `Infinity` or `-Infinity` (rule 3).

    `json.loads` accepts those three bare tokens by default, which turns a malformed answer into a
    number nobody asked for and calls it a success. Raising here makes them a parse failure, which
    the contract answers with no payload at all. `strict=True` (the default) already rejects an
    unescaped control character inside a string, which is the other half of "JSON means RFC 8259".
    """
    raise ValueError("not JSON: %s" % token)


def parse_payload(slice_text: str):
    """Rule 3: parse the slice as RFC 8259 JSON. Returns the object, or None for no payload.

    Only an object is a payload: an array or a scalar that happens to contain braces is not the
    answer that was asked for. Nothing is recovered from a failure - a parser that half-reads a
    broken answer is worse than one that reports nothing, because the application cannot tell the
    difference afterwards.
    """
    try:
        value = json.loads(slice_text, parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        return None
    if isinstance(value, dict):
        return value
    return None


def _json_number_text(value) -> str:
    """JSON text for a number, in the shortest round-trip form JSON.stringify would use.

    The contract keeps non-integer numbers out of this capability on purpose ("serializing a float
    is a formatting decision that each language makes differently"), and the corpus carries none.
    Integers - the only case the contract promises - are exact and identical in both languages.
    """
    if isinstance(value, bool):                          # unreachable here, but never `True`/`False`
        return "true" if value else "false"
    if isinstance(value, int):
        # `JSON.stringify(-0)` is `0`: JavaScript has one zero. Python keeps the sign on both the
        # parsed integer `-0` and the float, so it has to be said explicitly.
        return "0" if value == 0 else str(value)
    if value != value:                                   # NaN, reachable only through a literal
        return "null"
    if value in (float("inf"), float("-inf")):
        return "null"
    if value == int(value) and abs(value) < 1e21:
        integral = int(value)
        return "0" if integral == 0 else str(integral)
    # Outside the contract's scope (see the docstring), so this only has to be deterministic and
    # to agree with itself: `repr` of a float round-trips, which is the shortest form's purpose.
    return repr(value)


def json_text(value) -> str:
    """JSON text with no insignificant whitespace, for a `value` the report has to name (rule 4).

    A non-string element of `tags` is reported this way because it is the only form the report can
    compare across languages: `{"a": 1, "b": [2, 3]}` is `{"a":1,"b":[2,3]}`, `42` is `42`, `null`
    is `null`, and a string keeps its JSON form, quotes and escapes included. Key order is the
    order the model wrote, which is the order the parser preserved.
    """
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=True, separators=JSON_SEPARATORS)
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "null"
    if isinstance(value, (int, float)):
        return _json_number_text(value)
    if isinstance(value, list):
        return "[" + ",".join(json_text(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(
            json.dumps(key, ensure_ascii=True, separators=JSON_SEPARATORS) + ":" + json_text(item)
            for key, item in value.items()) + "}"
    return json.dumps(value, ensure_ascii=True, separators=JSON_SEPARATORS)


def _read_input_fields(payload: dict):
    """Rules 7: the three optional fields, validated before any parsing is attempted.

    The order of the checks is the order the reference applies them, because the corpus compares
    the error *code* and a request with two problems has to give the same one in every language.
    """
    raw = payload.get("raw")
    if not isinstance(raw, str):
        raise _bad("input.raw must be a string")

    vocabulary_input = payload.get("vocabulary")
    if vocabulary_input is None:
        vocabulary_input = []
    if not isinstance(vocabulary_input, list):
        raise _bad("input.vocabulary must be an array")
    for entry in vocabulary_input:
        if not isinstance(entry, str):
            raise _bad("every vocabulary entry must be a string")

    max_tags = payload.get("maxTags")
    if max_tags is None:
        max_tags = 0
    if not is_integer(max_tags) or max_tags < 0:
        raise _bad("maxTags must be a non-negative integer")

    max_summary_chars = payload.get("maxSummaryChars")
    if max_summary_chars is None:
        max_summary_chars = 0
    if not is_integer(max_summary_chars) or max_summary_chars < 0:
        raise _bad("maxSummaryChars must be a non-negative integer")

    return raw, vocabulary_input, max_tags, max_summary_chars


def _strip_fence(raw: str):
    """Rule 1, first half: the fence. Returns (body, fenced).

    A fence is three backticks at the first non-whitespace position of the answer; the rest of that
    line goes with it, and the body ends at the next line whose content is exactly three backticks
    - a trailing carriage return is a line ending, not content, because model output arrives over
    HTTP with either line ending - or at the end of the input when there is none.
    """
    first = 0
    while first < len(raw) and raw[first] in ASCII_WHITESPACE:
        first += 1
    if first >= len(raw) or not raw.startswith("```", first):
        return raw, False

    newline = raw.find("\n", first)
    if newline < 0:
        return "", True                       # the fence is the whole answer: nothing inside it
    body = raw[newline + 1:]
    lines = body.split("\n")
    for index, line in enumerate(lines):
        content = line[:-1] if line.endswith("\r") else line
        if content == "```":
            body = "\n".join(lines[:index])
            break
    return body, True


def parse_answer(payload) -> dict:
    """Rules 1-10 of section 11. Pure: no clock, no randomness, no network, no floats."""
    if not isinstance(payload, dict):
        raise _bad("input must be an object")
    raw, vocabulary, max_tags, max_summary_chars = _read_input_fields(payload)

    # 1. the fence, then the first complete object inside whatever is left
    body, fenced = _strip_fence(raw)
    slice_text = first_object_slice(body)

    payload_object = None
    comma_repairs = 0
    if slice_text is None:
        # No complete object at all: prose, an empty answer, or JSON that never closes. The answer
        # is empty and `repaired` says the answer arrived wrong - no partial recovery is attempted.
        repaired = True
    else:
        # Rule 9: the slice being the whole trimmed input means the answer arrived as the object.
        # `js_trim` and not `trim_ascii` - the comparison is with the reference's trim, and the
        # difference is observable for a trailing U+00A0 (see JS_TRIM_CHARS above).
        repaired = fenced or slice_text != js_trim(raw)
        fixed, comma_repairs = drop_trailing_commas(slice_text)
        if comma_repairs > 0:
            repaired = True
        payload_object = parse_payload(fixed)
        if payload_object is None:
            repaired = True

    # 4-6. the tags: type, trimming, matching, duplicates
    dropped = []
    accepted = []
    tags_value = payload_object.get("tags") if payload_object else None
    if isinstance(tags_value, list):
        index = {}
        for entry in vocabulary:
            key = fold_ascii(entry)
            if key not in index:
                index[key] = entry          # the first spelling of a vocabulary entry wins
        for element in tags_value:
            if not isinstance(element, str):
                dropped.append({"value": json_text(element), "reason": "not-a-string"})
                continue
            tag = trim_ascii(element)   # ASCII whitespace only: U+00A0 and U+3000 stay in the tag
            if tag == "":
                dropped.append({"value": "", "reason": "empty"})
                continue
            key = fold_ascii(tag)
            if key not in index:
                # Reported with the trimmed tag as it arrived, never guessed into a neighbour.
                dropped.append({"value": tag, "reason": "not-in-vocabulary"})
                continue
            canonical = index[key]
            if canonical in accepted:
                dropped.append({"value": canonical, "reason": "duplicate"})
                continue
            accepted.append(canonical)

    # 7. the limit, applied after deduplication, in the model's own order
    if max_tags > 0 and len(accepted) > max_tags:
        tags = accepted[:max_tags]
    else:
        tags = list(accepted)
    for extra in accepted[len(tags):]:
        dropped.append({"value": extra, "reason": "over-limit"})

    # 8. the summary: a non-string is empty, the rest is trimmed and truncated by code points
    summary_value = payload_object.get("summary") if payload_object else None
    summary = trim_ascii(summary_value) if isinstance(summary_value, str) else ""
    truncated = 0
    if max_summary_chars > 0 and len(summary) > max_summary_chars:
        # Python strings are sequences of code points, so `len` and slicing are already the
        # contract's unit. A UTF-16 or bytes-based implementation cuts an astral character in half
        # here and produces something that is not text.
        truncated = len(summary) - max_summary_chars
        summary = summary[:max_summary_chars]

    # 10. the report: sorted by value then reason, each as UTF-8 bytes
    dropped.sort(key=lambda entry: (utf8_key(entry["value"]), utf8_key(entry["reason"])))

    return {
        "tags": tags,
        "summary": summary,
        "dropped": dropped,
        "repaired": repaired,
        "counts": {"tags": len(tags), "dropped": len(dropped), "truncated": truncated},
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
            output = parse_answer(request.get("input") if request.get("input") is not None else {})
        except BadInput as exc:
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
# --selfcheck: the contract's edge rules, each pinned where a runtime default would decide it
# ---------------------------------------------------------------------------------------------

# A summary of four astral characters and two letters, used by the two truncation cases.
EMOJI_SUMMARY = '{"summary": "\U0001F600\U0001F600ab"}'

SELFCHECK_CASES = (
    ("a clean object needs no repair",
     {"raw": '{"tags": ["debut"], "summary": "ok"}', "vocabulary": ["debut"]},
     {"tags": ["debut"], "summary": "ok", "dropped": [], "repaired": False,
      "counts": {"tags": 1, "dropped": 0, "truncated": 0}}),
    ("a fenced answer is found, and the fence counts as repaired",
     {"raw": 'Sure!\n```json\n{"tags": ["debut"], "summary": "ok"}\n```\n', "vocabulary": ["debut"]},
     {"tags": ["debut"], "summary": "ok", "dropped": [], "repaired": True,
      "counts": {"tags": 1, "dropped": 0, "truncated": 0}}),
    ("a fence with CRLF endings closes at a line whose content is the fence",
     {"raw": '```json\r\n{"tags": ["debut"]}\r\n```\r\n', "vocabulary": ["debut"]},
     {"tags": ["debut"], "summary": "", "dropped": [], "repaired": True,
      "counts": {"tags": 1, "dropped": 0, "truncated": 0}}),
    ("a fence that is the whole answer has nothing inside it",
     {"raw": '```json', "vocabulary": ["debut"]},
     {"tags": [], "summary": "", "dropped": [], "repaired": True,
      "counts": {"tags": 0, "dropped": 0, "truncated": 0}}),
    ("prose around the object is discarded and counts as repaired",
     {"raw": 'Here you go: {"tags": ["debut"]} Let me know.', "vocabulary": ["debut"]},
     {"tags": ["debut"], "summary": "", "dropped": [], "repaired": True,
      "counts": {"tags": 1, "dropped": 0, "truncated": 0}}),
    ("braces inside a string do not end the payload",
     {"raw": 'prose {"summary": "a } b { c", "tags": ["debut"]} more', "vocabulary": ["debut"]},
     {"tags": ["debut"], "summary": "a } b { c", "dropped": [], "repaired": True,
      "counts": {"tags": 1, "dropped": 0, "truncated": 0}}),
    ("an escaped quote inside a string does not end it",
     {"raw": '{"summary": "say \\"ok\\" now", "tags": []}'},
     {"tags": [], "summary": 'say "ok" now', "dropped": [], "repaired": False,
      "counts": {"tags": 0, "dropped": 0, "truncated": 0}}),
    ("a trailing comma in an object is the one repair",
     {"raw": '{"tags": ["debut"], "summary": "ok",}', "vocabulary": ["debut"]},
     {"tags": ["debut"], "summary": "ok", "dropped": [], "repaired": True,
      "counts": {"tags": 1, "dropped": 0, "truncated": 0}}),
    ("a trailing comma in an array is the same repair",
     {"raw": '{"tags": ["debut" ,\n  ], "summary": "ok"}', "vocabulary": ["debut"]},
     {"tags": ["debut"], "summary": "ok", "dropped": [], "repaired": True,
      "counts": {"tags": 1, "dropped": 0, "truncated": 0}}),
    ("a comma inside a string is data, not a trailing comma",
     {"raw": '{"summary": "a,}", "tags": []}'},
     {"tags": [], "summary": "a,}", "dropped": [], "repaired": False,
      "counts": {"tags": 0, "dropped": 0, "truncated": 0}}),
    ("a comma followed by a bracket inside a string is data as well",
     {"raw": '{"tags": ["debut"], "summary": "x , ] y",}', "vocabulary": ["debut"]},
     {"tags": ["debut"], "summary": "x , ] y", "dropped": [], "repaired": True,
      "counts": {"tags": 1, "dropped": 0, "truncated": 0}}),
    ("an array is not the payload: only an object is",
     {"raw": '[1, 2]', "vocabulary": ["debut"]},
     {"tags": [], "summary": "", "dropped": [], "repaired": True,
      "counts": {"tags": 0, "dropped": 0, "truncated": 0}}),
    ("broken JSON yields nothing and says it was repaired",
     {"raw": '{"tags": ["debut"', "vocabulary": ["debut"]},
     {"tags": [], "summary": "", "dropped": [], "repaired": True,
      "counts": {"tags": 0, "dropped": 0, "truncated": 0}}),
    ("an answer with no object at all is not an error",
     {"raw": "I am not sure what you want."},
     {"tags": [], "summary": "", "dropped": [], "repaired": True,
      "counts": {"tags": 0, "dropped": 0, "truncated": 0}}),
    ("the empty answer behaves like prose with nothing in it",
     {"raw": ""},
     {"tags": [], "summary": "", "dropped": [], "repaired": True,
      "counts": {"tags": 0, "dropped": 0, "truncated": 0}}),
    ("a tags field that is a string contributes nothing and is not guessed into a list",
     {"raw": '{"tags": "debut, 3d"}', "vocabulary": ["debut", "3d"]},
     {"tags": [], "summary": "", "dropped": [], "repaired": False,
      "counts": {"tags": 0, "dropped": 0, "truncated": 0}}),
    ("the vocabulary spelling wins over the model spelling",
     {"raw": '{"tags": ["DEBUT"]}', "vocabulary": ["debut"]},
     {"tags": ["debut"], "summary": "", "dropped": [], "repaired": False,
      "counts": {"tags": 1, "dropped": 0, "truncated": 0}}),
    ("a tag outside the vocabulary is dropped and named as it arrived",
     {"raw": '{"tags": ["singing"]}', "vocabulary": ["debut"]},
     {"tags": [], "summary": "", "dropped": [{"value": "singing", "reason": "not-in-vocabulary"}],
      "repaired": False, "counts": {"tags": 0, "dropped": 1, "truncated": 0}}),
    ("the same tag in three spellings is one tag and two duplicates",
     {"raw": '{"tags": ["debut", "Debut", "DEBUT"]}', "vocabulary": ["debut"]},
     {"tags": ["debut"], "summary": "",
      "dropped": [{"value": "debut", "reason": "duplicate"},
                  {"value": "debut", "reason": "duplicate"}],
      "repaired": False, "counts": {"tags": 1, "dropped": 2, "truncated": 0}}),
    ("maxTags keeps the first tags in the model's order, after deduplication",
     {"raw": '{"tags": ["3d", "debut", "karaoke", "debut"]}',
      "vocabulary": ["debut", "3d", "karaoke"], "maxTags": 2},
     {"tags": ["3d", "debut"], "summary": "",
      "dropped": [{"value": "debut", "reason": "duplicate"},
                  {"value": "karaoke", "reason": "over-limit"}],
      "repaired": False, "counts": {"tags": 2, "dropped": 2, "truncated": 0}}),
    ("an empty tag and a non-string element are dropped with their own reasons",
     {"raw": '{"tags": ["  ", 7, ["x"], "debut"]}', "vocabulary": ["debut"]},
     {"tags": ["debut"], "summary": "",
      "dropped": [{"value": "", "reason": "empty"},
                  {"value": "7", "reason": "not-a-string"},
                  {"value": "[\"x\"]", "reason": "not-a-string"}],
      "repaired": False, "counts": {"tags": 1, "dropped": 3, "truncated": 0}}),
    ("a non-string element is reported as its JSON text, not as a Python repr",
     {"raw": '{"tags": [{"a": 1, "b": [2, 3]}, true, null, 42, -0]}'},
     {"tags": [], "summary": "",
      "dropped": [{"value": "0", "reason": "not-a-string"},
                  {"value": "42", "reason": "not-a-string"},
                  {"value": "null", "reason": "not-a-string"},
                  {"value": "true", "reason": "not-a-string"},
                  {"value": "{\"a\":1,\"b\":[2,3]}", "reason": "not-a-string"}],
      "repaired": False, "counts": {"tags": 0, "dropped": 5, "truncated": 0}}),
    ("an integer larger than 2^53 keeps its own digits, which the reference cannot",
     # Deliberate, documented divergence: rule 4 says "integers as decimal digits", and this
     # implementation writes the digits the model sent. The reference passes the number through a
     # JavaScript Number, so it answers 9007199254740992 here - it cannot do otherwise, since the
     # value is already rounded before the report is built. `counts` and every other field agree.
     {"raw": '{"tags": [9007199254740993]}'},
     {"tags": [], "summary": "",
      "dropped": [{"value": "9007199254740993", "reason": "not-a-string"}],
      "repaired": False, "counts": {"tags": 0, "dropped": 1, "truncated": 0}}),
    ("the summary is truncated by code points and the count is code points",
     {"raw": EMOJI_SUMMARY, "maxSummaryChars": 3},
     {"tags": [], "summary": "\U0001F600\U0001F600a", "dropped": [], "repaired": False,
      "counts": {"tags": 0, "dropped": 0, "truncated": 1}}),
    ("truncation never cuts an astral character in half",
     {"raw": '{"summary": "ab\U0001F600"}', "maxSummaryChars": 2},
     {"tags": [], "summary": "ab", "dropped": [], "repaired": False,
      "counts": {"tags": 0, "dropped": 0, "truncated": 1}}),
    ("a summary limit of zero means no limit",
     {"raw": '{"summary": "a summary that stays whole"}', "maxSummaryChars": 0},
     {"tags": [], "summary": "a summary that stays whole", "dropped": [], "repaired": False,
      "counts": {"tags": 0, "dropped": 0, "truncated": 0}}),
    ("trailing ASCII whitespace around the object is not a repair",
     {"raw": '{"tags": ["debut"]} ', "vocabulary": ["debut"]},
     {"tags": ["debut"], "summary": "", "dropped": [], "repaired": False,
      "counts": {"tags": 1, "dropped": 0, "truncated": 0}}),
    ("trailing U+00A0 around the object is not a repair either, because the reference trims it",
     {"raw": '{"tags": ["debut"]}\u00a0', "vocabulary": ["debut"]},
     {"tags": ["debut"], "summary": "", "dropped": [], "repaired": False,
      "counts": {"tags": 1, "dropped": 0, "truncated": 0}}),
    ("trailing U+1680 is trimmed by JavaScript's trim, so it is not a repair either",
     {"raw": '{"tags": ["debut"]}\u1680', "vocabulary": ["debut"]},
     {"tags": ["debut"], "summary": "", "dropped": [], "repaired": False,
      "counts": {"tags": 1, "dropped": 0, "truncated": 0}}),
    ("U+001C after the object is not trimmed by the reference, so the answer counts as repaired",
     {"raw": '{"tags": ["debut"]}\u001c', "vocabulary": ["debut"]},
     {"tags": ["debut"], "summary": "", "dropped": [], "repaired": True,
      "counts": {"tags": 1, "dropped": 0, "truncated": 0}}),
    ("U+0085 after the object is not trimmed either",
     {"raw": '{"tags": ["debut"]}\u0085', "vocabulary": ["debut"]},
     {"tags": ["debut"], "summary": "", "dropped": [], "repaired": True,
      "counts": {"tags": 1, "dropped": 0, "truncated": 0}}),
    ("a paired surrogate escape decodes to the astral character it encodes",
     {"raw": '{"tags": ["\\ud83d\\ude00"]}'},
     {"tags": [], "summary": "",
      "dropped": [{"value": "\U0001F600", "reason": "not-in-vocabulary"}],
      "repaired": False, "counts": {"tags": 0, "dropped": 1, "truncated": 0}}),
    ("a tag padded with ASCII whitespace is trimmed into a match",
     {"raw": '{"tags": ["\\tdebut\\n"]}', "vocabulary": ["debut"]},
     {"tags": ["debut"], "summary": "", "dropped": [], "repaired": False,
      "counts": {"tags": 1, "dropped": 0, "truncated": 0}}),
    ("U+00A0 is not whitespace: the tag is not trimmed into a match",
     {"raw": '{"tags": ["\u00a0debut"]}', "vocabulary": ["debut"]},
     {"tags": [], "summary": "",
      "dropped": [{"value": "\u00a0debut", "reason": "not-in-vocabulary"}],
      "repaired": False, "counts": {"tags": 0, "dropped": 1, "truncated": 0}}),
    ("U+3000 is not whitespace either",
     {"raw": '{"tags": ["\u3000debut"]}', "vocabulary": ["debut"]},
     {"tags": [], "summary": "",
      "dropped": [{"value": "\u3000debut", "reason": "not-in-vocabulary"}],
      "repaired": False, "counts": {"tags": 0, "dropped": 1, "truncated": 0}}),
    ("a summary padded with U+00A0 keeps it, because trimming is the ASCII set",
     {"raw": '{"summary": "\u00a0ok\u00a0"}'},
     {"tags": [], "summary": "\u00a0ok\u00a0", "dropped": [], "repaired": False,
      "counts": {"tags": 0, "dropped": 0, "truncated": 0}}),
    ("folding is ASCII-only: the Kelvin sign is not the letter k",
     {"raw": '{"tags": ["\u212a"]}', "vocabulary": ["k"]},
     {"tags": [], "summary": "",
      "dropped": [{"value": "\u212a", "reason": "not-in-vocabulary"}],
      "repaired": False, "counts": {"tags": 0, "dropped": 1, "truncated": 0}}),
    ("folding is ASCII-only: the dotted capital I is not the letter i",
     {"raw": '{"tags": ["\u0130"]}', "vocabulary": ["i"]},
     {"tags": [], "summary": "",
      "dropped": [{"value": "\u0130", "reason": "not-in-vocabulary"}],
      "repaired": False, "counts": {"tags": 0, "dropped": 1, "truncated": 0}}),
    ("a bare NaN is not JSON: no payload and no recovery",
     {"raw": '{"tags": [NaN]}', "vocabulary": ["debut"]},
     {"tags": [], "summary": "", "dropped": [], "repaired": True,
      "counts": {"tags": 0, "dropped": 0, "truncated": 0}}),
    ("bare Infinity and -Infinity are not JSON either",
     {"raw": '{"tags": [Infinity, -Infinity]}', "vocabulary": ["debut"]},
     {"tags": [], "summary": "", "dropped": [], "repaired": True,
      "counts": {"tags": 0, "dropped": 0, "truncated": 0}}),
    ("an unescaped control character inside a string is not JSON",
     {"raw": '{"tags": ["debut\nkaraoke"]}', "vocabulary": ["debut", "karaoke"]},
     {"tags": [], "summary": "", "dropped": [], "repaired": True,
      "counts": {"tags": 0, "dropped": 0, "truncated": 0}}),
    ("an astral character in an unmatched tag survives into the report",
     {"raw": '{"tags": ["\U0001F600debut", "debut"]}', "vocabulary": ["debut"]},
     {"tags": ["debut"], "summary": "",
      "dropped": [{"value": "\U0001F600debut", "reason": "not-in-vocabulary"}],
      "repaired": False, "counts": {"tags": 1, "dropped": 1, "truncated": 0}}),
    ("the report is sorted by value then reason as UTF-8 bytes",
     {"raw": '{"tags": ["zeta", "alpha", "Alpha"]}', "vocabulary": ["alpha"]},
     {"tags": ["alpha"], "summary": "",
      "dropped": [{"value": "alpha", "reason": "duplicate"},
                  {"value": "zeta", "reason": "not-in-vocabulary"}],
      "repaired": False, "counts": {"tags": 1, "dropped": 2, "truncated": 0}}),
    ("a summary that is not a string is empty while the tags still work",
     {"raw": '{"summary": ["a", "b"], "tags": ["debut"]}', "vocabulary": ["debut"]},
     {"tags": ["debut"], "summary": "", "dropped": [], "repaired": False,
      "counts": {"tags": 1, "dropped": 0, "truncated": 0}}),
)


def _show(value, limit: int = 160) -> str:
    text = json.dumps(value, ensure_ascii=False, separators=JSON_SEPARATORS)
    if len(text) > limit:
        text = text[:limit] + "..."
    return text


def run_selfcheck() -> int:
    """The case list plus the protocol and ordering checks. One English line per case."""
    passed = 0
    total = 0
    failures = []
    for name, request, expected in SELFCHECK_CASES:
        total += 1
        try:
            got = parse_answer(request)
            ok = got == expected
            detail = "got %s, want %s" % (_show(got), _show(expected))
            shown = _show(got)
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

    # A property the case list states one case at a time: the same answer twice gives the same
    # bytes, and the field order is the contract's. Key order is part of the answer here, because
    # the harness compares the output as JSON and a dict built in another order is another answer.
    total += 1
    try:
        first = parse_answer({"raw": '{"tags": ["3d", "debut", "karaoke"]}',
                              "vocabulary": ["karaoke", "debut", "3d"], "maxTags": 2})
        second = parse_answer({"raw": '{"tags": ["3d", "debut", "karaoke"]}',
                               "vocabulary": ["karaoke", "debut", "3d"], "maxTags": 2})
        if tuple(first.keys()) != ("tags", "summary", "dropped", "repaired", "counts"):
            raise AssertionError("output field order is %s" % (tuple(first.keys()),))
        if tuple(first["counts"].keys()) != ("tags", "dropped", "truncated"):
            raise AssertionError("counts field order is %s" % (tuple(first["counts"].keys()),))
        if first["dropped"] and tuple(first["dropped"][0].keys()) != ("value", "reason"):
            raise AssertionError("dropped[] key order is %s" % (tuple(first["dropped"][0].keys()),))
        if json.dumps(first, ensure_ascii=False, separators=JSON_SEPARATORS) != json.dumps(
                second, ensure_ascii=False, separators=JSON_SEPARATORS):
            raise AssertionError("two identical requests produced two different answers")
        passed += 1
        print("[pass] protocol: field order is the contract's and two runs agree byte for byte")
    except Exception as exc:
        failures.append(("protocol: field order", str(exc)))
        print("[FAIL] protocol: field order: %s" % exc)

    # The protocol surface: envelopes, the descriptor, and the capability guard. `handle` is the
    # code the host actually talks to, so it is exercised here and not only in the case list.
    total += 1
    try:
        ok_envelope = handle({"id": 1, "op": "invoke", "capability": "llm.parse",
                              "input": {"raw": "{}"}})
        bad_envelope = handle({"id": 2, "op": "invoke", "capability": "llm.parse",
                               "input": {"raw": 5}})
        wrong_capability = handle({"id": 3, "op": "invoke", "capability": "text.normalize",
                                   "input": {"raw": "{}"}})
        descriptor = handle({"id": 4, "op": "describe"})
        if tuple(ok_envelope.keys()) != ("id", "ok", "output"):
            raise AssertionError("invoke envelope key order is %s" % (tuple(ok_envelope.keys()),))
        if tuple(bad_envelope.keys()) != ("id", "ok", "error"):
            raise AssertionError("error envelope key order is %s" % (tuple(bad_envelope.keys()),))
        if bad_envelope["error"]["code"] != "bad-input":
            raise AssertionError("a non-string input.raw must give bad-input, got %r"
                                 % (bad_envelope["error"]["code"],))
        if wrong_capability["error"]["code"] != "unsupported":
            raise AssertionError("another capability must give unsupported, got %r"
                                 % (wrong_capability["error"]["code"],))
        if tuple(descriptor["worker"].keys()) != ("protocol", "capability", "language", "impl",
                                                  "runtime", "deterministic"):
            raise AssertionError("descriptor key order is %s"
                                 % (tuple(descriptor["worker"].keys()),))
        if descriptor["worker"]["capability"] != "llm.parse":
            raise AssertionError("descriptor names %r" % (descriptor["worker"]["capability"],))
        for request, label in (({"raw": "{}", "maxTags": -1}, "a negative maxTags"),
                               ({"raw": "{}", "maxSummaryChars": -1}, "a negative maxSummaryChars"),
                               ({"raw": "{}", "vocabulary": ["ok", 5]},
                                "a vocabulary entry that is not a string"),
                               ({"raw": "{}", "vocabulary": "debut"},
                                "a vocabulary that is not an array"),
                               ({"raw": "{}", "maxTags": True}, "a boolean maxTags"),
                               ({"raw": "{}", "maxTags": 1.5}, "a non-integer maxTags"),
                               ({}, "no raw at all")):
            answer = handle({"id": 5, "op": "invoke", "capability": "llm.parse", "input": request})
            if answer.get("ok") is not False or answer["error"]["code"] != "bad-input":
                raise AssertionError("%s must give bad-input, got %s"
                                     % (label, _show(answer)))
        passed += 1
        print("[pass] protocol: envelopes, descriptor and every bad-input rule answer as specified")
    except Exception as exc:
        failures.append(("protocol: envelopes", str(exc)))
        print("[FAIL] protocol: envelopes: %s" % exc)

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
    if mode == "selfcheck":
        CURRENT_CAPABILITY = "llm.parse"
        return run_selfcheck()

    if capability not in CAPABILITIES:
        diag("error: unknown --capability %r; this worker implements %s"
             % (capability, ", ".join(CAPABILITIES)))
        return 2

    CURRENT_CAPABILITY = capability
    diag("vmlllm.py ready: capability=%s, protocol=%d" % (capability, PROTOCOL_VERSION))
    return run_protocol()


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except BrokenPipeError:
        sys.exit(0)
