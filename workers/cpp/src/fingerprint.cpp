// text.fingerprint: FNV-1a 64 + SimHash, all integer arithmetic.
//
// Everything in section 4 is integer work on purpose ("All integer arithmetic,
// so 'byte-identical across languages' is achievable rather than aspirational"),
// so there is no floating point anywhere in this file.
#include "fingerprint.h"

#include <cstdint>
#include <string>
#include <vector>

#include "utf8.h"

namespace vml {
namespace {

// Section 4: CJK = Han U+3400-U+4DBF, U+4E00-U+9FFF, U+F900-U+FAFF,
// kana U+3040-U+30FF, Hangul U+AC00-U+D7AF. Everything else is "other".
bool IsCjk(uint32_t cp) {
  return (cp >= 0x3400u && cp <= 0x4DBFu) || (cp >= 0x4E00u && cp <= 0x9FFFu) ||
         (cp >= 0xF900u && cp <= 0xFAFFu) || (cp >= 0x3040u && cp <= 0x30FFu) ||
         (cp >= 0xAC00u && cp <= 0xD7AFu);
}

// The exact set from section 4: !?,.;:'"()[]{}<>-_/\|*+=~`@#$%^&
bool IsAsciiPunctuation(uint32_t cp) {
  switch (cp) {
    case '!': case '?': case ',': case '.': case ';': case ':': case '\'':
    case '"': case '(': case ')': case '[': case ']': case '{': case '}':
    case '<': case '>': case '-': case '_': case '/': case '\\': case '|':
    case '*': case '+': case '=': case '~': case '`': case '@': case '#':
    case '$': case '%': case '^': case '&':
      return true;
    default:
      return false;
  }
}

bool IsAsciiPunctuationByte(unsigned char c) {
  return c < 0x80u && IsAsciiPunctuation(static_cast<uint32_t>(c));
}

// Leading and trailing ASCII punctuation is stripped from a token before the
// run/bigram rule, so "hello," and "hello" emit the same token (otherwise every
// sentence that ends in a full stop would be a new token as far as the
// fingerprint is concerned). A token that is empty after stripping emits
// nothing. Both this and the tokenizer below are stated in the parent contract
// delta; section 4's bullet list only mentions the all-punctuation token.
void EmitToken(const std::string& token, std::vector<std::string>* out) {
  size_t begin = 0;
  size_t end = token.size();
  while (begin < end && IsAsciiPunctuationByte(static_cast<unsigned char>(token[begin]))) ++begin;
  while (end > begin && IsAsciiPunctuationByte(static_cast<unsigned char>(token[end - 1]))) --end;
  if (begin == end) return;
  const std::string trimmed = token.substr(begin, end - begin);

  bool allPunctuation = true;
  {
    size_t i = 0;
    while (i < trimmed.size()) {
      if (!IsAsciiPunctuation(Utf8Next(trimmed, i))) {
        allPunctuation = false;
        break;
      }
    }
  }
  if (allPunctuation) return;

  size_t i = 0;
  while (i < trimmed.size()) {
    const size_t runStart = i;
    const uint32_t first = Utf8Next(trimmed, i);
    const bool cjk = IsCjk(first);
    std::vector<uint32_t> codePoints;
    codePoints.push_back(first);
    while (i < trimmed.size()) {
      const size_t save = i;
      const uint32_t cp = Utf8Next(trimmed, i);
      if (IsCjk(cp) != cjk) {
        i = save;
        break;
      }
      codePoints.push_back(cp);
    }
    if (!cjk) {
      // An "other" run emits itself (verbatim bytes, no re-encoding needed).
      out->push_back(trimmed.substr(runStart, i - runStart));
    } else if (codePoints.size() == 1) {
      out->push_back(Utf8FromCodePoint(codePoints[0]));
    } else {
      for (size_t k = 0; k + 1 < codePoints.size(); ++k) {
        std::string bigram;
        Utf8Append(bigram, codePoints[k]);
        Utf8Append(bigram, codePoints[k + 1]);
        out->push_back(bigram);
      }
    }
  }
}

// FNV-1a, 64-bit, exactly the loop the contract gives:
//   h = 14695981039346656037; for each byte b: h ^= b; h *= 1099511628211 (mod 2^64)
uint64_t Fnv1a64(const std::string& bytes) {
  uint64_t hash = 14695981039346656037ULL;
  for (size_t i = 0; i < bytes.size(); ++i) {
    hash ^= static_cast<uint64_t>(static_cast<unsigned char>(bytes[i]));
    // Unsigned overflow is well defined in C++ and wraps modulo 2^64, which is
    // exactly the "mod 2^64" the contract asks for. The multiplication is
    // deliberately not guarded against overflow.
    hash *= 1099511628211ULL;
  }
  return hash;
}

std::string ToHex16(uint64_t value) {
  static const char* kHex = "0123456789abcdef";
  std::string out(16, '0');
  for (int i = 15; i >= 0; --i) {
    out[static_cast<size_t>(i)] = kHex[value & 0xFu];
    value >>= 4;
  }
  return out;
}

}  // namespace

FingerprintResult FingerprintText(const std::string& text) {
  // Tokenize on single spaces. Splitting on ' ' means a run of two spaces
  // produces an empty token, which emits nothing.
  std::vector<std::string> tokens;
  size_t start = 0;
  for (;;) {
    const size_t space = text.find(' ', start);
    if (space == std::string::npos) {
      EmitToken(text.substr(start), &tokens);
      break;
    }
    EmitToken(text.substr(start, space - start), &tokens);
    start = space + 1;
  }

  // Shingles: overlapping runs of 3 emitted tokens; fewer than 3 tokens means
  // the whole token list joined by a space is the single shingle; no tokens at
  // all means no shingles.
  std::vector<std::string> shingles;
  if (!tokens.empty()) {
    if (tokens.size() < 3) {
      std::string joined;
      for (size_t i = 0; i < tokens.size(); ++i) {
        if (i) joined.push_back(' ');
        joined += tokens[i];
      }
      shingles.push_back(joined);
    } else {
      for (size_t i = 0; i + 3 <= tokens.size(); ++i) {
        shingles.push_back(tokens[i] + " " + tokens[i + 1] + " " + tokens[i + 2]);
      }
    }
  }

  int64_t counters[64] = {0};
  for (const std::string& shingle : shingles) {
    const uint64_t hash = Fnv1a64(shingle);
    for (int bit = 0; bit < 64; ++bit) {
      if ((hash >> bit) & 1ULL) {
        counters[bit] += 1;
      } else {
        counters[bit] -= 1;
      }
    }
  }
  uint64_t fingerprint = 0;
  for (int bit = 0; bit < 64; ++bit) {
    if (counters[bit] > 0) fingerprint |= (1ULL << bit);
  }

  FingerprintResult result;
  result.simhash = ToHex16(fingerprint);
  result.tokens = static_cast<long long>(tokens.size());
  result.shingles = static_cast<long long>(shingles.size());
  return result;
}

}  // namespace vml
