// text.extract: the specified state machine of docs/WORKERS.md section 3.
//
// There is no HTML parser in C++ without a dependency and the project has no
// HTML dependency on purpose, so this is a hand-written scanner over the UTF-8
// bytes. Every ASCII delimiter the scanner looks for ('<', '>', '&', '"', '\'')
// is a byte that cannot occur inside a multi-byte UTF-8 sequence, which is what
// makes byte scanning safe here.
//
// **The pass order is the contract's, and it is not the order the rules are
// numbered in.** Section 3: hide every CDATA body first, then remove comments
// and doctypes, then remove the listed elements with their content, and only
// then walk what is left. The remover runs over the raw text, looking for the
// element start, so whether the '<' of a `<style>` happens to sit after
// characters that a *later* tag walk would read as an unclosed tag cannot
// protect it - that walk has not run yet. This file used to do all of that in
// one left-to-right scan, which a seeded differential run against the reference
// caught: `<p t<style>a</style>` kept the style body, and `<p t<p<!DOCTYPE
// html><a href="x">` found an anchor the four other implementations do not.
//
// Section 3 step 8 is honoured: this file never normalizes anything. The
// extracted text keeps its newlines and its runs of whitespace, the title and
// the link texts keep their case and their accents, and the title's own text is
// kept out of `text` (step 5) exactly like a browser rendering it would.
#include "extract.h"

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "utf8.h"

