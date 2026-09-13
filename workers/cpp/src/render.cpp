#include "render.h"

#include <utility>

#include "extract.h"
#include "fingerprint.h"
#include "normalize.h"

namespace vml {

JsonValue RenderNormalize(const std::string& text) {
  JsonValue out = JsonObject();
  out.members.emplace_back("text", JsonString(NormalizeText(text)));
  return out;
}

JsonValue RenderExtract(const std::string& html) {
  const ExtractResult result = ExtractHtml(html);
  JsonValue out = JsonObject();
  out.members.emplace_back("title", JsonString(result.title));
  out.members.emplace_back("text", JsonString(result.text));
  JsonValue links = JsonArray();
  links.array.reserve(result.links.size());
  for (const ExtractLink& link : result.links) {
    JsonValue entry = JsonObject();
    entry.members.emplace_back("href", JsonString(link.href));
    entry.members.emplace_back("absolute", JsonBool(link.absolute));
    entry.members.emplace_back("text", JsonString(link.text));
    links.array.push_back(std::move(entry));
  }
  out.members.emplace_back("links", std::move(links));
  out.members.emplace_back("images", JsonInt(result.images));
  return out;
}

JsonValue RenderFingerprint(const std::string& text) {
  const FingerprintResult result = FingerprintText(text);
  JsonValue out = JsonObject();
  out.members.emplace_back("simhash", JsonString(result.simhash));
  out.members.emplace_back("tokens", JsonInt(result.tokens));
  out.members.emplace_back("shingles", JsonInt(result.shingles));
  return out;
}

JsonValue RenderShutdownAck(const JsonValue& id) {
  JsonValue out = JsonObject();
  out.members.emplace_back("id", id);
  out.members.emplace_back("ok", JsonBool(true));
  return out;
}

}  // namespace vml
