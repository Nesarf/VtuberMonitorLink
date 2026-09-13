#include "json.h"

#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>

#include "utf8.h"

namespace vml {

const JsonValue* JsonValue::Find(const std::string& key) const {
  for (size_t i = members.size(); i > 0; --i) {
    if (members[i - 1].first == key) return &members[i - 1].second;
  }
  return nullptr;
}

JsonValue JsonNull() { return JsonValue(); }

JsonValue JsonBool(bool v) {
  JsonValue j;
  j.type = JsonType::Bool;
  j.boolValue = v;
  return j;
}

JsonValue JsonInt(long long v) {
  JsonValue j;
  j.type = JsonType::Number;
  j.isInteger = true;
  j.intValue = v;
  j.floatValue = static_cast<double>(v);
  return j;
}

JsonValue JsonString(const std::string& v) {
  JsonValue j;
  j.type = JsonType::String;
  j.str = v;
  return j;
}

JsonValue JsonArray() {
  JsonValue j;
  j.type = JsonType::Array;
  return j;
}

JsonValue JsonObject() {
  JsonValue j;
  j.type = JsonType::Object;
  return j;
}

namespace {

void AppendUnicodeEscape(std::string& out, uint32_t cp) {
  static const char* kHex = "0123456789abcdef";
  out += "\\u";
  out.push_back(kHex[(cp >> 12) & 0xF]);
  out.push_back(kHex[(cp >> 8) & 0xF]);
  out.push_back(kHex[(cp >> 4) & 0xF]);
  out.push_back(kHex[cp & 0xF]);
}

// Escaping matches JSON.stringify byte for byte: only ", \ and control
// characters below U+0020 are escaped (with the short forms where JavaScript
// uses them), plus lone surrogates, which well-formed JSON.stringify also
// escapes. U+007F and everything above stay raw, so non-ASCII text travels as
// UTF-8 exactly like the other implementations' output.
void SerializeString(const std::string& s, std::string& out) {
  out.push_back('"');
  size_t i = 0;
  while (i < s.size()) {
    const size_t start = i;
    const uint32_t cp = Utf8Next(s, i);
    switch (cp) {
      case '"':
        out += "\\\"";
        continue;
      case '\\':
        out += "\\\\";
        continue;
      case '\b':
        out += "\\b";
        continue;
      case '\f':
        out += "\\f";
        continue;
      case '\n':
        out += "\\n";
        continue;
      case '\r':
        out += "\\r";
        continue;
      case '\t':
        out += "\\t";
        continue;
      default:
        break;
    }
    if (IsInvalidByteCodePoint(cp)) {
      out += "\xEF\xBF\xBD";  // unreachable through the JSON parser
      continue;
    }
    if (cp < 0x20u || (cp >= 0xD800u && cp <= 0xDFFFu)) {
      AppendUnicodeEscape(out, cp);
      continue;
    }
    out.append(s, start, i - start);
  }
  out.push_back('"');
}

void SerializeNumber(const JsonValue& v, std::string& out) {
  if (v.isInteger) {
    char buf[32];
    const auto res = std::to_chars(buf, buf + sizeof(buf), v.intValue);
    out.append(buf, static_cast<size_t>(res.ptr - buf));
    return;
  }
  if (!std::isfinite(v.floatValue)) {
    out += "null";  // JSON has no NaN/Infinity; JSON.stringify emits null
    return;
  }
  if (v.floatValue == 0.0) {
    out += "0";
    return;
  }
  char buf[64];
  const auto res = std::to_chars(buf, buf + sizeof(buf), v.floatValue);
  out.append(buf, static_cast<size_t>(res.ptr - buf));
}

void SerializeInto(const JsonValue& v, std::string& out) {
  switch (v.type) {
    case JsonType::Null:
      out += "null";
      return;
    case JsonType::Bool:
      out += v.boolValue ? "true" : "false";
      return;
    case JsonType::Number:
      SerializeNumber(v, out);
      return;
    case JsonType::String:
      SerializeString(v.str, out);
      return;
    case JsonType::Array: {
      out.push_back('[');
      for (size_t i = 0; i < v.array.size(); ++i) {
        if (i) out.push_back(',');
        SerializeInto(v.array[i], out);
      }
      out.push_back(']');
      return;
    }
    case JsonType::Object: {
      out.push_back('{');
      for (size_t i = 0; i < v.members.size(); ++i) {
        if (i) out.push_back(',');
        SerializeString(v.members[i].first, out);
        out.push_back(':');
        SerializeInto(v.members[i].second, out);
      }
      out.push_back('}');
      return;
    }
  }
}

constexpr int kMaxDepth = 200;

struct Parser {
  const std::string& s;
  size_t i = 0;
  std::string error;
  int depth = 0;