namespace vml {
namespace {

// CDATA bodies hide behind these two private-use code points while the removal
// passes run, and are put back after the walk. Private-use code points cannot
// occur in sampled text by accident, and they contain none of '<', '>' or '&',
// so no rule can mistake a hidden body for markup or for an entity.
const char kCdataOpen[] = "\xEE\x80\x80";   // U+E000
const char kCdataClose[] = "\xEE\x80\x81";  // U+E001

bool IsAsciiAlpha(unsigned char c) { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'); }
bool IsAsciiDigit(unsigned char c) { return c >= '0' && c <= '9'; }
bool IsAsciiAlnum(unsigned char c) { return IsAsciiAlpha(c) || IsAsciiDigit(c); }
bool IsWordChar(char c) {
  const unsigned char u = static_cast<unsigned char>(c);
  return IsAsciiAlnum(u) || c == '_';
}
bool IsHtmlSpace(char c) {
  return c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '\f' || c == '\r';
}
// Section 3, bracket rules: "<" starts a tag only when followed by [A-Za-z/!].
bool IsTagStartChar(unsigned char c) { return IsAsciiAlpha(c) || c == '/' || c == '!'; }
// Name characters of the tag-name pattern [A-Za-z][A-Za-z0-9:-]*.
bool IsTagNameChar(char c) {
  const unsigned char u = static_cast<unsigned char>(c);
  return IsAsciiAlnum(u) || c == ':' || c == '-';
}

char AsciiLower(char c) { return (c >= 'A' && c <= 'Z') ? static_cast<char>(c - 'A' + 'a') : c; }

// Note: there is no "is this a removed element" check in the walk any more. The
// listed elements are gone before the walk starts, which is what section 3's
// pass order means; a stray closing tag for one of them is just a dropped tag.

// Section 3 step 3: a tag becomes a newline, on the opening and the closing tag.
bool IsBlockTag(const std::string& name) {
  static const char* const kBlocks[] = {
      "br",         "p",     "div",     "li",     "ul",       "ol",     "tr",
      "th",         "td",    "h1",      "h2",     "h3",       "h4",     "h5",
      "h6",         "section", "article", "header", "footer",  "aside",  "nav",
      "blockquote", "pre",   "table",   "hr",     "dd",       "dt",     "figure",
      "figcaption", "main",  "form"};
  for (const char* block : kBlocks) {
    if (name == block) return true;
  }
  return false;
}

struct NamedEntity {
  const char* name;
  uint32_t codePoint;
};

// Section 3 step 6. The decoded values are the characters the entities name:
// &nbsp; is U+00A0 and not a plain space, &copy; is U+00A9 and not "(c)".
// (The JavaScript reference currently maps several of these to ASCII stand-ins
// such as "(c)", "(tm)" and "x"; the contract's own note that a decoded
// &nbsp; "lands on a value the normalizer would map" only makes sense for
// U+00A0, and the Java and Go workers decode the characters too.)
const NamedEntity kEntities[] = {
    {"amp", 0x0026u},    {"lt", 0x003Cu},      {"gt", 0x003Eu},     {"quot", 0x0022u},
    {"apos", 0x0027u},   {"nbsp", 0x00A0u},    {"mdash", 0x2014u},  {"ndash", 0x2013u},
    {"hellip", 0x2026u}, {"laquo", 0x00ABu},   {"raquo", 0x00BBu},  {"copy", 0x00A9u},
    {"reg", 0x00AEu},    {"trade", 0x2122u},   {"times", 0x00D7u},  {"middot", 0x00B7u},
};

bool LookupNamedEntity(const std::string& name, uint32_t* out) {
  for (const NamedEntity& e : kEntities) {
    if (name == e.name) {
      *out = e.codePoint;
      return true;
    }
  }
  return false;
}

bool IsHexDigit(char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

uint32_t HexValue(char c) {
  if (c >= '0' && c <= '9') return static_cast<uint32_t>(c - '0');
  if (c >= 'a' && c <= 'f') return static_cast<uint32_t>(c - 'a') + 10u;
  return static_cast<uint32_t>(c - 'A') + 10u;
}

// Section 3 step 6, in the shape the contract pins down: the reference is looked
// for within 12 characters of the '&' (that is 11 characters after it), named
// and numeric references are both decoded with or without the trailing
// semicolon, and there is no backtracking - the name is the longest run of
// letters/digits after the '&', so "&copy2024" stays literal instead of
// decoding "&copy" and leaving "2024".
bool DecodeEntity(const std::string& s, size_t runEnd, size_t amp, std::string* replacement,
                  size_t* next) {
  constexpr size_t kWindow = 11;  // characters examined after the '&'
  const size_t bodyStart = amp + 1;
  if (bodyStart >= runEnd) return false;
  const size_t bodyEnd = (bodyStart + kWindow < runEnd) ? bodyStart + kWindow : runEnd;
  size_t p = bodyStart;

  if (s[p] == '#') {
    ++p;
    bool hex = false;
    if (p < bodyEnd && (s[p] == 'x' || s[p] == 'X')) {
      hex = true;
      ++p;
    }
    const size_t limit = hex ? 6 : 7;  // 1-6 hex digits, 1-7 decimal digits
    uint32_t value = 0;
    size_t digits = 0;
    while (p < bodyEnd && digits < limit &&
           (hex ? IsHexDigit(s[p]) : IsAsciiDigit(static_cast<unsigned char>(s[p])))) {
      value = hex ? value * 16u + HexValue(s[p])
                  : value * 10u + static_cast<uint32_t>(s[p] - '0');
      ++p;
      ++digits;
    }
    if (digits == 0) return false;
    if (value > 0x10FFFFu || (value >= 0xD800u && value <= 0xDFFFu)) return false;
    size_t end = p;
    if (end < runEnd && s[end] == ';') ++end;
    *replacement = Utf8FromCodePoint(value);
    *next = end;
    return true;
  }

  if (!IsAsciiAlpha(static_cast<unsigned char>(s[p]))) return false;
  // [A-Za-z][A-Za-z0-9]{1,7}: a name is 2 to 8 characters long.
  size_t q = p + 1;
  size_t length = 1;
  while (q < bodyEnd && length < 8 && IsAsciiAlnum(static_cast<unsigned char>(s[q]))) {
    ++q;
    ++length;
  }
  if (length < 2) return false;
  std::string name;
  name.reserve(length);
  for (size_t t = p; t < q; ++t) name.push_back(AsciiLower(s[t]));
  uint32_t codePoint = 0;
  if (!LookupNamedEntity(name, &codePoint)) return false;
  size_t end = q;
  if (end < runEnd && s[end] == ';') ++end;
  *replacement = Utf8FromCodePoint(codePoint);
  *next = end;
  return true;
}

// Section 3 step 4: absolute means "starts with a scheme": [A-Za-z][A-Za-z0-9+.-]*:
bool IsAbsoluteHref(const std::string& href) {
  if (href.empty() || !IsAsciiAlpha(static_cast<unsigned char>(href[0]))) return false;
  size_t i = 1;
  while (i < href.size()) {
    const unsigned char c = static_cast<unsigned char>(href[i]);
    if (!IsAsciiAlnum(c) && c != '+' && c != '-' && c != '.') break;
    ++i;
  }
  return i < href.size() && href[i] == ':';
}

// The href is read out of the raw tag text with the equivalent of
// /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i - the first matching
// attribute wins, quotes are optional, and the value is kept verbatim.
bool FindHref(const std::string& raw, std::string* href) {
  const size_t n = raw.size();
  for (size_t i = 0; i + 4 <= n; ++i) {
    if (AsciiLower(raw[i]) != 'h' || AsciiLower(raw[i + 1]) != 'r' ||
        AsciiLower(raw[i + 2]) != 'e' || AsciiLower(raw[i + 3]) != 'f') {
      continue;
    }
    if (i > 0 && IsWordChar(raw[i - 1])) continue;  // the \b of the pattern
    size_t p = i + 4;
    while (p < n && IsHtmlSpace(raw[p])) ++p;
    if (p >= n || raw[p] != '=') continue;
    ++p;
    while (p < n && IsHtmlSpace(raw[p])) ++p;
    if (p >= n) continue;
    if (raw[p] == '"' || raw[p] == '\'') {
      const char quote = raw[p];
      const size_t e = raw.find(quote, p + 1);
      if (e == std::string::npos) continue;  // [^"]* needs a closing quote
      *href = raw.substr(p + 1, e - p - 1);
      return true;
    }
    const size_t valueStart = p;
    while (p < n && !IsHtmlSpace(raw[p]) && raw[p] != '>') ++p;
    if (p == valueStart) continue;  // [^\s>]+ needs at least one character
    *href = raw.substr(valueStart, p - valueStart);
    return true;
  }
  return false;
}

// --- the removal passes, in the order section 3 states -------------------------

size_t FindCaseInsensitive(const std::string& s, size_t from, const char* literal) {
  const size_t length = std::strlen(literal);
  if (length == 0 || s.size() < length) return std::string::npos;
  for (size_t i = from; i + length <= s.size(); ++i) {
    bool matched = true;
    for (size_t k = 0; k < length; ++k) {
      if (AsciiLower(s[i + k]) != AsciiLower(literal[k])) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return std::string::npos;
}

// Pass 1: every CDATA body is hidden behind a sentinel. An unclosed section -
// "]]>" missing - keeps everything to the end of the input, the same principle
// as a removed element with no closing tag.
void HideCdataBodies(const std::string& src, std::string* out, std::vector<std::string>* bodies) {
  static const char kOpen[] = "<![CDATA[";
  const size_t openLength = sizeof(kOpen) - 1;
  size_t i = 0;
  while (i < src.size()) {
    const size_t start = src.find(kOpen, i);
    if (start == std::string::npos) {
      out->append(src, i, src.size() - i);
      return;
    }
    out->append(src, i, start - i);
    const size_t contentStart = start + openLength;
    const size_t end = src.find("]]>", contentStart);
    const size_t contentEnd = (end == std::string::npos) ? src.size() : end;
    bodies->push_back(src.substr(contentStart, contentEnd - contentStart));
    out->append(kCdataOpen);
    out->append(std::to_string(bodies->size() - 1));
    out->append(kCdataClose);
    i = (end == std::string::npos) ? src.size() : end + 3;
  }
}

// Pass 2a: comments, with an unterminated one running to the end of the input.
void RemoveComments(const std::string& src, std::string* out) {
  size_t i = 0;
  while (i < src.size()) {
    const size_t start = src.find("<!--", i);
    if (start == std::string::npos) {
      out->append(src, i, src.size() - i);
      return;
    }
    out->append(src, i, start - i);
    const size_t end = src.find("-->", start + 4);
    i = (end == std::string::npos) ? src.size() : end + 3;
  }
}

// Pass 2b: doctype declarations. The pattern needs its closing '>'; without one
// nothing is removed here and the walk deals with what is left.
void RemoveDoctypes(const std::string& src, std::string* out) {
  size_t i = 0;
  while (i < src.size()) {
    const size_t start = FindCaseInsensitive(src, i, "<!DOCTYPE");
    if (start == std::string::npos) {
      out->append(src, i, src.size() - i);
      return;
    }
    const size_t end = src.find('>', start);
    if (end == std::string::npos) {
      out->append(src, i, src.size() - i);
      return;
    }
    out->append(src, i, start - i);
    i = end + 1;
  }
}

// The start of an element: "<name" where the name is followed by a character
// that is not a word character.
size_t FindElementStart(const std::string& src, size_t from, const std::string& name) {
  for (size_t i = from; i + 1 + name.size() <= src.size(); ++i) {
    if (src[i] != '<') continue;
    bool matched = true;
    for (size_t k = 0; k < name.size(); ++k) {
      if (AsciiLower(src[i + 1 + k]) != name[k]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    const size_t after = i + 1 + name.size();
    if (after < src.size() && IsWordChar(src[after])) continue;
    return i;
  }
  return std::string::npos;
}

// The end of the closing tag: "</name" followed by whitespace only and then '>'.
// Returns one past the '>', or npos when the element never closes.
size_t FindElementEnd(const std::string& src, size_t from, const std::string& name) {
  for (size_t i = from; i + 2 + name.size() <= src.size(); ++i) {
    if (src[i] != '<' || src[i + 1] != '/') continue;
    bool matched = true;
    for (size_t k = 0; k < name.size(); ++k) {
      if (AsciiLower(src[i + 2 + k]) != name[k]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    size_t p = i + 2 + name.size();
    while (p < src.size() && IsHtmlSpace(src[p])) ++p;
    if (p < src.size() && src[p] == '>') return p + 1;
  }
  return std::string::npos;
}

// Pass 3: one element type removed everywhere, with its content. This runs over
// the raw text and looks for the element start, so what precedes it - including
// characters a later tag walk would read as an unclosed tag - cannot protect it.
// The opening tag ends at its first '>', and a missing closing tag means "to end
// of input".
std::string RemoveElementEverywhere(const std::string& src, const std::string& name) {
  std::string out;
  size_t i = 0;
  while (i < src.size()) {
    const size_t start = FindElementStart(src, i, name);
    if (start == std::string::npos) {
      out.append(src, i, src.size() - i);
      break;
    }
    const size_t openEnd = src.find('>', start + 1 + name.size());
    if (openEnd == std::string::npos) {
      out.append(src, i, src.size() - i);
      break;
    }
    out.append(src, i, start - i);
    const size_t closeEnd = FindElementEnd(src, openEnd + 1, name);
    if (closeEnd == std::string::npos) return out;  // to end of input
    i = closeEnd;
  }
  return out;
}

std::string PrepareSource(const std::string& html, std::vector<std::string>* cdataBodies) {
  std::string hidden;
  HideCdataBodies(html, &hidden, cdataBodies);
  std::string withoutComments;
  RemoveComments(hidden, &withoutComments);
  std::string src;
  RemoveDoctypes(withoutComments, &src);
  static const char* const kRemoved[] = {"script", "style", "noscript",
                                         "template", "svg",   "iframe"};
  for (const char* name : kRemoved) src = RemoveElementEverywhere(src, name);
  return src;
}

// Puts the hidden CDATA bodies back once no rule can mistake them for markup.
std::string RestoreCdata(const std::string& s, const std::vector<std::string>& bodies) {
  const size_t openLength = std::strlen(kCdataOpen);
  const size_t closeLength = std::strlen(kCdataClose);
  std::string out;
  size_t i = 0;
  while (i < s.size()) {
    const size_t start = s.find(kCdataOpen, i);
    if (start == std::string::npos) {
      out.append(s, i, s.size() - i);
      break;
    }
    const size_t digitsStart = start + openLength;
    const size_t close = s.find(kCdataClose, digitsStart);
    if (close == std::string::npos || close == digitsStart) {
      out.append(s, i, digitsStart - i);
      i = digitsStart;
      continue;
    }
    size_t index = 0;
    bool digits = true;
    for (size_t k = digitsStart; k < close; ++k) {
      if (!IsAsciiDigit(static_cast<unsigned char>(s[k]))) {
        digits = false;
        break;
      }
      index = index * 10 + static_cast<size_t>(s[k] - '0');
    }
    if (!digits) {
      out.append(s, i, digitsStart - i);
      i = digitsStart;
      continue;
    }
    out.append(s, i, start - i);
    if (index < bodies.size()) out += bodies[index];
    i = close + closeLength;
  }
  return out;
}

struct Extractor {
  std::string html;                            // the prepared source, owned
  const std::vector<std::string>& cdataBodies;  // bodies to put back at the end
  std::string text;
  std::string title;
  std::vector<ExtractLink> links;
  bool titleSeen = false;
  bool inTitle = false;
  bool haveLink = false;
  ExtractLink current;
  int images = 0;

  Extractor(std::string source, const std::vector<std::string>& bodies)
      : html(std::move(source)), cdataBodies(bodies) {}

  // Section 3 step 5: the title's own text is not part of `text`. Everything
  // else lands in the document text and, while an <a> is open, in the link text.
  void PushText(const std::string& chunk) {
    if (chunk.empty()) return;
    if (inTitle) {
      title += chunk;
      return;
    }
    text += chunk;
    if (haveLink) current.text += chunk;
  }

  // Copies one text run, decoding entities in place.
  void PushRun(size_t from, size_t to) {
    size_t i = from;
    std::string plain;
    while (i < to) {
      if (html[i] == '&') {
        std::string replacement;
        size_t next = 0;
        if (DecodeEntity(html, to, i, &replacement, &next)) {
          PushText(plain);
          plain.clear();
          PushText(replacement);
          i = next;
          continue;
        }
      }
      plain.push_back(html[i]);
      ++i;
    }
    PushText(plain);
  }

  size_t HandleTag(size_t pos) {
    const size_t n = html.size();

    // Comments, doctypes and CDATA were dealt with by the passes that ran before
    // this walk, which is the order section 3 states. An unrecognised "<!...>"
    // that survived them is an ordinary tag and is dropped below.
    // Scan to the '>' that ends the tag, honouring quoted attribute values: a
    // '>' inside them does not end the tag.
    size_t j = pos + 1;
    char quote = '\0';
    while (j < n) {
      const char c = html[j];
      if (quote != '\0') {
        if (c == quote) quote = '\0';
      } else if (c == '"' || c == '\'') {
        quote = c;
      } else if (c == '>') {
        break;
      }
      ++j;
    }
    if (j >= n) {
      // An incomplete tag at end of input is dropped as a tag: no newline, no
      // image, no link, and its name characters go with it. (`<p` contributes
      // nothing, which is the one place the reference contradicted its own
      // rule; a lone `<` that never started a tag is literal text and took a
      // different branch to get here.)
      return n;
    }
    const std::string raw = html.substr(pos + 1, j - (pos + 1));  // without the angle brackets
    const size_t next = j + 1;

    bool closing = false;
    size_t p = 0;
    if (!raw.empty() && raw[0] == '/') {
      closing = true;
      ++p;
    }
    while (p < raw.size() && IsHtmlSpace(raw[p])) ++p;
    const size_t nameStart = p;
    if (p < raw.size() && IsAsciiAlpha(static_cast<unsigned char>(raw[p]))) {
      ++p;
      while (p < raw.size() && IsTagNameChar(raw[p])) ++p;
    }
    std::string name;
    name.reserve(p - nameStart);
    for (size_t t = nameStart; t < p; ++t) name.push_back(AsciiLower(raw[t]));

    if (name == "title") {
      if (!closing && !titleSeen) {
        inTitle = true;
        titleSeen = true;
      } else if (closing && inTitle) {
        inTitle = false;
      }
      return next;
    }
    if (name == "img" && !closing) ++images;
    if (name == "a") {
      if (!closing) {
        // HTML does not allow nested anchors, and a browser closes the open one
        // when a new one starts: report the outer with the text it collected so
        // far, then start the inner. An anchor still open at end of input is
        // reported too.
        if (haveLink) {
          links.push_back(current);
          haveLink = false;
        }
        std::string href;
        FindHref(raw, &href);
        current = ExtractLink();
        current.href = href;
        current.absolute = IsAbsoluteHref(href);
        haveLink = true;
      } else if (haveLink) {
        links.push_back(current);
        haveLink = false;
        current = ExtractLink();
      }
      return next;
    }
    if (IsBlockTag(name)) PushText("\n");
    return next;
  }

  ExtractResult Run() {
    const size_t n = html.size();
    size_t pos = 0;
    while (pos < n) {
      if (html[pos] == '<' && pos + 1 < n &&
          IsTagStartChar(static_cast<unsigned char>(html[pos + 1]))) {
        pos = HandleTag(pos);
        continue;
      }
      size_t k = pos;
      while (k < n) {
        if (html[k] == '<' && k + 1 < n &&
            IsTagStartChar(static_cast<unsigned char>(html[k + 1]))) {
          break;
        }
        ++k;
      }
      PushRun(pos, k);
      pos = k;
    }
    if (haveLink) {
      links.push_back(current);
      haveLink = false;
    }
    // Now that no rule can mistake them for markup, the hidden CDATA bodies go
    // back into every field that carried a sentinel.
    ExtractResult result;
    result.title = RestoreCdata(title, cdataBodies);
    result.text = RestoreCdata(text, cdataBodies);
    result.links.reserve(links.size());
    for (const ExtractLink& link : links) {
      ExtractLink restored;
      restored.href = link.href;
      restored.absolute = link.absolute;
      restored.text = RestoreCdata(link.text, cdataBodies);
      result.links.push_back(std::move(restored));
    }
    result.images = images;
    return result;
  }
};

}  // namespace

ExtractResult ExtractHtml(const std::string& html) {
  std::vector<std::string> cdataBodies;
  const std::string prepared = PrepareSource(html, &cdataBodies);
  Extractor extractor(prepared, cdataBodies);
  return extractor.Run();
}

}  // namespace vml
