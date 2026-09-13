// The built-in case list, run by --selfcheck.
//
// The cases are the contract's edge rules, not a regression suite for this
// implementation: unclosed tag, entity without a semicolon, numeric entity,
// zero-width characters, full-width ASCII, a CJK string that must pass through
// untouched, an idempotency pair, empty input. The expected values come from
// reading docs/WORKERS.md sections 2-4 (and the parent contract delta), not from
// running this binary - otherwise the check would only prove that the code does
// what it already does.
//
// The report goes to stderr, matching the JavaScript reference and section 1's
// rule that stdout carries protocol messages and nothing else. Every line is
// pure ASCII (values are escaped for display), so the report cannot be mangled
// by a console code page that is not UTF-8.
#include "selfcheck.h"

#include <cstdio>
#include <string>
#include <vector>

#include "json.h"
#include "normalize.h"
#include "render.h"
#include "stdio_io.h"
#include "utf8.h"

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#else
#include <unistd.h>
#endif

namespace vml {
namespace {

// Runs the protocol I/O the way the host does: over a pipe whose write end
// stays open for the whole run. Both of the failure modes below are invisible
// when a request is piped in from a file (stdin reaches EOF immediately, which
// flushes everything); against a real host they are a timeout with no error
// message at all.
bool OpenPipe(std::FILE** reader, std::FILE** writer) {
  int descriptors[2];
#ifdef _WIN32
  if (_pipe(descriptors, 4096, _O_BINARY) != 0) return false;
  *reader = _fdopen(descriptors[0], "rb");
  *writer = _fdopen(descriptors[1], "wb");
#else
  if (pipe(descriptors) != 0) return false;
  *reader = fdopen(descriptors[0], "rb");
  *writer = fdopen(descriptors[1], "wb");
#endif
  return *reader != nullptr && *writer != nullptr;
}

struct Case {
  std::string name;
  std::string actual;
  std::string expected;
};

// Renders a string as printable ASCII for the report: control characters get
// their short escapes, everything above U+007F becomes \uXXXX.
std::string EscapeForDisplay(const std::string& s) {
  static const char* kHex = "0123456789abcdef";
  std::string out;
  size_t i = 0;
  while (i < s.size()) {
    const uint32_t cp = Utf8Next(s, i);
    if (IsInvalidByteCodePoint(cp)) {
      const unsigned char b = InvalidByteFromCodePoint(cp);
      out += "\\x";
      out.push_back(kHex[(b >> 4) & 0xF]);
      out.push_back(kHex[b & 0xF]);
      continue;
    }
    switch (cp) {
      case '\n': out += "\\n"; continue;
      case '\r': out += "\\r"; continue;
      case '\t': out += "\\t"; continue;
      default: break;
    }
    if (cp >= 0x20u && cp < 0x7Fu) {
      out.push_back(static_cast<char>(cp));
      continue;
    }
    out += "\\u";
    out.push_back(kHex[(cp >> 12) & 0xF]);
    out.push_back(kHex[(cp >> 8) & 0xF]);
    out.push_back(kHex[(cp >> 4) & 0xF]);
    out.push_back(kHex[cp & 0xF]);
  }
  return out;
}

std::string NormalizedJson(const std::string& text) {
  return JsonSerialize(RenderNormalize(text));
}

std::string ExtractJson(const std::string& html) {
  return JsonSerialize(RenderExtract(html));
}

std::string FingerprintJson(const std::string& text) {
  return JsonSerialize(RenderFingerprint(text));
}

}  // namespace

int RunSelfcheck() {
  std::vector<Case> cases;
  const auto add = [&cases](const char* name, const std::string& actual,
                            const std::string& expected) {
    cases.push_back(Case{name, actual, expected});
  };

  // ---- text.normalize (section 2) ----
  add("normalize: empty input produces an empty string", NormalizedJson(""), "{\"text\":\"\"}");

  // Built from code points so that the control characters are unambiguous.
  std::string controls;
  controls += 'a';
  controls += '\0';
  controls += 'b';
  controls += '\b';
  controls += 'c';
  controls += Utf8FromCodePoint(0x200Bu);  // zero width space
  controls += 'd';
  controls += Utf8FromCodePoint(0x200Eu);  // left-to-right mark
  controls += 'f';
  controls += Utf8FromCodePoint(0x2060u);  // word joiner
  controls += 'g';
  controls += Utf8FromCodePoint(0xFEFFu);  // byte order mark
  controls += 'h';
  add("normalize: control, zero-width and BOM code points are deleted", NormalizedJson(controls),
      "{\"text\":\"abcdfgh\"}");

  add("normalize: full-width ASCII maps to ASCII",
      NormalizedJson(Utf8FromCodePoint(0xFF23u) + Utf8FromCodePoint(0xFF41u) +
                     Utf8FromCodePoint(0xFF46u) + Utf8FromCodePoint(0x00E9u)),
      "{\"text\":\"cafe\"}");

  const std::string probeA = Utf8FromCodePoint(0xFF23u) + Utf8FromCodePoint(0xFF41u) +
                             Utf8FromCodePoint(0xFF46u) + Utf8FromCodePoint(0x00E9u) +
                             Utf8FromCodePoint(0x3000u) + Utf8FromCodePoint(0x2014u) +
                             Utf8FromCodePoint(0x3000u) + "L" + Utf8FromCodePoint(0x2019u) +
                             Utf8FromCodePoint(0x00C9u) + "T" + Utf8FromCodePoint(0x00C9u) +
                             Utf8FromCodePoint(0x200Bu);
  add("normalize: full-width, ideographic space, em dash, curly quote and zero width space",
      NormalizedJson(probeA), "{\"text\":\"cafe - l'ete\"}");

  add("normalize: a run of spaces, tabs and newlines collapses to one space",
      NormalizedJson("a \t\n b"), "{\"text\":\"a b\"}");
  add("normalize: leading and trailing spaces are trimmed", NormalizedJson("   x   "),
      "{\"text\":\"x\"}");

  std::string scripts = Utf8FromCodePoint(0x65E5u) + Utf8FromCodePoint(0x672Cu) +
                        Utf8FromCodePoint(0x8A9Eu) + Utf8FromCodePoint(0x30C6u) +
                        Utf8FromCodePoint(0x30B9u) + Utf8FromCodePoint(0x30C8u) + " " +
                        Utf8FromCodePoint(0xD55Cu) + Utf8FromCodePoint(0xAD6Du) +
                        Utf8FromCodePoint(0xC5B4u) + " " + Utf8FromCodePoint(0x41Fu) +
                        Utf8FromCodePoint(0x440u) + Utf8FromCodePoint(0x438u) +
                        Utf8FromCodePoint(0x432u) + Utf8FromCodePoint(0x435u) +
                        Utf8FromCodePoint(0x442u);
  add("normalize: Han, kana, Hangul and Cyrillic pass through unchanged",
      JsonSerialize(RenderNormalize(scripts)), "{\"text\":\"" + scripts + "\"}");
  // (Compared against the input itself: the tables say nothing about these
  // scripts, so the contract requires them to be copied through untouched.)

  const std::string sharpS = "Stra" + Utf8FromCodePoint(0x00DFu) + "e " +
                             Utf8FromCodePoint(0x00C6u) + Utf8FromCodePoint(0x00D8u);
  add("normalize: lowercasing then folding (sharp s, AE, O slash)", NormalizedJson(sharpS),
      "{\"text\":\"strasse aeo\"}");

  add("normalize: ellipsis maps to three dots", NormalizedJson(std::string("A") +
      Utf8FromCodePoint(0x2026u) + "B"), "{\"text\":\"a...b\"}");

  const std::string probeB = Utf8FromCodePoint(0x0141u) + Utf8FromCodePoint(0x00F3u) + "d" +
                             Utf8FromCodePoint(0x017Au) + "   " + Utf8FromCodePoint(0x017Bu) +
                             Utf8FromCodePoint(0x00D3u) + Utf8FromCodePoint(0x0141u) +
                             Utf8FromCodePoint(0x0106u);
  add("normalize: Polish diacritics fold, inner runs collapse", NormalizedJson(probeB),
      "{\"text\":\"lodz zolc\"}");

  add("normalize: a combining mark is deleted (decomposed == composed)",
      NormalizedJson(std::string("e") + Utf8FromCodePoint(0x0301u)), "{\"text\":\"e\"}");

  const std::string dottedI = Utf8FromCodePoint(0x0130u) + "stanbul";
  add("normalize: U+0130 is absent from the lower table and folds to i, as the fold table says",
      NormalizedJson(dottedI), "{\"text\":\"istanbul\"}");

  const std::string idempotencyInput = "  " + Utf8FromCodePoint(0x00C9u) + "T" +
                                       Utf8FromCodePoint(0x00C9u) + Utf8FromCodePoint(0x2019u) +
                                       "s  " + Utf8FromCodePoint(0x2014u) + "  " +
                                       Utf8FromCodePoint(0x00DFu) + "  ";
  add("normalize: idempotency pair - normalize(normalize(x)) == normalize(x)",
      JsonSerialize(RenderNormalize(NormalizeText(NormalizeText(idempotencyInput)))),
      "{\"text\":\"ete's - ss\"}");

  // ---- text.extract (section 3) ----
  add("extract: block tags become newlines and a link keeps its text unnormalized",
      ExtractJson("<p>Hello <b>world</b></p><a href=\"/x\">Link</a> <img src=a>"),
      "{\"title\":\"\",\"text\":\"\\nHello world\\nLink \",\"links\":[{\"href\":\"/x\","
      "\"absolute\":false,\"text\":\"Link\"}],\"images\":1}");

  add("extract: an unclosed tag at end of input is dropped as a tag",
      ExtractJson("<b>bold<i"), "{\"title\":\"\",\"text\":\"bold\",\"links\":[],\"images\":0}");

  add("extract: an entity without a semicolon decodes, &nbsp; is U+00A0",
      ExtractJson("a&amp b&lt c&nbsp d"),
      "{\"title\":\"\",\"text\":\"a& b< c\xC2\xA0 d\",\"links\":[],\"images\":0}");

  add("extract: numeric entities decode (decimal, lower and upper hex)", ExtractJson("&#65;&#x42;&#X43;"),
      "{\"title\":\"\",\"text\":\"ABC\",\"links\":[],\"images\":0}");

  add("extract: script is removed with its content", ExtractJson("<p>a</p><script>var x=1;</script><p>b</p>"),
      "{\"title\":\"\",\"text\":\"\\na\\n\\nb\\n\",\"links\":[],\"images\":0}");

  add("extract: a comment is removed entirely", ExtractJson("a<!-- x -->b"),
      "{\"title\":\"\",\"text\":\"ab\",\"links\":[],\"images\":0}");

  add("extract: the title is decoded but not normalized and is not part of text",
      ExtractJson("<title>Hi &amp; Bye</title><a href=\"HTTP://X/\">Link</a>"),
      "{\"title\":\"Hi & Bye\",\"text\":\"Link\",\"links\":[{\"href\":\"HTTP://X/\","
      "\"absolute\":true,\"text\":\"Link\"}],\"images\":0}");

  add("extract: images are counted with a tag boundary respected",
      ExtractJson("<img src=a><IMG src=b><image src=c></img>"),
      "{\"title\":\"\",\"text\":\"\",\"links\":[],\"images\":2}");

  add("extract: empty input produces empty fields, never null", ExtractJson(""),
      "{\"title\":\"\",\"text\":\"\",\"links\":[],\"images\":0}");

  add("extract: a removed element with a missing closing tag runs to end of input",
      ExtractJson("<p>a</p><script>var x=1;"),
      "{\"title\":\"\",\"text\":\"\\na\\n\",\"links\":[],\"images\":0}");

  add("extract: an unknown named entity and a lone & stay verbatim", ExtractJson("&unknown; &"),
      "{\"title\":\"\",\"text\":\"&unknown; &\",\"links\":[],\"images\":0}");

  add("extract: no backtracking - &copy2024 stays literal", ExtractJson("&copy2024"),
      "{\"title\":\"\",\"text\":\"&copy2024\",\"links\":[],\"images\":0}");

  add("extract: an anchor opened while another is open closes the outer (browser rule)",
      ExtractJson("<a href=\"/one\">one<a href=\"/two\">two</a>"),
      "{\"title\":\"\",\"text\":\"onetwo\",\"links\":[{\"href\":\"/one\",\"absolute\":false,"
      "\"text\":\"one\"},{\"href\":\"/two\",\"absolute\":false,\"text\":\"two\"}],\"images\":0}");

  add("extract: end of input inside a tag drops the incomplete tag", ExtractJson("<p>abc<b"),
      "{\"title\":\"\",\"text\":\"\\nabc\",\"links\":[],\"images\":0}");

  add("extract: a lone < at end of input is literal text", ExtractJson("a<"),
      "{\"title\":\"\",\"text\":\"a<\",\"links\":[],\"images\":0}");

  add("extract: an incomplete tag contributes nothing at end of input, neither newline nor image",
      ExtractJson("<p<img"), "{\"title\":\"\",\"text\":\"\",\"links\":[],\"images\":0}");

  add("extract: CDATA content is literal text and is not re-parsed as markup",
      ExtractJson("<![CDATA[<b>raw</b>]]>"),
      "{\"title\":\"\",\"text\":\"<b>raw</b>\",\"links\":[],\"images\":0}");

  add("extract: an unclosed CDATA section keeps everything to the end of input",
      ExtractJson("<![CDATA[unclosed"),
      "{\"title\":\"\",\"text\":\"unclosed\",\"links\":[],\"images\":0}");

  add("extract: nothing inside CDATA is interpreted, entities included",
      ExtractJson("<![CDATA[a &amp; b &#65;]]>"),
      "{\"title\":\"\",\"text\":\"a &amp; b &#65;\",\"links\":[],\"images\":0}");

  add("extract: removal wins over CDATA when the CDATA sits inside a removed element",
      ExtractJson("<p><![CDATA[<script>x</script>]]></p><script>&lt;![CDATA[y]]&gt;</script>"),
      "{\"title\":\"\",\"text\":\"\\n<script>x</script>\\n\",\"links\":[],\"images\":0}");

  add("extract: a title inside an anchor belongs to the title, not to the anchor's text",
      ExtractJson("<a href=\"/x\"><title>T</title>t</a>"),
      "{\"title\":\"T\",\"text\":\"t\",\"links\":[{\"href\":\"/x\",\"absolute\":false,"
      "\"text\":\"t\"}],\"images\":0}");

  // ---- text.fingerprint (section 4) ----
  add("fingerprint: empty text has no tokens, no shingles and an all-zero hash",
      FingerprintJson(""),
      "{\"simhash\":\"0000000000000000\",\"tokens\":0,\"shingles\":0}");

  add("fingerprint: one token is one shingle equal to the hash of that token", FingerprintJson("x"),
      "{\"simhash\":\"af63f54c86021707\",\"tokens\":1,\"shingles\":1}");

  const std::string probeD = std::string("openai gpt ") + Utf8FromCodePoint(0x5DF2u) +
                            Utf8FromCodePoint(0x7ECFu) + " " + Utf8FromCodePoint(0x5DF2u) +
                            Utf8FromCodePoint(0x7ECFu);
  add("fingerprint: a CJK run of 2 emits one bigram; 4 tokens give 2 shingles",
      FingerprintJson(probeD),
      "{\"simhash\":\"2a000d8009183078\",\"tokens\":4,\"shingles\":2}");

  add("fingerprint: a token of ASCII punctuation only emits nothing", FingerprintJson("!!! ,,, a"),
      "{\"simhash\":\"af63dc4c8601ec8c\",\"tokens\":1,\"shingles\":1}");

  add("fingerprint: three tokens are one shingle", FingerprintJson("a b c"),
      "{\"simhash\":\"69cf480885ad45af\",\"tokens\":3,\"shingles\":1}");

  add("fingerprint: a CJK run of 1 emits its code point, mixed runs split",
      FingerprintJson(std::string("a") + Utf8FromCodePoint(0x4E2Du) + "b"),
      "{\"simhash\":\"27e4e607b4097edd\",\"tokens\":3,\"shingles\":1}");

  add("fingerprint: leading and trailing ASCII punctuation is trimmed from a token",
      FingerprintJson("hello, hello!"),
      "{\"simhash\":\"f76746f79c7033ff\",\"tokens\":2,\"shingles\":1}");

  // ---- protocol byte I/O (section 1) ----
  {
    std::FILE* reader = nullptr;
    std::FILE* writer = nullptr;
    std::string actual = "<could not create a pipe>";
    if (OpenPipe(&reader, &writer)) {
      const std::string request = "{\"id\":1,\"op\":\"describe\"}";
      // The write end deliberately stays open: that is what a host does.
      WriteLine(writer, request);
      LineReader pipeReader(reader);
      std::string line;
      actual = pipeReader.Next(&line) ? line
                                      : std::string("<nothing: the reader waited for end of input>");
      std::fclose(reader);
      std::fclose(writer);
    }
    add("protocol: a request line is read while the host keeps the pipe open", actual,
        "{\"id\":1,\"op\":\"describe\"}");
  }
  {
    std::FILE* reader = nullptr;
    std::FILE* writer = nullptr;
    std::string actual = "<could not create a pipe>";
    if (OpenPipe(&reader, &writer)) {
      const std::string response = "{\"id\":1,\"ok\":true,\"output\":{\"text\":\"x\"}}";
      WriteLine(writer, response);  // must be on the pipe before the host looks
      LineReader pipeReader(reader);
      std::string line;
      actual = pipeReader.Next(&line) ? line
                                      : std::string("<nothing: the response never left its buffer>");
      std::fclose(reader);
      std::fclose(writer);
    }
    add("protocol: a response line is flushed before the host reads it", actual,
        "{\"id\":1,\"ok\":true,\"output\":{\"text\":\"x\"}}");
  }
  {
    // Section 1 pins the shutdown answer as the bare envelope.
    add("protocol: shutdown answers the bare envelope", JsonSerialize(RenderShutdownAck(JsonInt(7))),
        "{\"id\":7,\"ok\":true}");
  }

  int passed = 0;
  for (const Case& c : cases) {
    const bool ok = c.actual == c.expected;
    if (ok) ++passed;
    if (ok) {
      std::fprintf(stderr, "  [ok]   %s\n", c.name.c_str());
    } else {
      std::fprintf(stderr, "  [FAIL] %s\n         expected %s\n         actual   %s\n",
                   c.name.c_str(), EscapeForDisplay(c.expected).c_str(),
                   EscapeForDisplay(c.actual).c_str());
    }
  }
  std::fprintf(stderr, "%d/%d checks passed\n", passed, static_cast<int>(cases.size()));
  std::fflush(stderr);
  return passed == static_cast<int>(cases.size()) ? 0 : 1;
}

}  // namespace vml