  explicit Parser(const std::string& text) : s(text) {}

  bool Fail(const std::string& message) {
    if (error.empty()) error = message;
    return false;
  }

  void SkipWhitespace() {
    while (i < s.size()) {
      const char c = s[i];
      if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
        ++i;
      } else {
        break;
      }
    }
  }

  bool AtEnd() const { return i >= s.size(); }

  bool ParseHex4(uint32_t& out) {
    if (i + 4 > s.size()) return Fail("truncated \\u escape");
    uint32_t value = 0;
    for (int k = 0; k < 4; ++k) {
      const char c = s[i + static_cast<size_t>(k)];
      uint32_t digit;
      if (c >= '0' && c <= '9') {
        digit = static_cast<uint32_t>(c - '0');
      } else if (c >= 'a' && c <= 'f') {
        digit = static_cast<uint32_t>(c - 'a') + 10u;
      } else if (c >= 'A' && c <= 'F') {
        digit = static_cast<uint32_t>(c - 'A') + 10u;
      } else {
        return Fail("invalid hex digit in \\u escape");
      }
      value = (value << 4) | digit;
    }
    i += 4;
    out = value;
    return true;
  }

  bool ParseStringBody(std::string& out) {
    // s[i] is the opening quote.
    ++i;
    out.clear();
    for (;;) {
      if (AtEnd()) return Fail("unterminated string");
      const char c = s[i];
      if (c == '"') {
        ++i;
        return true;
      }
      if (c == '\\') {
        ++i;
        if (AtEnd()) return Fail("unterminated escape");
        const char e = s[i++];
        switch (e) {
          case '"':
            out.push_back('"');
            break;
          case '\\':
            out.push_back('\\');
            break;
          case '/':
            out.push_back('/');
            break;
          case 'b':
            out.push_back('\b');
            break;
          case 'f':
            out.push_back('\f');
            break;
          case 'n':
            out.push_back('\n');
            break;
          case 'r':
            out.push_back('\r');
            break;
          case 't':
            out.push_back('\t');
            break;
          case 'u': {
            uint32_t hi = 0;
            if (!ParseHex4(hi)) return false;
            if (hi >= 0xD800u && hi <= 0xDBFFu && i + 1 < s.size() && s[i] == '\\' &&
                s[i + 1] == 'u') {
              const size_t save = i;
              i += 2;
              uint32_t lo = 0;
              if (!ParseHex4(lo)) return false;
              if (lo >= 0xDC00u && lo <= 0xDFFFu) {
                const uint32_t cp = 0x10000u + ((hi - 0xD800u) << 10) + (lo - 0xDC00u);
                Utf8Append(out, cp);
                break;
              }
              i = save;
            }
            // A lone surrogate keeps its WTF-8 encoding so that the serializer
            // can emit the same \uXXXX escape JavaScript would.
            Utf8Append(out, hi);
            break;
          }
          default:
            return Fail("invalid escape sequence in string");
        }
        continue;
      }
      if (static_cast<unsigned char>(c) < 0x20u) {
        return Fail("unescaped control character in string");
      }
      // Raw bytes: copy the whole run and replace ill-formed UTF-8 with U+FFFD,
      // like a UTF-8 decoding host would.
      const size_t start = i;
      while (i < s.size()) {
        const char r = s[i];
        if (r == '"' || r == '\\' || static_cast<unsigned char>(r) < 0x20u) break;
        ++i;
      }
      out += SanitizeUtf8(s.substr(start, i - start));
    }
  }

