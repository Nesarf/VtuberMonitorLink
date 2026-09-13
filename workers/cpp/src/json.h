// A small dependency-free JSON value, parser and serializer.
//
// The protocol (docs/WORKERS.md section 1) is JSON Lines over stdio, and the
// contract forbids third-party dependencies, so this is written by hand. It
// covers exactly what a host request can contain: strings with the full escape
// set including \uXXXX with surrogate pairs, integers, doubles, booleans, null,
// arrays and nested objects.
//
// Serialization is byte-deterministic: members are emitted in insertion order
// (never std::unordered_map order, which is not deterministic), separators are
// the compact JSON.stringify ones, non-ASCII is emitted as raw UTF-8 and the
// only \uXXXX escapes produced are for control characters below U+0020 and for
// lone surrogates - i.e. exactly what JSON.stringify does, which is what the
// cross-implementation diff compares against.
#pragma once

#include <string>
#include <utility>
#include <vector>

namespace vml {

enum class JsonType { Null, Bool, Number, String, Array, Object };

struct JsonValue {
  JsonType type = JsonType::Null;
  bool boolValue = false;
  bool isInteger = true;  // Number only: parsed without '.'/'e'
  long long intValue = 0;
  double floatValue = 0.0;
  std::string str;  // String: UTF-8 bytes
  std::vector<JsonValue> array;
  std::vector<std::pair<std::string, JsonValue>> members;  // Object, in order

  bool IsString() const { return type == JsonType::String; }
  bool IsObject() const { return type == JsonType::Object; }
  bool IsNumber() const { return type == JsonType::Number; }

  // Last match wins, like JSON.parse in JavaScript.
  const JsonValue* Find(const std::string& key) const;
};

JsonValue JsonNull();
JsonValue JsonBool(bool v);
JsonValue JsonInt(long long v);
JsonValue JsonString(const std::string& v);
JsonValue JsonArray();
JsonValue JsonObject();

std::string JsonSerialize(const JsonValue& v);

// Parses exactly one JSON value (surrounding whitespace allowed, trailing
// content rejected). Returns false and fills `error` with a short English
// message on failure.
bool JsonParse(const std::string& text, JsonValue& out, std::string& error);

}  // namespace vml
