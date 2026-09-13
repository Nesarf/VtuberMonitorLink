// UTF-8 byte-level helpers for the C++ worker.
//
// docs/WORKERS.md section 1.2 is explicit about this language: the worker reads
// and writes *bytes* (fread/fwrite) and never uses the wide-character console
// APIs. Everything below therefore operates on std::string holding UTF-8 bytes;
// code points are decoded only where a rule in the contract is defined per code
// point (the mapping tables, CJK run detection, entity decoding), and the result
// is re-encoded to UTF-8 before it reaches the JSON serializer.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace vml {

// A byte that is not part of a valid UTF-8 sequence is reported as
// kRawByteBase + byte. No rule range contains such a value, so an unknown byte
// cannot be mapped, folded or deleted by accident.
constexpr uint32_t kRawByteBase = 0x110000u;

inline bool IsInvalidByteCodePoint(uint32_t cp) { return cp >= kRawByteBase; }

inline unsigned char InvalidByteFromCodePoint(uint32_t cp) {
  return static_cast<unsigned char>(cp - kRawByteBase);
}

// Decodes one code point in `s` at offset i and advances i past it.
// `s` must be non-empty and i must be < s.size().
//
// Surrogate code points are accepted here on purpose: the JSON decoder turns a
// lone \uD800-style escape into its WTF-8 bytes (ED A0 80) so the value survives
// a round trip and is re-emitted as an escape, exactly like JSON.stringify.
// An ill-formed sequence consumes exactly one byte.
inline uint32_t Utf8Next(const std::string& s, size_t& i) {
  const unsigned char c = static_cast<unsigned char>(s[i]);
  if (c < 0x80) {
    i += 1;
    return c;
  }
  size_t need;
  uint32_t cp;
  if ((c & 0xE0u) == 0xC0u) {
    need = 1;
    cp = c & 0x1Fu;
  } else if ((c & 0xF0u) == 0xE0u) {
    need = 2;
    cp = c & 0x0Fu;
  } else if ((c & 0xF8u) == 0xF0u) {
    need = 3;
    cp = c & 0x07u;
  } else {
    i += 1;
    return kRawByteBase + c;
  }
  if (need > s.size() - i - 1) {
    i += 1;
    return kRawByteBase + c;
  }
  for (size_t k = 1; k <= need; ++k) {
    const unsigned char cc = static_cast<unsigned char>(s[i + k]);
    if ((cc & 0xC0u) != 0x80u) {
      i += 1;
      return kRawByteBase + c;
    }
    cp = (cp << 6) | (cc & 0x3Fu);
  }
  static const uint32_t kMin[4] = {0u, 0x80u, 0x800u, 0x10000u};
  if (cp < kMin[need] || cp > 0x10FFFFu) {
    i += 1;
    return kRawByteBase + c;
  }
  i += need + 1;
  return cp;
}

inline void Utf8Append(std::string& out, uint32_t cp) {
  if (cp >= kRawByteBase) {
    out.push_back(static_cast<char>(InvalidByteFromCodePoint(cp)));
    return;
  }
  if (cp < 0x80u) {
    out.push_back(static_cast<char>(cp));
  } else if (cp < 0x800u) {
    out.push_back(static_cast<char>(0xC0u | (cp >> 6)));
    out.push_back(static_cast<char>(0x80u | (cp & 0x3Fu)));
  } else if (cp < 0x10000u) {
    out.push_back(static_cast<char>(0xE0u | (cp >> 12)));
    out.push_back(static_cast<char>(0x80u | ((cp >> 6) & 0x3Fu)));
    out.push_back(static_cast<char>(0x80u | (cp & 0x3Fu)));
  } else {
    out.push_back(static_cast<char>(0xF0u | (cp >> 18)));
    out.push_back(static_cast<char>(0x80u | ((cp >> 12) & 0x3Fu)));
    out.push_back(static_cast<char>(0x80u | ((cp >> 6) & 0x3Fu)));
    out.push_back(static_cast<char>(0x80u | (cp & 0x3Fu)));
  }
}

inline std::string Utf8FromCodePoint(uint32_t cp) {
  std::string s;
  Utf8Append(s, cp);
  return s;
}

// Replaces every byte sequence that is not well-formed UTF-8 (and every encoded
// surrogate) with U+FFFD. This mirrors what a JavaScript host does when it
// decodes stdin as UTF-8, so a malformed request can never make this worker emit
// malformed JSON. The corpus is always well-formed UTF-8, so in practice this is
// a no-op.
inline std::string SanitizeUtf8(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  size_t i = 0;
  while (i < s.size()) {
    const size_t start = i;
    size_t j = i;
    const uint32_t cp = Utf8Next(s, j);
    const bool ok = !IsInvalidByteCodePoint(cp) && !(cp >= 0xD800u && cp <= 0xDFFFu);
    if (ok) {
      out.append(s, start, j - start);
      i = j;
    } else {
      out += "\xEF\xBF\xBD";
      i = start + 1;
    }
  }
  return out;
}

}  // namespace vml