  bool ParseNumber(JsonValue& out) {
    const size_t start = i;
    if (!AtEnd() && s[i] == '-') ++i;
    if (AtEnd() || s[i] < '0' || s[i] > '9') return Fail("invalid number");
    while (!AtEnd() && s[i] >= '0' && s[i] <= '9') ++i;
    bool isInteger = true;
    if (!AtEnd() && s[i] == '.') {
      isInteger = false;
      ++i;
      if (AtEnd() || s[i] < '0' || s[i] > '9') return Fail("invalid number");
      while (!AtEnd() && s[i] >= '0' && s[i] <= '9') ++i;
    }
    if (!AtEnd() && (s[i] == 'e' || s[i] == 'E')) {
      isInteger = false;
      ++i;
      if (!AtEnd() && (s[i] == '+' || s[i] == '-')) ++i;
      if (AtEnd() || s[i] < '0' || s[i] > '9') return Fail("invalid number");
      while (!AtEnd() && s[i] >= '0' && s[i] <= '9') ++i;
    }
    const std::string token = s.substr(start, i - start);
    out.type = JsonType::Number;
    out.isInteger = isInteger;
    if (isInteger) {
      long long value = 0;
      const auto res = std::from_chars(token.data(), token.data() + token.size(), value);
      if (res.ec != std::errc() || res.ptr != token.data() + token.size()) {
        return Fail("integer out of range");
      }
      out.intValue = value;
      out.floatValue = static_cast<double>(value);
      return true;
    }
    double value = 0.0;
    const auto res = std::from_chars(token.data(), token.data() + token.size(), value);
    if (res.ec != std::errc() || res.ptr != token.data() + token.size()) {
      return Fail("invalid number");
    }
    out.floatValue = value;
    out.intValue = static_cast<long long>(value);
    return true;
  }

  bool ParseValue(JsonValue& out) {
    if (depth >= kMaxDepth) return Fail("JSON nesting too deep");
    SkipWhitespace();
    if (AtEnd()) return Fail("unexpected end of input");
    const char c = s[i];
    if (c == '{') return ParseObject(out);
    if (c == '[') return ParseArray(out);
    if (c == '"') {
      out.type = JsonType::String;
      out.str.clear();
      return ParseStringBody(out.str);
    }
    if (c == 't') {
      if (s.compare(i, 4, "true") != 0) return Fail("invalid literal");
      i += 4;
      out.type = JsonType::Bool;
      out.boolValue = true;
      return true;
    }
    if (c == 'f') {
      if (s.compare(i, 5, "false") != 0) return Fail("invalid literal");
      i += 5;
      out.type = JsonType::Bool;
      out.boolValue = false;
      return true;
    }
    if (c == 'n') {
      if (s.compare(i, 4, "null") != 0) return Fail("invalid literal");
      i += 4;
      out.type = JsonType::Null;
      return true;
    }
    return ParseNumber(out);
  }

  bool ParseObject(JsonValue& out) {
    out.type = JsonType::Object;
    out.members.clear();
    ++depth;
    ++i;  // '{'
    SkipWhitespace();
    if (!AtEnd() && s[i] == '}') {
      ++i;
      --depth;
      return true;
    }
    for (;;) {
      SkipWhitespace();
      if (AtEnd() || s[i] != '"') return Fail("expected object key string");
      std::string key;
      if (!ParseStringBody(key)) return false;
      SkipWhitespace();
      if (AtEnd() || s[i] != ':') return Fail("expected ':' after object key");
      ++i;
      JsonValue value;
      if (!ParseValue(value)) return false;
      out.members.emplace_back(std::move(key), std::move(value));
      SkipWhitespace();
      if (AtEnd()) return Fail("unterminated object");
      if (s[i] == ',') {
        ++i;
        continue;
      }
      if (s[i] == '}') {
        ++i;
        --depth;
        return true;
      }
      return Fail("expected ',' or '}' in object");
    }
  }

  bool ParseArray(JsonValue& out) {
    out.type = JsonType::Array;
    out.array.clear();
    ++depth;
    ++i;  // '['
    SkipWhitespace();
    if (!AtEnd() && s[i] == ']') {
      ++i;
      --depth;
      return true;
    }
    for (;;) {
      JsonValue value;
      if (!ParseValue(value)) return false;
      out.array.push_back(std::move(value));
      SkipWhitespace();
      if (AtEnd()) return Fail("unterminated array");
      if (s[i] == ',') {
        ++i;
        continue;
      }
      if (s[i] == ']') {
        ++i;
        --depth;
        return true;
      }
      return Fail("expected ',' or ']' in array");
    }
  }
};

}  // namespace

std::string JsonSerialize(const JsonValue& v) {
  std::string out;
  SerializeInto(v, out);
  return out;
}

bool JsonParse(const std::string& text, JsonValue& out, std::string& error) {
  Parser parser(text);
  JsonValue value;
  if (!parser.ParseValue(value)) {
    error = parser.error.empty() ? "invalid JSON" : parser.error;
    return false;
  }
  parser.SkipWhitespace();
  if (!parser.AtEnd()) {
    error = "unexpected trailing content after JSON value";
    return false;
  }
  out = std::move(value);
  return true;
}

}  // namespace vml
